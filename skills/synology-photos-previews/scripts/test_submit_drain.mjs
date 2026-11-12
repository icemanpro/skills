// processTree 的「提交后必须等转换完成」策略测试。
// 用户两次报同一个缺陷：进了目录、点了生成预览，没等转换完就退回上一级。
// 除了判据错（bad=0 即返回）之外，还有三条路径会绕过排空：
//   a) `r.sent > 0 && !r.blocked`：sel-fail / budget / quota 时已提交的图被直接丢下；
//   b) `drainBudget > 20000`：pump 吃满预算后恰好不满足，整段排空被跳过；
//   c) spaceDrain(deadline-now-90000) 把剩余时间吃光，后面的 drain 无时间可用。
// 这里只替换浏览器边界（goto/pumpX2/drain/spaceDrain/persist），被测的是真实的控制流策略。
import assert from 'node:assert/strict';

const LIB = './synophotos_lib.mjs';
await import(LIB + '?t=' + Date.now());
const H = globalThis.__H, L = globalThis.__LED;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
function stub(o) {
  ['goto', 'pumpX2', 'drain', 'spaceDrain', 'persist'].forEach((k) => { if (!(k in ORIG)) ORIG[k] = H[k]; });
  Object.assign(H, o);
  L.needDrain = {}; L.res2 = {}; L.retry = {}; L.tr = [];
}
function restore() { Object.assign(H, ORIG); }
const node = { id: '4112', path: '影像资料-2025年/某目录' };
const okDrain = { reason: 'converted', loaded: 16, all: 16, bad: 0, waited: 15000 };

await test('submitAndDrain / drainNode 存在', () => {
  assert.equal(typeof H.submitAndDrain, 'function', 'H.submitAndDrain 未实现');
  assert.equal(typeof H.drainNode, 'function', 'H.drainNode 未实现');
});

await test('sent>0 但 blocked=sel-fail：仍然必须排空（旧代码 !r.blocked 会跳过）', async () => {
  let drains = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 16, blocked: 'sel-fail' }),
    drain: async () => { drains++; return okDrain; }
  });
  try {
    const res = await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    assert.equal(drains, 1, '提交过的图被丢下了');
    assert.equal(res.pause, null);
    assert.equal(res.submitted, 16);
  } finally { restore(); }
});

await test('sent>0 但 blocked=quota：仍然必须排空', async () => {
  let drains = 0, spaceArg = null;
  stub({
    goto: async () => {}, persist: async () => true,
    pumpX2: async () => ({ id: '4112', sent: 110, blocked: 'quota' }),
    spaceDrain: async (ms) => { spaceArg = ms; return { reason: 'timeout' }; },
    drain: async () => { drains++; return okDrain; }
  });
  try {
    const dl = Date.now() + 500000;
    const res = await H.submitAndDrain(node, 300, dl, 'enter');
    assert.equal(drains, 1);
    assert.ok(spaceArg === null || spaceArg <= dl - Date.now() - 90000, 'spaceDrain 吃光了排空时间');
    assert.equal(res.pause, null);
  } finally { restore(); }
});

await test('剩余时间不够排空：不提交，直接暂停（而不是提交完就走）', async () => {
  let pumps = 0, drains = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => { pumps++; return { sent: 16 }; },
    drain: async () => { drains++; return okDrain; }
  });
  try {
    const res = await H.submitAndDrain(node, 16, Date.now() + 200000, 'enter');
    assert.equal(pumps, 0, '没时间等转换却提交了');
    assert.equal(drains, 0);
    assert.equal(res.pause, 'SUBMIT_BUDGET');
  } finally { restore(); }
});

// 小目录饿死（2026-11-11 审计 4 实测 5 个 SUBMIT_BUDGET）：
// 外层 tailReserve 只给到 60~65s 就放行，内层 splitBudget 仍按默认 safety 90s + reserve 120s 算，
// 于是 1-5 项的目录根本拿不到提交窗口 —— 白花一次导航 + 安定闸门，还被记进 pending。
// safety/reserve/minPump 必须由调用方透传，并且透传要一路走到 drainNode。
await test('小目录透传 safety/reserve 后能拿到窗口（外层放行 = 内层可提交）', async () => {
  let pumps = 0, drains = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async (id, budget) => { pumps++; assert.ok(budget > 0, 'pump 预算必须为正: ' + budget); return { id: '4112', sent: 5 }; },
    drain: async () => { drains++; return { reason: 'converted', loaded: 5, all: 5, bad: 0, waited: 9000 }; }
  });
  try {
    const b = H.smallBudget();
    const res = await H.submitAndDrain(node, 5, Date.now() + b.window, 'p2', { atReady: true, safety: b.safety, reserve: b.reserve });
    assert.equal(res.pause, null, '小目录被拒提: ' + res.pause);
    assert.equal(pumps, 1, '没有提交');
    assert.equal(drains, 1, '提交了却没排空');
  } finally { restore(); }
});

await test('不传 opts 时默认口径不变（小窗口照样拒提，不放水）', async () => {
  let pumps = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => { pumps++; return { id: '4112', sent: 5 }; },
    drain: async () => okDrain
  });
  try {
    const res = await H.submitAndDrain(node, 5, Date.now() + 65000, 'p2', { atReady: true });
    assert.equal(pumps, 0, '默认预算下偷偷提交了');
    assert.equal(res.pause, 'SUBMIT_BUDGET');
  } finally { restore(); }
});

await test('safety 一路透传进 drainNode：排空用调用方预留的余量，而不是死扣 90s', async () => {
  let gotos = 0, drains = 0;
  stub({
    goto: async () => { gotos++; }, persist: async () => true,
    drain: async () => { drains++; return { reason: 'converted', loaded: 5, all: 5, bad: 0, waited: 9000 }; }
  });
  try {
    L.needDrain['4112'] = { total: 5 };
    const res = await H.drainNode(node, 5, Date.now() + 60000, { safety: 15000 });
    assert.equal(res.pause, null, '排空被默认 90s 安全垫挡掉');
    assert.equal(gotos, 1);
    assert.equal(drains, 1);
  } finally { restore(); }
});

await test('drainNode 不传 opts 时仍按 90s 安全垫（首轮大目录口径不变）', async () => {
  let gotos = 0;
  stub({
    goto: async () => { gotos++; }, persist: async () => true,
    drain: async () => { gotos += 10; return okDrain; }
  });
  try {
    L.needDrain['4112'] = { total: 16 };
    const res = await H.drainNode(node, 16, Date.now() + 100000);
    assert.equal(res.pause, 'DRAIN_BUDGET');
    assert.equal(gotos, 0);
    assert.ok(L.needDrain['4112']);
  } finally { restore(); }
});

await test('drain=not-rendered：暂停并保留补排空标记，绝不标完成', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 52 }),
    drain: async () => ({ reason: 'not-rendered', loaded: 0, all: 0, bad: 0, waited: 20000 })
  });
  try {
    const res = await H.submitAndDrain(node, 52, Date.now() + 500000, 'enter');
    assert.equal(res.pause, 'DRAIN_NOT_RENDERED');
    assert.ok(L.needDrain['4112'], '标记丢了，下一格无法补排空');
  } finally { restore(); }
});

await test('drain=converted：清掉标记，并把结果写进 res2 供审计', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 16 }),
    drain: async () => okDrain
  });
  try {
    const res = await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    assert.equal(res.pause, null);
    assert.equal(L.needDrain['4112'], undefined);
    assert.equal(L.res2['4112'].drain.reason, 'converted');
    assert.equal(L.res2['4112'].drain.loaded, 16);
  } finally { restore(); }
});

await test('drain=stalled：记账号入 retry 留给第二遍，但不假装成功', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 16 }),
    drain: async () => ({ reason: 'stalled', loaded: 9, all: 16, bad: 7, waited: 60000 })
  });
  try {
    const res = await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    assert.equal(res.pause, null);
    assert.equal(L.retry['4112'], 1);
    assert.equal(L.res2['4112'].drain.reason, 'stalled');
    assert.ok(L.needDrain['4112']);
  } finally { restore(); }
});

await test('sent=0：不排空、不暂停', async () => {
  let drains = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 0, clean: true }),
    drain: async () => { drains++; return okDrain; }
  });
  try {
    const res = await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    assert.equal(drains, 0);
    assert.equal(res.pause, null);
    assert.equal(res.submitted, 0);
  } finally { restore(); }
});

await test('补排空标记必须在 drain 之前落下：drain 抛错也不会丢掉待排空目录', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 16 }),
    drain: async () => { throw new Error('TAB_NOT_OWNED'); }
  });
  try {
    await assert.rejects(() => H.submitAndDrain(node, 16, Date.now() + 500000, 'enter'));
    assert.ok(L.needDrain['4112'], '中断后无法知道这个目录还欠一次排空');
  } finally { restore(); }
});

await test('排空之前必须把 needDrain 标记写盘（kernel 中途被回收也能补排空）', async () => {
  const order = [];
  stub({
    goto: async () => {}, spaceDrain: async () => ({}),
    persist: async (tag) => { order.push({ tag: tag, marked: !!L.needDrain['4112'] }); return true; },
    pumpX2: async () => ({ id: '4112', sent: 16 }),
    drain: async () => { order.push({ tag: 'DRAIN', marked: !!L.needDrain['4112'] }); return okDrain; }
  });
  try {
    await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    const di = order.findIndex((o) => o.tag === 'DRAIN');
    assert.ok(di > 0, '没有调用 drain');
    assert.ok(order.slice(0, di).some((o) => o.marked), 'drain 前没有一次带着标记的 persist：' + JSON.stringify(order));
  } finally { restore(); }
});

await test('pumpX2 报 not-rendered：必须暂停，不能把目录标 done', async () => {
  let drains = 0;
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 0, blocked: 'not-rendered', done: false }),
    drain: async () => { drains++; return okDrain; }
  });
  try {
    const res = await H.submitAndDrain(node, 52, Date.now() + 500000, 'enter');
    assert.equal(res.pause, 'NOT_RENDERED', '页面没渲染出来却继续往下走');
    assert.equal(drains, 0);
  } finally { restore(); }
});

await test('drainNode：预算不足时不导航不排空，返回 DRAIN_BUDGET（不切目录）', async () => {
  let gotos = 0, drains = 0;
  stub({
    goto: async () => { gotos++; }, persist: async () => true,
    drain: async () => { drains++; return okDrain; }
  });
  try {
    L.needDrain['4112'] = { total: 16 };
    const res = await H.drainNode(node, 16, Date.now() + 100000);
    assert.equal(res.pause, 'DRAIN_BUDGET');
    assert.equal(gotos, 0);
    assert.equal(drains, 0);
    assert.ok(L.needDrain['4112']);
  } finally { restore(); }
});

await test('drainNode：converted 后清标记（用于下一格补排空）', async () => {
  stub({ goto: async () => {}, persist: async () => true, drain: async () => okDrain });
  try {
    L.needDrain['4112'] = { total: 16 };
    const res = await H.drainNode(node, 16, Date.now() + 500000);
    assert.equal(res.pause, null);
    assert.equal(res.dr.reason, 'converted');
    assert.equal(L.needDrain['4112'], undefined);
  } finally { restore(); }
});

// 零提交 + 页面干净时的欠账（2026-11-12 审计）：drainNode 在 converted/empty 时销账，
// 但 submitAndDrain 的 clean 分支直接 return，needDrain 里的旧标记永远留着 ⇒
// 汇总永远挂假「待补排空」，processTree 重入还白烧一次 drainNode。
// 反过来也不能一律销：clean 只覆盖渲染窗口时（7979：82 项 / 窗口 81），窗外那条可能仍缺。
await test('零提交且整页装得下的 clean：销掉 needDrain 欠账（与 drainNode 口径一致）', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 0, clean: true, total: 16, win: 16 }),
    drain: async () => okDrain
  });
  try {
    L.needDrain['4112'] = { total: 16, sent: 16, why: 'revoke' };
    const res = await H.submitAndDrain(node, 16, Date.now() + 500000, 'enter');
    assert.equal(res.pause, null);
    assert.equal(L.needDrain['4112'], undefined, '整页已证明干净，欠账却没销');
  } finally { restore(); }
});

await test('零提交但窗口装不下整页：clean 只是窗口内结论，欠账必须留着', async () => {
  stub({
    goto: async () => {}, persist: async () => true, spaceDrain: async () => ({}),
    pumpX2: async () => ({ id: '4112', sent: 0, clean: true, total: 82, win: 81 }),
    drain: async () => okDrain
  });
  try {
    L.needDrain['4112'] = { total: 82, sent: 81 };
    const res = await H.submitAndDrain(node, 82, Date.now() + 500000, 'enter');
    assert.equal(res.pause, null);
    assert.ok(L.needDrain['4112'], '窗口外还没核验就把欠账销了');
  } finally { restore(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);