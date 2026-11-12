// 弹窗护栏测试（2026-11-12「在删除之前启用回收站」事件后新增）。
// 老实现的两条致命路径：
//   ① dialogOpen / dismissDialog 对整份 document 扫第一个「确定」按钮并直接点 —— 删除确认框的按钮就是它；
//   ② genPreview2 右键失败分支 `continue` 不关残留菜单 —— 菜单第一项是「删除」，下一次点击可能落在上面。
// 钉住的不变量：库里**没有任何一条路径**会因为「看见确定按钮」就去点它；
// 只有关闭配额弹窗（文案同时命中「生成预览」与「最多可以新增」）这一个动作允许点按钮。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H, L = globalThis.__LED;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const KEYS = ['G', 'PW', 'grid', 'sleep', 'snap', 'parse', 'goto', 'dialogTexts', 'menuInfo', 'clickGen',
  'genToolbar', 'brokenCount', 'selSpan3', 'genPreview2', 'clearSel', 'sizeSmall', 'pageDown', 'dialogGate'];
const ORIG = {};
KEYS.forEach((k) => { ORIG[k] = H[k]; });
function restore() { Object.assign(H, ORIG); }

const QUOTA = '您每个空间最多可以新增120个项目以生成预览';
const DANGER = '在删除之前启用回收站 File Station 中的回收站可让您恢复从 Synology Photo 删除的项目';

/* ---------- 1. 纯函数分类 ---------- */

await test('classifyDialog：空文案判 none', async () => {
  assert.equal(H.classifyDialog(''), 'none');
  assert.equal(H.classifyDialog('   \n  '), 'none');
  assert.equal(H.classifyDialog(null), 'none');
});

await test('classifyDialog：配额弹窗判 quota（这是唯一允许点确定的）', async () => {
  assert.equal(H.classifyDialog(QUOTA), 'quota');
  assert.equal(H.classifyDialog('提示 每个空间最多 120 个待处理预览任务 生成预览'), 'quota');
});

await test('classifyDialog：删除/回收站类文案判 danger', async () => {
  assert.equal(H.classifyDialog(DANGER), 'danger');
  assert.equal(H.classifyDialog('确定要删除这 3 个项目吗？'), 'danger');
  assert.equal(H.classifyDialog('是否将其移除出共享空间'), 'danger');
  assert.equal(H.classifyDialog('确认注销当前账号？'), 'danger');
  assert.equal(H.classifyDialog('Are you sure you want to delete these items?'), 'danger');
});

await test('classifyDialog：危险词优先于配额判据（宁可不关，不可误点）', async () => {
  assert.equal(H.classifyDialog('每个空间最多可以新增120个项目以生成预览，超出将删除已有任务'), 'danger');
});

await test('classifyDialog：认不出的弹窗判 other（同样拦停，不点按钮）', async () => {
  assert.equal(H.classifyDialog('Synology Image Assistant 正在生成预览图'), 'other');
  assert.equal(H.classifyDialog('存储空间已满'), 'other');
});

/* ---------- 2. 可见性 / 分类闸 ---------- */

const textsStub = (arr) => { H.dialogTexts = async () => arr.slice(); };

await test('dialogOpen 只对配额弹窗返回 true：danger / other / 无弹窗都是 false', async () => {
  textsStub([DANGER]); assert.equal(await H.dialogOpen(), false, '删除弹窗被当成可点的配额弹窗');
  textsStub(['存储空间已满']); assert.equal(await H.dialogOpen(), false);
  textsStub([]); assert.equal(await H.dialogOpen(), false);
  textsStub([QUOTA]); assert.equal(await H.dialogOpen(), true);
});

await test('visibleDialog：同时有危险与配额时按 danger 报', async () => {
  textsStub([QUOTA, DANGER]);
  assert.equal((await H.visibleDialog()).kind, 'danger');
});

await test('dialogGate：danger 与 other 拦停，quota 与 none 放行', async () => {
  textsStub([DANGER]); assert.equal((await H.dialogGate()).ok, false);
  textsStub(['不认识的东西']); assert.equal((await H.dialogGate()).ok, false);
  textsStub([QUOTA]); assert.equal((await H.dialogGate()).ok, true);
  textsStub([]); assert.equal((await H.dialogGate()).ok, true);
});

/* ---------- 3. dismissDialog 只碰配额弹窗内部的按钮 ---------- */

await test('dismissDialog：danger 弹窗连页面都不进（一次 evaluate 都不发）', async () => {
  textsStub([DANGER]);
  let calls = 0;
  H.G = (fn) => { calls++; return fn(); };
  H.PW = () => ({ locator: () => ({ evaluate: async () => { calls++; return true; } }) });
  const r = await H.dismissDialog();
  assert.equal(r.clicked, false);
  assert.equal(r.kind, 'danger');
  assert.equal(calls, 0, '危险弹窗下不该向页面发点击源码：calls=' + calls);
});

// 真跑一遍 dismissDialog 生成的页内源码：假 DOM 里既有「配额弹窗内的确定」也有「弹窗外的确定」，
// 只有前者允许被点。这一条直接钉住「不再全表扫 document 的确定按钮」。
function fakeDom({ quota = false, danger = false }) {
  const mk = (text, vis, btns) => ({
    _text: text, _vis: vis,
    getBoundingClientRect: () => ({ width: vis ? 400 : 0, height: vis ? 300 : 0 }),
    textContent: text,
    querySelectorAll: (sel) => (sel === 'button' ? btns : []),
    parentElement: null
  });
  const inside = { textContent: '确定', n: 0, click() { this.n++; } };
  const outside = { textContent: '确定', n: 0, click() { this.n++; } };
  const nodes = [];
  if (quota) nodes.push(mk(QUOTA, true, [inside]));
  if (danger) nodes.push(mk(DANGER, true, [inside]));
  // 关掉但没卸载的门户：宽 0，必须被 vis() 挡掉
  nodes.push(mk('已关闭的残留弹窗 ' + QUOTA, false, [inside]));
  return { nodes, inside, outside };
}

await test('dismissDialog：只点配额弹窗内部的确定，弹窗外的确定一个不碰', async () => {
  textsStub([QUOTA]);
  const dom = fakeDom({ quota: true });
  globalThis.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  globalThis.document = { querySelectorAll: () => dom.nodes };
  let src = null;
  H.G = (fn) => fn();
  H.PW = () => ({
    locator: () => ({
      evaluate: async (code) => {
        src = code;
        // 页内求值契约：源码字符串求值后得到函数，再由调用方执行（shim 就是这么做的）。
        // new Function 只吃我们自己的库生成的常量源码，不引入任何外部输入。
        const make = new Function('window', 'document', 'return ' + code);
        return make(globalThis.window, globalThis.document)();
      }
    })
  });
  try {
    const r = await H.dismissDialog();
    assert.equal(r.clicked, true, '没点到配额弹窗的确定');
    assert.equal(dom.inside.n, 1);
    assert.equal(dom.outside.n, 0);
    assert.ok(src.indexOf('want') >= 0 && src.indexOf(JSON.stringify(QUOTA).slice(0, 12)) >= 0,
      '页内源码没按文案定位对话框：' + String(src).slice(0, 120));
    assert.ok(/getBoundingClientRect/.test(src), '页内源码没做可见性判定');
  } finally { delete globalThis.window; delete globalThis.document; }
});

await test('dismissDialog：危险弹窗在场时，即便页面上有确定按钮也不点', async () => {
  textsStub([DANGER]);
  const dom = fakeDom({ danger: true });
  globalThis.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  globalThis.document = { querySelectorAll: () => dom.nodes };
  H.G = (fn) => fn();
  H.PW = () => ({ locator: () => ({ evaluate: async () => { throw new Error('不该向页面发点击源码'); } }) });
  try {
    const r = await H.dismissDialog();
    assert.equal(r.clicked, false);
    assert.equal(dom.inside.n, 0, '点了删除弹窗的确定按钮');
  } finally { delete globalThis.window; delete globalThis.document; }
});

/* ---------- 4. dismissMenu：右键菜单必须关掉 ---------- */

await test('dismissMenu 按 Escape 关掉右键菜单', async () => {
  const log = [];
  H.G = (fn) => fn();
  H.PW = () => ({ locator: () => ({ press: async (k) => { log.push('press:' + k); } }) });
  H.sleep = async () => {};
  await H.dismissMenu();
  assert.deepEqual(log, ['press:Escape']);
});

await test('dismissMenu 吞掉传输层报错，不打断跑批', async () => {
  H.G = () => { throw new Error('CDP timeout'); };
  H.sleep = async () => {};
  await H.dismissMenu();   // 不抛即通过
});

await test('genPreview2：菜单打开但没有「生成预览」→ 关掉菜单再换候选', async () => {
  const log = [];
  H.G = (fn) => fn();
  H.sleep = async () => {};
  H.PW = () => ({
    locator: () => ({ evaluate: async () => ({}), press: async (k) => { log.push('press:' + k); } }),
    getByRole: () => ({ first: () => ({ click: async () => {} }) })
  });
  H.grid = () => ({ nth: () => ({ scrollIntoViewIfNeeded: async () => {}, click: async (o) => { if (o && o.button === 'right') log.push('rclick'); } }) });
  H.genToolbar = async () => 'no-btn';
  H.menuInfo = async () => ({ open: true, hasGen: false });   // 每次都开到「只有删除」的菜单
  H.brokenCount = async () => 0;
  const r = await H.genPreview2([{ idx: 0, id: 7, broken: true, checked: true }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-menu');
  assert.ok(log.filter((x) => x === 'press:Escape').length >= 3, '残留菜单没关：' + JSON.stringify(log));
});

await test('genPreview2：工具条点完没效果、页上挂着危险弹窗 → 绝不再走右键', async () => {
  textsStub([DANGER]);
  const log = [];
  H.G = (fn) => fn();
  H.sleep = async () => {};
  H.PW = () => ({
    locator: () => ({ evaluate: async () => ({}), press: async () => {} }),
    getByRole: () => ({ first: () => ({ click: async () => {} }) })
  });
  H.grid = () => ({ nth: () => ({ scrollIntoViewIfNeeded: async () => {}, click: async (o) => { if (o && o.button === 'right') log.push('rclick'); } }) });
  H.genToolbar = async () => 'clicked';
  H.brokenCount = async () => 30;      // 点了没效果 → 会往慢路走
  H.menuInfo = async () => ({ open: true, hasGen: true });
  H.clickGen = async () => 'clicked';
  const r = await H.genPreview2(Array.from({ length: 3 }, (_, i) => ({ idx: i, id: 10 + i, broken: true, checked: true })));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dialog-blocking');
  assert.equal(log.indexOf('rclick'), -1, '危险弹窗在场还去右键：' + JSON.stringify(log));
});

/* ---------- 5. pumpX2 的提交前闸 ---------- */

const dirty = (n) => Array.from({ length: n }, (_, i) => ({ id: 'x' + i, broken: true, loaded: false }));

function pumpScene(gateOk) {
  const log = [];
  L.folders = { '9001': { id: '9001', name: '测试目录', total: 5 } };
  L.res2 = {}; L.vDone = {}; L.subm = {}; L.stuckIds = {}; L.tr = []; L.totSent = 0; L.pendingSamples = [];
  H.G = (fn) => fn();
  H.sleep = async () => {};
  H.goto = async () => {};
  H.snap = async () => 'snap';
  H.parse = () => dirty(5);
  H.sizeSmall = async () => {};
  H.pageDown = async () => {};
  H.clearSel = async () => { log.push('clearSel'); };
  H.dialogGate = async () => (gateOk ? { ok: true, kind: 'none', texts: [] } : { ok: false, kind: 'danger', texts: [DANGER] });
  H.selSpan3 = async () => { log.push('selSpan3'); return 5; };
  H.genPreview2 = async () => { log.push('genPreview2'); return { ok: true, via: 'toolbar', dialog: false }; };
  return { log };
}

await test('pumpX2：页面有危险弹窗时一张都不点，且不标 done', async () => {
  const s = pumpScene(false);
  try {
    const r = await H.pumpX2('9001', 120000);
    assert.equal(r.blocked, 'dialog-blocking');
    assert.equal(r.sent, 0);
    assert.equal(r.done, false, '被弹窗拦住却标了 done');
    assert.equal(r.clean, false);
    assert.equal(r.dialog, 'danger');
    assert.equal(s.log.indexOf('selSpan3'), -1, '还是去点选了：' + JSON.stringify(s.log));
    assert.equal(s.log.indexOf('genPreview2'), -1);
  } finally { restore(); }
});

await test('pumpX2：没有弹窗时正常提交（护栏不放行就等于没修好）', async () => {
  const s = pumpScene(true);
  try {
    const r = await H.pumpX2('9001', 120000);
    assert.equal(r.blocked, null, JSON.stringify(r));
    assert.ok(r.sent > 0, '没提交：' + JSON.stringify(s.log));
    assert.ok(s.log.indexOf('selSpan3') >= 0 && s.log.indexOf('genPreview2') >= 0);
  } finally { restore(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
