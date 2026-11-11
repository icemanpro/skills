---
name: synology-photos-previews
version: 1.0.0
description: 群晖 Synology Photos 共享空间的缩略图/预览坏掉（「图片预览不出来」「重新生成预览」「synofoto-item-image-broken」「Synology Image Assistant」），或需要全树复查（「再检查一遍某年」「确认预览都生成好了」，台账全标 done 也要重核）、补漏与完成标记复核（「标了完成却还有坏图」「某个目录下整支子目录没跑」）时使用。仅适用于已登录该 NAS、装有 Synology Image Assistant 扩展的那台 Chrome：转换在浏览器端完成，服务端不会自己修好。
---

# Synology Photos 预览重建

## Overview

在 DSM 共享空间的照片/视频网格里，把仍显示坏图的条目批量选中 → 工具条「生成预览」→ 等客户端队列排空 → 复检，并把逐目录结果持久化成台账。
预览与缩略图由 **这台浏览器** 上的 Synology Image Assistant 扩展生成后回传：页面关掉、换浏览器、或扩展没装，提交就不会生效。所以必须用 `browser-use` skill 驱动用户已登录的 Chrome，不能用 in-app 浏览器。

## 先确认可执行前提

1. Chrome 已登录 Synology Photos，且装有 **Synology Image Assistant** 扩展。
2. 该扩展只在活跃标签页里做转换：批量期间保持这个页面开着，别把标签页关掉。
3. 空间级配额：**每个共享空间最多 120 条待处理预览任务**。超限会弹「您每个空间最多可以新增120个项目以生成预览」并**整批拒绝**——不是部分成功。
4. 若用户要求「小批量 + 等完再继续」，配额撞墙时必须做空间级排空等待，而不是继续提交（重复提交只会挤占配额）。

## 在新机器上首次运行

1. 装包：在 Qoder 的「技能」里安装本 skill 的 `.zip`（zip 根目录即 `synology-photos-previews/`）。前置条件不变：**同一台机器**上的 Chrome 已登录该 NAS 并装有 Synology Image Assistant 扩展。
2. 改配置，优先级从高到低：装载库之前在 cell 里设 `globalThis.__CFG = { host:'<NAS>:<端口>', ledger:'<台账路径>' }`（可只给部分字段）；或用环境变量 `SYNOPHOTOS_HOST` / `SYNOPHOTOS_LEDGER`。**host 没有默认值、必须配置**（未配置时 `H.boot()` 返回 `NO_HOST`，不会静默指向任何机器）；台账不配则落 `~/Documents/synology-previews/ledger.json`。
3. 新机器首次 `H.load()` 返回 `{loaded:false, reason:'no-ledger'}` 是正常的，说明还没有台账，直接用 `H.processTree(rootId)` 开始处理；`H.persist()` 会自动创建台账所在目录。
4. 台账只是本机进度，不要拿别机的台账来「续跑」：`vQueue` 与页面 DOM 状态绑定，换机应重新枚举。

## 关键判读规则（先记住这几条再动手）

- 坏图判定：卡片内出现 class `synofoto-item-image-broken`（位于 `div[data-testid="item-image-status"]`）。**与条目类型无关**：照片和视频用同一判定，视频同样能按本方法生成缩略图。
- `broken` 是**瞬时状态**：待处理期间取不到缩略图就标坏，转换完成后整批突然恢复（实测 81 → 0 的阶跃）。因此「提交后还是坏」≠「失败」，要等完再判。
- **反过来也成立：刚进目录时读到 `bad=0` 不等于干净。** 卡片 ~1.3s 就出现在 DOM，但 broken class 要等图片请求超时/失败才挂上。实测（2026-11-11）时间线：`2705` 1320ms `{all:12,bad:0}` → 1934ms `{all:12,bad:12}`；`2711` 1272ms `{all:43,bad:0}` → 1904ms `{all:43,bad:22}` → 2536ms `{all:43,bad:43}`。所以 `H.goto` 里那 3.2s 固定等待是承重的，任何「提速」改动把它去掉都会把整批目录误标 done。复检的干净判据必须走 `H.stSettled()`：要求 **渲染满**（`all >= total`；虚拟化只画窗口内那部分，容量随视口变化）且 **每张卡片都有确定状态**（`bad + loaded >= all`）；到预算仍不安定就返回 `settled:false`，绝不标 done。
- **`loaded >= all`、`bad=0`、`drain:converted` 也都只覆盖渲染窗口，不是全目录结论。** 窗口容量实测 81–198 张，所以 **`total <= 120` 不等于「一屏装得下」**：实测目录 7979 有 82 项、只挂载 81 张，页面报 `{all:81, loaded:81, bad:0}`、台账 `drain:converted` + `p2.done=1`，而第 82 条（`121626`）HEAD `sm` 连测 3 次都是 404 —— 它正好是唯一在窗外的那条，DOM 里根本不存在。判「装不下」用 `st.all + st.folders < 页项数`，**不是** `total > 120`。要全目录结论只有 API 逐项 + HEAD（见工作流第 5 步「全树复查」）。网格请求 `size="sm"`、灯箱请求 `size="xl"`，`loaded` 说的是 sm 那一档。
- 一个卡片的选中态在 DOM 里是 **2 个节点**（`basic-selectable_0.checked` 与 `.synofoto-selectable-wrapper.checked`）。用 `checked` 节点数当卡片数会翻倍，导致误判「超量」并退回逐张点选。
- 逐张点选实测 **平均 6.7 秒/张**（Playwright 在动效和图片加载下等可操作性），110 张要 12 分钟。区间选择（点首张 + Shift 点末张）是**唯一可用路径**，实测精确：锚第 0 张 + Shift 第 95 张 = 96 张。
- 每次进入新目录先按用户要求把预览尺寸调小（`aria-label="更改预览大小"` → `small thumbnail size`；该按钮可能不存在，`H.sizeSmall` 两次 click 都吞错，调完要复测容量）。**单窗口容量不是常数**：早先最大化窗口实测 198 张；Chrome 重启后视口变小，同一轮 13 个目录的抽样里窗口分别是 **81 / 100 / 143** 张。目录视图只虚拟挂载窗口内的卡片：`scrollTop` 到 725 就到底且写进去被回弹、`scrollIntoViewIfNeeded` 只推进一页、`pw.mouse` 在这个 shim 里是 undefined；body `PageDown` **有时能推进、有时一步都不动**（7439 从 81 扫到 143；2238/2696/2702 的 `swept == all`）。所以别假定滚动一定有效或一定无效，**以 `H.audit` 回报的 `swept` 为准**；扫不动或要全目录结论就走 API 逐项审计（见下），要修窗口外的坏图先把排序切成降序（实测尾巴会进窗口）。
- 计数口径：`H.parse(await H.snap())` 数的是快照文本里的卡片标记，`H.grid().count()` / `querySelectorAll` 数的是活 DOM，**两者不同源、不保证一致**。判据统一用快照口径，别拿 locator 计数去「校正」它。
- 单次 DOM/点击往返 2–8 秒（扩展桥延迟），所以每目录的地板耗时约 25–40 秒；吞吐瓶颈是延迟而不是配额。
- `Escape` 一键清空全部选中；每批选择前先清空，否则残留选中会让「想选 55 实选 121」并触发配额拒绝。

## 工作流

1. **接管标签页并装载库**。在 `node_repl` 里装载 `scripts/synophotos_lib.mjs`：可以整份文件作为 cell code 提交，也可以用 `globalThis.__bua = await import('@qoder-space/browser-use')` 后 `await import('file:///…/synophotos_lib.mjs')` 省 token（裸包名只能在 cell 里解析，模块自身解析不到，必须先注入）。装载后 `await globalThis.__H.boot()` 接管已登录的 Photos 标签页。cell 超时上限 600000 ms，同一时刻只允许一个 cell 在跑；跨 turn 必须重新 boot 并重装库（`await H.load()` 从台账恢复状态）。
2. **确认选择器仍然匹配**（页面改版时必做）：调用 `await H.probe()`，它会回报当前站点的网格/坏图/选中节点计数与 `data-testid` 采样。计数全为 0 说明选择器或路由变了，先修 `H.parse` 再批量。
3. **定位目标目录**。用 `H.goto(id)` + 快照解析逐层进入目标路径（如 根 → 项目影像资料 → 影像资料 → 影像资料-2026年），记录最终根目录 ID。**子目录清单一律用 `await H.listChildren(id)`（分页 API），不要拿快照里的 `folder-draggable-zone-(\d+)` 当清单**——快照只有渲染窗口那一段：2026-11-11 实测 7227 页面 `folders:90 / total:130`，按快照枚举会漏掉 40 支子目录（1289 条条目全没转换），父目录还被标 done。快照只留作交叉校验。
4. **深度优先递归处理**。调用 `await H.processTree(rootId, { path:'影像资料-2026年', deadline: Date.now() + 540000 })`。该函数自动执行：进入目录 → 提交当前坏图 → 递归所有子目录 → 回来复检 → 返回上级。无需预先枚举全树。若返回 `paused: true`（cell 即将超时），下一个 cell 重新 boot + load 后再次调用 `H.processTree(rootId, { deadline: ... })` 即可从断点继续（treeStack 已持久化）。
5. **复检**：processTree 完成后，对仍有坏图的目录可单独调用 `H.pumpX2(id, budgetMs)` 补提。最后 `node scripts/summarize_ledger.cjs <台账.json>` 出汇总并写报告。
   **用户说「再检查一遍某年」/ 要交付「预览都生成好了」的结论时，走全树复查**（不是重跑 p2Pass、不是抽样、不是读台账标记）：① 页内一次递归枚举整树 → 与台账求差集；② 逐目录 API 取全部条目 + 每条 HEAD `sm`/`xl`；③ 只对实测 404 的目录修，修完再逐项 HEAD 复验。通过判据 = `smBad=0 && xlBad=0 && errs=0 && nock=0` 且审计目录数 = 枚举目录数。分格游标 runner、可直接跑的 cell 模板与实测吞吐见 **`references/recheck-recipe.md`**。
6. **报告口径**：会话内提交数与累计提交数分开报；「已提交但仍是坏图」不能算失败也不能算完成；只有确实无法选中的条目才记入 stuckIds（待处理条目不算 stuck，否则会产出几百条假阳性）。

## processTree 使用说明

`H.processTree(rootId, opts)` 是核心入口，采用深度优先遍历：

```
进入目录 → 提交当前坏图 → 等转换完成（drain） → 逐个进入子目录（递归） → 子目录全部完成后回来复检 → 等转换完成 → 返回上级
```

**参数**：
- `rootId`：目标根目录 ID（字符串）
- `opts.path`：目录路径名（用于台账记录，如 `'影像资料-2026年'`）
- `opts.deadline`：截止时间戳（ms），默认 `Date.now() + 540000`（留 60s 余量给 cell 超时）
- `opts.fresh`：设为 `true` 时忽略已保存的 treeStack，从头开始

**返回值**：
- `{ done: true, processed, submitted, totSent }` — 全部完成
- `{ paused: true, remaining, processed, submitted }` — 即将超时，已保存栈，下次调用自动续跑
- `{ paused: true, err, node }` — 主动暂停，`err` ∈ `NAV_MISMATCH`（URL 没落到目标目录）、`NOT_RENDERED`（URL 对了但瓦片/子目录卡片没渲染出来）、`CHILDREN_API`（子目录分页接口失败/返回非 JSON，例如 803 掉登录）、`CHILDREN_MISMATCH`（快照里有 API 没返回的子目录 id，两边不同源）、`SUBMIT_BUDGET`（剩余时间不够「提交+等转换」，本格不做）、`SUBMIT_BLOCKED`（pump 一张都没提交进去且页面仍脏：budget/sel-fail/gp-*/quota/stuck-window，**绝不标 done**）、`DRAIN_BUDGET`（已提交但没时间排空，留在原地）、`DRAIN_NOT_RENDERED`（排空时看不到瓦片）。这几种都**不会**把目录标 done，续跑时自动重做。

**渲染闸门（2026-11-10 新增，与排空判据同样重要）**：`H.goto()` 之后 URL 立刻就对了，但网格可能十几秒后才渲染——实测目录 4127 在 goto + 9.2s 后仍是 `{all:0, folders:0}` 而 `totalShown=2`。旧代码只校验 URL，这种情况会把目录当「空叶子」标 `done`，**整支子目录静默丢失**（2026-11-08 的 414 事故同类）。现在进目录后先过 `H.waitRender(deadline)`：

- 看到图片瓦片（`all>0`）或子目录卡片（`folders>0`）立即放行；
- 真空目录也放行：判据是 `total === 0` **或** `emptyView`。注意空目录页面显示的是「**无项目**」而不是「0 个项目」，快照里的标记是 `data-testid="empty-view-wrapper"`（实测目录 2249；`empty-view` / `.empty-view-wrapper` 这两个选择器都不存在）；
- 有项目却看不到瓦片：最多等 25s（每 2s 取样一次），仍不行返回 `NOT_RENDERED` 暂停，绝不标 done；
- 闸门那次快照会复用为 `total` 与 `st`，比旧写法少一次往返。`pumpX2` 重新 goto 后同样先过闸门，失败记 `blocked:'not-rendered'`，上层暂停而不是标 done。

**断点续跑**：treeStack 每次 persist 时写盘。新 turn 里 boot + load 后直接再调 `H.processTree(rootId, { deadline: ... })` 即可从上次中断处继续，无需 fresh。

**配额处理**：pumpX2 撞配额时自动做空间级排空（spaceDrain），排空后继续处理；spaceDrain 的时间上限已扣掉排空预留，不会把等转换的时间吃光。

**等转换完成（2026-11-10 修正，务必按新判据理解）**：

Synology Image Assistant 只在**活跃标签页**做转换，切走就停。所以「提交」和「等转换完成」是一个不可拆的整体，由 `H.submitAndDrain()` 统一执行：

- **完成判据是 `loaded >= all`，不是 `bad === 0`。** 实测目录 4112（16 张坏图）：提交前 `{all:16, loaded:0, bad:16, nosrc:16}`；点完「生成预览」的**同一秒**就变成 `{all:16, loaded:2, bad:0, nosrc:0}`——broken class 立刻消失、src 立刻就有，但真正加载完只有 2/16，约十几秒后才 16/16。旧版 `H.drain` 第一行 `if (bad===0) return 'zero'` 因此秒退，processTree 随即切目录，这就是「没等预览生成就退回上一级」的根因。`nosrc` 同样不可信。
- 判据集中在纯函数 `H.drainDecide(sample, ctx, opts)`，返回 `null`（继续等）或 `converted | empty | not-rendered | stalled | timeout`。`empty` 只给「只有子目录」或「真的 0 项」的目录；有项目却看不到瓦片一律 `not-rendered` 并暂停，绝不当完成。停滞按 **loaded 是否推进**判（连续 6 轮不推进），不再按 bad。
- **只要 `sent > 0` 就必须排空**，`blocked`（sel-fail / budget / quota）也不例外——旧版 `!r.blocked` 条件会把已提交的图直接丢下。
- **预算先预留再提交**：`H.splitBudget(deadline, now, opts)` 先扣安全余量、再扣排空预留，剩下的才给 pumpX2（默认 safety 90s / reserve 120s / minPump 30s，上限 420s）；不够就返回 `SUBMIT_BUDGET` 暂停。旧版把 `deadline-now-90000` 全给 pump，pump 吃满后排空预算恰好 ≈20000，被 `> 20000` 挡掉，**整段排空被静默跳过**。
- **外层放行必须等于内层可用**（小目录饿死，2026-11-11 实测 5 个 1-5 项目录全吃 `SUBMIT_BUDGET`）：尾巴闸门用 `H.tailReserve(total)`，它的地板与内层同源——`H.smallBudget()` 返回 `{safety 12s, reserve 20s, minPump 30s, slack 8s, window 70s}`。跑一屏装得下的小目录（`pgTot <= 120`）时把这三个数透传进 `H.submitAndDrain(node, total, dl, phase, { atReady: true, safety, reserve, minPump })`，它会继续把 `safety` 传给 `H.drainNode`（否则那里的 90s 死扣会把排空预算削成负数）。**不传 opts 的调用方口径不变**。
- 排空结果写进 `res2[id].drain = {reason, loaded, all, bad, waited, at}`；`stalled/timeout` 记入 `retry` 留给第二遍复检。提交后先在 `needDrain[id]` 落标记再排空，中途抛错或 kernel 被回收，下一格进入该目录时会**先补排空**（`tree-redrain-*` 检查点）。
- **第二遍扫描 / 假干净审计用 `H.p2Pass(opts)`**，别在 cell 里手贴循环（历史上尾巴常量抄错过一次，白烧一格）：
  ```js
  var ids = bigFirst.slice(0, 456);          // 调用方决定顺序与候选；缺省 = 全部 folders 按 id 升序
  var rep = await H.p2Pass({ ids: ids, deadline: Date.now() + 520000, cleanMark: 3, tag: 'p2-audit' });
  nodeRepl.write(JSON.stringify(rep));
  ```
  `cleanMark` 是判干净时写的值（主扫描 1、审计通过 3），跳过条件同为「等于 cleanMark」（主扫描可传 `skip: id => !!L.p2.done[id]`，把 1/2/3 都算已覆盖）。目录内自动：安定闸门 → 脏则按 `tailReserve`/`bigGate` 判尾巴 → `submitAndDrain`（小目录透传 `smallBudget`）→ converted+整页渲染满直接采信，否则导航复验 → 没收敛就 `retry++` 并 `delete` 标记（退回主扫描，**绝不保留假干净**），满 6 次标 `2`。返回 `{seen,skipped,wasClean,falseClean,repaired,stillBad,pending,tailSkip,starved,rounds,sent,trusted,reVer,deep,deepClean,gaveUp,pauses,samp,errs,needDrain,totSent,p2all,persist,ms}`。
- **首轮由老引擎跑完的台账（`res2` 有 converted/empty 证据、但 `p2.done` 是空的）先播种再清扫**，否则整年重扫一遍（2026 实测 1212 个目录里 353 个可直接采信，省 3–4 小时）：
  ```js
  L.p2 = L.p2 || {}; L.p2.done = L.p2.done || {};
  Object.keys(L.folders).forEach(function (k) {
    var d = (L.res2[k] || {}).drain, tot = (L.folders[k] || {}).total || 0;
    if (!d || (d.reason !== 'converted' && d.reason !== 'empty')) return;
    if (tot > 0 && (d.all || 0) < tot) return;     // 证据只盖渲染窗口就不采信（窗口可低到 81，82 项目录同样中招）
    if (!L.p2.done[k]) L.p2.done[k] = 3;           // 3=证据/审计采信，1=二轮亲验，2=六次仍坏
    if (L.needDrain) delete L.needDrain[k];        // 债已还：销掉残留欠账
  });
  await H.persist('p2-seed');                      // 播种先落盘，kernel 回收也不丢
  var keys = Object.keys(L.folders).sort(function (a, b) { return (+a) - (+b); });
  var big = keys.filter(k => (L.folders[k].total || 0) > 120), rest = keys.filter(k => (L.folders[k].total || 0) <= 120);
  var order = big.concat(rest);                    // 大目录(>120)优先，其余 id 升序：跨格稳定、可续跑
  var rep = await H.p2Pass({ ids: order, cleanMark: 1, skip: function (id) { return !!L.p2.done[id]; },
    deadline: Date.now() + 520000, tag: 'p2-2026' });
  ```
  `skip` 必须传：默认跳过条件是 `=== cleanMark`，播种写的 `3` 会被当成未覆盖重扫。残留 `needDrain` 不清，汇总会永远挂假「待补排空」，日后 processTree 重入还要白烧一次 drainNode。一格跑不完就自己算 `leftAfter`（`folders` 里没标记的个数，`rep` 不含这个字段），同 turn 紧接着重发同一格即可，播种是幂等的。播种采信的是**首轮证据**，首轮之后新增的条目不在覆盖内。上面那条 `d.all < tot` 会连「条目+子目录」的混合容器一起拒掉（`total` 含子目录卡片、`drain.all` 只数图片瓦片）—— 宁可重扫也不假干净。**要全量现验就别播种，优先走 API 逐项 HEAD 的全树复查**（`references/recheck-recipe.md`，实测 1257 目录 / 20707 条约 7.5 分钟，比 DOM 二轮的小时级又快又准）；非要用 DOM 二轮扫全部就 `cleanMark:1`，且 `p2.done` 已满时得显式传 `skip: function(){ return false; }`（默认跳过条件只看 `=== cleanMark`）。
- **页项数超过渲染窗口的目录不能用安定闸门判干净（与 `total>120` 无关：82 项 / 窗口 81 同样中招）**：`st.all` 永远到不了 `total`，会被一路 strike 到 `p2=2`（误报仍坏；实测 2238/2696 深度扫 `broken=0`、连一次提交都不需要）。`H.p2Pass` 对这种目录（`capped = st.all + folders < 页项数`）改走 `H.audit(id, maxPages=12)`（PageDown 滚动 + 按条目 id 去重，报 `{swept,broken,noSrc,videos}` 并写 `L.aud[id]`）：`broken===0` 判干净且不记 strike；`broken>0` 才提交排空，收口仍以深度扫为准；深度扫顺带回答「剩下的是不是视频」。大目录一轮 `converted` 就 break（pumpX2 内部已扫过多窗口），别机械跑满 4 轮 —— 4×180s 排空会吃光一格。一屏装得下的目录不许滚动。
- **`broken===0` 只有在 `swept >= 页项数` 时才是全目录结论**：引擎的 capped 分支**不查覆盖率**（`ok = deep.broken === 0`），窗口缩到 81–143 张时，它会把只核验了这部分条目的 242 项目录标成干净。跑完先核对 `L.aud[id].swept` 与 `folders[id].total`，`swept < total` 不许写成「0 坏图」。
- **要全目录结论就用 API 逐项审计（2026-11-11 实测，18 个大目录 3006 条全核完）**：共享空间的 `SYNO.FotoTeam.Browse.Item` **返回 JSON**（此前「`SYNO.Foto.Browse.Item` 直取返回 HTML、此路未通」说的是个人空间接口，别套到共享空间）。在页面上下文里：

  ```js
  // POST /webapi/entry.cgi/SYNO.FotoTeam.Browse.Item
  //   api=SYNO.FotoTeam.Browse.Item&method=list&version=7&folder_id=<id>
  //   &additional=["thumbnail"]&sort_by="takentime"&sort_direction="asc"&offset=N&limit=100
  // 头：content-type: application/x-www-form-urlencoded; charset=UTF-8
  //     x-syno-token: <URL 里的 SynoToken，或现抄一条同类请求的头>
  // 分页到返回条数 < 100；按 id 去重（takentime 相同的条目跨页会重复）
  // cache_key 取自 item.additional.thumbnail.cache_key（encodeURIComponent 后放进 %22…%22）
  // 逐条 HEAD /synofoto/api/v2/t/Thumbnail/get?id=<id>&cache_key=%22<cache_key>%22
  //   &type=%22unit%22&size=%22sm%22&SynoToken=<tok>   → 404=缺，200=有；size="xl" 同法
  ```

  **元数据 `additional.thumbnail.sm` 不可信**：2696/2702 各有 40/130 条写 `ready`，HEAD 实际 404。判坏必须实测 URL；HEAD 缺席时返回 404 + 12KB HTML（加 Range 也一样），不用读 body。并发 8 时 ~100 次 HEAD/秒，271 条约 5.5s。
- **尾部坏图修复配方（实测 2696/2702/7439）**：把「排序方式 → 降序」切一下，按拍摄时间排序的尾巴就变成窗口头部（2696 的 40 条坏图一次全进窗口）。然后一次 evaluate 点掉窗口内所有 broken 卡片的 `select-button`（相当于批量 `H.selTap`，别逐张往返）→ `H.genToolbar()` 点工具条「生成预览」→ `H.drain` 等 `loaded>=all`。窗口装不下的坏图用 `H.pageDown()` 翻页再选（2702 三批 81+36+13，合计 ~184s）。修完必须用上面的 HEAD 逐项复验，**别只看 `bad=0`**。注意：右键菜单/灯箱里的「生成预览」在扩展没被识别的窗口会弹 `external_convert_intro` 对话框（报「请先安装扩展」）；**工具条按钮才是可用路径**，转换中页面顶部会出现「Synology Image Assistant 正在生成预览图/压缩视频…」。
- **子目录枚举也必须走 API（2026-11-11 事故）**：`H.processTree` 旧版从一次 `domSnapshot` 切 `folder-draggable-zone-` 当子目录清单，而文件夹视图只挂载渲染窗口内的卡片 ⇒ **窗口外的子目录整支静默跳过，父目录照样标 done**。实测 7227：页面 `folders:90 / total:130`，台账里正好是 UI 排序的**前 90 个**、第 91 个起一个没有；漏掉的 40 支共 1289 条条目 **100% 缺缩略图**，而已访问的 90 支 2047 条 0 缺。同签名还有 2025 的 412（12/20）、2226（8/11）、2254（64/96）、2750（1/13）、4188（2/3）——递归展开后共 **3061 个目录 / 29925 条条目**没跑（清单见 `gap-audit-20261111.json`）。被跳过条目的 `indexed_time` 是 2026-11-02，早于跑批，**不是新上传**。
  现在：`H.listChildren(id)` 用 `SYNO.FotoTeam.Browse.Folder`（`method=list&version=2&id=<父>&offset&limit=100`）分页取全、按 id 去重；processTree 拿它当清单，快照只做交叉校验。接口失败 → 暂停 `CHILDREN_API`；快照里有 API 没返回的 id → 暂停 `CHILDREN_MISMATCH`；两者都不标 done。台账 `folders[id].kids` 记下枚举到的子目录数，便于事后对账。
  **查自己有没有中招**：从年度根目录用 Folder 接口**在页面上下文里一次递归枚举整棵树**，把得到的 id 集合与 `Object.keys(L.folders)` 求差集；差集非空就是有整支没跑。缺口是「前缀截断」（已记录的都是排序前 N 个）时基本可断定是这个 bug；只有零星新 id（如 32xxx）才是跑完之后新建的目录。**别在 node 侧逐目录调 `H.listChildren`**：每次调用一趟桥往返，1257 个目录 ≈ 42 分钟–2.8 小时；同样的 1257 次请求放在页内递归（并发 6）只要 **54s**。可跑模板见 `references/recheck-recipe.md`。
  **差集非空怎么补跑**：单位是「最小根集」= parent 不在 missing 里的那些 id（`H.missingRoots(parents, missing)`，孤儿也当根），从这些根进去恰好覆盖 missing 含孙目录；一格一个根调 `H.processTree(root, {path, deadline, fresh})`，`path` 沿 API 父链拼**真实名字**（别用 `'<年度目录名>/'+id` 合成，`folders[id].name` 是报告与对账依据）。实测 2026 的 5 个 missing → 4 个根（32342 是 32341 的子目录）。**别删年度根 `vDone` + `fresh:true`**（整年重跑十几小时），也别逐个 missing id 调（公共祖先重复跑）。选入口看根下已完成后代的比例：`processTree` **不按 `vDone` 跳过已完成后代**，根下大多已完成时改用 `p2Pass({ids})` 只跑缺的叶子；但 `p2Pass` 不递归、不建档（跑完差集依旧非空），**整支没跑必须走 processTree**。续跑同根 `fresh:false`，栈非空且栈底是别的根时先跑完那个根。模板见 Cell 4。
- **页面上下文调 WebAPI 的两个 shim 坑**：`H.apiPost(api, params)` 已封装（自动从 `performance` 资源 URL 里抓 `SynoToken`，803 时重读一次再试）。① `page.evaluate` 恒返回 null，必须 `locator('body').evaluate`；② **这个 shim 会丢掉 evaluate 的第二个参数**（实测传 `{hello:1}` 页面里收到 `{}`，循环 0 次却不报错），所以数据要**内联进函数源码字符串**：`evaluate('(async function(){ var ids = ' + JSON.stringify(ids) + '; … })')`。字符串形式必须是「求值后是一个函数」，写成 IIFE `(function(){…})()` 会被拒（`Locator evaluation source must evaluate to a function`）。
- **「零提交却标 done」事故（2026-11-11，7227 补跑第一批 7333/7335/7336）**：台账 `res2 = {sent:0, batches:0, blocked:'budget', stillBadWindow:30/41/28, clean:false, done:false, elapsed:41678}`，而 `vDone = {done:true}`；HEAD 逐项复验 **30/30、41/41、28/28 全缺**。两条根因叠加：
  ① **预算饿死**：processTree 自己先花 ~41.6s 过导航+渲染闸门，再按大目录口径（`safety 90s + reserve 120s`）切预算，300s 的格子只剩 **48.3s** 给 pump；pumpX2 又自己重导航一次（没传 `atReady`），前置 41.6s > 预算闸 `budgetMs-20000 ≈ 28s` ⇒ **第一批都没提交就 `blocked:'budget'`**。
  ② **假完成**：`submitAndDrain` 把 `sent=0` 一律当没事返回 `pause:null`，processTree 叶子分支无条件写 `done:true`。
  现在：`H.treeSubmitOpts(total)` 给 enter/exit 统一口径 —— 一律 `atReady:true`（上层刚拍过快照，别再导航），`total<=120` 透传 `smallBudget` 的 safety/reserve/minPump，大目录保持默认；`submitAndDrain` 零提交时只有 `clean:true` 才放行，否则返回 **`SUBMIT_BLOCKED`** 暂停。修完同样预算下 pump 拿到 226s（> 61.7s 饿死阈值）。
  **自查用 `H.falseMarks(L, {head, kids})`，别只用 `sent===0 && clean===false`**：后者只抓「零提交却标 done」这一类，抓不到 7979 那种**证据只盖渲染窗口**的假完成（82 项、窗口 81、`drain:converted`、`p2.done=1`，窗外第 82 条 HEAD sm 实测 404）。撤销走 `H.revokeFalseMarks({head, kids})`：内部已 `force:true`（撤销让内存 `vDone` 变少，必然撞回归保护），**必须查返回的 `ok===true`** —— 被拒时 `persist` 返回字符串而不是抛错，下一次 `load` 又把假标记读回来。它只删 `vDone`/`p2.done`，保留 `res2`/`retry`/`L.aud` 等历史证据，给 `sent>0` 却无 `drain` 的目录补 `needDrain` 欠账；`p2.done=2`（六次仍坏，已知坏不是假干净）与证据不足的 `unknown` 桶不动，**也别手动删年度根的 `vDone`**（那等于整年重跑）。
  `head` 是逐项 HEAD 结果（`recheck.json` 的 `res`，**必须盖上修复后的 `repair.dirRecheck` / `newDirsAudited`**，否则已修好的目录被再撤销一次），`kids` 从 API 父链数出来：台账 1257 条里只有 45 条记了 `kids`，把 `total` 当图片数会把纯容器 7227（130 全是子目录、连 `res2` 都没有）误判成「130 张图全无证据」。实测同一份台账：喂 head+kids 报 **1** 个（正是 7979），只喂 kids 报 23 个、什么都不喂报 14 个且 857 个判不了 ⇒ 按 DOM/台账证据撤销会误撤销 22 个。四个桶（bad/trusted/unknown/gaveup）的判据与可跑模板见 `references/recheck-recipe.md` Cell 5。
- **台账附加字段必须落盘（2026-11-11 发现的证据丢失）**：旧 `H.persist` 只写一份固定白名单，`L.apiAudit` / `L.repair` / `L.apiAuditMeta` 这类审计证据**从未落盘**（#14 的 3006 条逐项 HEAD 结果在主台账和两个 `.bak` 里都查不到，只剩报告正文）。现在白名单之外的自有字段一律当附加证据一起写盘、`load` 时读回；`__` 前缀的内部状态和 `tr` 内存日志仍不落盘；换台账时附加字段一并清零（防串任务）。**审计结论务必同时写一份独立 JSON**（如 `gap-audit-*.json`），别只挂在台账上。
- 回归测试：`scripts/` 下 19 个 `test_*.mjs`，`for f in test_*.mjs; do node $f; done` 全绿 **199 例**（2026-11-11 实测）：boot_adopt 7、children 9、drain 14、drain_loop 12、fast 10、p2_pass 16、persist_atomic 3、persist_extra 6、persist_p2 7、**publish_hygiene 11**（发布卫生：无个人路径/IP/业务地名、测试相对 import、host 必填闸、文档一致性）、render_gate 10、revoke_marks 33、sel 4、settle 9、submit_drain 17、summarize 8、tail_reserve 6、toolbar_gen 7、tree_false_done 10。改引擎前先跑它们，改完再跑一遍；**发布前还要把整个目录复制到别的路径再跑一遍**（验证换机可跑）。

**与旧模式的区别**：不再需要先遍历全树建 vQueue 再跑 workerX2。processTree 边发现边处理，适合深层目录树（3-4 层、数百个子目录）。旧的 `workerX2` + `pumpX2` 仍可用于已知叶子目录的批量提交或补提。

## 台账隔离与安全闸（2026-11-08 事故后必读）

一次事故：kernel 被回收后重装库，cell 里把 `H.boot()` 写在 `H.load()` 前面；boot 因浏览器连接未就绪抛错，load 没执行，随后的批次用 import 时创建的空 `L` 跑。processTree 进 414 时页面还没渲染出子目录，就把 414 当成叶子目录标 `done`，接着开跑 2025，每次 `persist` 都把 2026 的真台账覆盖掉（5178 条提交记录、678 个 vDone 目录全丢；NAS 上已生成好的预览不受影响）。

现在的防护：

- **一任务一台账**：`ledger-2026.json` / `ledger-2025.json` 分开。切换任务时改 `globalThis.__CFG.ledger`，再 `H.load()`，确认 loaded 和目录数对得上。
- **启动只用 `H.ready()`**：它先 `load()`（不依赖浏览器）再 `boot()`（失败只记录不抛），返回 `ok:true` 才允许跑批量。**永远不要把 `boot()` 放在 `load()` 前面。**
- **persist 回归保护**：盘上 `vDone` 比内存多 5 个、或 `totSent` 多 50 以上时拒绝覆盖，转存为 `<台账>.conflict-<时间戳>`；正常覆盖前留 `<台账>.bak`，**但 `force:true` 走的是另一条分支、不写 `.bak`** —— 撤销假标记前自己 `copyFileSync` 留一份 `.before-revoke`。确需重置时显式传 `{ force:true }`。**被拒时返回的是 `'PERSIST_REFUSED …'` 字符串，不是抛错** —— 凡是要减少 `vDone` 的操作（撤销假标记、重置任务）都必须 `force:true` 并检查返回值 `=== true`，否则静默不生效，下一次 `load` 把盘上的旧标记读回来（p2 游标取盘/内存里键多的那一份）。`H.revokeFalseMarks` 内部已 force，调用方只看它的 `ok`。
- **processTree / revokeFalseMarks 安全闸**：没调用过 `H.load()`（缺 `L.__loadedAt`）直接返回 `LEDGER_NOT_LOADED`（撤销返回 `{ok:false, err:'LEDGER_NOT_LOADED'}`，不动内存也不动盘）。空 `L` 配 `force:true` 会绕过回归保护把真台账洗成空，所以这道闸在撤销里同样必须有。
- **导航校验**：进目录后检查 URL 是否含 `/folder/<id>`，不匹配重试一次，仍不匹配返回 `NAV_MISMATCH` 并暂停，绝不把「没渲染完」当成「空目录已处理」。

## 无人值守连续跑（多任务自动衔接）

用户要求「自己自动跑、中间不要断」时，**先读 [references/runbooks.md](references/runbooks.md) 的「无人值守连续跑」节**，按其中的 cell 循环模板执行（每个 cell 对每个任务只调一次 processTree，`paused` 立即收尾、同 turn 紧接下一格）。三条铁律（都曾造成整 cell 空转，完整解释见 runbooks）：

1. **deadline 对齐**：给 processTree 传 `cellDeadline - 15000`；**绝不**外套 `while` 循环原地重试——第一次 paused 后 deadline 已过，后续每次调用都立即 paused，只刷台账不干活。
2. **完成标记**：跨 cell 判断任务完成看 `L.vDone[rootId].done`；栈空且没有完成标记时才用 `fresh: true` 开新树。
3. **栈归属**：续跑前确认 `L.treeStack[0].path`（栈底是根）属于当前任务；属于别的任务就跳过，让归属任务先跑完。

进度观测：长泵（pumpX2 预算最长 420s）期间台账数分钟不更新是正常的，不要误判为卡死。用 `node -e "require('<台账>')"` 读 `tag/totSent/treeStack.length` 看实时进度。

## 失败恢复

Chrome 重启、`TAB_NOT_OWNED`、kernel 回收、台账被覆盖、cell 中断的完整恢复步骤见 **[references/runbooks.md](references/runbooks.md) 的「失败恢复」节**。两条最常踩的：

- 启动永远先 `H.ready()`（load 先于 boot），确认台账 loaded 且目录数正常再跑；`var` 声明的 cell 内变量跨 turn 会丢，只有 `globalThis.__*` 能活。
- 整页导航后仍全 0、或 `emptyView:true` 与台账 `total>0` 矛盾 = **人工停机点**：让人手动刷新/重开该标签页，别原地循环 goto。

## Resources

- `scripts/synophotos_lib.mjs`：常驻 kernel 库（导航、快照解析、区间选择、生成预览、排空、配额退避、**深度优先递归处理 processTree**、逐目录引擎、台账持久化、**假完成标记检测/撤销 falseMarks·revokeFalseMarks 与补跑根集 missingRoots**）。作为 cell code 执行。
- `scripts/summarize_ledger.cjs`：读台账 JSON 输出统计（目录数、提交数、状态分布、剩余队列、stuckIds 按目录分组）。
- `references/dom-notes.md`：DOM 判据、配额与延迟实测数字、路由与根目录结构、已踩过的坑清单。
- `references/recheck-recipe.md`：**全树复查配方**（页内递归枚举对账 + 分块游标逐项 HEAD 审计 + 窗外缺失修复 + **missing 整支补跑入口 Cell 4** + **假标记检测与撤销 Cell 5** + 落盘口径），含可直接跑的 cell 模板与实测吞吐。要回答「这棵树是不是全都生成好了」、或要补跑漏掉的子树/撤销不可信的完成标记时读它。
- `references/runbooks.md`：**无人值守 cell 循环模板**（多任务自动衔接、三条铁律）与**失败恢复完整步骤**（Chrome 重启 / TAB_NOT_OWNED / kernel 回收 / 台账被覆盖 / cell 中断）。跑无人值守批量或从故障恢复时读它。
- `assets/icon.png`：skill 图标（1024×1024，照片墙 + 中心刷新箭头），供市场列表展示用，不参与运行逻辑。
