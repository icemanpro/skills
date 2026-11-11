// 热路径提速的回归测试。
// 实测（2026-11-10，目录 2500 附近）：这个 shim 里 PW().waitForTimeout 单次往返约 4.6s、
// locator.click 约 5.4~7s、locator.count 约 4.4s；而 page.evaluate 只要 0.2~0.5s。
// 一个坏目录 70~90s 里约 44s 花在「选中 + 右键菜单」的往返上。提速手段：
//   1) 所有等待改用本地 H.sleep（不经过 PW）；
//   2) 选中与计数改用 evaluate（合成点击/合成 Shift 事件），失败再退回原来的 Playwright 慢路径；
//   3) 右键菜单用 Playwright 打开（合成 contextmenu 实测无效），但读菜单/点「生成预览」用 evaluate。
// 这里测的是编排逻辑：成功走快路，失败必须退回慢路，绝不因为快路失效而谎报成功。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
['G', 'PW', 'grid', 'selCount', 'clearSel', 'sleep', 'selTap', 'selShift', 'selCount2',
 'menuInfo', 'clickGen', 'genToolbar', 'brokenCount', 'dialogOpen', 'dismissDialog'].forEach((k) => { ORIG[k] = H[k]; });
function restore() { Object.assign(H, ORIG); }

// selSpan3 场景：fast 决定快路是否成功；slow 决定 Playwright 兜底是否成功
function selScene({ first = 0, last = 3, fastTap = true, fastShift = true, slowWorks = true } = {}) {
  const log = [];
  let sel = 0;
  const base = first;
  H.G = (fn) => fn();
  H.sleep = async () => { log.push('sleep'); };
  H.clearSel = async () => { sel = 0; log.push('clear'); };
  H.PW = () => ({ locator: () => ({ press: async () => { log.push('press:Space'); if (slowWorks && sel < 1) sel = 1; } }) });
  H.grid = () => ({
    nth: (i) => ({
      scrollIntoViewIfNeeded: async () => {},
      focus: async () => { log.push('focus'); },
      click: async (o) => {
        log.push(o && o.modifiers ? 'pw-shift' : 'pw-click');
        if (!slowWorks) return;
        if (o && o.modifiers) sel = last - base + 1; else sel = Math.max(sel, 1);
      },
      locator: () => ({ first: () => ({ click: async () => { log.push('pw-btn'); if (slowWorks) sel = Math.max(sel, 1); } }) }),
      evaluate: async () => true
    })
  });
  H.selTap = async () => { log.push('tap'); if (fastTap) sel = Math.max(sel, 1); return fastTap; };
  H.selShift = async () => { log.push('shiftEval'); if (fastShift) sel = last - base + 1; return { ok: fastShift, n: sel }; };
  H.selCount2 = async () => sel;
  return { log, get sel() { return sel; } };
}

await test('selSpan3 多张：合成选中成功时不再走 Playwright 慢路径', async () => {
  const s = selScene({ first: 0, last: 4, fastTap: true, fastShift: true });
  try {
    const n = await H.selSpan3(0, 4);
    assert.equal(n, 5);
    assert.ok(s.log.indexOf('pw-click') < 0, '还在点 Playwright 首张：' + JSON.stringify(s.log));
    assert.ok(s.log.indexOf('pw-shift') < 0, '还在点 Playwright Shift：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('selSpan3 多张：合成 Shift 无效时退回 Playwright Shift', async () => {
  const s = selScene({ first: 0, last: 4, fastTap: true, fastShift: false, slowWorks: true });
  try {
    const n = await H.selSpan3(0, 4);
    assert.equal(n, 5);
    assert.ok(s.log.indexOf('pw-shift') >= 0, '没有兜底 Shift：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('selSpan3 多张：合成首张选中无效时退回 Playwright select-button', async () => {
  const s = selScene({ first: 0, last: 2, fastTap: false, fastShift: false, slowWorks: true });
  try {
    const n = await H.selSpan3(0, 2);
    assert.equal(n, 3);
    assert.ok(s.log.indexOf('pw-btn') >= 0, '没有兜底 select-button：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('selSpan3 单张：合成点选成功即返回', async () => {
  const s = selScene({ first: 0, last: 0, fastTap: true });
  try {
    assert.equal(await H.selSpan3(3, 3), 1);
    assert.ok(s.log.indexOf('pw-btn') < 0, '慢路径不该被用到：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('selSpan3 单张：页面已显示选中但计数读到 0，不能再点一次（会取消选中）', async () => {
  const s = selScene({ first: 0, last: 0, fastTap: true });
  const realCount = H.selCount2;
  H.selCount2 = async () => 0;   // 模拟计数慢一拍：页面 checked 已生效，但读数还是 0
  try {
    const n = await H.selSpan3(0, 0);
    assert.equal(n, 1, '应信任页面状态并返回 1');
    assert.equal(s.log.filter((x) => x === 'pw-btn').length, 0, '又点了一次 select-button：' + JSON.stringify(s.log));
  } finally { H.selCount2 = realCount; restore(); }
});

// genPreview2 场景
function gpScene({ open = [true], badSeq = [4, 0], dialog = false, jsNoop = false } = {}) {
  const log = [];
  let mi = 0, bi = 0;
  H.G = (fn) => fn();
  H.sleep = async () => {};
  H.PW = () => ({
    getByRole: () => ({ first: () => ({ click: async () => { log.push('pw-gen'); }, isVisible: async () => false }) }),
    locator: () => ({ first: () => ({ click: async () => { log.push('pw-confirm'); } }) }),
    waitForTimeout: async () => {}
  });
  H.grid = () => ({
    nth: (i) => ({
      scrollIntoViewIfNeeded: async () => {},
      click: async (o) => { log.push(o && o.button === 'right' ? 'pw-rclick' : 'pw-click'); },
      evaluate: async () => true
    })
  });
  H.menuInfo = async () => ({ open: !!open[Math.min(mi++, open.length - 1)], hasGen: true });
  // 这些用例专门验证「右键菜单」那条慢路径，所以显式让工具条快路不存在
  // （工具条生效/退回的行为由 test_toolbar_gen.mjs 覆盖）。
  H.genToolbar = async () => { log.push('tb-none'); return 'no-btn'; };
  H.clickGen = async () => { log.push('js-gen'); return jsNoop ? 'no-btn' : 'clicked'; };
  H.brokenCount = async () => badSeq[Math.min(bi++, badSeq.length - 1)];
  H.dialogOpen = async () => dialog;
  H.dismissDialog = async () => { log.push('dismiss'); };
  return { log };
}

const PS = [{ broken: true, id: '1', checked: true }, { broken: true, id: '2', checked: true }];

await test('genPreview2：JS 点「生成预览」后坏图数下降，直接成功', async () => {
  const s = gpScene({ badSeq: [2, 0] });
  try {
    const r = await H.genPreview2(PS);
    assert.equal(r.ok, true);
    assert.ok(s.log.indexOf('js-gen') >= 0);
    assert.ok(s.log.indexOf('pw-gen') < 0, '慢路径不该被用到：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('genPreview2：JS 点击无效（坏图数不变）时退回 Playwright 点菜单按钮', async () => {
  const s = gpScene({ badSeq: [2, 2] });
  try {
    const r = await H.genPreview2(PS);
    assert.equal(r.ok, true);
    assert.ok(s.log.indexOf('js-gen') >= 0);
    assert.ok(s.log.indexOf('pw-gen') >= 0, '没有兜底：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('genPreview2：出现「确定」弹窗判为配额拒绝并点掉', async () => {
  const s = gpScene({ dialog: true });
  try {
    const r = await H.genPreview2(PS);
    assert.equal(r.ok, false);
    assert.equal(r.dialog, true);
    assert.ok(s.log.indexOf('dismiss') >= 0, '没点掉弹窗');
    assert.ok(s.log.indexOf('pw-gen') < 0, 'JS 点击已经弹出配额框，不该再点一次');
  } finally { restore(); }
});

await test('genPreview2：菜单一直打不开时返回 no-menu', async () => {
  const s = gpScene({ open: [false] });
  try {
    const r = await H.genPreview2(PS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-menu');
    assert.equal(s.log.filter((x) => x === 'pw-rclick').length, 3, '应该依次试三个候选');
  } finally { restore(); }
});

await test('H.sleep 是本地的，不走 PW', async () => {
  let touched = false;
  const origPW = H.PW;
  H.PW = () => { touched = true; throw new Error('should not touch page'); };
  try {
    const t = Date.now();
    await ORIG.sleep.call(H, 40);
    const dt = Date.now() - t;
    assert.equal(touched, false, 'sleep 碰了页面');
    assert.ok(dt >= 30 && dt < 1000, 'sleep 时长不对: ' + dt);
  } finally { H.PW = origPW; restore(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
