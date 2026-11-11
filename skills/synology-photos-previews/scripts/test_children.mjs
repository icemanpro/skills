// 子目录枚举：必须来自分页 API，不能来自一次 domSnapshot。
// 事故现场（2026-11-11，目录 7227 曹铺站LNG）：API 有 130 个子目录，台账里只有 UI 排序的前 90 个，
// 第 91 个往后一个都没有 —— 文件夹视图只虚拟挂载渲染窗口内的卡片，快照切出来的就是窗口那一段。
// 后果：40 个子目录整支没被访问（1289 条条目 100% 缺缩略图），父目录却照样标 done。
// 同一签名在 2025 的 412（12/20）、2254（64/96）、2750（1/13）上重复出现。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-children-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');
fs.writeFileSync(ledger, JSON.stringify({
  at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {},
  stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}, p2: { done: {} }
}));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED;

const ORIG = {};
function keep(k) { if (!(k in ORIG)) ORIG[k] = H[k]; }
function restore() { Object.assign(H, ORIG); }

// 只替换浏览器边界：apiPost 一次请求；分页/去重/判错用真实实现。
function stubApi(pages) {
  keep('apiPost');
  const calls = [];
  H.apiPost = async (api, params) => {
    calls.push({ api: api, params: Object.assign({}, params) });
    const off = Number(params.offset || 0);
    const idx = Math.floor(off / 100);
    const p = pages[Math.min(idx, pages.length - 1)];
    return typeof p === 'function' ? p(params) : p;
  };
  return calls;
}
const item = (id, name) => ({ id: id, name: '/项目影像资料/影像资料/影像资料-2026年/项目/' + name });
const page = (arr) => ({ success: true, data: { list: arr } });

await test('H.listChildren / H.apiPost 存在', () => {
  assert.equal(typeof H.listChildren, 'function', 'H.listChildren 未实现');
  assert.equal(typeof H.apiPost, 'function', 'H.apiPost 未实现');
});

await test('分页取满：100 + 30 = 130 个子目录，offset 递增', async () => {
  const hundred = []; for (let i = 0; i < 100; i++) hundred.push(item(7000 + i, 'd' + i));
  const thirty = []; for (let i = 0; i < 30; i++) thirty.push(item(7100 + i, 'e' + i));
  const calls = stubApi([page(hundred), page(thirty)]);
  try {
    const r = await H.listChildren('7227');
    assert.equal(r.ok, true, '分页取子目录失败: ' + JSON.stringify(r));
    assert.equal(r.kids.length, 130, '只拿到 ' + r.kids.length + ' 个，窗口外的又丢了');
    assert.equal(calls.length, 2, '请求次数不对: ' + calls.length);
    assert.equal(calls[0].api, 'SYNO.FotoTeam.Browse.Folder', '共享空间必须用 FotoTeam');
    assert.equal(String(calls[0].params.id), '7227');
    assert.equal(String(calls[1].params.offset), '100');
  } finally { restore(); }
});

await test('按 id 去重：翻页重叠不产生重复子目录', async () => {
  const first = []; for (let i = 1; i <= 100; i++) first.push(item(i, 'd' + i));
  stubApi([page(first), page([item(100, 'd100'), item(101, 'd101')])]);   // 第二页重复了 id 100
  try {
    const r = await H.listChildren('9');
    assert.equal(r.ok, true);
    assert.equal(r.kids.length, 101, '重复 id 没去掉: ' + r.kids.length);
    assert.equal(r.kids.filter(k => String(k.id) === '100').length, 1);
    assert.equal(String(r.kids[r.kids.length - 1].id), '101');
  } finally { restore(); }
});

await test('名字取路径末段（台账 path 要用它拼接）', async () => {
  stubApi([page([item(7333, '照片9.19')])]);
  try {
    const r = await H.listChildren('7227');
    assert.equal(r.kids[0].name, '照片9.19');
  } finally { restore(); }
});

await test('API 报错（如 803 未登录）：ok:false，绝不返回半截清单', async () => {
  stubApi([{ success: false, code: 803 }]);
  try {
    const r = await H.listChildren('7227');
    assert.equal(r.ok, false, '接口失败却当成成功，会把整支子目录丢掉');
  } finally { restore(); }
});

await test('翻页上限：一直返回满页时返回 ok:false，不交半截清单', async () => {
  const full = []; for (let i = 0; i < 100; i++) full.push(item(9000 + i, 'x' + i));
  const calls = stubApi([page(full)]);
  try {
    const r = await H.listChildren('7227');
    assert.equal(r.ok, false, '无限满页却当成取完了');
    assert.ok(calls.length <= 41, '请求次数失控: ' + calls.length);
  } finally { restore(); }
});

/* ---------- processTree 集成：窗口只有 90 张卡片，API 有 130 个子目录 ---------- */

function snapZones(ids) {
  return ids.map(id => 'folder-draggable-zone-' + id + '" class="x"><div class="synofoto-folder-name">d' + id + '</div>').join('\n');
}
function stubTree(o) {
  ['goto', 'waitRender', 'snap', 'st', 'persist', 'sleep', 'submitAndDrain', 'drainNode', 'apiPost'].forEach(keep);
  const seen = { goto: [], persist: [] };
  let cur = String(o.root);
  H.goto = async (id) => { cur = String(id); seen.goto.push(cur); };
  globalThis.__tab = { url: async () => 'https://test/?launchApp=SYNO.Foto.AppInstance#/shared_space/folder/' + cur };
  const atRoot = () => cur === String(o.root);
  const n = () => (atRoot() ? o.domIds.length : 0);
  H.waitRender = async () => ({ ok: true, st: { all: 0, loaded: 0, bad: 0, nosrc: 0, folders: n(), total: n(), checked: 0, emptyView: false } });
  H.snap = async () => (atRoot() ? snapZones(o.domIds) : '');
  H.st = async () => ({ all: 0, loaded: 0, bad: 0, nosrc: 0, folders: n(), total: n(), checked: 0 });
  H.persist = async (tag) => { seen.persist.push(tag); return true; };
  H.sleep = async () => {};
  H.submitAndDrain = async () => ({ r: { sent: 0 }, dr: { reason: 'empty' }, pause: null, submitted: 0 });
  H.drainNode = async () => ({ pause: null });
  H.apiPost = async (api, params) => {
    if (String(params.id) !== String(o.root)) return page([]);
    const off = Number(params.offset || 0);
    const slice = o.apiIds.slice(off, off + 100);
    return page(slice.map(id => item(id, 'd' + id)));
  };
  L.__loadedAt = Date.now();
  L.treeStack = []; L.folders = {}; L.vDone = {}; L.needDrain = {}; L.res2 = {}; L.retry = {};
  return seen;
}

await test('窗口只挂载 90 张卡片时，130 个子目录一个都不能少（7227 事故复现）', async () => {
  const apiIds = []; for (let i = 0; i < 130; i++) apiIds.push(7229 + i);
  const domIds = apiIds.slice(0, 90);           // 渲染窗口只有前 90 个
  stubTree({ root: 7227, apiIds: apiIds, domIds: domIds });
  try {
    const r = await H.processTree('7227', { path: '项目', deadline: Date.now() + 400000 });
    assert.equal(r.done, true, '没有跑完: ' + JSON.stringify(r));
    const missing = apiIds.filter(id => !L.vDone[String(id)]);
    assert.equal(missing.length, 0, '有 ' + missing.length + ' 个子目录没被访问（窗口外整支丢失）: ' + missing.slice(0, 5).join(','));
  } finally { restore(); }
});

await test('子目录 API 失败：暂停 CHILDREN_API，父目录绝不标 done', async () => {
  const apiIds = []; for (let i = 0; i < 5; i++) apiIds.push(8000 + i);
  stubTree({ root: 7999, apiIds: apiIds, domIds: apiIds });
  H.apiPost = async () => ({ success: false, code: 803 });
  try {
    const r = await H.processTree('7999', { path: '项目', deadline: Date.now() + 400000 });
    assert.equal(r.paused, true, '接口失败还继续跑: ' + JSON.stringify(r));
    assert.equal(r.err, 'CHILDREN_API');
    assert.equal(L.vDone['7999'], undefined, '枚举失败却把父目录标完成');
  } finally { restore(); }
});

await test('快照里有 API 没返回的子目录：暂停 CHILDREN_MISMATCH，不静默采信任何一方', async () => {
  const apiIds = [8100, 8101];
  stubTree({ root: 8099, apiIds: apiIds, domIds: [8100, 8101, 8102] });
  try {
    const r = await H.processTree('8099', { path: '项目', deadline: Date.now() + 400000 });
    assert.equal(r.paused, true, '两边对不上还继续跑: ' + JSON.stringify(r));
    assert.equal(r.err, 'CHILDREN_MISMATCH');
    assert.equal(L.vDone['8099'], undefined);
  } finally { restore(); }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
