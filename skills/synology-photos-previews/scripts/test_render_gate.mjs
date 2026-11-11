// 渲染闸门：goto 后 URL 立刻就对了，但瓦片可能十几秒后才出现。
// 实测（2026-11-10，目录 4127）：goto + 9.2s 等待后 {all:0, folders:0}，而 totalShown=2；再等几秒才出现 2 个瓦片。
// 旧 processTree 只校验 URL，这种情况会把目录当「空叶子」标 done —— 子目录整支静默丢失
// （2026-11-08 的 414 事故就是这一类）。必须先等网格渲染出来，等不到就暂停，绝不标 done。
import assert from 'node:assert/strict';

const LIB = './synophotos_lib.mjs';
await import(LIB + '?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
function withPage(samples, fn) {
  ['st', 'G', 'PW'].forEach((k) => { if (!(k in ORIG)) ORIG[k] = H[k]; });
  let i = 0; const seen = [];
  H.st = async () => { const s = samples[Math.min(i, samples.length - 1)]; i++; seen.push(s); return s; };
  H.G = (f) => f();
  H.PW = () => ({ waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)) });
  return Promise.resolve(fn(seen)).finally(() => Object.assign(H, ORIG));
}
const s = (o) => Object.assign({ all: 0, loaded: 0, bad: 0, nosrc: 0, folders: 0, checked: 0, total: null }, o);

await test('totalFrom / waitRender 存在', () => {
  assert.equal(typeof H.totalFrom, 'function', 'H.totalFrom 未实现');
  assert.equal(typeof H.waitRender, 'function', 'H.waitRender 未实现');
});

await test('totalFrom 从页面文本解析「N 个项目」', () => {
  assert.equal(H.totalFrom('blah 2 个项目 blah'), 2);
  assert.equal(H.totalFrom('xxx 1351\n个项目'), 1351);
  assert.equal(H.totalFrom('没有数字'), null);
  assert.equal(H.totalFrom('0 个项目'), 0);
});

await test('有图片瓦片：立即通过', async () => {
  await withPage([s({ all: 16, total: 16 })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(r.st.all, 16);
  });
});

await test('只有子目录卡片：立即通过（不能当成未渲染）', async () => {
  await withPage([s({ all: 0, folders: 19, total: 19 })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(r.st.folders, 19);
  });
});

await test('页面明确显示 0 个项目：通过并标 empty', async () => {
  await withPage([s({ all: 0, folders: 0, total: 0 })], async () => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true);
    assert.equal(r.empty, true);
  });
});

await test('真空目录显示「无项目」而没有计数：必须判 empty，不能卡成 not-rendered', async () => {
  // 实测目录 2249：body 文本是「无项目」，快照里没有任何「N 个项目」，
  // 但有 data-testid="empty-view-wrapper" / "empty-view-icon"。
  await withPage([s({ all: 0, folders: 0, total: null, emptyView: true })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true, '空目录会被误判未渲染，导致每格都卡在同一个节点');
    assert.equal(r.empty, true);
    assert.equal(seen.length, 1);
  });
});

await test('核心回归：有项目但瓦片还没渲染，必须继续等而不是判空', async () => {
  await withPage([s({ all: 0, folders: 0, total: 2 }), s({ all: 0, folders: 0, total: 2 }), s({ all: 2, loaded: 2, total: 2 })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true);
    assert.ok(seen.length >= 3, '只取样 ' + seen.length + ' 次就放行了');
    assert.equal(r.st.all, 2);
  });
});

await test('total 读不到（null）时也不能当成空目录', async () => {
  await withPage([s({ all: 0, folders: 0, total: null }), s({ all: 0, folders: 3, total: 3 })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 25000, 1);
    assert.equal(r.ok, true);
    assert.ok(seen.length >= 2);
    assert.equal(r.st.folders, 3);
  });
});

await test('超过宽限仍看不到瓦片：不通过，reason=not-rendered（上层必须暂停而不是标 done）', async () => {
  await withPage([s({ all: 0, folders: 0, total: 52 })], async (seen) => {
    const r = await H.waitRender(Date.now() + 120000, 20, 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-rendered');
    assert.ok(seen.length >= 2, '没有重试取样');
  });
});

await test('逼近 cell 截止时间：不硬等，返回 not-rendered 交给下一格', async () => {
  await withPage([s({ all: 0, folders: 0, total: 52 })], async () => {
    const r = await H.waitRender(Date.now() + 10000, 25000, 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-rendered');
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);