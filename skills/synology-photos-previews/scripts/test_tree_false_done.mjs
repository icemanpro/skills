// 「零提交却标 done」事故（2026-11-11，7227 补跑第一批 7333/7335/7336）。
// 实测台账：res2 = {sent:0, batches:0, blocked:'budget', stillBadWindow:30/41/28, clean:false, done:false,
//                  elapsed:41678/41652/41654}，而 vDone = {total:30, done:true}；HEAD 复验 30/30、41/41、28/28 全缺。
// 根因两条，缺一不可：
//   1) 预算饿死：processTree 先花 ~41.6s 过导航+渲染闸门，再按大目录口径（safety 90s + reserve 120s）
//      切预算，300s 的格子只剩 ~48s 给 pump；pumpX2 又自己导航一次（没传 atReady），
//      前置开销 41.6s > budgetMs-20000 ≈ 28s，于是第一批都没提交就 blocked='budget'。
//   2) 假完成：submitAndDrain 把「sent=0」一律当没事（pause:null），processTree 叶子分支无条件写 done:true。
// 这里只替换浏览器边界；splitBudget / smallBudget / submitAndDrain / processTree 用真实实现。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-false-done-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');
fs.writeFileSync(ledger, JSON.stringify({
  at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {},
  stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}, p2: { done: {} }
}));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1', cap: 60 };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED;

const ORIG = {};
function keep(k) { if (!(k in ORIG)) ORIG[k] = H[k]; }
function restore() { Object.assign(H, ORIG); }

const PRE_MS = 41678;          // 实测：pumpX2 前置（导航+渲染闸门+快照）耗时
const STARVE_MS = PRE_MS + 20000;   // 实测饿死阈值：pump 预算低于它，第一批都进不去
const node = { id: '7333', path: '影像资料-2026年/项目/照片9.19' };

/* ---------- 第一层：submitAndDrain 的零提交契约 ---------- */

function stubPump(r) {
  ['goto', 'pumpX2', 'drain', 'spaceDrain', 'persist'].forEach(keep);
  const calls = { pump: [], drain: 0 };
  H.goto = async () => {};
  H.persist = async () => true;
  H.spaceDrain = async () => ({});
  H.pumpX2 = async (id, budget, opts) => { calls.pump.push({ id: String(id), budget: budget, opts: opts || {} }); return Object.assign({ id: String(id) }, r); };
  H.drain = async () => { calls.drain++; return { reason: 'converted', loaded: 30, all: 30, bad: 0, waited: 9000 }; };
  L.needDrain = {}; L.res2 = {}; L.retry = {}; L.tr = [];
  return calls;
}

await test('零提交 + blocked=budget + clean=false：必须暂停，不能当没事发生', async () => {
  const calls = stubPump({ sent: 0, batches: 0, blocked: 'budget', clean: false, done: false, stillBadWindow: 30 });
  try {
    const res = await H.submitAndDrain(node, 30, Date.now() + 500000, 'enter');
    assert.ok(res.pause, '一张都没提交、窗口里还有 30 张坏图，却返回 pause=null（上层会标 done）');
    assert.equal(calls.drain, 0, '没提交就不该排空');
    assert.equal(res.submitted, 0);
  } finally { restore(); }
});

await test('零提交 + clean=true：仍然 pause=null（真干净的目录不能被误伤）', async () => {
  const calls = stubPump({ sent: 0, batches: 0, blocked: null, clean: true, done: true, stillBadWindow: 0 });
  try {
    const res = await H.submitAndDrain(node, 30, Date.now() + 500000, 'enter');
    assert.equal(res.pause, null);
    assert.equal(calls.drain, 0);
  } finally { restore(); }
});

await test('零提交 + sel-fail / gp-fail / stuck-window / quota：一律暂停', async () => {
  for (const b of ['sel-fail', 'gp-fail', 'stuck-window', 'quota']) {
    const calls = stubPump({ sent: 0, batches: 1, blocked: b, clean: false, done: false, stillBadWindow: 12 });
    try {
      const res = await H.submitAndDrain(node, 30, Date.now() + 500000, 'enter');
      assert.ok(res.pause, 'blocked=' + b + ' 且零提交却放行');
      assert.equal(calls.drain, 0);
    } finally { restore(); }
  }
});

await test('提交过（sent>0）即使 blocked 也照旧排空，不受新闸门影响', async () => {
  const calls = stubPump({ sent: 30, batches: 1, blocked: 'budget', clean: false, done: false, stillBadWindow: 0 });
  try {
    const res = await H.submitAndDrain(node, 30, Date.now() + 500000, 'enter');
    assert.equal(calls.drain, 1, '提交过的图被丢下了');
    assert.equal(res.pause, null);
    assert.equal(res.submitted, 30);
  } finally { restore(); }
});

/* ---------- 第二层：processTree 传给 submitAndDrain 的口径 ---------- */

// 一个脏叶子目录：total 项、bad 项、无子目录。只替换浏览器边界。
function stubLeaf(o) {
  ['goto', 'waitRender', 'snap', 'st', 'persist', 'sleep', 'submitAndDrain', 'drainNode', 'apiPost', 'G', 'pumpX2', 'drain', 'spaceDrain'].forEach(keep);
  const seen = { submit: [], pump: [], goto: [] };
  const st = { all: o.total, loaded: o.loaded == null ? 0 : o.loaded, bad: o.bad, nosrc: 0, folders: 0, total: o.total, checked: o.total, emptyView: false };
  let cur = String(o.id);
  H.G = (f) => f();
  globalThis.__tab = { url: async () => 'https://test/?launchApp=SYNO.Foto.AppInstance#/shared_space/folder/' + cur };
  H.goto = async (id) => { cur = String(id); seen.goto.push(cur); };
  H.waitRender = async () => ({ ok: true, st: Object.assign({}, st), waited: 0 });
  H.snap = async () => '';
  H.st = async () => Object.assign({}, st);
  H.sleep = async () => {};
  H.persist = async () => true;
  H.apiPost = async () => ({ success: true, data: { list: [] } });   // 叶子：没有子目录
  H.drainNode = async () => ({ dr: { reason: 'converted' }, pause: null });
  H.submitAndDrain = async (nd, total, dl, phase, opts) => {
    seen.submit.push({ id: String(nd.id), total: total, phase: phase, opts: opts || {} });
    return o.result || { r: { sent: total, clean: false }, dr: { reason: 'converted' }, pause: null, submitted: total };
  };
  L.__loadedAt = Date.now();
  L.treeStack = []; L.folders = {}; L.vDone = {}; L.needDrain = {}; L.res2 = {}; L.retry = {}; L.tr = [];
  return seen;
}

await test('叶子目录刚过渲染闸门：必须传 atReady=true，别让 pumpX2 再导航一次', async () => {
  const seen = stubLeaf({ id: '7333', total: 30, bad: 30 });
  try {
    const r = await H.processTree('7333', { path: node.path, deadline: Date.now() + 300000 });
    assert.equal(r.done, true, JSON.stringify(r));
    assert.equal(seen.submit.length, 1);
    assert.equal(seen.submit[0].opts.atReady, true, '没传 atReady：pumpX2 会重导航，白烧 ~41s 前置开销');
  } finally { restore(); }
});

await test('小目录（total<=120）：透传 smallBudget 的 safety/reserve/minPump', async () => {
  const seen = stubLeaf({ id: '7333', total: 30, bad: 30 });
  const sb = H.smallBudget();
  try {
    await H.processTree('7333', { path: node.path, deadline: Date.now() + 300000 });
    const o = seen.submit[0].opts;
    assert.equal(o.safety, sb.safety, 'safety 仍是大目录的 90s，小目录会被饿死');
    assert.equal(o.reserve, sb.reserve);
    assert.equal(o.minPump, sb.minPump);
  } finally { restore(); }
});

await test('大目录（total>120）：保持默认口径，不套小目录预算', async () => {
  const seen = stubLeaf({ id: '2696', total: 2702, bad: 40 });
  try {
    await H.processTree('2696', { path: '大目录', deadline: Date.now() + 500000 });
    const o = seen.submit[0].opts;
    assert.equal(o.safety, undefined, '大目录被套上小目录安全垫');
    assert.equal(o.reserve, undefined);
  } finally { restore(); }
});

await test('实测预算复现：300s 格子 - 41.6s 前置开销后，pump 预算必须高于饿死阈值', async () => {
  // 用真实 submitAndDrain + 真实 splitBudget，只把 pumpX2 换成记录预算的探针。
  const seen = stubLeaf({ id: '7333', total: 30, bad: 30 });
  const calls = { pump: [] };
  H.pumpX2 = async (id, budget, opts) => { calls.pump.push({ budget: budget, opts: opts || {} }); return { id: String(id), sent: 30, batches: 1, blocked: null, clean: false, done: true, stillBadWindow: 0 }; };
  H.drain = async () => ({ reason: 'converted', loaded: 30, all: 30, bad: 0, waited: 9000 });
  H.spaceDrain = async () => ({});
  H.submitAndDrain = ORIG.submitAndDrain;    // 用真实实现（stubLeaf 里存的是 ORIG）
  try {
    // 截止时刻等价于「格子给了 300s，processTree 自己已经花掉 41.6s」
    const r = await H.processTree('7333', { path: node.path, deadline: Date.now() + 300000 - PRE_MS });
    assert.equal(calls.pump.length, 1, '根本没走到提交: ' + JSON.stringify(r));
    assert.ok(calls.pump[0].budget > STARVE_MS,
      'pump 预算 ' + calls.pump[0].budget + 'ms <= 实测饿死阈值 ' + STARVE_MS + 'ms，第一批提交不进去');
    assert.equal(calls.pump[0].opts.atReady, true);
  } finally { restore(); }
});

/* ---------- 第三层：事故复现（真实 submitAndDrain + 实测 pump 结果） ---------- */

await test('7333 事故复现：pump 返回实测的零提交 budget 结果时，叶子绝不能标 done', async () => {
  const seen = stubLeaf({ id: '7333', total: 30, bad: 30 });
  H.submitAndDrain = ORIG.submitAndDrain;
  H.pumpX2 = async (id) => ({ id: String(id), total: 30, elapsed: PRE_MS, pass: 'submit', sent: 0, batches: 0, quota: 0, drained: 0, stillBadWindow: 30, blocked: 'budget', done: false, windowsSeen: 1, clean: false });
  H.drain = async () => { throw new Error('不该排空：一张都没提交'); };
  H.spaceDrain = async () => ({});
  try {
    const r = await H.processTree('7333', { path: node.path, deadline: Date.now() + 300000 - PRE_MS });
    assert.equal(r.paused, true, '零提交还继续往下跑: ' + JSON.stringify(r));
    assert.ok(!L.vDone['7333'] || L.vDone['7333'].done !== true,
      'HEAD 实测 30/30 全缺，却被标 done: ' + JSON.stringify(L.vDone['7333']));
    assert.ok(L.treeStack.length > 0, '栈被弹空了，下一格无法接着补这个目录');
  } finally { restore(); }
});

await test('exit 阶段同样传 atReady + 小目录预算（复检不能走另一套口径）', async () => {
  const seen = stubLeaf({ id: '7400', total: 20, bad: 5 });
  // 造一个 exit 阶段的父目录：一个子目录（叶子，干净）+ 父目录自己脏
  H.apiPost = async (api, params) => ({ success: true, data: { list: String(params.id) === '7400' ? [{ id: 7401, name: '/x/子' }] : [] } });
  H.submitAndDrain = async (nd, total, dl, phase, opts) => {
    seen.submit.push({ id: String(nd.id), total: total, phase: phase, opts: opts || {} });
    if (String(nd.id) === '7401') return { r: { sent: 0, clean: true }, dr: null, pause: null, submitted: 0 };
    return { r: { sent: total, clean: false }, dr: { reason: 'converted' }, pause: null, submitted: total };
  };
  const sb = H.smallBudget();
  try {
    const r = await H.processTree('7400', { path: '父', deadline: Date.now() + 400000 });
    assert.equal(r.done, true, JSON.stringify(r));
    const ex = seen.submit.filter(x => x.phase === 'exit');
    assert.equal(ex.length, 1, 'exit 阶段没提交: ' + JSON.stringify(seen.submit));
    assert.equal(ex[0].opts.atReady, true);
    assert.equal(ex[0].opts.safety, sb.safety);
  } finally { restore(); }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;