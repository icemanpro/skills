// 文档覆盖回归：把「实测出来的规则必须写进手册」变成可失败的断言。
// 背景（2026-11-12 审计）：引擎与现场笔记里已经验证过的 17 条规则，有相当一部分只活在
// 一次性 cell / 会话记忆里，手册没写 ⇒ 下一个 agent（或下一次内核回收后的自己）会重犯：
//   窗口被遮挡仍提交（白烧 115–180s/目录还挤占配额）、运行中调 wait 把 cell 打断、
//   安定判据写成 all>=total（少图多子目录的目录永远判不安定）、欠账不销/乱销……
// 这些是机械可检的，所以用断言钉住，而不是靠「记得写」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SKILL = read('SKILL.md');
const DOM = read('references/dom-notes.md');
const RUN = read('references/runbooks.md');
const REC = read('references/recheck-recipe.md');
const README = read('README.md');
const LIB = read('scripts/synophotos_lib.mjs');
const ALL = SKILL + DOM + RUN + REC;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

await test('A1 前台闸门：手册写明 visibilityState 与原生窗口遮挡，且给出可用的重启开关', () => {
  assert.ok(SKILL.includes('visibilityState'), 'SKILL.md 未写前台判据 visibilityState');
  assert.ok(ALL.includes('CalculateNativeWinOcclusion'), '未写 Chrome 原生窗口遮挡计算');
  assert.ok(RUN.includes('--disable-features=CalculateNativeWinOcclusion'), 'runbooks 未给实测有效的重启命令行');
  assert.ok(RUN.includes('tab-hidden'), 'runbooks 未写 tab-hidden 停机口径');
});

await test('A1 无效手段要写明无效（别让下一个 agent 再试一遍）', () => {
  assert.ok(DOM.includes('bringToFront'), 'dom-notes 未记 Page.bringToFront 这条路');
  assert.ok(DOM.includes('visibility.set(true)'), 'dom-notes 未记 SDK visibility 能力');
  assert.ok(/注册表[\s\S]{0,120}(不生效|无效)/.test(DOM + RUN), '未写明注册表策略实测不生效');
});

await test('A1 重启浏览器是人工动作：手册要写明不得自行重启（会关掉用户所有标签页）', () => {
  assert.ok(/(不得|不要|别)自行重启/.test(RUN),
    'runbooks 未禁止 agent 自行重启 Chrome —— 场景复测里 agent 明确说「我能否代跑重启，文档未覆盖」');
  assert.ok(/重启[\s\S]{0,200}(所有标签|全部标签|其它标签|其他标签)/.test(RUN),
    '未写明重启的代价：用户其它标签页/窗口会一起被关掉');
  assert.ok(/(最小化|挪开|移动)[\s\S]{0,80}(其它|其他)窗口/.test(RUN),
    '未写明也不许自行最小化/挪开用户的其它窗口来解遮挡');
  assert.ok(/(没回应|不回应|没回复)[\s\S]{0,160}(收尾|结束)/.test(RUN),
    '未写用户不回应时收尾回报、结束回合，别原地轮询 visibility');
});

await test('A2 cell 节奏：运行中调 wait 会打断 cell，收尾判定看日志新行', () => {
  assert.ok(RUN.includes('CAPABILITY_NOT_NEGOTIATED'), 'runbooks 未写 wait 的实测报错');
  assert.ok(RUN.includes('node_repl_wait'), 'runbooks 未写 wait 的正确时机');
  assert.ok(SKILL.includes('node_repl_wait'), 'SKILL.md 铁律摘要里缺 wait 时机');
  assert.ok(/jsonl[\s\S]{0,80}新行|新行[\s\S]{0,80}jsonl/.test(RUN), '未写「jsonl 出现含 stop 的新行 = 该格已收尾」');
});

await test('A2 收尾信号是「含 stop 的新行」：多根格中途也写 root 行，任何新行都算收尾会打断 cell', () => {
  const src = read('scripts/gap_runner.mjs');
  assert.ok(/results\.push\(rec\); log\(rec\);/.test(src), 'runner 不再逐根写日志了，本断言要跟着改');
  const cadence = RUN.split('## cell 节奏')[1].split('\n## ')[0];
  assert.ok(/stop/.test(cadence), 'cell 节奏节未把 wait 的触发信号限定为 stop 行');
  assert.ok(!/无条件成立/.test(cadence), 'cell 节奏节仍宣称「有新行=已收尾」无条件成立');
  assert.ok(/root[\s\S]{0,80}(中途|还在跑|仍继续|不是收尾)/.test(RUN), '未写明逐根 root 行是格子中途写的');
  assert.ok(!SKILL.includes('日志有新行 = 该格已收尾'), 'SKILL.md 仍写「任何新行=该格已收尾」');
  assert.ok(!README.includes('jsonl 出现新行 = 该格已收尾」无条件成立'), 'README 仍写「任何新行=已收尾」无条件成立');
});

await test('A2 外部中断不会有 stop 行：等待上限与 logErr 回退判据要写', () => {
  assert.ok(RUN.includes('logErr'), 'runbooks 未写日志写不进去（logErr）时收尾信号失效');
  assert.ok(/(被杀|中断|回合结束)[\s\S]{0,200}stop/.test(RUN), '未写外部中断（回合结束/运行中 wait/CDP 卡死）不会有 stop 行');
  assert.ok(/cellMs[\s\S]{0,160}(仍无|还没有|没出现|仍没有)/.test(RUN), '未给「等多久还没有 stop 行就按中断处置」的上限');
});

await test('D15 stack-other-root 判据 = 栈底不在本 plan；一格可推进多个根', () => {
  assert.ok(/if \(!hit\) return \{ err: 'stack-other-root'/.test(LIB), 'gapNextRoot 判据变了，文档断言要跟着改');
  assert.ok(/栈底[\s\S]{0,80}(不在本|不在计划|不属于本)/.test(RUN + REC), '未写明 stack-other-root 的判据是栈底不在本 plan');
  assert.ok(!SKILL.includes('一格一个根调'), 'SKILL.md 仍写「一格一个根」，与 runner 一格多根矛盾');
});

await test('A2 收尾信号口径全库一致：不许再教「任何新行 = 已收尾」（含 markdown 强调与脚本注释）', () => {
  const plain = (s) => s.replace(/[*`]/g, '');
  const runner = read('scripts/gap_runner.mjs');
  assert.ok(!/有没有新行/.test(runner), 'gap_runner 头注释仍教「看有没有新行」判收尾');
  assert.ok(!/(出现|等日志出现)\s*新行/.test(plain(SKILL)), 'SKILL.md 铁律 5 仍写「出现新行 = 已收尾」');
  assert.ok(!/等日志出现新行/.test(plain(README)), 'README 铁律 5 仍写「等日志出现新行」');
  assert.ok(/收尾信号[\s\S]{0,40}stop/.test(plain(SKILL)), 'SKILL.md 未把收尾信号写成 stop 行');
});

await test('A2 盯 stop 行的操作细节：Bash 单次 600s 上限 / 中断后收尸 / logErr 停机', () => {
  const cadence = RUN.split('## cell 节奏')[1].split('\n## ')[0];
  assert.ok(/600\s*s|600000/.test(cadence), 'cell 节奏节未写 Bash 单次上限 600s（盯 stop 行要分段发）');
  assert.ok(/(中断|被杀)[\s\S]{0,300}(wait 收|收尸|收掉)/.test(cadence), '未写中断后先 wait 收掉上一格再 ready');
  assert.ok(/logErr[\s\S]{0,240}(盘满|停机|别续发|别继续发)/.test(RUN), '未写 logErr 非 null 要停机回报（盘满时台账也写不进）');
});

await test('A3 CDP 整格卡死是人工停机点，不是重试能解决的', () => {
  assert.ok(ALL.includes('waited too long in queue'), '未记 CDP 队列卡死的报错原文');
  assert.ok(/卡死[\s\S]{0,200}(人工|刷新)/.test(ALL), '未写明只能人工刷新/重开标签页');
});

await test('B4 select-button 是开关：已选中再点会取消', () => {
  assert.ok(/select-button[\s\S]{0,200}开关/.test(DOM), 'dom-notes 未写 select-button 的开关语义');
});

await test('B5 shim 性能指纹与快原语：等待用本地 setTimeout，别用 waitForTimeout', () => {
  assert.ok(DOM.includes('waitForTimeout'), 'dom-notes 未记 waitForTimeout 的往返成本');
  assert.ok(DOM.includes('H.sleep'), 'dom-notes 未给本地等待替代');
  assert.ok(DOM.includes('selTap') && DOM.includes('evaluate'), '未记 evaluate 版快原语');
});

await test('B6 台账原子落盘与坏文件自愈要写进手册', () => {
  assert.ok(/\.tmp[\s\S]{0,120}rename/.test(DOM + SKILL), '未写 .tmp + rename 原子替换');
  assert.ok(DOM.includes('corrupt'), '未写 load 返回 corrupt 时的处置');
  assert.ok(/\.bak[\s\S]{0,160}(修|恢复|救)/.test(DOM + RUN), '未写 .bak 自愈/手工救回');
});

await test('B7 安定判据与引擎一致：all + folders >= total（不是 all >= total）', () => {
  assert.ok(LIB.includes('st.all + st.folders >= want'), '引擎判据变了，文档断言要跟着改');
  assert.ok(!SKILL.includes('`all >= total`'), 'SKILL.md 仍写旧的 all >= total 判据');
  assert.ok(/all\s*\+\s*(st\.)?folders/.test(SKILL), 'SKILL.md 未写含子目录卡片的安定判据');
});

await test('B8 欠账销账口径：只有证据盖住整目录才销，窗口内 clean 不算', () => {
  assert.ok(ALL.includes('debtPaid'), '未写 H.debtPaid 销账判据');
  assert.ok(/needDrain[\s\S]{0,400}(窗口|覆盖)/.test(DOM + SKILL), '未写「窗口内 clean 不销账」');
});

await test('C9 两类欠账的处置分别写清（重提排空 vs HEAD 四零后手工销账）', () => {
  assert.ok(REC.includes('needDrain'), 'recheck-recipe 未写欠账处置');
  assert.ok(/sel-fail[\s\S]{0,300}timeout|timeout[\s\S]{0,300}sel-fail/.test(REC), '未区分两类欠账');
  assert.ok(REC.includes('delete L.needDrain'), '未给手工销账的可跑代码');
});

await test('C10 目录封面坏图是另一类缺陷（扩展修不了，要单列）', () => {
  assert.ok(ALL.includes('synofoto-small-item-folder-item'), '未记目录封面坏图的选择器');
});

await test('C11 吞吐口径：转换速率与每目录耗时要有实测数字', () => {
  assert.ok(/张\/秒/.test(DOM + SKILL), '未记转换速率（张/秒）');
});

await test('C12 只剩门户标签时的恢复路径 + ready().ok 不认 adopted 的判读', () => {
  assert.ok(RUN.includes('门户标签'), 'runbooks 未写门户标签处置');
  assert.ok(RUN.includes('adopted'), 'runbooks 未写 adopted 分支可用');
  assert.ok(/ok:true[\s\S]{0,200}adopted|adopted[\s\S]{0,200}ok:true/.test(SKILL), 'SKILL.md 的启动判据与 dom-notes 冲突未解');
});

await test('C13 根目录 id 必须在树上核实，路径用 API 真名（可能含全角字符）', () => {
  assert.ok(SKILL.includes('全角'), 'SKILL.md 未提醒目录名可能含全角字符');
  assert.ok(/(核实|确认)[\s\S]{0,80}(根目录|rootId|根 id)/.test(SKILL + REC), '未写根 id 要核实、别猜');
});

await test('E18 弹窗护栏：手册写清「只关配额弹窗」，代码不许再全表扫确定按钮', () => {
  assert.ok(LIB.includes('H.classifyDialog'), '引擎里 classifyDialog 不见了 —— 护栏被删？');
  assert.ok(LIB.includes('H.dialogGate') && LIB.includes('H.dismissMenu'), '护栏原语 dialogGate / dismissMenu 缺失');
  assert.ok(!/var bs = document\.querySelectorAll\('button'\)[\s\S]{0,120}'确定'[\s\S]{0,60}\.click\(\)/.test(LIB),
    'dismissDialog 又退回「全表扫确定按钮并直接点」—— 那会点到删除确认框');
  assert.ok(/dialog-blocking/.test(SKILL), 'SKILL.md 的 SUBMIT_BLOCKED 枚举未含 dialog-blocking');
  assert.ok(/护栏/.test(SKILL), 'SKILL.md 未写弹窗护栏');
  assert.ok(/护栏/.test(DOM), 'dom-notes 未写弹窗护栏');
  assert.ok(/回收站/.test(DOM), 'dom-notes 未记 2026-11-12 的删除弹窗事故');
  assert.ok(RUN.includes('dialog-blocking'), 'runbooks 未写弹窗挡住时的停机处置');
});

await test('D14/D15/D16 三个可跑脚本随包发布，并在 Resources 里列名', () => {
  ['scripts/head_audit.mjs', 'scripts/gap_runner.mjs', 'scripts/gap_progress.cjs'].forEach((f) => {
    assert.ok(fs.existsSync(path.join(ROOT, f)), '缺脚本: ' + f);
    assert.ok(SKILL.includes(path.basename(f)), 'SKILL.md Resources 未列 ' + f);
  });
});

await test('D17 计划落独立 JSON：内核回收后能重建游标', () => {
  assert.ok(REC.includes('__plan'), 'recheck-recipe 未写 __plan 的落盘/重建');
  assert.ok(/plan[\s\S]{0,120}JSON/.test(REC), '未写计划要落独立 JSON');
});

await test('D15 runner 收尾口径：任何出口都写恰好一行 stop，停机原因与代码逐一对得上', () => {
  const src = read('scripts/gap_runner.mjs');
  const stops = Array.from(new Set(Array.from(src.matchAll(/stop:\s*'([A-Za-z_-]+)'/g)).map((m) => m[1])));
  assert.ok(stops.length >= 8, 'runner 的停机出口数变了，手册要跟着核对：' + stops.join(','));
  stops.forEach((s) => assert.ok(RUN.includes(s), 'runbooks 未写 runner 的停机原因 ' + s));
  assert.ok(!RUN.includes('all-roots-done'),
    'runbooks 写了代码里不存在的 stop:all-roots-done —— 等这个信号会永远等不到');
  assert.ok(/(任何|每个)[\s\S]{0,24}(出口|return)[\s\S]{0,60}一行/.test(RUN),
    'runbooks 未写「任何出口都写恰好一行 stop」，下一个 agent 只能猜格子收尾了没');
});

await test('D16 gap_progress 的 cells / lines / stops 语义要写进手册', () => {
  const src = read('scripts/gap_progress.cjs');
  ['cells:', 'lines:', 'stops:'].forEach((k) => assert.ok(src.includes(k), 'gap_progress 少了字段 ' + k));
  assert.ok(/cells[\s\S]{0,120}(格数|收尾)/.test(RUN + README), '未写 cells = 已收尾格数');
  assert.ok(/lines[\s\S]{0,80}行数/.test(RUN + README), '未写 lines = 日志行数');
});

await test('D15 Cell 4 只留 runner 入口：手贴的多根循环（无前台闸、无 jsonl）必须撤掉', () => {
  assert.ok(REC.includes('__gapRun'), 'recheck-recipe 未给 runner 入口');
  assert.ok(!REC.includes('all-roots-done'),
    'recheck-recipe 仍发 all-roots-done，与 runner 的 all-done 不是同一个信号');
  assert.ok(!/H\.processTree\(t\.id/.test(REC),
    'recheck-recipe 仍留着手贴的多根循环体：没有前台闸、没有逐根日志，照抄就会重犯遮挡白烧');
});

await test('未证实的推断不得写进手册（803=旧 token / ReactModal 常态 class）', () => {
  const docs = ALL + README;
  assert.ok(!docs.includes('ReactModal__Body--open'), '手册写入了未证实的 ReactModal 推断');
  assert.ok(!/803\s*=\s*旧/.test(docs), '手册写入了未证实的 803 归因');
});

await test('测试清单与实际文件一致（改引擎必须同步手册计数）', () => {
  const files = fs.readdirSync(HERE).filter((f) => /^test_.*\.mjs$/.test(f)).sort();
  assert.ok(SKILL.includes(files.length + ' 个 `test_*.mjs`'),
    'SKILL.md 的套数与实际不符：实际 ' + files.length + ' 套');
  files.forEach((f) => {
    const short = f.replace(/^test_/, '').replace(/\.mjs$/, '');
    assert.ok(SKILL.includes(short), 'SKILL.md 回归清单缺 ' + short);
  });
});

await test('README 与手册同口径：前台闸 / 五条铁律 / 新脚本 / 实测速率', () => {
  assert.ok(!README.includes('活跃标签页'), 'README 仍写「只在活跃标签页转换」（遮挡同样停机）');
  assert.ok(README.includes('visibilityState'), 'README 未写前台判据 visibilityState');
  assert.ok(!README.includes('三条铁律'), 'README 的铁律条数与 runbooks 不一致');
  assert.ok(README.includes('五条铁律'), 'README 未同步五条铁律');
  assert.ok(/张\/秒/.test(README), 'README 性能数据缺实测转换速率');
  ['head_audit.mjs', 'gap_runner.mjs', 'gap_progress.cjs'].forEach((f) => {
    assert.ok(README.includes(f), 'README 项目结构缺 ' + f);
  });
});

await test('README 的测试计数与 SKILL.md / 实际文件一致', () => {
  const files = fs.readdirSync(HERE).filter((f) => /^test_.*\.mjs$/.test(f));
  const m = SKILL.match(/全绿\s*\*\*(\d+)\s*例/);
  assert.ok(m, 'SKILL.md 未写全绿总例数，无法对账');
  assert.ok(new RegExp(files.length + '\\s*个测试文件').test(README),
    'README 套数与实际不符：实际 ' + files.length + ' 套');
  assert.ok(new RegExp(m[1] + '\\s*(例|个测试用例)').test(README),
    'README 总例数与 SKILL.md 不符：应为 ' + m[1]);
});

console.log(`\ndoc_coverage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);