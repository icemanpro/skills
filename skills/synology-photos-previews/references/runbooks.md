# 运行手册：无人值守连续跑 与 失败恢复

SKILL.md 正文只留铁律摘要；这里是完整模板与恢复步骤。跑无人值守批量、或从故障中恢复时读本文件。

## 无人值守连续跑（多任务自动衔接）

用户要求「自己自动跑、中间不要断」时，按下面的 cell 循环模式执行。**每个 cell 对每个任务只调一次 processTree**，返回 `paused` 就立即结束本 cell，由 agent 在同一 turn 里紧接着发下一个 cell（kernel 未回收时无需重新 boot/load）：

```js
var H = globalThis.__H, L = globalThis.__LED;
var cellDeadline = Date.now() + 565000;          // cell timeout_ms 设 600000
// 每个任务独立台账；切任务时改 CFG.ledger 并重新 load，绝不让两个任务写同一个文件
var plan = [
  { id:'414', path:'影像资料-2026年', ledger:'<台账目录>/ledger-2026.json' },
  { id:'412', path:'影像资料-2025年', ledger:'<台账目录>/ledger-2025.json' }
];
var results = [];
for (var i = 0; i < plan.length; i++) {
  var t = plan[i];
  var prevLedger = String(globalThis.__CFG.ledger).replace(/\\/g,'/');
  if (prevLedger !== t.ledger) {
    globalThis.__CFG.ledger = t.ledger;
    var ld = await H.load();
    results.push({ task: t.id, switched: ld });
    if (!ld.loaded) { L.treeStack = []; L.vDone = {}; }   // 该任务首次跑：全新状态
  }
  var stackActive = !!(L.treeStack && L.treeStack.length > 0);
  var stackIsThis = stackActive && String(L.treeStack[0].path || '').indexOf(t.path) === 0;
  if (L.vDone[t.id] && L.vDone[t.id].done && !stackIsThis) { results.push({task:t.id, skipped:'already-done'}); continue; }
  if (stackActive && !stackIsThis) { results.push({task:t.id, skipped:'stack-other-task'}); continue; }
  var r = await H.processTree(t.id, { path: t.path, deadline: cellDeadline - 15000, fresh: !stackActive });
  results.push({ task: t.id, r: r, totSent: L.totSent });
  if (r.paused) break;   // 关键：paused 说明 cell 时间已耗尽，立即收尾，绝不原地重试
}
nodeRepl.write(JSON.stringify(results));
```

三条铁律（都曾造成整 cell 空转）：

1. **deadline 对齐**：processTree 内部在 `deadline - 60000` 暂停。给它 `cellDeadline - 15000`，暂停点落在 cellDeadline-75000，留足收尾时间。**不要**在外层再套 `while (Date.now() < cellDeadline - X)` 循环重试——第一次 paused 后 deadline 已过，后续每次调用都立即 paused，会空转几百次只刷台账不干活。
2. **完成标记**：根节点 exit 阶段完成时会写 `L.vDone[rootId] = {done:true}`。跨 cell 判断任务是否已完成看这个标记；栈空且没有完成标记时才用 `fresh: true` 开新树。**栈空后不要用 `fresh: false` 调已完成任务的 rootId**，否则会重新初始化整棵树重跑。
3. **栈归属**：续跑前确认 `L.treeStack[0].path`（栈底是根）属于当前任务；属于别的任务就跳过，让归属任务先跑完。

进度观测：cell 运行期间台账只在每个目录提交/排空后落盘，长泵（pumpX2 预算最长 420s）期间台账数分钟不更新是正常的，不要误判为卡死。用 `node -e "require('<台账>')"` 读 `tag/totSent/treeStack.length` 看实时进度。

## 失败恢复

- **Chrome 被整个重启**（cell 连报「没有可用的外部浏览器」、`list_pages` 只剩 `about:blank`）：按顺序做，别跳步——
  1. `chrome_devtools.list_pages` 确认标签没了 → `chrome_devtools.navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance', timeout:45000 }`（多标签时带 `pageId`）。**第一次读到 `#/signin/password` 不等于会话过期**：等它走完 `external_login` 重定向再读一次 URL（`list_pages`，或 `chrome_devtools.evaluate_script` 读 `location.href` —— 这条通道的 evaluate 有返回值，browser-use shim 的 `page.evaluate` 恒 null）。实测重读就回到 `#/shared_space/folder/1`、侧栏共享文件夹都在，说明会话还活着。只有重读仍停在登录表单（`#account`/`#password` 字段在）才是真过期 → 停下来让人登录，**不要自动重试**。
  2. 会话活着也可能 `H.st()` 全 0、`emptyView:true`（SPA **半初始化**），这时反复 `H.goto(id)` 没用。改用 **`navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance#/shared_space/folder/<id>', timeout:60000 }`** 做整页导航到目标文件夹（真文档导航，不是只改 hash）。
  3. 这一步会自动多开一个 `https://<host>/` 门户标签：`list_pages` 找到它的 `pageId`，`close_page { pageId }` 关掉，只留一个 Photos 标签，否则 boot 认领歧义、扩展也不在正确的活动页转换。
  4. 恢复后重新 `H.ready()`（load 先于 boot）认领标签，再 `H.probe()` 确认渲染出卡片才跑批量。**`emptyView:true` 与台账 `total>0` 矛盾时绝不判干净**：`H.waitRender`/`H.stSettled` 只看页面（`total===0 || emptyView` 就放行 empty），半初始化页面会把有项目的目录判成空，`p2Pass` 随即写 cleanMark。整页导航后仍全 0 就是人工停机点：让人手动刷新/重开该标签页，别原地循环 goto。
  报错目录的游标不会丢：连接层错误只进 `rep.errs`，不标 done、不提交，收尾仍 persist。续跑前离线核对这些 id 未被标记即可（2026-11-11 实测 8 个报错目录零游标损失）。
- `TAB_NOT_OWNED` / `userTabs: []`：新 turn 需要重新 `browser.user.openTabs()` + `claimTab()`，找不到就 `browser.tabs.new()` 后 `goto` 到共享空间路由；页面渲染出 `main-grid` 就说明仍在登录态。
- kernel 被回收（`globalThis.__H` 为 undefined）：重装库后**先 `await H.ready()`**（load 在 boot 之前），确认台账 loaded 且目录数正常再跑；`var` 声明的 cell 内变量会丢，只有 `globalThis.__*` 能活过 turn。
- 台账被误覆盖：`H.persist` 会拒绝「内存落后于盘」的写入并留下 `.conflict-<ts>`；上一版在 `<台账>.bak`。若已被覆盖，先 `cp` 一份现场，再按任务重走——已生成好的预览在 NAS 上，重走只会补提仍坏的条目，同时兼作复检。
- cell 被中断 / processTree 返回 `paused: true`：treeStack 已写盘，新 cell 里 boot + load 后再调 `H.processTree(rootId, { deadline: ... })` 自动从断点继续。不要加 `fresh: true`，否则重置进度。
- 旧的 workerX2 中断：只要引擎按批 `rec()` + `persist()`，进度仍在磁盘和全局里，读 `__LED.res2` / `__LED.tr` 恢复，不要重放整批写操作。