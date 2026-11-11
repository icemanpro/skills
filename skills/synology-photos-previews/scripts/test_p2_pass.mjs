// H.p2Pass：第二遍扫描 / 假干净审计共用的那个循环。
// 为什么要收进库：2025 审计还剩 235 个目录，2026 二轮 845 个，2024 一整轮 —— 十几格循环代码
// 手贴在 cell 里，既容易把尾巴常量抄错（历史上就抄出过 SUBMIT_BUDGET 白烧一格的事故），
// 也没法用测试钉住语义。这里只替换浏览器边界（goto/stSettled/submitAndDrain/persist），
// tailReserve / smallBudget 用真实实现：外层放行与内层口径必须来自同一个数，这正是要测的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-p2pass-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');
fs.writeFileSync(ledger, JSON.stringify({
  at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {},
  stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}, p2: { done: {} }
}));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED;
const sb = H.smallBudget();

const ORIG = {};
// state[id] = { total, bad, all, settled } —— stSettled 每次都用它作答（可被 submits 改写）
function stub(o) {
  o = o || {};
  ['goto', 'stSettled', 'submitAndDrain', 'persist', 'audit'].forEach((k) => { if (!(k in ORIG)) ORIG[k] = H[k]; });
  const calls = { goto: [], settle: [], submit: [], persist: [], audit: [] };
  H.audit = async (id) => {
    calls.audit.push(String(id));
    const st = (o.view || {})[String(id)] || { bad: 0, total: 0 };
    return Object.assign({ swept: st.total || 0, broken: st.bad || 0, noSrc: 0, videos: 0 }, ((o.deep || {})[String(id)] || {}));
  };
  H.goto = async (id) => { calls.goto.push(String(id)); };
  H.stSettled = async (opts) => {
    const id = String(calls.goto[calls.goto.length - 1]);
    calls.settle.push(id);
    const st = (o.view || {})[id] || { total: 5, bad: 0, all: 5 };
    return { settled: st.settled !== false, st: { all: st.all == null ? 5 : st.all, bad: st.bad || 0, loaded: st.loaded || 0, total: st.total == null ? (st.all == null ? 5 : st.all) : st.total, folders: st.folders || 0 } };
  };
  H.submitAndDrain = async (node, total, dl, phase, opts) => {
    const id = String(node.id);
    calls.submit.push({ id: id, total: total, phase: phase, opts: opts, tail: calls.goto.length });
    const res = (o.submits || {})[id];
    if (res) { if (!(id in (o.view || {}))) o.view[id] = { total: total, bad: 0, all: total }; Object.assign(o.view[id], res.after || {}); }
    return res ? { r: { sent: res.sent == null ? total : res.sent }, dr: res.dr, pause: res.pause || null, submitted: res.sent == null ? total : res.sent }
                : { r: { sent: total }, dr: { reason: 'converted', loaded: total, all: total, bad: 0 }, pause: null, submitted: total };
  };
  H.persist = async (tag) => { calls.persist.push(tag); return true; };
  L.p2 = { done: {} }; L.retry = {}; L.needDrain = {};
  return calls;
}
function restore() { Object.assign(H, ORIG); }
function seed(folders, done) {
  L.folders = folders; L.p2.done = done || {}; L.retry = {};
}

await test('H.p2Pass 存在且返回计数字段', async () => {
  assert.equal(typeof H.p2Pass, 'function', 'H.p2Pass 未实现');
  stub(); restore();
});

await test('已标干净（cleanMark）的目录跳过：不导航、不重复审计', async () => {
  const calls = stub();
  seed({ '1': { id: '1', total: 5 }, '2': { id: '2', total: 5 } }, { '1': 3 });
  try {
    const r = await H.p2Pass({ ids: ['1', '2'], deadline: Date.now() + 400000, cleanMark: 3, tag: 'a' });
    assert.deepEqual(calls.goto, ['2'], '跳过的目录却导航了: ' + JSON.stringify(calls.goto));
    assert.equal(r.seen, 1);
    assert.equal(r.wasClean, 1);
    assert.equal(r.skipped, 1);
  } finally { restore(); }
});

await test('假干净（done=1 但安定后 bad>0）：记 falseClean 并真的重排 drain', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 7, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(r.falseClean, 1, '没被算成假干净: ' + JSON.stringify(r));
    assert.equal(calls.submit.length, 1, '只复验不重排，转换永远补不回来');
    assert.equal(calls.submit[0].total, 20, 'submitAndDrain 的 total 该用页面项数');
  } finally { restore(); }
});

await test('小目录必须透传 smallBudget（外层放行 = 内层可提交）', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 7, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  try {
    await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    const o = calls.submit[0].opts;
    assert.equal(o.atReady, true, '刚过安定闸门，pumpX2 不必再导航一次');
    assert.equal(o.safety, sb.safety, 'safety 没透传: ' + JSON.stringify(o));
    assert.equal(o.reserve, sb.reserve, 'reserve 没透传: ' + JSON.stringify(o));
    assert.equal(o.minPump, sb.minPump, 'minPump 没透传: ' + JSON.stringify(o));
  } finally { restore(); }
});

await test('大目录（total>120）保持默认 90+120 口径，不塞小预算', async () => {
  const calls = stub({ view: { '7': { total: 242, bad: 30, all: 198 } }, submits: { '7': { sent: 30, after: { bad: 30, all: 198 }, dr: { reason: 'stalled', loaded: 120, all: 198, bad: 30 } } } });
  seed({ '7': { id: '7', total: 242 } }, { '7': 1 });
  try {
    await H.p2Pass({ ids: ['7'], deadline: Date.now() + 400000, cleanMark: 3 });
    const o = calls.submit[0].opts;
    assert.equal(o.safety, undefined, '大目录用了小目录的安全垫');
    assert.equal(o.reserve, undefined, '大目录用了小目录的排空预留');
    assert.ok(calls.submit.length >= 2, '大目录排空未收敛，应最多跑 bigRounds 轮: ' + calls.submit.length);
  } finally { restore(); }
});

await test('收敛：drain converted 且整页渲染满 → 标 cleanMark，retry 归零', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 5, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  L.retry['9'] = 4;
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(L.p2.done['9'], 3, '没标成审计通过: ' + L.p2.done['9']);
    assert.equal(L.retry['9'], 0);
    assert.equal(r.repaired, 1);
    assert.equal(r.trusted, 1, '整页渲染满 + converted，不该再导航一次复验');
    assert.equal(calls.goto.length, 1);
  } finally { restore(); }
});

await test('未收敛：retry+1 且退回主扫描（delete），绝不标干净', async () => {
  const calls = stub({
    view: { '9': { total: 20, bad: 6, all: 20 } },
    submits: { '9': { sent: 6, after: { bad: 6, all: 20 }, dr: { reason: 'stalled', loaded: 14, all: 20, bad: 6 } } }
  });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(L.p2.done['9'], undefined, '没修好却留着标记，下一格就再也不碰它了');
    assert.equal(L.retry['9'], 1);
    assert.equal(r.stillBad, 1);
    assert.equal(r.pending, 1);
    assert.ok(calls.goto.length >= 2, '排空没收敛时要导航复验');
  } finally { restore(); }
});

await test('retry 满 6 次：标 2（复检仍坏），不是干净', async () => {
  stub({
    view: { '9': { total: 20, bad: 6, all: 20 } },
    submits: { '9': { sent: 6, after: { bad: 6, all: 20 }, dr: { reason: 'stalled', loaded: 14, all: 20, bad: 6 } } }
  });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  L.retry['9'] = 5;
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(L.p2.done['9'], 2, '强制收口必须是 2: ' + L.p2.done['9']);
    assert.equal(r.gaveUp.length, 1);
    assert.equal(r.stillBad, 1);
  } finally { restore(); }
});

await test('尾巴窗口不够：tailSkip++ 且绝不提交（不能提交完就走）', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 6, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  try {
    // 只剩「放行线 - 1ms」：安定闸门照跑，但脏目录必须让位
    const tight = Date.now() + H.tailReserve(20) - 1;
    const r = await H.p2Pass({ ids: ['9'], deadline: tight, cleanMark: 3 });
    assert.equal(calls.submit.length, 0, '窗口不够还是提交了');
    assert.equal(r.tailSkip, 1);
    assert.equal(L.p2.done['9'], 1, '没做的目录要留着，下一格重跑');
  } finally { restore(); }
});

await test('纯脏区尾巴：连续 tailSkip 到达标就 break，不空扫剩余目录', async () => {
  const f = {}, ids = [], v = {};
  for (let i = 1; i <= 5; i++) { const id = 'd' + i; f[id] = { id: id, total: 5 }; ids.push(id); v[id] = { total: 5, bad: 3, all: 5 }; }
  const calls = stub({ view: v });
  seed(f, {});
  try {
    // 闸门按 tailReserve 算：deadline 只给到「放行线 - 1ms」，每个脏目录都该被尾巴挡下
    const r = await H.p2Pass({ ids: ids, deadline: Date.now() + H.tailReserve(5) - 1, cleanMark: 1, consecLimit: 3 });
    assert.equal(r.tailSkip, 3, '连续脏到 consecLimit 必须收工: ' + JSON.stringify(r));
    assert.equal(r.seen, 3, '剩下的目录不该再空扫: ' + r.seen);
    assert.equal(calls.submit.length, 0, '窗口不够还是提交了');
    assert.equal(L.p2.done['d1'], undefined, '被尾巴跳过的目录不能留任何 done');
  } finally { restore(); }
});

await test('每 persistEvery 个落一次盘，结束时必落盘', async () => {
  const calls = stub();
  const f = {}, ids = [];
  for (let i = 1; i <= 6; i++) { f['c' + i] = { id: 'c' + i, total: 3 }; ids.push('c' + i); }
  seed(f, {});
  try {
    await H.p2Pass({ ids: ids, deadline: Date.now() + 400000, cleanMark: 1, persistEvery: 2, tag: 'p2-x' });
    assert.ok(calls.persist.length >= 3, '中间落盘太少: ' + JSON.stringify(calls.persist));
    assert.equal(calls.persist[calls.persist.length - 1], 'p2-x', '收尾必须用调用方给的 tag');
  } finally { restore(); }
});

// 大目录（页项数 > 渲染窗口 ~198）：st.all 永远到不了 total，安定闸门判不满 →
// 只能靠 H.audit 滚动全目录扫描（按 id 去重）拿结论。实测 2238/2696 就是被这个误判到 retry=6 标成 p2=2 的。
await test('大目录渲染窗口装不下：用 H.audit 全目录扫作结论，broken=0 即判干净（不算 strike）', async () => {
  const calls = stub({ view: { '9': { total: 242, bad: 0, all: 198, settled: false } } });
  seed({ '9': { id: '9', total: 242 } }, { '9': 1 });
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(calls.audit.length, 1, '渲染不满却没做滚动全扫');
    assert.equal(L.p2.done['9'], 3, '深度扫无坏图应判干净: ' + L.p2.done['9']);
    assert.equal(r.stillBad, 0, '不能再记一次 strike');
    assert.equal(r.deepClean, 1);
    assert.equal(calls.submit.length, 0, '全目录已无坏图，不该再提交');
  } finally { restore(); }
});

await test('大目录深度扫仍有坏图：提交排空后收口仍以深度扫为准', async () => {
  const calls = stub({
    view: { '9': { total: 242, bad: 55, all: 198, settled: false } },
    submits: { '9': { sent: 55, after: { bad: 0 }, dr: { reason: 'converted', loaded: 198, all: 198, bad: 0 } } }
  });
  seed({ '9': { id: '9', total: 242 } }, { '9': 1 });
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(r.falseClean, 1);
    assert.equal(calls.submit.length, 1, '没重排 drain');
    assert.equal(calls.audit.length, 2, '收口要再扫一次全目录: ' + calls.audit.length);
    assert.equal(L.p2.done['9'], 3);
    assert.equal(r.repaired, 1);
  } finally { restore(); }
});

await test('一屏装得下的目录不许滚动（省掉 12 次 pageDown）', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 5, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  try {
    await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(calls.audit.length, 0, '小目录走了深度扫');
  } finally { restore(); }
});

await test('判干净即销帐：needDrain 的陈欠标记必须一起清掉', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 0, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  L.needDrain['9'] = { total: 20, sent: 20, at: Date.now() - 600000 };
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(L.p2.done['9'], 3);
    assert.equal(L.needDrain['9'], undefined, '页面已证明全部转换，还留着欠排空标记会让报告永远喊疼');
    assert.deepEqual(r.needDrain, []);
  } finally { restore(); }
});

await test('修好后也销帐：repaired 的目录不留 needDrain', async () => {
  const calls = stub({ view: { '9': { total: 20, bad: 5, all: 20 } } });
  seed({ '9': { id: '9', total: 20 } }, { '9': 1 });
  L.needDrain['9'] = { total: 20, sent: 20, at: Date.now() };
  try {
    const r = await H.p2Pass({ ids: ['9'], deadline: Date.now() + 400000, cleanMark: 3 });
    assert.equal(r.repaired, 1);
    assert.equal(L.needDrain['9'], undefined);
  } finally { restore(); }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
