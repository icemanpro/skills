// 「生成预览」快路径：选中后工具条里就有这个按钮，不必右键。
// 实测（2026-11-11，目录 2709，29 张坏图）：selSpan3 选完 29 张后，DOM 里有一个
// 不在 .synofoto-right-click-menu 里的 button，textContent 正是「生成预览」，
// 它被 park 在 x=-49992（视觉隐藏），但 JS .click() 照样触发 React handler：
// 提交后 broken 29→0，drain 判 converted 29/29。
// 老路径必须先做一次真实 Playwright 右键（实测 5-7s）才能打开菜单；
// 快路径把这 7s 省掉。坏图数没减少 / 按钮不存在时，必须原样退回右键慢路径。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
['G', 'PW', 'grid', 'sleep', 'brokenCount', 'dialogOpen', 'dismissDialog', 'menuInfo', 'clickGen', 'genToolbar', 'selCount2'].forEach((k) => { ORIG[k] = H[k]; });
function restore() { Object.assign(H, ORIG); }

const psOf = (n) => Array.from({ length: n }, (_, i) => ({ idx: i, id: 1000 + i, broken: true, checked: true }));

function scene({ toolbar = 'clicked', bad = [30, 5], menuOpen = true, hasGen = true, dialog = false } = {}) {
  const log = [];
  let bi = 0;
  H.G = (fn) => fn();
  H.sleep = async () => {};
  H.PW = () => ({
    locator: () => ({ evaluate: async () => ({}) }),
    getByRole: () => ({ first: () => ({ click: async () => { log.push('pw-menu-btn'); } }) })
  });
  H.grid = () => ({ nth: () => ({ scrollIntoViewIfNeeded: async () => {}, click: async (o) => { if (o && o.button === 'right') log.push('rightclick'); } }) });
  H.genToolbar = async () => { log.push('toolbar:' + toolbar); return toolbar; };
  H.brokenCount = async () => { const v = bad[Math.min(bi, bad.length - 1)]; bi++; log.push('bad' + v); return v; };
  H.dialogOpen = async () => { log.push('dialog'); return dialog; };
  H.dismissDialog = async () => { log.push('dismiss'); };
  H.menuInfo = async () => { log.push('menu'); return { open: menuOpen, hasGen: hasGen }; };
  H.clickGen = async () => { log.push('clickGen'); return 'clicked'; };
  H.selCount2 = async () => 30;
  return { log };
}

await test('工具条按钮生效：直接返回 ok，不做真实右键', async () => {
  // 新实现的「提交前」基准取自本批候选数（idxs.length），所以按钮不存在时一次坏图读取都不花；
  // 这里 bad 只给点击之后的读数。
  const s = scene({ toolbar: 'clicked', bad: [0] });
  try {
    const r = await H.genPreview2(psOf(3));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.via, 'toolbar');
    assert.equal(s.log.indexOf('rightclick'), -1, '不该再走右键：' + JSON.stringify(s.log));
    assert.equal(s.log.indexOf('menu'), -1);
    assert.equal(s.log.filter((x) => /^bad\d+$/.test(x)).length, 1, '坏图只该读一次（提交后）：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('工具条没有该按钮：退回右键菜单', async () => {
  const s = scene({ toolbar: 'no-btn', bad: [30, 30] });
  try {
    const r = await H.genPreview2(psOf(3));
    assert.equal(r.ok, true);
    assert.equal(r.via, 'menu');
    assert.ok(s.log.indexOf('rightclick') >= 0 && s.log.indexOf('clickGen') >= 0, JSON.stringify(s.log));
  } finally { restore(); }
});

await test('工具条点了但坏图没减少：退回右键菜单（不能空转）', async () => {
  const s = scene({ toolbar: 'clicked', bad: [30, 30] });
  try {
    const r = await H.genPreview2(psOf(3));
    assert.equal(r.ok, true);
    assert.equal(r.via, 'menu');
    assert.ok(s.log.indexOf('rightclick') >= 0, JSON.stringify(s.log));
  } finally { restore(); }
});

await test('工具条点击后弹「确定」＝配额拒绝：点掉弹窗并上报，不再重试右键', async () => {
  const s = scene({ toolbar: 'clicked', dialog: true, bad: [30, 30] });
  try {
    const r = await H.genPreview2(psOf(3));
    assert.equal(r.ok, false);
    assert.equal(r.dialog, true);
    assert.ok(s.log.indexOf('dismiss') >= 0, JSON.stringify(s.log));
    assert.equal(s.log.indexOf('rightclick'), -1, '配额拒绝不该再用右键重提一遍');
  } finally { restore(); }
});

await test('工具条按钮不存在时不额外读坏图（省掉一次往返）', async () => {
  const s = scene({ toolbar: 'no-btn', bad: [30, 5] });
  try {
    const r = await H.genPreview2(psOf(3));
    assert.equal(r.via, 'menu');
    const reads = s.log.filter((x) => /^bad\d+$/.test(x)).length;
    assert.equal(reads, 2, '坏图数多读了：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('genToolbar 只点工具条那个按钮，绝不点右键菜单里的', async () => {  const list = [b('删除'), b('生成预览', true), b('生成预览', false)];
  globalThis.document = { querySelectorAll: () => list };
  H.G = (fn) => fn();
  H.PW = () => ({ locator: () => ({ evaluate: (fn) => fn() }) });
  try {
    const r = await H.genToolbar();
    assert.equal(r, 'clicked');
    assert.equal(list[1].n, 0, '点了右键菜单里那个');
    assert.equal(list[2].n, 1);
  } finally { delete globalThis.document; restore(); }
});

await test('genToolbar：页面里没有该按钮时返回 no-btn', async () => {
  globalThis.document = { querySelectorAll: () => [b('删除')] };
  H.G = (fn) => fn();
  H.PW = () => ({ locator: () => ({ evaluate: (fn) => fn() }) });
  try {
    const r = await H.genToolbar();
    assert.equal(r, 'no-btn');
  } finally { delete globalThis.document; restore(); }
});

function b(text, inMenu) {
  const o = { textContent: text, n: 0, closest: () => (inMenu ? {} : null), click: () => { o.n++; } };
  return o;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
