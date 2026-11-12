# Synology Photos 预览重建工具

## 📝 项目简介

这是一个用于批量修复群晖 Synology Photos 共享空间中损坏的缩略图和预览图的自动化工具。当遇到「图片预览不出来」、需要「重新生成预览」或者需要全树复查某个年份目录的预览状态时使用。

**重要说明**：此工具仅适用于已登录 NAS 并安装了 **Synology Image Assistant** 扩展的 Chrome 浏览器。预览转换在浏览器端完成，服务端不会自动修复。

## ✨ 主要功能

- **批量识别坏图**：自动检测网格中显示为损坏状态的图片/视频
- **批量生成预览**：通过工具栏批量提交预览生成任务
- **深度优先递归处理**：自动遍历目录树，处理所有子目录
- **进度持久化**：台账记录处理进度，原子落盘 + 坏文件自愈，支持断点续跑
- **配额管理**：自动处理每个共享空间最多 120 条任务的配额限制
- **前台闸**：页面不可见（切走 / 最小化 / 被完全遮挡）时不提交，避免白烧时间
- **弹窗护栏**：只关闭「配额」弹窗（按可见性 + 文案分类识别），删除/回收站等危险或未知弹窗一律不点按钮并停机回报；残留右键菜单必须关掉，避免误点「删除」
- **全树复查**：通过 API 逐项 HEAD 审计，确保所有预览都已生成
- **假完成标记检测**：识别并撤销错误标记为完成的目录
- **缺口补跑**：多根跨格游标 runner + 离线进度统计

## 🔧 系统要求

1. **Chrome 浏览器**已登录 Synology Photos
2. 安装 **Synology Image Assistant** 扩展
3. Node.js 环境（用于运行脚本）
4. 该扩展只在**前台可见**的页面里转换：判据是 `document.visibilityState === 'visible'`，不是「标签页被选中」。切到别的标签页、窗口最小化、**或被别的窗口完全遮挡**都会停止转换（Chrome 的 `CalculateNativeWinOcclusion` 会把被完全盖住的窗口判成 hidden）。批量期间不能关闭标签页；被遮挡时的处置见 `references/runbooks.md`「前台闸」节

## 📦 安装步骤

### 首次安装

1. **在 Qoder 的「技能」中安装**本 skill 的 `.zip` 包（zip 根目录为 `synology-photos-previews/`）

2. **配置参数**（优先级从高到低）：
   - 在装载库之前，在 cell 里设置：
     ```javascript
     globalThis.__CFG = {
       host: '<NAS地址>:<端口>',  // 必填，如 '192.168.1.100:5000'
       ledger: '<台账路径>'        // 可选，默认为 ~/Documents/synology-previews/ledger.json
     }
     ```
   - 或使用环境变量：`SYNOPHOTOS_HOST` / `SYNOPHOTOS_LEDGER`

3. **首次运行**时 `H.load()` 返回 `{loaded:false, reason:'no-ledger'}` 是正常的，说明还没有台账，可直接使用 `H.processTree(rootId)` 开始处理

## 🚀 快速开始

### 1. 装载核心库

在 `node_repl` 中装载 `scripts/synophotos_lib.mjs`：

```javascript
// 方式一：整份文件作为 cell code 提交
// （将 synophotos_lib.mjs 内容粘贴到 cell）

// 方式二：使用 import（需要先注入 browser-use）
globalThis.__bua = await import('@qoder-space/browser-use');
await import('file:///路径/synophotos_lib.mjs');

// 启动并接管标签页
await globalThis.__H.ready();
```

### 2. 确认选择器匹配

```javascript
// 验证页面元素选择器是否正常
await H.probe();
// 应返回当前页面的网格/坏图/选中节点计数
```

### 3. 定位目标目录

```javascript
// 先在树上核实根目录 id，别按年份猜（实测根 id 与直觉不符，目录名还可能含全角字符）
// 逐层进入目标路径，记录最终根目录 ID
await H.goto(id);
```

### 4. 开始批量处理

```javascript
// 深度优先递归处理整个目录树
var result = await H.processTree(rootId, {
  path: '<年度目录名>',
  deadline: Date.now() + 540000  // 9分钟超时
});

// 返回 {done: true} 表示完成
// 返回 {paused: true} 表示超时暂停，下次调用自动续跑
```

### 5. 生成处理报告

```bash
node scripts/summarize_ledger.cjs <台账.json>
```

## 📂 项目结构

```
synology-photos-previews/
├── SKILL.md                      # 详细技术文档
├── README.md                     # 本文件
├── scripts/
│   ├── synophotos_lib.mjs       # 核心库（导航、选择、提交、排空、前台闸、台账等）
│   ├── summarize_ledger.cjs     # 台账统计工具
│   ├── head_audit.mjs           # 单目录逐项 HEAD 审计（sm/xl）
│   ├── gap_runner.mjs           # 多根缺口补跑的跨格游标 runner
│   ├── gap_progress.cjs         # 离线读补跑进度（不依赖浏览器）
│   └── test_*.mjs               # 测试套件（24个测试文件，共288个测试用例）
├── references/
│   ├── dom-notes.md             # DOM判据、配额与延迟实测、已知问题清单
│   ├── recheck-recipe.md        # 全树复查配方与模板
│   └── runbooks.md              # 无人值守模板、前台闸、cell 节奏与故障恢复
└── assets/
    └── icon.png                 # Skill 图标
```

## 🔍 核心概念

### 坏图判定

- **判定标准**：卡片内出现 class `synofoto-item-image-broken`
- **瞬时状态**：待处理期间显示为坏图，转换完成后批量恢复
- **适用类型**：照片和视频使用同一判定方式
- **另一类缺陷**：目录封面坏图（`synofoto-small-item-folder-item`）扩展修不了，要单列

### 渲染窗口

- Synology Photos 使用虚拟化渲染，只挂载窗口内的卡片
- 窗口容量不固定：实测为 81-198 张，随视口变化
- 超出窗口的条目不会出现在 DOM 中，所以 `bad=0` / `loaded>=all` / `drain:converted` 都**只是窗口内结论**；全目录结论只有 API 逐项 HEAD

### 配额限制

- **每个共享空间最多 120 条待处理预览任务**
- 超限会整批拒绝（不是部分成功）
- 工具会自动进行空间级排空等待

## ⚠️ 重要注意事项

### 关键判读规则

1. **`broken` 是瞬时状态**：提交后仍显示坏图≠失败，要等转换完成再判断
2. **刚进目录时 `bad=0` 不等于干净**：broken class 需要等图片请求超时才会挂上（约2-3秒）
3. **完成判据是 `loaded >= all`**，不是 `bad === 0`
4. **安定判据是 `all + folders >= total`**：`total` 含子目录卡片，只比 `all` 会把「少照片+多子目录」的目录永远判不安定
5. **子目录清单必须用 API**：使用 `H.listChildren(id)` 获取完整子目录列表，不能依赖快照
6. **页面不可见就不提交**：每格开跑前过 `H.foregroundGate()`，返回 `tab-hidden` 立即收尾回报

### 安全机制

- **台账隔离**：一个任务一个台账文件（如 `ledger-2026.json`）
- **原子落盘**：先写 `<台账>.tmp` 再 `renameSync`，别的读者不会读到半截 JSON
- **坏文件自愈**：主文件坏/缺而 `.bak` 可读时用 `.bak` 修好并恢复游标；两个都坏返回 `reason:'corrupt'` 并清零内存
- **回归保护**：防止误覆盖已有的处理记录
- **导航校验**：确保页面确实跳转到目标目录
- **渲染闸门**：确保网格内容渲染完成才开始处理

### 启动规范

**永远使用 `H.ready()` 启动**，它会先加载台账再连接浏览器：

```javascript
await H.ready();  // ✅ 正确：load 先于 boot
```

放行判据 = `load.loaded === true` 且目录数对得上，再要 `ok:true`。**`ok:false` 但 `boot.adopted` 为真、`H.probe()` 能读到卡片时同样可用** —— `ready().ok` 只认 `claimed || created`，adopted 不算 ok 是库的判据漏项，别为它反复重启浏览器。

❌ **不要**把 `H.boot()` 放在 `H.load()` 前面

## 📊 处理流程

```
启动 H.ready()
    ↓
确认选择器 H.probe()
    ↓
前台闸 H.foregroundGate()
    ↓
定位根目录 H.goto(id)
    ↓
深度优先递归 H.processTree(rootId)
    ├─ 进入目录
    ├─ 提交当前坏图
    ├─ 等转换完成 (drain)
    ├─ 递归所有子目录
    ├─ 回来复检
    └─ 返回上级
    ↓
生成报告 summarize_ledger.cjs
```

## 🔄 断点续跑

工具支持断点续跑：

1. `processTree` 返回 `{paused: true}` 表示超时暂停
2. 下一个 cell 中重新 `H.ready()` 加载状态
3. 再次调用 `H.processTree(rootId, {deadline})` 自动从断点继续

```javascript
// Cell 1
var result = await H.processTree(rootId, {
  path: '<年度目录名>',
  deadline: Date.now() + 540000
});
// 返回 {paused: true, remaining: 100}

// Cell 2（新的 turn）
await H.ready();  // 加载台账恢复状态
var result = await H.processTree(rootId, {
  deadline: Date.now() + 540000
});
// 从断点继续
```

## 🔬 测试

项目包含完整的测试套件（24个测试文件，共288个测试用例）：

```bash
# 运行所有测试
cd scripts
for f in test_*.mjs; do node $f; done
```

| 套件 | 覆盖 | 例数 |
|---|---|---|
| boot_adopt | 启动与接管 | 7 |
| children | 子目录枚举（API 分页） | 9 |
| doc_coverage | 实测规则是否写进手册 | 29 |
| drain | 排空判据 | 14 |
| drain_loop | 排空循环 | 12 |
| fast | evaluate 快原语 | 10 |
| gap_ops | 补跑根集、runner 判据与收尾日志 | 26 |
| gap_progress | 离线进度统计 | 6 |
| head_audit | 逐项 HEAD 审计 | 8 |
| p2_pass | 二轮扫描 | 16 |
| persist_atomic | 原子落盘与坏文件自愈 | 3 |
| persist_extra | 附加证据落盘 | 6 |
| persist_p2 | 二轮游标落盘 | 7 |
| publish_hygiene | 发布卫生检查 | 11 |
| render_gate | 渲染闸门 | 10 |
| revoke_marks | 假标记撤销 | 33 |
| sel | 选择与计数 | 4 |
| settle | 安定闸门 | 9 |
| submit_drain | 提交与排空预算 | 19 |
| summarize | 汇总口径 | 8 |
| tail_reserve | 尾巴预算 | 6 |
| toolbar_gen | 工具条生成预览 | 7 |
| tree_false_done | 树处理假完成检测 | 10 |

**改引擎或改文档都要跑**（`doc_coverage` 会红）。
**发布前必须**：把整个目录复制到别的路径再跑一遍测试，验证换机可跑。

## 📖 进阶功能

### 全树复查

当需要确认「某年目录的预览都生成好了」时，使用全树复查：

1. 页内递归枚举整树 → 与台账求差集
2. 逐目录 API 取全部条目 + 每条 HEAD `sm`/`xl`
3. 只对实测 404 的目录修复，修完再逐项 HEAD 复验

通过判据：`smBad=0 && xlBad=0 && errs=0 && nock=0` 且审计目录数 = 枚举目录数

详见：`references/recheck-recipe.md`

### 缺口补跑（整支子目录没跑）

差集非空时按「最小根集」补跑，别逐个 id、也别删年度根标记整年重跑：

```javascript
await import('file:///路径/scripts/gap_runner.mjs');   // 只定义全局函数，不自动跑
await globalThis.__gapRun({
  plan: globalThis.__plan,                  // 来自独立落盘的计划 JSON
  log: '<工作目录>/run-<任务>-<日期>.jsonl',
  cellMs: 565000, waitVis: 240000
});
```

```bash
node scripts/gap_progress.cjs <run.jsonl> <ledger.json> <plan.json>
```

`__gapRun` 的**任何出口都写恰好一行 `stop` 日志**（`all-done` / `cell-budget` / `paused` / `tab-hidden` / `stack-other-root` / `err` / `loop-cap` / `LEDGER_NOT_LOADED` / `NO_PLAN`）。**收尾信号 = 含 `stop` 的那一行**（逐根 `{root,…}` 行是格子中途写的，别当收尾去 wait，否则会打断 cell）；判完成看 `stop:'all-done'` 且 `rootsLeft === 0`。
`gap_progress` 的字段口径：`cells` = 已收尾格数（数 stop 行）、`lines` = 日志行数、`stops` = stop 行数；`perRoot[].cells` 是该根被几格碰过，不是总格数。

详见：`references/recheck-recipe.md` Cell 4 与 `references/runbooks.md`

### 假完成标记检测与撤销

自动检测并撤销不可信的完成标记：

```javascript
// 检测假标记（必须喂 head/kids 证据，否则会误撤销）
var marks = H.falseMarks(L, {head, kids});

// 撤销假标记
var result = await H.revokeFalseMarks({head, kids});
// 必须检查 result.ok === true
```

详见：`references/recheck-recipe.md` Cell 5

### 无人值守连续跑

支持多任务自动衔接，详见 `references/runbooks.md`

五条铁律：
1. **deadline 对齐**：给 processTree 传 `cellDeadline - 15000`，`paused` 后绝不原地重试
2. **完成标记**：跨 cell 判断看 `L.vDone[rootId].done`
3. **栈归属**：续跑前确认 `L.treeStack[0].path` 属于当前任务
4. **前台闸**：页面不可见就收尾，绝不提交
5. **wait 时机**：`node_repl_wait` 只能在格子**已跑完**时调（运行中调会报 `CAPABILITY_NOT_NEGOTIATED` 并打断 cell）；节奏是「发格 → 等日志出现含 `stop` 的新行 → wait 取结果 → 同 turn 立刻发下一格」（逐根 `{root,…}` 行是格子中途写的，不算收尾）

## 🛠️ 故障恢复

遇到以下情况的完整恢复步骤见 `references/runbooks.md`：

- Chrome 重启 / 只剩门户标签（boot 报 ambiguous）
- `TAB_NOT_OWNED` 错误
- CDP 整格卡死（`Tool command waited too long in queue`）
- Kernel 被回收
- 台账被覆盖或读不出来（`reason:'corrupt'`）
- Cell 中断

**四条最常踩的坑**：
1. 启动永远先 `H.ready()`，确认台账 loaded 且目录数正常再跑
2. `var` 声明的 cell 内变量跨 turn 会丢，只有 `globalThis.__*` 能活
3. CDP 整格卡死是**人工停机点**：请人刷新/重开该标签页，重试与新建会话都无效
4. 台账 `corrupt` 先手工救最新的 `.bak` / `.conflict-*`，别直接重跑整轮、也别带空内存跑批量

## 📈 性能数据

- **单次 DOM/点击往返**：2-8 秒
- **`PW().waitForTimeout(ms)`**：单次往返约 4.6 秒，等待改用本地 `H.sleep(ms)`
- **每目录地板耗时**：约 25-40 秒
- **转换速率（扩展端侧）**：约 0.5 张/秒（实测硬下限）；干净目录 ~4s、有坏图目录 30-65s
- **逐张点选平均耗时**：6.7 秒/张
- **区间选择**：实测精确且快速（推荐方式）
- **API HEAD 并发**：约 100 次/秒（并发8）
- **全树复查实测**：1257 目录 / 20707 条约 7.5 分钟

## 📄 许可证

本项目为内部工具，请勿用于商业用途。

## 🤝 贡献

本项目为 Skill 工具包，修改前请：
1. 先运行所有测试确保通过
2. 修改后再次运行测试（改文档也要跑）
3. 阅读 `SKILL.md` 了解完整技术细节

## 📚 相关文档

- **SKILL.md** - 完整技术文档（必读）
- **references/dom-notes.md** - DOM 判据与实测数据
- **references/recheck-recipe.md** - 全树复查配方与模板
- **references/runbooks.md** - 无人值守、前台闸、cell 节奏与故障恢复

---

**最后更新**：2026-11-12  
**版本**：1.0.1
