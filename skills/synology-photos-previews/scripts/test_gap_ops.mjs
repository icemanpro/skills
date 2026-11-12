// 多根缺口补跑的可跑原语：欠账是否还清、前台闸门、下一根选择、跨格 runner。
// 为什么收进库：这三件事此前只活在一次性 cell 里（手贴循环抄错过常量、白烧一格），
// 而它们每一条都对应一次实测事故：
//   a) 零提交且页面干净时 needDrain 不销账 ⇒ 汇总永远挂假「待补排空」，重入还白烧一次 drainNode；
//      但「干净」只覆盖渲染窗口时绝不能销（7979：82 项 / 窗口 81，窗外那条 HEAD 实测 404）。
//   b) Chrome 窗口被别的窗口盖住 ⇒ visibilityState=hidden，扩展停止转换，提交再多也不会生效。
//   c) 栈底属于别的根时硬跑当前根 ⇒ 两个任务的游标互相踩。
// 这里只替换浏览器边界（probe/sleep/processTree/persist），被测的是真实控制流。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H, L = globalThis.__LED;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
function stub(o) {
  ['processTree', 'persist', 'foregroundGate', 'visibility'].forEach((k) => { if (!(k in ORIG)) ORIG[k] = H[k]; });
  Object.assign(H, o);
}
function restore() { Object.assign(H, ORIG); }
function freshLedger() {
  L.__loadedAt = new Date().toISOString();
  L.folders = {}; L.res2 = {}; L.vDone = {}; L.treeStack = []; L.needDrain = {}; L.retry = {}; L.tr = [];
  L.totSent = 0; L.p2 = { done: {} };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-gap-'));
const readLines = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/* ---------- a) 欠账是否真的还清（debtPaid） ---------- */

await test('debtPaid：整页装得下且 clean ⇒ 债已还', () => {
  assert.equal(typeof H.debtPaid, 'function', 'H.debtPaid 未实现');
  assert.equal(H.debtPaid({ clean: true, total: 16, win: 16 }, 16), true);
});

await test('debtPaid：clean 但窗口装不下整页 ⇒ 债留着（窗外可能仍缺）', () => {
  assert.equal(H.debtPaid({ clean: true, total: 82, win: 81 }, 82), false);
});

await test('debtPaid：只有子目录（noTiles）⇒ 没有可转换的图，债已还', () => {
  assert.equal(H.debtPaid({ clean: true, noTiles: true, total: 130, win: 0 }, 130), true);
});

await test('debtPaid：不 clean / 缺窗口证据 ⇒ 一律不销账', () => {
  assert.equal(H.debtPaid({ clean: false, total: 16, win: 16 }, 16), false);
  assert.equal(H.debtPaid({ clean: true, total: 16 }, 16), false, '没有 win 证据也敢销账');
  assert.equal(H.debtPaid(null, 16), false);
});

await test('debtPaid：total=0 的空目录 ⇒ 债已还', () => {
  assert.equal(H.debtPaid({ clean: true, total: 0, win: 0 }, 0), true);
});

/* ---------- b) 前台闸门（foregroundGate） ---------- */

await test('foregroundGate：可见时立即放行，只探一次', async () => {
  assert.equal(typeof H.foregroundGate, 'function', 'H.foregroundGate 未实现');
  let polls = 0;
  const r = await H.foregroundGate({ probe: async () => { polls++; return 'visible'; }, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.vis, 'visible');
  assert.equal(polls, 1);
});

await test('foregroundGate：被遮挡时轮询等待，恢复可见后放行', async () => {
  const seq = ['hidden', 'hidden', 'visible'];
  let i = 0, sleeps = 0;
  const r = await H.foregroundGate({ probe: async () => seq[i++], sleep: async () => { sleeps++; }, pollMs: 10 });
  assert.equal(r.ok, true, '恢复可见后仍判不可用');
  assert.equal(r.polls, 3);
  assert.equal(sleeps, 2, '每次轮询之间要等，别空转打桥');
});

await test('foregroundGate：等满预算仍不可见 ⇒ ok:false + reason tab-hidden（绝不提交）', async () => {
  let polls = 0;
  const r = await H.foregroundGate({ probe: async () => { polls++; return 'hidden'; }, sleep: async () => {}, waitMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tab-hidden');
  assert.equal(polls, 1, '预算为 0 也要先探一次，别一次都不看就判死');
});

await test('foregroundGate：探针抛错按不可见处理，且轮询次数有硬上限（时钟不走也不会死循环）', async () => {
  let polls = 0;
  const r = await H.foregroundGate({ probe: async () => { polls++; throw new Error('TAB_NOT_OWNED'); }, sleep: async () => {}, waitMs: 30, pollMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.vis, 'err');
  assert.equal(polls, 3, '轮询次数必须由 waitMs/pollMs 封顶');
});

/* ---------- c) 下一根选择（gapNextRoot） ---------- */

const plan = [
  { id: '100', path: '年/甲' },
  { id: '200', path: '年/乙' },
  { id: '300', path: '年/丙' }
];

await test('gapNextRoot：栈非空 ⇒ 续跑栈底那一根，fresh:false（哪怕它排在后面）', () => {
  assert.equal(typeof H.gapNextRoot, 'function', 'H.gapNextRoot 未实现');
  freshLedger();
  L.treeStack = [{ id: 300, path: '年/丙', phase: 'enter' }, { id: '301', path: '年/丙/子', phase: 'enter' }];
  const r = H.gapNextRoot(plan, L);
  assert.equal(r.id, '300');
  assert.equal(r.path, '年/丙');
  assert.equal(r.fresh, false);
});

await test('gapNextRoot：栈底不在本计划里 ⇒ stack-other-root，绝不硬跑', () => {
  freshLedger();
  L.treeStack = [{ id: '999', path: '别的任务/根', phase: 'enter' }];
  const r = H.gapNextRoot(plan, L);
  assert.equal(r.err, 'stack-other-root');
  assert.equal(r.id, '999');
});

await test('gapNextRoot：栈空 ⇒ 第一个未完成的根，fresh:true', () => {
  freshLedger();
  L.vDone['100'] = { done: true }; L.vDone['200'] = { done: true };
  const r = H.gapNextRoot(plan, L);
  assert.equal(r.id, '300');
  assert.equal(r.fresh, true);
});

await test('gapNextRoot：全部完成 ⇒ done:true（调用方据此收工）', () => {
  freshLedger();
  plan.forEach((p) => { L.vDone[p.id] = { done: true }; });
  assert.equal(H.gapNextRoot(plan, L).done, true);
});

await test('gapNextRoot：vDone 存在但 done 不为真 ⇒ 仍算未完成', () => {
  freshLedger();
  L.vDone['100'] = { done: false };
  assert.equal(H.gapNextRoot(plan, L).id, '100');
});

/* ---------- d) 跨格 runner（__gapRun） ---------- */

await import('./gap_runner.mjs?t=' + Date.now());
const gapRun = globalThis.__gapRun;

function runnerStubs(o) {
  freshLedger();
  stub(Object.assign({
    persist: async () => true,
    foregroundGate: async () => ({ ok: true, vis: 'visible', waited: 0, polls: 1 }),
    processTree: async () => ({ done: true, processed: 1, submitted: 0 })
  }, o));
}

await test('gapRun：台账没 load ⇒ LEDGER_NOT_LOADED，一次 processTree 都不调', async () => {
  assert.equal(typeof gapRun, 'function', 'globalThis.__gapRun 未实现');
  let calls = 0;
  runnerStubs({ processTree: async () => { calls++; return { done: true }; } });
  delete L.__loadedAt;
  const log = path.join(tmp, 'noload.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(r.err, 'LEDGER_NOT_LOADED');
  assert.equal(calls, 0);
  restore();
});

await test('gapRun：标签页不可见 ⇒ stop tab-hidden，不提交任何目录', async () => {
  let calls = 0;
  runnerStubs({
    foregroundGate: async () => ({ ok: false, vis: 'hidden', waited: 0, reason: 'tab-hidden' }),
    processTree: async () => { calls++; return { done: true }; }
  });
  const log = path.join(tmp, 'hidden.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(r.stop, 'tab-hidden');
  assert.equal(calls, 0, '窗口被盖住还提交，扩展根本不转换');
  assert.ok(readLines(log).some((o) => o.stop === 'tab-hidden'), '停机原因要落日志');
  restore();
});

await test('gapRun：格子预算不够开一根 ⇒ stop cell-budget，不空转', async () => {
  let calls = 0;
  runnerStubs({ processTree: async () => { calls++; return { done: true }; } });
  const r = await gapRun({ plan: plan, log: path.join(tmp, 'budget.jsonl'), cellMs: 100000 });
  assert.equal(r.stop, 'cell-budget');
  assert.equal(calls, 0);
  restore();
});

await test('gapRun：栈底属于别的根 ⇒ stop stack-other-root，不碰游标', async () => {
  let calls = 0;
  runnerStubs({ processTree: async () => { calls++; return { done: true }; } });
  L.treeStack = [{ id: '999', path: '别的任务/根', phase: 'enter' }];
  const r = await gapRun({ plan: plan, log: path.join(tmp, 'other.jsonl') });
  assert.equal(r.stop, 'stack-other-root');
  assert.equal(calls, 0);
  restore();
});

await test('gapRun：processTree 返回 paused ⇒ 立即收尾，本格只调一次', async () => {
  let calls = 0;
  runnerStubs({ processTree: async () => { calls++; return { paused: true, remaining: 9 }; } });
  const log = path.join(tmp, 'paused.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(calls, 1, 'paused 后还在原地重试 = 整格空转');
  assert.equal(r.stop, 'paused');
  const lines = readLines(log);
  assert.equal(lines.filter((o) => o.root).length, 1);
  assert.equal(lines[0].root, '100');
  assert.equal(lines[0].path, '年/甲');
  restore();
});

await test('gapRun：多根顺序跑完 ⇒ 每根一条日志 + all-done，fresh 只在栈空时为真', async () => {
  const seen = [];
  runnerStubs({
    processTree: async (id, o) => {
      seen.push({ id: id, fresh: o.fresh, path: o.path, dl: o.deadline });
      L.vDone[id] = { done: true };
      L.folders[id] = { id: id, name: o.path, total: 3 };
      L.totSent += 2;
      return { done: true, processed: 1, submitted: 2 };
    }
  });
  const log = path.join(tmp, 'multi.jsonl');
  const t0 = Date.now();
  const r = await gapRun({ plan: plan, log: log, cellMs: 565000 });
  assert.equal(r.stop, 'all-done');
  assert.deepEqual(seen.map((s) => s.id), ['100', '200', '300']);
  assert.ok(seen.every((s) => s.fresh === true));
  assert.ok(seen.every((s) => s.dl <= t0 + 565000 - 15000 + 50), 'deadline 必须比 cell 截止早 15s');
  const lines = readLines(log).filter((o) => o.root);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].sent, 2, '每根要记本格新增提交数');
  assert.equal(lines[0].newFolders, 1, '每根要记本格新增目录数');
  assert.equal(lines[2].rootsLeft, 0);
  restore();
});

await test('gapRun：processTree 抛错 ⇒ 记 err 并收尾，不吞异常也不继续下一根', async () => {
  let calls = 0;
  runnerStubs({ processTree: async () => { calls++; throw new Error('没有可用的外部浏览器'); } });
  const log = path.join(tmp, 'err.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(calls, 1);
  assert.equal(r.stop, 'err');
  assert.ok(readLines(log).some((o) => o.stop === 'err' && /外部浏览器/.test(o.err || '')));
  restore();
});

/* ---------- e) 每个收尾出口都必须写一行 stop 日志 ----------
   为什么钉这条：手册教的收尾判定是「jsonl 出现含 stop 的新行 = 该格已跑完，可以调 node_repl_wait」。
   若某个出口不写 stop 行，agent 会一直等一个永远不会出现的信号（白等到 cellMs 上限），
   或者误判成卡死。2026-11-12 的 GREEN 复测里受测 agent 正是发现了 all-done/cell-budget/loop-cap
   三个出口不写日志，只能猜「等到上限再 wait」。
   同一轮复测还纠正了反向错误：逐根 {root,…} 行是格子中途写的，把「任何新行」当收尾会打断正在跑的 cell。 */

await test('gapRun 收尾日志：all-done 也要写一行（否则等不到 stop 行）', async () => {
  runnerStubs({});
  plan.forEach((p) => { L.vDone[p.id] = { done: true }; });
  const log = path.join(tmp, 'fin-alldone.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(r.stop, 'all-done');
  assert.ok(readLines(log).some((o) => o.stop === 'all-done'), 'all-done 出口没写日志');
  restore();
});

await test('gapRun 收尾日志：cell-budget 也要写一行', async () => {
  runnerStubs({});
  const log = path.join(tmp, 'fin-budget.jsonl');
  const r = await gapRun({ plan: plan, log: log, cellMs: 100000 });
  assert.equal(r.stop, 'cell-budget');
  assert.ok(readLines(log).some((o) => o.stop === 'cell-budget'), 'cell-budget 出口没写日志');
  restore();
});

await test('gapRun 收尾日志：loop-cap 也要写一行', async () => {
  runnerStubs({ processTree: async () => ({ done: true }) });   // 不写 vDone ⇒ 游标不前进，撞循环上限
  const log = path.join(tmp, 'fin-loopcap.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(r.stop, 'loop-cap');
  assert.ok(readLines(log).some((o) => o.stop === 'loop-cap'), 'loop-cap 出口没写日志');
  restore();
});

await test('gapRun 收尾日志：两道前置闸（LEDGER_NOT_LOADED / NO_PLAN）也要写一行', async () => {
  runnerStubs({});
  delete L.__loadedAt;
  const log1 = path.join(tmp, 'fin-noload.jsonl');
  const r1 = await gapRun({ plan: plan, log: log1 });
  assert.equal(r1.err, 'LEDGER_NOT_LOADED');
  assert.ok(readLines(log1).some((o) => o.stop === 'LEDGER_NOT_LOADED'), 'LEDGER_NOT_LOADED 出口没写日志');
  restore();
  runnerStubs({});
  const log2 = path.join(tmp, 'fin-noplan.jsonl');
  const r2 = await gapRun({ plan: [], log: log2 });
  assert.equal(r2.err, 'NO_PLAN');
  assert.ok(readLines(log2).some((o) => o.stop === 'NO_PLAN'), 'NO_PLAN 出口没写日志');
  restore();
});

await test('gapRun 收尾日志：一格恰好一行 stop（每根的行另算），便于离线数格数', async () => {
  runnerStubs({
    processTree: async (id, o) => { L.vDone[id] = { done: true }; L.folders[id] = { id: id, name: o.path, total: 1 }; return { done: true }; }
  });
  const log = path.join(tmp, 'fin-onestop.jsonl');
  const r = await gapRun({ plan: plan, log: log });
  assert.equal(r.stop, 'all-done');
  const lines = readLines(log);
  assert.equal(lines.filter((o) => o.stop).length, 1, '收尾行只能有一条，多了会把格数算重');
  assert.equal(lines.filter((o) => o.root).length, plan.length);
  restore();
});

console.log(`\ngap_ops: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);