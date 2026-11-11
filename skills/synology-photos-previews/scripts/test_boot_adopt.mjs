// H.boot 的标签页归属测试。
// 现象：node_repl kernel 被回收后 globalThis.__tab 丢失，boot() 里 browser.user.openTabs()
// 只列「未被认领的用户标签页」，之前 claim/创建过的 Photos 标签不在列表里 → 落到 tabs.new()，
// 每格新建一个孤儿 Photos 标签（实测第 2、3 格都返回 created:true）。
// 期望：先认领 openTabs 里唯一匹配的；否则复用活动标签 tabs.selected()（URL 命中 host 才复用）；
// 都不行才新建。绝不能因为列表为空就无脑开新标签。
import assert from 'node:assert/strict';

const LIB = './synophotos_lib.mjs';
await import(LIB + '?t=' + Date.now());
const H = globalThis.__H, CFG = globalThis.__CFG;
CFG.host = 'nas.example:5001';
CFG.base = 'https://' + CFG.host + '/?launchApp=SYNO.Foto.AppInstance';
CFG.route = (id) => '#/shared_space/folder/' + id;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const PHOTOS_URL = CFG.base + CFG.route('4167');
const PORTAL_URL = 'https://' + CFG.host + '/?launchApp=SYNO.SDS.Session';
function fakeTab(url, tag) {
  return {
    tag, url: async () => url, goto: async () => {},
    playwright: { waitForTimeout: async () => {} }
  };
}
// 造一个假 browser：openTabs / claimTab / tabs.new / tabs.selected 全部可观测
function setup(opts) {
  const o = opts || {};
  const calls = { claimed: [], created: 0, selected: 0 };
  const selTab = o.selected === null ? null : (o.selected || fakeTab(PHOTOS_URL, 'active'));
  const newTab = fakeTab(CFG.base + CFG.route(CFG.rootFolder), 'new');
  const browser = {
    user: {
      openTabs: async () => o.userTabs || [],
      claimTab: async (t) => { calls.claimed.push(t.tabId); return fakeTab(t.url, 'claimed'); }
    },
    tabs: {
      new: async () => { calls.created++; return newTab; },
      selected: async () => { calls.selected++; return selTab; }
    }
  };
  if (o.noSelected) delete browser.tabs.selected;
  const agent = { browsers: { list: async () => [{ id: 'b1' }], get: async () => browser } };
  globalThis.__createBrowserAgent = async () => agent;
  return { calls, selTab, newTab, browser, agent };
}

await test('openTabs 为空但活动标签就是 Photos：复用活动标签，不新建', async () => {
  const s = setup({ userTabs: [] });
  const r = await H.boot();
  assert.equal(s.calls.created, 0, '又新建了一个孤儿 Photos 标签');
  assert.ok(r && !r.err, 'boot 返回错误：' + JSON.stringify(r));
  assert.equal(globalThis.__tab, s.selTab, '没有把活动标签设成 __tab');
});

await test('活动标签是 DSM 门户（URL 不含 Photos 路由）：仍然新建', async () => {
  const s = setup({ userTabs: [], selected: fakeTab(PORTAL_URL, 'portal') });
  const r = await H.boot();
  assert.equal(s.calls.created, 1);
  assert.equal(globalThis.__tab, s.newTab);
  assert.equal(r.created, true);
});

await test('openTabs 唯一匹配：优先 claim，不去看 selected', async () => {
  const s = setup({ userTabs: [{ tabId: 't9', title: 'Photos', url: PHOTOS_URL }] });
  const r = await H.boot();
  assert.deepEqual(s.calls.claimed, ['t9']);
  assert.equal(s.calls.created, 0);
  assert.equal(s.calls.selected, 0);
  assert.equal(r.claimed, 'Photos');
});

await test('openTabs 多个匹配：返回 ambiguous，既不 claim 也不新建', async () => {
  const s = setup({ userTabs: [
    { tabId: 't1', title: 'A', url: PHOTOS_URL },
    { tabId: 't2', title: 'B', url: CFG.base + CFG.route('412') }
  ] });
  const r = await H.boot();
  assert.ok(r.ambiguous && r.ambiguous.length === 2);
  assert.equal(s.calls.created, 0);
  assert.deepEqual(s.calls.claimed, []);
});

await test('SDK 没有 tabs.selected：回退新建，不能抛错', async () => {
  const s = setup({ userTabs: [], noSelected: true });
  const r = await H.boot();
  assert.equal(s.calls.created, 1);
  assert.equal(globalThis.__tab, s.newTab);
});

await test('tabs.selected 抛错：回退新建，不能让整个 boot 失败', async () => {
  const s = setup({ userTabs: [] });
  s.browser.tabs.selected = async () => { throw new Error('Tab is not owned by this Turn'); };
  const r = await H.boot();
  assert.ok(r && !r.err, 'selected 抛错不该让 boot 失败：' + JSON.stringify(r));
  assert.equal(s.calls.created, 1);
});

await test('活动标签 URL 读不出来：不复用，新建（不猜）', async () => {
  const s = setup({ userTabs: [] });
  s.selTab.url = async () => { throw new Error('no url'); };
  const r = await H.boot();
  assert.ok(r && !r.err);
  assert.equal(s.calls.created, 1);
  assert.equal(globalThis.__tab, s.newTab);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);