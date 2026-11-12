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

五条铁律（都曾造成整 cell 空转或整批白烧）：

1. **deadline 对齐**：processTree 内部在 `deadline - 60000` 暂停。给它 `cellDeadline - 15000`，暂停点落在 cellDeadline-75000，留足收尾时间。**不要**在外层再套 `while (Date.now() < cellDeadline - X)` 循环重试——第一次 paused 后 deadline 已过，后续每次调用都立即 paused，会空转几百次只刷台账不干活。
2. **完成标记**：根节点 exit 阶段完成时会写 `L.vDone[rootId] = {done:true}`。跨 cell 判断任务是否已完成看这个标记；栈空且没有完成标记时才用 `fresh: true` 开新树。**栈空后不要用 `fresh: false` 调已完成任务的 rootId**，否则会重新初始化整棵树重跑。
3. **栈归属**：续跑前确认 `L.treeStack[0].path`（栈底是根）属于当前任务；属于别的任务就跳过，让归属任务先跑完。
4. **前台闸**：每格开头、每个根开头都过 `H.foregroundGate`（见下节）。`tab-hidden` 就收尾回报，**绝不后台提交**。
5. **wait 时机**：`node_repl_wait` 只能在格子**已跑完**时调（见下节）。运行中调会打断 cell。

进度观测：cell 运行期间台账只在每个目录提交/排空后落盘，长泵（pumpX2 预算最长 420s）期间台账数分钟不更新是正常的，不要误判为卡死。用 `node -e "require('<台账>')"` 读 `tag/totSent/treeStack.length` 看实时进度；补跑轮用 `node scripts/gap_progress.cjs <run.jsonl> <ledger.json> <plan.json>` 一次看全（格数、增量、根剩余、停机原因）。

## 前台闸：扩展只在可见页面转换（遮挡是隐形停机）

判据是页面里的 `document.visibilityState`，**不是「标签被选中」也不是 `hasFocus`**：

```js
let v = await H.visibility();                       // 'visible' | 'hidden' | 'err'
let g = await H.foregroundGate({ waitMs: 240000 });  // 每 10s 探一次，最多等 240s
if (!g.ok) { /* g.reason === 'tab-hidden'：收尾回报，绝不提交 */ }
```

- **实测代价（2026-11-11 10:20）**：用户切去看别的网站，`visibilityState=hidden`，之后 4 个目录全 `stalled`（`loaded 0/7`、`0/19`、`0/12`），**每目录白烧 115–180s 还挤占空间级配额**。所以后台时立即收尾、等人把 Photos 页放回前台（或拖成独立可见窗口），别硬跑。
- **更隐蔽的一种（11:21 实测）**：Photos 是选中页、`hasFocus=true`，`visibilityState` 仍 `hidden` —— Chrome 的原生窗口遮挡计算 `CalculateNativeWinOcclusion` 把被完全盖住的窗口判成隐藏，扩展就停止转换。
- **一次性解决（15:3x 实测有效）：重启 Chrome 关掉遮挡计算 —— 这是人工动作，agent 不得自行重启。** 命令行重启会关掉用户**所有标签页与窗口**（别的网站、没提交的表单都在里面），所以只把命令和代价告诉用户、等他做完再继续，别自行杀进程或关窗口代跑，也别自行最小化/挪开用户的其它窗口来解遮挡（那是他的工作现场）。给用户执行：

  ```
  chrome.exe --disable-features=CalculateNativeWinOcclusion --restore-last-session "https://<host>:<端口>/?launchApp=SYNO.Foto.AppInstance"
  ```

  复测（窗口 `state=maximized`、`focused=false`，即被别的窗口完全遮挡）：`visibilityState=visible, hasFocus=false` ⇒ 遮挡不再触发 hidden。**但窗口最小化、或切到别的标签页仍然会 hidden，闸要留着。**
  用户重启回来后按顺序做：`H.ready()`（load 先于 boot）→ 关掉多开的门户标签 → `H.visibility()` 确认 `visible` → 才继续发格。游标在台账里，重启不会丢进度。
- **别再试的无效手段**（都实测过，详见 dom-notes 陷阱 18）：SDK `visibility.set(true)` 只恢复最小化、`Page.bringToFront` 被 CDP allowlist 拒绝、`management` 只开放 `getVersion/getWindows/getSessionName`、注册表策略 `CalculateNativeWinOcclusion=0` 不生效。
- 重启后会多开一个 `https://<host>/` **门户标签**：两个同 host 标签让 `boot()` 报 ambiguous，claim + `close_page` 关掉它，只留 Photos 标签；此时 boot 走 **adopted** 分支，`ready().ok` 会是 `false`（它只认 `claimed || created`）—— **实际可用**（能读 `visibilityState`、能拍快照），别为它反复重启。放行判据见 SKILL.md「台账隔离与安全闸」。
- **用户没回应就收尾回报、结束本回合**，别原地轮询 `visibility` 等他回来：cell 在回合结束时会被杀，轮询只是白烧时间。游标在台账里，他说「继续」时重新 `H.ready()`（load 先于 boot）接着发格即可。

## cell 节奏：`node_repl_wait` 只能在收尾后调

2026-11-11 实测（两格就这么死的：无日志行、内存与盘一致、欠账留在 `needDrain`）：

- 格子**已跑完**时调 `node_repl_wait` → 正常取回结果。
- 格子**运行中**调 → 报 `CAPABILITY_NOT_NEGOTIATED`，并把 cell **打断**。
- 格子正常跑完后**必须先 wait 取回结果**，否则下一格报 `has finished … before starting another cell`。

所以节奏是：**发格 → 用 `Bash` sleep 到 jsonl 出现含 `stop` 的新行 → `node_repl_wait` 取结果 → 同一 turn 立刻发下一格**。
**收尾信号是「含 `stop` 字段的那一行」，不是「任何新行」**：`gap_runner.mjs` 一格可以推进多个根，每根一行 `{root,…}` 是**格子中途**写的（`log(rec)` 在循环里，写完继续跑下一根），把 root 行当收尾去 wait 会**打断正在跑的 cell**。runner 的每个出口都写恰好一行 `stop`（含 `all-done` / `cell-budget` / `loop-cap` 与两道前置闸），所以盯住 `stop` 行就不必等到 `cellMs` 上限再猜。手贴循环的旧日志只在异常出口写 stop，那种日志要看 `lines` 与 `last` 有没有推进（见下节）。
**外部中断不会有 stop 行**：回合结束被杀、运行中调 wait 被打断、kernel 回收、CDP 整格卡死都属于这类。等到 `cellMs` + 60s 仍没有 stop 行就按中断处置：**先 wait 收掉上一格**（下一格若报 `has finished … before starting another cell` 就是没收），离线读台账核对游标（`at/tag/treeStack/needDrain`），按「失败恢复」重新 `H.ready()` 再发格，别原地重发同一格。
**盯 stop 行的 Bash 循环要分段**：Bash 单次上限 600s（`timeout_ms` 最大 600000），所以每段轮询 ≤ 540s，到点没等到就再发一段，别把 `cellMs` + 60s 写成一段（会被工具超时截断）。先记基线 `grep -c '"stop":' <log>`，再轮询到计数变大。
返回里 `logErr` 非 null = 日志写不进去，收尾信号失效：**先停机回报，别续发格**。常见原因是盘满或权限，那时台账 `persist` 很可能同样写不进（同一块盘），进度只在内存里，继续跑等于白跑；让人清盘/换路径后再 `H.ready()` 续跑。
没有 jsonl 日志时就看台账 `at/tag` 是否更新（长泵期间数分钟不更新是正常的）。`cell` 在**回合结束时也会被杀**，所以「自动跑、中间不要断」= 在同一回合里一格接一格发，别指望后台等待。
`yield_time_ms` 每格换一个值（48000–60000 之间轮换），别连发同一个等待值。

## 多根缺口补跑：用 `gap_runner.mjs`，别手贴循环

`references/recheck-recipe.md` Cell 4 算出 `globalThis.__plan`（最小根集 + 真实路径）并**落一份独立 JSON**（kernel 回收后能重建）之后，每格只发一行：

```js
// 前置（新 turn / kernel 回收后跑一次）：__CFG → __bua → 装库 → H.ready() → 从 plan JSON 读回 __plan
await import('file:///<skill 目录>/scripts/gap_runner.mjs?v=' + Date.now());
nodeRepl.write(JSON.stringify(await globalThis.__gapRun({
  plan: globalThis.__plan, log: '<台账目录>/run-gap.jsonl', cellMs: 565000, waitVis: 240000
})));
```

它内部就是上面五条铁律：`LEDGER_NOT_LOADED` / `NO_PLAN` 闸 → 开格前台闸（等不到 `visible` 就 `{stop:'tab-hidden'}`）→ `H.gapNextRoot(plan, L)` 选根（栈非空续栈底 `fresh:false`，栈空取下一个未完成根 `fresh:true`，栈底不在本 plan 则 `{stop:'stack-other-root'}`）→ 每个根前再探一次前台 → `processTree(root, {deadline: cellDeadline-15000})` → 逐根写 jsonl → `paused` 立即 `{stop:'paused'}` 收尾。
返回 `{results, folders, totSent, rootsLeft, needDrain, ms, stop, logErr}`。**判完成看 `stop:'all-done'` 且 `rootsLeft === 0`**，接着重跑 Cell 1 对账（差集应归零）+ Cell 2 逐项 HEAD。

**收尾唯一出口：任何 return 都先写恰好一行 `stop` 日志**（`fin()` 统一落盘），所以每格的日志形状固定 = 每根一行 `{root,…}` + 收尾一行 `{stop,…}`。九种停机原因与处置：

| stop | 含义 | 下一步 |
| --- | --- | --- |
| `LEDGER_NOT_LOADED` / `NO_PLAN` | 前置闸没过，一次 `processTree` 都没调 | 先 `H.ready()` 确认 loaded、把计划读进 `__plan`，再发格 |
| `tab-hidden` | 开格或某根开跑前页面不可见 | 让人把 Photos 放回前台可见，**别提交**，再发格 |
| `stack-other-root` | 栈底不在本 plan（是别的任务的根） | 先跑完归属任务，别碰游标 |
| `cell-budget` | 剩余预算不够再开一根（< 120s） | 同一 turn 紧接着发下一格续跑 |
| `paused` | `processTree` 主动暂停（本格只调一次） | 同上，续栈 `fresh:false` |
| `err` | 连接层抛错：不标 done、不吞异常、不继续下一根 | 按「失败恢复」处置，游标未动 |
| `all-done` | 计划里的根全部 `vDone.done` | 走全树复查对账 |
| `loop-cap` | 循环上限兜底（`plan.length + 1` 轮） | 看 `rootsLeft`，非 0 就续发一格 |

离线汇总：`node scripts/gap_progress.cjs <run.jsonl> <ledger.json> <plan.json>`（或用 `SYNOPHOTOS_GAP_LOG` / `SYNOPHOTOS_GAP_LEDGER` / `SYNOPHOTOS_GAP_PLAN` 环境变量，缺参数报用法退出码 2）。字段口径别读错：

- `cells` = **已收尾格数**（数 stop 行），`stops` 同值；`lines` = 日志行数（每根一行 + 每格一行）。
- `perRoot[].cells` = 该根被几格碰过，**不是**总格数；`dirsAdded` / `sentAdded` 是这批日志的新增量，不是台账累计。
- 手贴循环的旧日志只在异常出口写 stop ⇒ `cells` 会偏少，这时看 `lines` 与 `last` 判断有没有在推进。
- 长泵期间台账数分钟不更新是正常的，判「卡死 vs 在跑」看日志有没有新行（任何新行都说明还在跑）；判「格子收尾了没」只看新的 **stop 行**，两者别混。

## 失败恢复

- **Chrome 被整个重启**（cell 连报「没有可用的外部浏览器」、`list_pages` 只剩 `about:blank`）：按顺序做，别跳步——
  1. `chrome_devtools.list_pages` 确认标签没了 → `chrome_devtools.navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance', timeout:45000 }`（多标签时带 `pageId`）。**第一次读到 `#/signin/password` 不等于会话过期**：等它走完 `external_login` 重定向再读一次 URL（`list_pages`，或 `chrome_devtools.evaluate_script` 读 `location.href` —— 这条通道的 evaluate 有返回值，browser-use shim 的 `page.evaluate` 恒 null）。实测重读就回到 `#/shared_space/folder/1`、侧栏共享文件夹都在，说明会话还活着。只有重读仍停在登录表单（`#account`/`#password` 字段在）才是真过期 → 停下来让人登录，**不要自动重试**。
  2. 会话活着也可能 `H.st()` 全 0、`emptyView:true`（SPA **半初始化**），这时反复 `H.goto(id)` 没用。改用 **`navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance#/shared_space/folder/<id>', timeout:60000 }`** 做整页导航到目标文件夹（真文档导航，不是只改 hash）。
  3. 这一步会自动多开一个 `https://<host>/` 门户标签：`list_pages` 找到它的 `pageId`，`close_page { pageId }` 关掉，只留一个 Photos 标签，否则 boot 认领歧义、扩展也不在正确的活动页转换。
  4. 恢复后重新 `H.ready()`（load 先于 boot）认领标签，再 `H.probe()` 确认渲染出卡片才跑批量。**`emptyView:true` 与台账 `total>0` 矛盾时绝不判干净**：`H.waitRender`/`H.stSettled` 只看页面（`total===0 || emptyView` 就放行 empty），半初始化页面会把有项目的目录判成空，`p2Pass` 随即写 cleanMark。整页导航后仍全 0 就是人工停机点：让人手动刷新/重开该标签页，别原地循环 goto。
  报错目录的游标不会丢：连接层错误只进 `rep.errs`，不标 done、不提交，收尾仍 persist。续跑前离线核对这些 id 未被标记即可（2026-11-11 实测 8 个报错目录零游标损失）。
- **只剩门户标签 / boot 报 ambiguous**：DSM `launchApp` 会自己多开一个 `https://<host>/` 门户标签，两个同 host 标签让认领歧义。`list_pages` 找到门户标签的 `pageId` → `close_page` 关掉，只留 Photos 标签，再 `H.ready()`。此时 boot 走 **adopted** 分支（复用活动标签），`ready().ok` 是 `false` —— 它只认 `claimed || created`，**adopted 不算 ok 是库的判据漏项**；只要 `load.loaded===true`、`H.probe()` 能读到卡片、`H.visibility()` 返回 `visible`，就可以跑批量，别为 `ok:false` 反复重启浏览器。
- **CDP 整格卡死（人工停机点，重试无效）**：实测 2026-11-10 ~15:40，一个目录完成后，接下来 3 个目录连续报 `Tool command waited too long in queue`，随后 `tab.url()` / `tabs.selected()` / `tabs.new()` **全部超时** —— 那个 Photos 标签页的 CDP 会话卡死了，**新建浏览器会话也无效**。处置：请人工把该 Photos 标签页刷新或关掉重开（有弹窗先点掉），之后 `H.ready()` 从游标继续；报错目录未标 done，会自动重跑。别原地循环重试，也别把它当成登录过期。
- `TAB_NOT_OWNED` / `userTabs: []`：新 turn 需要重新 `browser.user.openTabs()` + `claimTab()`，找不到就 `browser.tabs.new()` 后 `goto` 到共享空间路由；页面渲染出 `main-grid` 就说明仍在登录态。
- kernel 被回收（`globalThis.__H` 为 undefined）：重装库后**先 `await H.ready()`**（load 在 boot 之前），确认台账 loaded 且目录数正常再跑；`var` 声明的 cell 内变量会丢，只有 `globalThis.__*` 能活过 turn。
- 台账被误覆盖：`H.persist` 会拒绝「内存落后于盘」的写入并留下 `.conflict-<ts>`；上一版在 `<台账>.bak`。若已被覆盖，先 `cp` 一份现场，再按任务重走——已生成好的预览在 NAS 上，重走只会补提仍坏的条目，同时兼作复检。
- **台账读不出来（`load` 返回 `reason:'corrupt'`）**：`persist` 是原子替换（先写 `<台账>.tmp` 再 `renameSync`），所以主文件半截只会出现在旧版本或外力打断时；`load` 会先尝试**用 `.bak` 修好主文件并恢复游标**，两个都坏才报 `corrupt` 并把内存游标清零。此时**先手工救**：按修改时间挑最新的 `ledger-*.bak` / `ledger-*.conflict-*`，`node -e "JSON.parse(require('fs').readFileSync('<候选>','utf8'))"` 逐个验能解析、`folders/vDone/p2.done/totSent` 数量对得上，`cp` 成主文件后再 `H.load()`。**别直接重跑整轮**（白烧几小时浏览器时间），也别带着 `corrupt` 的空内存跑批量（会把真台账洗成空）。
- cell 被中断 / processTree 返回 `paused: true`：treeStack 已写盘，新 cell 里 `H.ready()`（load 先于 boot）后再调 `H.processTree(rootId, { deadline: ... })` 自动从断点继续。不要加 `fresh: true`，否则重置进度。
- 旧的 workerX2 中断：只要引擎按批 `rec()` + `persist()`，进度仍在磁盘和全局里，读 `__LED.res2` / `__LED.tr` 恢复，不要重放整批写操作。