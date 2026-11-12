# Synology Photos 预览重建工具

## 📝 项目简介

这是一个用于批量修复群晖 Synology Photos 共享空间中损坏的缩略图和预览图的自动化工具。当遇到「图片预览不出来」、需要「重新生成预览」或者需要全树复查某个年份目录的预览状态时使用。

**重要说明**：此工具仅适用于已登录 NAS 并安装了 **Synology Image Assistant** 扩展的 Chrome 浏览器。预览转换在浏览器端完成，服务端不会自动修复。

## ✨ 主要功能

- **批量识别坏图**：自动检测网格中显示为损坏状态的图片/视频
- **批量生成预览**：通过工具栏批量提交预览生成任务
- **深度优先递归处理**：自动遍历目录树，处理所有子目录
- **进度持久化**：台账记录处理进度，支持断点续跑
- **配额管理**：自动处理每个共享空间最多 120 条任务的配额限制
- **全树复查**：通过 API 逐项审计，确保所有预览都已生成
- **假完成标记检测**：识别并撤销错误标记为完成的目录

## 🔧 系统要求

1. **Chrome 浏览器**已登录 Synology Photos
2. 安装 **Synology Image Assistant** 扩展
3. Node.js 环境（用于运行脚本）
4. 该扩展只在**活跃标签页**里转换，批量期间不能关闭标签页

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
// 逐层进入目标路径，记录最终根目录 ID
await H.goto(id);
```

### 4. 开始批量处理

```javascript
// 深度优先递归处理整个目录树
var result = await H.processTree(rootId, {
  path: '影像资料-2026年',
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
│   ├── synophotos_lib.mjs       # 核心库（导航、选择、提交、排空、台账等）
│   ├── summarize_ledger.cjs     # 台账统计工具
│   └── test_*.mjs               # 测试套件（19个测试文件，共199个测试用例）
├── references/
│   ├── dom-notes.md             # DOM判据、配额实测、已知问题清单
│   ├── recheck-recipe.md        # 全树复查配方与模板
│   └── runbooks.md              # 无人值守运行模板与故障恢复步骤
└── assets/
    └── icon.png                 # Skill 图标
```

## 🔍 核心概念

### 坏图判定

- **判定标准**：卡片内出现 class `synofoto-item-image-broken`
- **瞬时状态**：待处理期间显示为坏图，转换完成后批量恢复
- **适用类型**：照片和视频使用同一判定方式

### 渲染窗口

- Synology Photos 使用虚拟化渲染，只挂载窗口内的卡片
- 窗口容量不固定：实测为 81-198 张
- 超出窗口的条目不会出现在 DOM 中

### 配额限制

- **每个共享空间最多 120 条待处理预览任务**
- 超限会整批拒绝（不是部分成功）
- 工具会自动进行空间级排空等待

## ⚠️ 重要注意事项

### 关键判读规则

1. **`broken` 是瞬时状态**：提交后仍显示坏图≠失败，要等转换完成再判断
2. **刚进目录时 `bad=0` 不等于干净**：broken class 需要等图片请求超时才会挂上（约2-3秒）
3. **完成判据是 `loaded >= all`**，不是 `bad === 0`
4. **子目录清单必须用 API**：使用 `H.listChildren(id)` 获取完整子目录列表，不能依赖快照

### 安全机制

- **台账隔离**：一个任务一个台账文件（如 `ledger-2026.json`）
- **回归保护**：防止误覆盖已有的处理记录
- **导航校验**：确保页面确实跳转到目标目录
- **渲染闸门**：确保网格内容渲染完成才开始处理

### 启动规范

**永远使用 `H.ready()` 启动**，它会先加载台账再连接浏览器：

```javascript
await H.ready();  // ✅ 正确
// 确认返回 {ok: true} 才允许跑批量
```

❌ **不要**把 `H.boot()` 放在 `H.load()` 前面

## 📊 处理流程

```
启动 H.ready()
    ↓
确认选择器 H.probe()
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
  path: '影像资料-2026年',
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

项目包含完整的测试套件（19个测试文件，共199个测试用例）：

```bash
# 运行所有测试
cd scripts
for f in test_*.mjs; do node $f; done

# 测试覆盖：
# - boot_adopt: 启动与接管（7例）
# - children: 子目录枚举（9例）
# - drain: 排空判据（14例）
# - p2_pass: 二轮扫描（16例）
# - persist: 持久化安全（16例）
# - publish_hygiene: 发布卫生检查（11例）
# - render_gate: 渲染闸门（10例）
# - revoke_marks: 假标记撤销（33例）
# - submit_drain: 提交与排空（17例）
# - tree_false_done: 树处理假完成检测（10例）
# 等...
```

**发布前必须**：把整个目录复制到别的路径再跑一遍测试，验证换机可跑。

## 📖 进阶功能

### 全树复查

当需要确认「某年目录的预览都生成好了」时，使用全树复查：

1. 页内递归枚举整树 → 与台账求差集
2. 逐目录 API 取全部条目 + 每条 HEAD `sm`/`xl`
3. 只对实测 404 的目录修复，修完再逐项 HEAD 复验

通过判据：`smBad=0 && xlBad=0 && errs=0 && nock=0` 且审计目录数 = 枚举目录数

详见：`references/recheck-recipe.md`

### 假完成标记检测与撤销

自动检测并撤销不可信的完成标记：

```javascript
// 检测假标记
var marks = H.falseMarks(L, {head, kids});

// 撤销假标记
var result = H.revokeFalseMarks({head, kids});
// 必须检查 result.ok === true
```

详见：`references/recheck-recipe.md` Cell 5

### 无人值守连续跑

支持多任务自动衔接，详见 `references/runbooks.md`

三条铁律：
1. **deadline 对齐**：给 processTree 传 `cellDeadline - 15000`
2. **完成标记**：跨 cell 判断看 `L.vDone[rootId].done`
3. **栈归属**：续跑前确认 `L.treeStack[0].path` 属于当前任务

## 🛠️ 故障恢复

遇到以下情况的完整恢复步骤见 `references/runbooks.md`：

- Chrome 重启
- `TAB_NOT_OWNED` 错误
- Kernel 被回收
- 台账被覆盖
- Cell 中断

**两条最常踩的坑**：
1. 启动永远先 `H.ready()`，确认台账 loaded 且目录数正常再跑
2. `var` 声明的 cell 内变量跨 turn 会丢，只有 `globalThis.__*` 能活

## 📈 性能数据

- **单次 DOM/点击往返**：2-8 秒
- **每目录地板耗时**：约 25-40 秒
- **逐张点选平均耗时**：6.7 秒/张
- **区间选择**：实测精确且快速（推荐方式）
- **API HEAD 并发**：约 100 次/秒（并发8）
- **全树复查实测**：1257 目录 / 20707 条约 7.5 分钟

## 📄 许可证

本项目为内部工具，请勿用于商业用途。

## 🤝 贡献

本项目为 Skill 工具包，修改前请：
1. 先运行所有测试确保通过
2. 修改后再次运行测试
3. 阅读 `SKILL.md` 了解完整技术细节

## 📚 相关文档

- **SKILL.md** - 完整技术文档（必读）
- **references/dom-notes.md** - DOM 判据与实测数据
- **references/recheck-recipe.md** - 全树复查配方与模板
- **references/runbooks.md** - 无人值守与故障恢复

---

**最后更新**：2024-11-11  
**版本**：1.0.0
