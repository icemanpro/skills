// Synology Photos 预览重建 · 常驻 node_repl 库
// 装载方式二选一（都跑在 browser-use 的持久 kernel 里）：
//   A. 把本文件内容整体作为一个 node_repl cell 的 code 提交；
//   B. 用动态 import 装载省 token：
//      globalThis.__bua = await import('@qoder-space/browser-use');
//      await import('file:///<本 skill 目录>/scripts/synophotos_lib.mjs');
//      nodeRepl.write(Object.keys(globalThis.__H).length);
//   （B 必须在 cell 里先注入 __bua：模块自身无法解析裸包名。）
// 装载后 H / L / CFG 挂在 globalThis.__*，后续 cell 用 `var H=globalThis.__H` 取用。
// 注意：cell 内 var 绑定跨 turn 会丢，只有 globalThis.__* 能存活；新 turn 需要重新 boot() 标签页。

var guardImpl = (typeof nodeRepl !== 'undefined' && nodeRepl.signal && nodeRepl.signal.guardAwait)
  ? (f => nodeRepl.signal.guardAwait(f())) : (f => f());
var say = (typeof nodeRepl !== 'undefined' && nodeRepl.write) ? nodeRepl.write : (s => s);

// 配置解析顺序：globalThis.__CFG（装载前设置，可只给部分字段）
//   > 环境变量 SYNOPHOTOS_HOST / SYNOPHOTOS_LEDGER > 内置默认。
// host 没有默认值，必须配置（未配置时 boot 返回 NO_HOST）；
// 台账默认落在 <用户名>/Documents/synology-previews/ledger.json。
var CFG = globalThis.__CFG || {};
var __env = function (k) { return (typeof process !== 'undefined' && process.env && process.env[k]) || ''; };
var __home = (__env('USERPROFILE') || __env('HOME') || '.').replace(/\\/g, '/');
var __defaults = {
  host: __env('SYNOPHOTOS_HOST') || '',                           // 必填：DSM 地址（含 HTTPS 端口）
  app: 'SYNO.Foto.AppInstance',
  space: 'shared_space',                                          // 共享空间；个人空间把 space 改成 ''
  rootFolder: '1',                                                // 共享空间根目录 id
  ledger: __env('SYNOPHOTOS_LEDGER') || (__home + '/Documents/synology-previews/ledger.json'),
  quota: 120,                                                     // 每空间待处理预览上限
  cap: 110                                                        // 单批上限，留余量给配额
};
Object.keys(__defaults).forEach(function (k) { if (CFG[k] == null) CFG[k] = __defaults[k]; });
globalThis.__CFG = CFG;
CFG.base = 'https://' + CFG.host + '/?launchApp=' + CFG.app;
CFG.route = id => '#/' + (CFG.space ? CFG.space + '/' : '') + 'folder/' + id;

var H = globalThis.__H = {};
var L = globalThis.__LED = globalThis.__LED || {
  folders: {}, res2: {}, subm: {}, stuckIds: {}, vDone: {}, tr: [], retry: {}, needDrain: {},
  totSent: 0, vQueue: [], pendingSamples: []
};
// 复用一个已被旧版引擎建好的 L 时补齐缺字段（跨 turn 存活的全局可能少了新版本字段）
L.folders = L.folders || {}; L.res2 = L.res2 || {}; L.subm = L.subm || {}; L.stuckIds = L.stuckIds || {};
L.vDone = L.vDone || {}; L.tr = L.tr || []; L.retry = L.retry || {}; L.vQueue = L.vQueue || [];
L.pendingSamples = L.pendingSamples || []; L.aud = L.aud || {}; L.needDrain = L.needDrain || {};
L.headAudit = L.headAudit || {};                     // 逐项 HEAD 审计证据（附加字段，persist 会一起落盘）
L.p2 = L.p2 || {}; L.p2.done = L.p2.done || {};      // 第二轮复检游标（必须落盘，见 test_persist_p2.mjs）

/* ---------- 连接与导航 ---------- */

H.G = guardImpl;
H.PW = () => globalThis.__tab.playwright;
H.snap = async () => String(await H.G(() => H.PW().domSnapshot({ depth: 90 })));

// 接管已登录标签页；不唯一时返回候选让上层决定，绝不猜 id
H.boot = async function (factory) {
  // host 必填闸：发布版不带任何默认 NAS 地址，未配置直接报错，绝不静默指向别人的机器
  if (!CFG.host) return { err: 'NO_HOST', hint: '设 globalThis.__CFG.host="<NAS>:<端口>"（或环境变量 SYNOPHOTOS_HOST）后重试' };
  var create = factory || globalThis.__createBrowserAgent || (globalThis.__bua && globalThis.__bua.createBrowserAgent);
  if (!create) {
    try { var mod = await import('@qoder-space/browser-use'); create = mod.createBrowserAgent; }
    catch (e) { return { err: 'NO_BROWSER_MODULE', why: String((e && e.message) || e).slice(0, 120) }; }
  }
  globalThis.__createBrowserAgent = create;
  var agent = globalThis.__agent = await create();
  var list = await agent.browsers.list();
  if (!list || !list.length) return { err: 'NO_BROWSER', hint: '启用浏览器连接并连接 Qoder Browser Connector' };
  var browser = globalThis.__browser = await agent.browsers.get(list[0].id);
  var mine = [];
  try {
    var userTabs = await browser.user.openTabs();
    mine = userTabs.filter(t => String(t.url || '').indexOf(CFG.host) >= 0);
  } catch (e) { /* 没有可接管的标签页 */ }
  if (mine.length > 1) return { ambiguous: mine.map(t => ({ id: t.tabId, title: t.title, url: t.url })) };
  if (mine.length === 1) { globalThis.__tab = await browser.user.claimTab(mine[0]); return { claimed: mine[0].title }; }
  // openTabs() 只列「未被认领的用户标签」：claim 过或本库新建过的 Photos 页不会再出现。
  // kernel 被回收后 __tab 丢失，若直接 tabs.new() 就会每格多一个孤儿 Photos 标签，
  // 而扩展只在活动页转换 —— 多标签会互相抢活动态。先复用命中的活动标签。
  try {
    var sel = browser.tabs.selected ? await browser.tabs.selected() : null;
    if (sel) {
      var selUrl = '';
      try { selUrl = String(await sel.url()); } catch (e) { selUrl = ''; }
      // 只认同 host 还不够：DSM 门户页也是同一个 host，接管它会把整格导航跑偏。
      var isPhotos = selUrl.indexOf(CFG.app) >= 0 ||
        selUrl.indexOf('#/' + (CFG.space ? CFG.space + '/' : '') + 'folder/') >= 0;
      if (selUrl.indexOf(CFG.host) >= 0 && isPhotos) { globalThis.__tab = sel; return { adopted: selUrl }; }
    }
  } catch (e) { /* SDK 无 selected 或标签已失效：走新建 */ }
  var tab = globalThis.__tab = await browser.tabs.new();
  await tab.goto(CFG.base + CFG.route(CFG.rootFolder));
  await H.sleep(4000);
  return { created: true };
};

H.nav = async function (id) {
  await H.G(() => globalThis.__tab.goto(CFG.base + CFG.route(id)));
};

H.goto = async function (id) {
  await H.nav(id);
  await H.sleep(3200);
  await H.G(() => H.PW().locator('body').press('Escape')).catch(() => {});
};

/* ---------- 前台闸门（提交之前必须过） ----------
 * 扩展只在「可见」的标签页里转换。2026-11-11 10:20 用户切去别的站点，visibilityState=hidden，
 * 之后 4 个目录全部 stalled（loaded 0/7、0/19、0/12），每目录白烧 115–180s 还挤占空间配额。
 * 更隐蔽的一种：Photos 是选中页、hasFocus=true，但窗口被别的窗口完全盖住 ⇒ 仍然 hidden
 *（Chrome 的原生窗口遮挡计算）。SDK 侧无解，只能重启 Chrome 时关掉该特性，见 references/runbooks.md。
 * 最小化 / 切到别的标签页同样会 hidden，所以这道闸要一直留着：不可见就收尾回报，绝不提交。 */
H.visibility = async function () {
  return String(await H.G(() => H.PW().locator('body').evaluate('() => document.visibilityState')));
};

// 轮询等前台。opts: probe/sleep（可注入，便于测试）、waitMs（默认 240s）、pollMs（默认 10s）。
// 轮询次数由 waitMs/pollMs 封顶：探针抛错或时钟不走也不会死循环。
// 返回 {ok, vis, waited, polls}；ok:false 时 reason='tab-hidden'，调用方必须收尾而不是提交。
H.foregroundGate = async function (opts) {
  var o = opts || {};
  var probe = o.probe || H.visibility, sleep = o.sleep || H.sleep;
  var waitMs = o.waitMs == null ? 240000 : Number(o.waitMs);
  var pollMs = Math.max(1, o.pollMs == null ? 10000 : Number(o.pollMs));
  var maxPolls = Math.max(1, Math.ceil(waitMs / pollMs));   // 预算为 0 也要先探一次
  var t0 = Date.now(), polls = 0, vis = 'err';
  for (;;) {
    polls++;
    try { vis = String(await probe()); } catch (e) { vis = 'err'; }
    if (vis === 'visible') return { ok: true, vis: vis, waited: Date.now() - t0, polls: polls };
    if (polls >= maxPolls) return { ok: false, vis: vis, reason: 'tab-hidden', waited: Date.now() - t0, polls: polls };
    await sleep(pollMs);
  }
};

/* 图片状态安定闸门（第二遍扫描的干净判据必须过这一关）。
 * 实测（2026-11-11，同一台 5754）：导航后卡片 ~1.3s 就出现在 DOM 里，但「坏图」标记
 * 要等图片请求超时/失败才挂上，时间线是
 *   2705  645ms 0/0/0 → 1320ms all12 bad0 → 1934ms all12 bad12
 *   2711  649ms 0/0/0 → 1272ms all43 bad0 → 1904ms all43 bad22 → 2536ms all43 bad43
 * 所以「读到 bad=0」有两种完全不同的含义：真的干净 / 还没判出来。只看 bad 会把整个目录
 * 误标 done（H.goto 里那 3.2s 固定等待就是为这个存在的，别去掉）。
 * 安定判据：渲染出来的每张卡片都有确定状态（bad + loaded >= all），且渲染数不小于目录总数
 *（虚拟化只画前 ~100 张，剩下没画的一律算不安定，交给 pumpX2 的多窗口）。
 * 预算用完仍不安定 → settled:false，上层绝不标 done。 */
H.stSettled = async function (opts) {
  opts = opts || {};
  var exp = opts.expectTotal, dl = opts.deadline == null ? Date.now() + 6000 : opts.deadline;
  var maxMs = opts.maxMs == null ? 9000 : opts.maxMs, gap = opts.gapMs == null ? 700 : opts.gapMs;
  var t0 = Date.now(), st = null, reads = 0;
  while (true) {
    st = await H.st(); reads++;
    var rendered = st.all > 0 || st.folders > 0;
    if (!rendered) {
      if (st.total === 0 || st.emptyView) return { settled: true, empty: true, st: st, reads: reads, waited: Date.now() - t0 };
    } else if (st.all === 0 && st.folders > 0) {
      return { settled: true, onlyFolders: true, st: st, reads: reads, waited: Date.now() - t0 };   // 只有子目录，没有可判的图片
    } else {
      var want = st.total != null ? st.total : exp;
      // total 里含子目录卡片，而 all 只数图片卡：必须把 folders 一起算，
      // 否则「少量照片 + 一堆子目录」的目录永远判不安定（实测 3361：all5+folders9 / total14），
      // 上层会把其实干净的目录一路 retry 到标成「仍坏」。
      if ((want == null || st.all + st.folders >= want) && st.bad + st.loaded >= st.all) {
        return { settled: true, st: st, reads: reads, waited: Date.now() - t0 };
      }
    }
    if (reads >= 25 || Date.now() - t0 >= maxMs || Date.now() > dl - 8000) {
      return { settled: false, st: st, reads: reads, waited: Date.now() - t0 };
    }
    await H.sleep(gap);
  }
};

H.pageDown = async function () {
  await H.G(() => H.PW().locator('body').press('PageDown'));
  await H.sleep(1200);
};

/* ---------- 页面判读 ---------- */

H.grid = () => H.PW().locator('[data-testid="file-clickable-area"]');
H.bad = () => H.PW().locator('[data-testid="file-clickable-area"]:has([data-testid="item-image-status"].synofoto-item-image-broken)');
// 坑：一个卡片有 2 个 checked 节点，别用这个计数当卡片数
H.chkNodes = () => H.PW().locator('[data-testid="file-clickable-area"]:has([data-testid="basic-selectable_0"].checked)');
// 每卡片 1 个节点，这才是可信的选中计数
H.selCount = async () => await H.G(() => H.PW().locator('[data-testid="file-clickable-area"]:has(.synofoto-selectable-wrapper.checked)').count());

/* ---------- 热路径原语 ----------
 * 实测（2026-11-10）：这个 shim 的 PW().waitForTimeout 单次往返 ~4.6s、locator.click ~5.4-7s、
 * locator.count ~4.4s，而 page.evaluate 只要 0.2-0.5s；Node 本地 setTimeout 几乎为 0。
 * 一个坏目录 70-90s 里约 44s 花在这些往返上，所以等待一律走 H.sleep，
 * 选中/计数/读菜单改走 evaluate，并且每一处快路失败都必须退回原来的慢路径。 */
H.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
// 注意：这个 shim 的 page.evaluate(fn) 永远返回 null（实测 2026-11-10），
// 页面级求值必须走 pw.locator('body').evaluate(fn)，同步/async 都能拿到真实返回值。

// evaluate 版选中计数：与 H.selCount 同一判据（每卡片一个 checked 节点）
H.selCountFast = async function () {
  var n = await H.G(() => H.PW().locator('body').evaluate(function () {
    var a = document.querySelectorAll('[data-testid="file-clickable-area"]'), c = 0;
    for (var i = 0; i < a.length; i++) if (a[i].querySelector('.synofoto-selectable-wrapper.checked')) c++;
    return c;
  }));
  return Number(n) || 0;
};
H.selCount2 = async function () {
  try { return await H.selCountFast(); } catch (e) { return await H.selCount(); }
};

// 合成点选单张：直接点卡片里的 select-button，并在页面内轮询到 checked 生效（实测 0.3s 内生效）。
// 关键：一旦页面报「已选中」就绝不再点第二次 —— select-button 是开关，重复点会把选中取消掉
// （2026-11-10 实测：单张目录 2501/2509/2526 因此全成 sel-fail）。
H.selTap = async function (i) {
  var r = await H.G(() => H.grid().nth(i).evaluate(async function (el) {
    var on = function () { return !!el.querySelector('.synofoto-selectable-wrapper.checked'); };
    var b = el.querySelector('button[data-testid="select-button"]');
    if (!b) return { ok: on(), why: 'no-btn' };
    if (!on()) b.click();
    for (var k = 0; k < 10; k++) {
      if (on()) return { ok: true, waited: k * 150 };
      await new Promise(function (res) { setTimeout(res, 150); });
    }
    return { ok: on(), why: 'no-change' };
  }));
  return !!(r && r.ok);
};

// 合成 Shift 区间：必须打在 elementFromPoint 命中的内层元素上（打在卡片本身不冒泡到内层处理器）。
// 返回 { ok, n }：n 是页面内读到的选中数，用来判断合成事件是否真的生效。
H.selShift = async function (i) {
  var r = await H.G(() => H.grid().nth(i).evaluate(async function (el) {
    var cnt = function () {
      var a = document.querySelectorAll('[data-testid="file-clickable-area"]'), c = 0;
      for (var k = 0; k < a.length; k++) if (a[k].querySelector('.synofoto-selectable-wrapper.checked')) c++;
      return c;
    };
    var n0 = cnt();
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var tgt = document.elementFromPoint(x, y) || el;
    var o = { bubbles: true, cancelable: true, shiftKey: true, view: window, clientX: x, clientY: y, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (tp) {
      tgt.dispatchEvent(tp.indexOf('pointer') === 0 ? new PointerEvent(tp, o) : new MouseEvent(tp, o));
    });
    for (var k = 0; k < 8; k++) {
      var n = cnt();
      if (n > n0) return { ok: true, n: n };
      await new Promise(function (res) { setTimeout(res, 150); });
    }
    return { ok: false, n: cnt() };
  }));
  return r || { ok: false, n: 0 };
};

// 读右键菜单：合成 contextmenu 实测打不开（菜单为 null），只能先用 Playwright 右键，再用 evaluate 判读
H.menuInfo = async function () {
  return await H.G(() => H.PW().locator('body').evaluate(function () {
    var m = document.querySelector('.synofoto-right-click-menu');
    if (!m) return { open: false, hasGen: false };
    var b = m.getBoundingClientRect();
    var bs = m.querySelectorAll('button'), gen = false;
    for (var i = 0; i < bs.length; i++) if (String(bs[i].textContent).trim() === '生成预览') gen = true;
    return { open: b.x > 0, hasGen: gen, x: Math.round(b.x), y: Math.round(b.y) };
  }));
};

H.clickGen = async function () {
  return await H.G(() => H.PW().locator('body').evaluate(function () {
    var m = document.querySelector('.synofoto-right-click-menu');
    if (!m) return 'no-menu';
    var bs = m.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (String(bs[i].textContent).trim() === '生成预览') { bs[i].click(); return 'clicked'; }
    return 'no-btn';
  }));
};

H.brokenCount = async function () {
  return Number(await H.G(() => H.PW().locator('body').evaluate(function () {
    return document.querySelectorAll('[data-testid="item-image-status"].synofoto-item-image-broken').length;
  }))) || 0;
};

H.dialogOpen = async function () {
  try {
    return !!(await H.G(() => H.PW().locator('body').evaluate(function () {
      var bs = document.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) if (String(bs[i].textContent).trim() === '确定') return true;
      return false;
    })));
  } catch (e) { return false; }
};

H.dismissDialog = async function () {
  await H.G(() => H.PW().locator('body').evaluate(function () {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (String(bs[i].textContent).trim() === '确定') { bs[i].click(); return true; }
    return false;
  })).catch(() => {});
};
// 一次快照取全部判据：6 次 locator.count 在这个 shim 里太慢，而且要与 pumpX2 的判读源保持一致。
// loaded 才是「预览真的生成完」的信号；bad/nosrc 在点完「生成预览」的同一秒就会归零。
H.st = async function () {
  var s = await H.snap(), ps = H.parse(s);
  return {
    all: ps.length,
    bad: ps.filter(function (p) { return p.broken; }).length,
    loaded: ps.filter(function (p) { return p.loaded; }).length,
    nosrc: ps.filter(function (p) { return p.noSrc; }).length,
    checked: ps.filter(function (p) { return p.checked; }).length,
    folders: s.split('folder-draggable-zone-').length - 1,
    total: H.totalFrom(s),
    // 真空目录显示「无项目」而不是「0 个项目」（实测 2249），必须认这个标记，否则闸门会永久卡住
    emptyView: s.indexOf('data-testid="empty-view-wrapper"') >= 0
  };
};
H.clearSel = async function () { await H.G(() => H.PW().locator('body').press('Escape')); await H.sleep(500); };
H.totalFrom = function (src) { var m = String(src).match(/(\d+)\s*个项目/); return m ? parseInt(m[1], 10) : null; };
H.totalShown = async () => H.totalFrom(await H.G(() => H.PW().domSnapshot({ depth: 30 })));

// 渲染闸门：URL 对了不代表瓦片好了。实测 goto 后 11s 仍可能 all=0/folders=0 而 total=2。
// 不等就判「空叶子」会把整支子目录静默丢掉（2026-11-08 的 414 事故同类）。
// 返回 ok:false 时上层必须暂停，绝不标 done。
H.waitRender = async function (deadline, graceMs, intMs) {
  var t0 = Date.now(), grace = graceMs == null ? 25000 : graceMs, gap = intMs || 2000, st = null;
  while (true) {
    st = await H.st();
    if (st.all > 0 || st.folders > 0) return { ok: true, st: st, waited: Date.now() - t0 };
    if (st.total === 0 || st.emptyView) return { ok: true, empty: true, st: st, waited: Date.now() - t0 };   // 页面明确显示空（「0 个项目」或「无项目」）
    // total 为 null（还没渲染出计数）或有项目却看不到瓦片：都只能继续等
    if (Date.now() - t0 >= grace || Date.now() > deadline - 60000) {
      return { ok: false, reason: 'not-rendered', st: st, waited: Date.now() - t0 };
    }
    await H.sleep(gap);
  }
};

// 缩略图调小：每进新目录做一次。单窗口容量随视口变化（最大化实测 198，视口变小后同一轮抽样 81/100/143），
// 两次 click 都吞错，所以调完要复测窗口容量，别把 143 当常数。
H.sizeSmall = async function () {
  var pw = H.PW();
  await H.G(() => pw.locator('button[aria-label="更改预览大小"]').first().click({ timeout: 5000 })).catch(() => {});
  await H.sleep(800);
  await H.G(() => pw.locator('[aria-label="small thumbnail size"]').first().click({ timeout: 5000 })).catch(() => {});
  await H.sleep(1500);
  await H.G(() => pw.locator('body').press('Escape')).catch(() => {});
};

H.parse = function (src) {
  var cs = String(src).split('data-testid="file-clickable-area"'), out = [];
  for (var i = 1; i < cs.length; i++) {
    var c = cs[i], seg = c.slice(0, 3000), idm = c.match(/file-draggable-zone-(\d+)/);
    out.push({
      idx: i - 1, id: idm ? idm[1] : null,
      broken: /synofoto-item-image-broken/.test(seg),     // 照片与视频共用该判据
      video: /synofoto-item-image-video/.test(seg),
      loaded: /synofoto-item-image-loaded/.test(seg),
      noSrc: !(/data-testid="item-image"[^>]*src=/.test(seg)),
      checked: /synofoto-selectable-wrapper[^"]*checked/.test(c.slice(0, 1200))
    });
  }
  return out;
};

// 页面改版 / 首次部署时先跑它，确认判据仍能命中，并采样 testid 供子目录选择器固化
H.probe = async function () {
  var s = await H.snap();
  var ids = {}, m, re = /data-testid="([^"]+)"/g;
  while ((m = re.exec(s)) && Object.keys(ids).length < 200) ids[m[1]] = (ids[m[1]] || 0) + 1;
  var ps = H.parse(s);
  return {
    tiles: ps.length,
    broken: ps.filter(p => p.broken).length,
    videos: ps.filter(p => p.video).length,
    noSrc: ps.filter(p => p.noSrc).length,
    totalShown: await H.totalShown().catch(() => null),
    st: await H.st().catch(() => null),
    selCount: await H.selCount().catch(() => null),
    testids: Object.keys(ids).sort()
  };
};

/* ---------- 选择 + 提交 ---------- */

H.selSpan3 = async function (first, last) {
  var pw = H.PW(), g = H.grid();
  await H.clearSel();
  await H.G(() => g.nth(first).scrollIntoViewIfNeeded()).catch(() => {});
  var n = 0;
  // 快路：evaluate 里点 select-button，页面内轮询到 checked；一旦页面确认选中，绝不再点第二次
  var okTap = await H.selTap(first).catch(() => false);
  if (okTap) { n = await H.selCount2(); if (n < 1) n = 1; }   // 计数慢一拍时信任页面状态
  if (n < 1) {
    // 慢路径：Playwright 点 select-button。
    // 单张不能靠 Space：实测（2026-11-10，目录 7047）focus() 之后 document.activeElement 仍是 null，
    // Space 打在 body 上一个也没选中；同页点 select-button 立刻选中。53 个 total=1 的目录因此全成 sel-fail。
    await H.G(() => g.nth(first).locator('button[data-testid="select-button"]').first().click({ force: true, timeout: first === last ? 4000 : 6000 })).catch(() => {});
    await H.sleep(first === last ? 700 : 400);
    n = await H.selCount2();
  }
  if (n < 1) {   // select-button 不可达时退回 focus+Space
    await H.G(() => g.nth(first).focus()).catch(() => {});
    await H.G(() => pw.locator('body').press('Space')).catch(() => {});
    await H.sleep(first === last ? 700 : 600);
    n = await H.selCount2();
  }
  if (n < 1) return 0;
  if (last > first) {
    await H.G(() => g.nth(last).scrollIntoViewIfNeeded()).catch(() => {});
    var sh = await H.selShift(last).catch(() => null);
    if (sh && sh.ok) { var n2 = await H.selCount2(); if (n2 > n) return n2; }   // 合成 Shift 生效
    // 合成 Shift 没生效（或读数是旧值）：退回 Playwright Shift 点击
    await H.G(() => g.nth(last).click({ modifiers: ['Shift'], force: true, timeout: 6000 })).catch(() => {});
    await H.sleep(800);
    return await H.selCount2();
  }
  return n;
};

// 工具条里的「生成预览」：选中之后 DOM 里就存在这个按钮（不在右键菜单里，被 park 在 x=-49992，
// 视觉隐藏但 JS click 有效）。实测（2026-11-11，目录 2709 选 29 张）：点它之后 broken 29→0、
// drain 判 converted 29/29，与右键菜单提交完全等效，却省掉一次 5-7s 的真实右键。
// 只认非菜单里的那个，避免和右键菜单的按钮互相干扰。
H.genToolbar = async function () {
  return await H.G(() => H.PW().locator('body').evaluate(function () {
    var bs = document.querySelectorAll('button'), t = null;
    for (var i = 0; i < bs.length; i++) {
      if (String(bs[i].textContent || '').trim() !== '生成预览') continue;
      if (bs[i].closest && bs[i].closest('.synofoto-right-click-menu')) continue;
      t = bs[i]; break;
    }
    if (!t) return 'no-btn';
    t.click();
    return 'clicked';
  }));
};

// 右键候选必须来自「本批要提交的 broken 下标」，不能用快照里的旧 checked 状态
// 右键菜单只能由 Playwright 的真实右键打开（合成 contextmenu 实测无效）；
// 之后的「读菜单 / 点生成预览 / 判弹窗」全部用 evaluate，省掉每次 2-4s 的往返。
H.genPreview2 = async function (ps) {
  var pw = H.PW(), g = H.grid(), idxs = [];
  ps.forEach(function (p, k) { if (p.broken && p.id) idxs.push(k); });
  if (!idxs.length) ps.forEach(function (p, k) { if (p.checked) idxs.push(k); });
  if (!idxs.length) return { ok: false, reason: 'no-cand' };
  /* 快路：先点工具条按钮。「提交成功」的判据是坏图数低于本批候选数 —— broken class 在提交后
   * 1s 内就会消失。这样安排是为了在按钮不存在时（页面改版/未选中）**一次额外读取都不花**，
   * 直接退回右键路径；点了却没效果（after 不小于候选数）同样退回右键。 */
  var tb = await H.genToolbar().catch(() => 'err');
  if (tb === 'clicked') {
    await H.sleep(900);
    if (await H.dialogOpen()) {           // 配额拒绝：整批被驳回，绝不能再用右键重提一遍
      await H.dismissDialog();
      return { ok: false, dialog: true, via: 'toolbar' };
    }
    var tbBad1 = await H.brokenCount().catch(() => -1);
    if (tbBad1 >= 0 && tbBad1 < idxs.length) return { ok: true, via: 'toolbar', dialog: false };
  }
  var tryIdx = [idxs[0], idxs[idxs.length - 1], idxs[Math.floor(idxs.length / 2)]];
  for (var j = 0; j < tryIdx.length; j++) {
    var t = g.nth(tryIdx[j]);
    await H.G(() => t.scrollIntoViewIfNeeded()).catch(() => {});
    await H.G(() => t.click({ button: 'right', force: true, timeout: 5000 })).catch(() => {});
    await H.sleep(900);
    var mi = await H.menuInfo().catch(() => null);
    if (!mi || !mi.open) continue;                       // x=-50000 表示菜单被 parked，等于没打开
    if (!mi.hasGen) continue;
    var badBefore = await H.brokenCount().catch(() => -1);
    await H.clickGen().catch(() => 'err');
    await H.sleep(900);
    if (await H.dialogOpen()) {   // 配额弹窗：整批已被拒绝
      await H.dismissDialog();
      return { ok: false, dialog: true, usedIndex: tryIdx[j] };
    }
    // 校验「生成预览」真的生效：坏图 class 应当减少；没变就退回 Playwright 点一次（慢但可信）
    var badAfter = await H.brokenCount().catch(() => -1);
    if (badBefore < 0 || badAfter < 0 || badAfter >= badBefore) {
      await H.G(() => pw.getByRole('button', { name: '生成预览', exact: true }).first().click({ timeout: 4000 })).catch(() => {});
      await H.sleep(900);
      if (await H.dialogOpen()) {
        await H.dismissDialog();
        return { ok: false, dialog: true, usedIndex: tryIdx[j] };
      }
    }
    return { ok: true, via: 'menu', usedIndex: tryIdx[j], dialog: false };
  }
  return { ok: false, reason: 'no-menu' };
};

/* ---------- 排空 ---------- */

// 纯判据：null=继续等，否则给出结束原因。
// 坑（实测 folder 4112，16 张坏图）：点完「生成预览」的同一秒 broken class 就消失、src 就有了，
// 但 loaded 只有 2/16。所以 bad===0 / nosrc===0 都不能当完成信号，唯一可信的是 loaded >= all。
H.drainDecide = function (sample, ctx, opts) {
  var st = sample || {}, c = ctx || {}, o = opts || {};
  var all = st.all || 0, loaded = st.loaded || 0, folders = st.folders || 0;
  var elapsed = c.elapsed || 0, total = o.total || 0;
  var maxMs = o.maxMs == null ? 180000 : o.maxMs;
  var minDwell = o.minDwellMs == null ? 8000 : o.minDwellMs;
  var grace = o.renderGraceMs == null ? 20000 : o.renderGraceMs;
  var stallNeed = o.stallNeed == null ? 6 : o.stallNeed;

  // 1) 全部瓦片 loaded，且不是刚提交完的瞬时假信号
  if (all > 0 && loaded >= all && elapsed >= minDwell) return 'converted';

  // 2) 一张图片瓦片都没有：区分「只有子目录的空目录」与「有图但还没渲染出来」
  if (all === 0) {
    if (elapsed < grace) return null;
    if (total === 0) return 'empty';
    if (folders >= total) return 'empty';
    return 'not-rendered';   // 绝不能当成完成
  }

  // 3) 未齐：看 loaded 有没有在推进（旧版看 bad，提交后 bad 恒为 0，永远判不出停滞）
  var h = Array.isArray(c.hist) ? c.hist : [];
  var win = h.slice(-stallNeed).map(function (x) { return (x && x.loaded) || 0; }).concat([loaded]);
  if (win.length > stallNeed) {
    var progressed = false;
    for (var i = 1; i < win.length; i++) { if (win[i] > win[i - 1]) { progressed = true; break; } }
    if (!progressed) return 'stalled';
  }

  if (elapsed > maxMs) return 'timeout';
  return null;
};

// 等当前目录的预览转换真正完成。判据全部交给纯函数 H.drainDecide，便于回归测试。
// 返回 reason ∈ converted | empty | not-rendered | stalled | timeout（不再有 zero：bad=0 不等于完成）
H.drain = async function (maxMs, stallNeed, intMs, opts) {
  var o = opts || {}, t0 = Date.now(), hist = [], gap = intMs || 8000;
  var rule = {
    total: o.total || 0, maxMs: maxMs, stallNeed: stallNeed || 6,
    minDwellMs: o.minDwellMs == null ? 8000 : o.minDwellMs,
    renderGraceMs: o.renderGraceMs == null ? 20000 : o.renderGraceMs
  };
  while (true) {
    var st = await H.st();
    var prev = hist.slice(); hist.push(st); if (hist.length > 60) hist.shift();
    var reason = H.drainDecide(st, { elapsed: Date.now() - t0, hist: prev }, rule);
    if (reason) {
      return {
        reason: reason, bad: st.bad, loaded: st.loaded, all: st.all, nosrc: st.nosrc, folders: st.folders,
        waited: Date.now() - t0, samples: hist.length, hist: hist.map(function (x) { return x.loaded; })
      };
    }
    await H.sleep(gap);
  }
};

// 尾巴预算：外层循环进脏目录之前，用它判断「剩下的窗口够不够跑完这个目录」。
// 成本模型来自实测（满窗 30~38）：脏目录固定开销 ~17s（导航 3.3 + 安定 1 + 选择 4 + 工具条 1.5 + 排空 minDwell 8），
// 之后约 1.1s/张（扩展的转换速率，硬下限）。写死 250s 会让只有几十张图的目录也白占窗口，
// 每格扔掉 ~200s；2026 二轮有 845 个目录要跑，照旧口径要多烧近两小时。
// 地板取 H.smallBudget().window：外层放行的窗口必须真的够内层跑完，
// 小于它等于外层放行、submitAndDrain 自己拒提，白花一次导航。见 scripts/test_tail_reserve.mjs。
// 小目录（一屏装得下）的窗口切分。外层 tailReserve 的地板就是这里的 window，
// 两边必须来自同一个数，否则会出现「外层放行、submitAndDrain 拒提」的饿死
// （2026-11-11 审计 4 实测：2526/2528/2529/2530/2532 五个 1-5 项目录全吃 SUBMIT_BUDGET）。
//   safety  12s：留给 persist + 复验 + 收尾（大目录的 90s 是给弹栈/多轮用的，小目录白占）
//   reserve 20s：drainNode 的最低排空预算（goto 3.3 + minDwell 8 + 至少一轮 8s 轮询）
//   minPump 30s：pumpX2 进窗口前先扣 20s 截止，且 goto/snap 自己就吃掉 3~5s
//   slack    8s：外层判定到内层取时之间真实花掉的几秒（安定闸门、上一次 persist）；
//                没有它，边界上永远差几毫秒被判拒提，等于把饿死又请回来
H.smallBudget = function () {
  var b = { safety: 12000, reserve: 20000, minPump: 30000, slack: 8000 };
  b.window = b.safety + b.reserve + b.minPump + b.slack;   // 派生，别手写第二个数
  return b;
};

H.tailReserve = function (total) {
  var n = Math.min(Math.max(0, Number(total) || 0), 120);   // >120 是大目录，走另一条截止线
  return Math.max(H.smallBudget().window, 20000 + 1200 * n);
};

// processTree 的 enter / exit 共用这一份提交口径，别让两处走偏：
//   atReady：上层刚 goto + 过渲染闸门 + 拍过快照，pumpX2 再导航一次要白烧 ~41s（实测 7333 elapsed 41678）
//   小目录（<=120 项，一屏装得下）按 smallBudget 放行；大目录仍用 90s+120s 的默认口径。
// 不这么做的后果：300s 的格子被前置开销吃掉 41.6s，再扣 210s 只剩 48s 给 pump，
// 而 pumpX2 的预算闸是 budgetMs-20000 ≈ 28s < 41.6s 前置 —— 第一批都没提交就 blocked='budget'。
H.treeSubmitOpts = function (total) {
  var o = { atReady: true };
  if ((Number(total) || 0) <= 120) {
    var b = H.smallBudget();
    o.safety = b.safety; o.reserve = b.reserve; o.minPump = b.minPump;
  }
  return o;
};

// 提交前先预留排空时间。pumpX2 会吃满给它的预算（只在预算末尾留 20s），
// 若按旧写法 pump=deadline-now-90000，排空阶段算出来的预算恰好 ≈20000，
// 会被 `drainBudget > 20000` 挡掉 —— 这就是「提交了却根本没等」的第二条根因。
H.splitBudget = function (deadline, now, opts) {
  var o = opts || {};
  var safety = o.safety == null ? 90000 : o.safety;      // 留给 persist / 弹栈 / 下一格接管
  var reserve = o.reserve == null ? 120000 : o.reserve;  // 留给转换排空
  var cap = o.cap == null ? 420000 : o.cap;
  var minPump = o.minPump == null ? 30000 : o.minPump;
  var left = deadline - now - safety;
  var pump = Math.min(cap, left - reserve);
  return { pump: pump, reserve: reserve, left: left, ok: pump > minPump };
};

// 「这个目录还欠一次排空吗」的唯一判据。零提交 + clean 只说明**渲染窗口内**没有坏图：
// 7979 有 82 项、窗口只挂载 81 张，页面报 clean、台账 drain:converted，而窗外第 82 条
// HEAD sm 连测 3 次都是 404。所以销账必须要求整页覆盖（win >= total），
// 或者根本没有可转换的图（noTiles / total===0）。拿不到窗口证据就一律留着欠账。
H.debtPaid = function (r, total) {
  if (!r || !r.clean) return false;
  var tot = Number(total == null ? r.total : total) || 0;
  if (r.noTiles) return true;
  if (tot === 0) return true;
  var win = Number(r.win) || 0;
  return win > 0 && win >= tot;
};

// 在当前目录等转换完成，并把结果记进台账。
// 返回 pause 非空时上层必须保存栈退出：宁可停在这一格，也不能把没转换完的目录丢下。
// opts.safety 由调用方透传（小目录用 H.smallBudget().safety）：90s 安全垫是给大目录的
// persist/弹栈余量，套在 60s 窗口的小目录头上就永远排不了空。
H.drainNode = async function (node, total, deadline, opts) {
  var o = opts || {};
  var safety = o.safety == null ? 90000 : o.safety;
  L.needDrain = L.needDrain || {}; L.res2 = L.res2 || {}; L.retry = L.retry || {}; L.tr = L.tr || [];
  var budget = Math.min(180000, deadline - Date.now() - safety);
  if (budget < 20000) return { dr: null, pause: 'DRAIN_BUDGET' };   // 不导航：留在原地等下一格
  await H.goto(node.id);   // 回到目录顶部，确保能看到首屏瓦片
  var dr = await H.drain(budget, 6, 8000, { total: total || 0 });
  L.res2[node.id] = Object.assign({}, L.res2[node.id], {
    id: node.id, drain: { reason: dr.reason, loaded: dr.loaded, all: dr.all, bad: dr.bad, waited: dr.waited, at: new Date().toISOString() }
  });
  L.tr.push({ t: Date.now(), id: node.id, m: 'drain ' + dr.reason + ' ' + dr.loaded + '/' + dr.all + ' bad=' + dr.bad });
  if (L.tr.length > 900) L.tr.shift();
  if (dr.reason === 'converted' || dr.reason === 'empty') { delete L.needDrain[node.id]; return { dr: dr, pause: null }; }
  if (dr.reason === 'not-rendered') return { dr: dr, pause: 'DRAIN_NOT_RENDERED' };
  L.retry[node.id] = (L.retry[node.id] || 0) + 1;   // stalled / timeout：标记保留，第二遍复检补做
  return { dr: dr, pause: null };
};

// 提交 + 等转换完成。enter / exit 两个阶段共用，避免两处策略走偏。
// opts.safety / opts.reserve / opts.minPump 透传给 splitBudget，safety 继续透传给 drainNode：
// 默认 90+120 是给大目录的口径，小目录（一屏装得下）按 H.smallBudget() 放行才不会饿死。
H.submitAndDrain = async function (node, total, deadline, phase, opts) {
  var o = opts || {};
  L.needDrain = L.needDrain || {};
  var b = H.splitBudget(deadline, Date.now(), { safety: o.safety, reserve: o.reserve, minPump: o.minPump });
  if (!b.ok) return { r: null, dr: null, pause: 'SUBMIT_BUDGET', submitted: 0 };   // 没时间等转换就别提交
  var r = await H.pumpX2(node.id, b.pump, { atReady: !!o.atReady });
  await H.persist('tree-' + phase + '-' + node.id);
  if (r.blocked === 'quota') {
    var rem = deadline - Date.now() - 90000 - 60000;   // 给排空留时间，别让 spaceDrain 吃光
    if (rem > 60000) await H.spaceDrain(rem);
  }
  if (r.blocked === 'not-rendered') return { r: r, dr: null, pause: 'NOT_RENDERED', submitted: 0 };   // 页面没渲染出来，绝不标 done
  // 零提交分两种：clean=true 是页面本来就干净，可以走；否则 blocked 说明一张都没提交进去
  // （budget / sel-fail / gp-* / quota / stuck-window），必须暂停。返回 pause=null 会让
  // processTree 的叶子分支无条件标 done —— 2026-11-11 的 7333/7335/7336 就是这样假完成的。
  if (!(r.sent > 0)) {
    if (r.clean) {
      // 整页已证明干净才销账；证据只盖渲染窗口时保留 needDrain（下一格补排空 / 逐项 HEAD 再说）
      if (H.debtPaid(r, total)) delete L.needDrain[node.id];
      return { r: r, dr: null, pause: null, submitted: 0 };
    }
    return { r: r, dr: null, pause: 'SUBMIT_BLOCKED', submitted: 0 };
  }
  // 只要提交过就必须等，blocked（sel-fail / budget / quota）也不例外。
  // 标记先落：drain 中途抛错或 kernel 被回收，下一格也知道这个目录还欠一次排空。
  L.needDrain[node.id] = { total: total || 0, at: Date.now(), sent: r.sent };
  await H.persist('tree-submit-' + phase + '-' + node.id);   // 标记必须先落盘：排空中 kernel 被回收也能补排空
  var d = await H.drainNode(node, total, deadline, { safety: o.safety });
  await H.persist('tree-drain-' + phase + '-' + node.id);
  return { r: r, dr: d.dr, pause: d.pause, submitted: r.sent || 0 };
};

// 空间级排空：配额撞墙时提交多少都进不去，只能等这台浏览器的转换队列消化。
// 探针用「刚提交过、之前是好的」目录，它们的坏图数就是近似待处理量。
H.spaceDrain = async function (maxMs, samples) {
  var s = (samples && samples.length ? samples : L.pendingSamples).slice(0, 3);
  var t0 = Date.now(), hist = [], prev = Infinity, stall = 0;
  if (!s.length) return { reason: 'no-samples', pending: null, waited: 0, hist: [] };
  while (true) {
    var tot = 0;
    for (var i = 0; i < s.length; i++) {
      await H.goto(s[i]);
      var ps = H.parse(await H.snap());
      tot += ps.filter(p => p.broken && p.id).length;
    }
    hist.push(tot);
    if (tot === 0) return { reason: 'empty', pending: 0, waited: Date.now() - t0, hist: hist };
    if (Date.now() - t0 > maxMs) return { reason: 'timeout', pending: tot, waited: Date.now() - t0, hist: hist };
    if (tot >= prev) { stall++; if (stall >= 3) return { reason: 'stalled', pending: tot, waited: Date.now() - t0, hist: hist }; } else stall = 0;
    prev = tot;
    await H.sleep(20000);
  }
};

/* ---------- 第二遍扫描 / 假干净审计（一个循环，两种口径） ---------- */

// cell 里只留三行，语义由 scripts/test_p2_pass.mjs 钉住（11 例先红后绿）。
// 为什么收进库：2025 审计还剩两百多个目录，2026 二轮 845 个，2024 一整轮 —— 十几格循环手贴在
// cell 里，尾巴常量抄错过一次（白烧一格），语义也没地方回归。
// opts:
//   ids          有序候选（调用方定优先级：大目录先做 / 审计池切片）；缺省 = 全部 folders 按 id 升序
//   deadline     本格硬截止（时间戳）。进目录前先判 `> dl-25000`，绝不开着脏目录越线
//   cleanMark    判干净时写进 L.p2.done 的值：主扫描 1、审计通过 3；跳过条件同样是「等于 cleanMark」
//   skip         自定义跳过判定 function(id)（主扫描用 `!!L.p2.done[id]`：1/2/3 都算已覆盖）
//   bigGate / bigRounds / bigRoundCap   大目录（total>120）的尾巴闸门、轮次与每目录限时
//   consecLimit  尾巴连续跳过的收工阈值；缺省自适应（seen>=20 且干净率<15% → 5，否则 12）
//   persistEvery 每处理这么多个落一次盘；收尾必落盘
H.p2Pass = async function (opts) {
  var o = opts || {};
  L.p2 = L.p2 || {}; L.p2.done = L.p2.done || {}; L.retry = L.retry || {};
  var dl = o.deadline || (Date.now() + 520000), tag = o.tag || 'p2';
  var cleanMark = o.cleanMark == null ? 1 : o.cleanMark;
  var bigRounds = o.bigRounds == null ? 4 : o.bigRounds;
  var bigRoundCap = o.bigRoundCap == null ? 200000 : o.bigRoundCap;
  var bigGate = o.bigGate == null ? 140000 : o.bigGate;
  var persistEvery = o.persistEvery == null ? 20 : o.persistEvery;
  var sb = H.smallBudget();
  var ids = o.ids || Object.keys(L.folders).sort(function (a, b) { return (+a) - (+b); });
  var rep = { seen: 0, skipped: 0, wasClean: 0, falseClean: 0, repaired: 0, stillBad: 0, pending: 0,
    tailSkip: 0, starved: 0, rounds: 0, sent: 0, trusted: 0, reVer: 0, deep: 0, deepClean: 0,
    gaveUp: [], pauses: [], samp: [], errs: [] };
  var t0 = Date.now(), consec = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i]);
    if (o.skip ? o.skip(id) : L.p2.done[id] === cleanMark) { rep.skipped++; continue; }
    if (Date.now() > dl - 25000) break;
    var f = L.folders[id] || {}, tot = f.total || 0, isBig = tot > 120, ta = Date.now();
    try {
      await H.goto(id);
      var q = await H.stSettled({ deadline: dl, expectTotal: tot });        // 安定闸门，不看裸 bad
      rep.seen++;
      var s = q.st, pgTot = s.total == null ? tot : s.total;               // 页项数含子目录卡片
      // 页项数超过渲染窗口时，「渲染满」这条闸门永远过不去：
      // 只能靠 H.audit 滚动全目录（按 id 去重）拿结论。实测 2238/2696 就是这样被误判到
      // retry=6、标成 p2=2（仍坏），而深度扫显示 bad=0。
      // 注意：窗口容量随视口变化（最大化实测 198，视口变小后同一轮抽样 81/100/143），且下面只看
      // broken===0、不查 swept 覆盖率 —— 缩窗跑大目录会漏判尾部，调用方必须核对 L.aud[id].swept >= 页项数。
      var capped = pgTot != null && (s.all + (s.folders || 0)) < pgTot;
      var deep = null;
      if (!q.settled && capped) { deep = await H.audit(id); rep.deep++; }
      if ((q.settled && s.bad === 0) || (deep && deep.broken === 0)) {
        rep.wasClean++; if (deep) rep.deepClean++;
        consec = 0; L.p2.done[id] = cleanMark;
        if (L.needDrain) delete L.needDrain[id];        // 页面已证明整目录转换完，欠排空的债就此销掉
        if (rep.seen % persistEvery === 0) await H.persist(tag);
        continue;
      }
      rep.falseClean++;                                                     // 之前标过 done，现在仍坏
      var gate = isBig ? bigGate : H.tailReserve(pgTot || tot);             // 与 submitAndDrain 同源
      if (Date.now() > dl - gate) {
        rep.tailSkip++; consec++;
        var lim = o.consecLimit != null ? o.consecLimit : (rep.seen >= 20 && rep.wasClean / rep.seen < 0.15 ? 5 : 12);
        if (consec >= lim) break;                                            // 纯脏区别空扫尾巴
        continue;
      }
      consec = 0;
      var roundsN = isBig ? bigRounds : 1, convDr = null, last = null, sentR = 0, q2 = null;
      for (var r2 = 0; r2 < roundsN && Date.now() < ta + bigRoundCap && Date.now() < dl - 60000; r2++) {
        var x = { atReady: true };                                          // 刚过安定闸门，pumpX2 不必再导航
        if (!isBig && pgTot <= 120) { x.safety = sb.safety; x.reserve = sb.reserve; x.minPump = sb.minPump; }
        last = await H.submitAndDrain({ id: id, path: f.name || id }, pgTot || tot, dl, tag, x);
        rep.rounds++; sentR += (last && last.submitted) || 0;
        if (last.pause) { rep.pauses.push([id, last.pause]); if (/BUDGET/.test(last.pause)) rep.starved++; break; }
        if (last.dr && (last.dr.reason === 'converted' || last.dr.reason === 'empty')) {
          convDr = last.dr;
          if (isBig) break;                       // 大目录一轮 converted 就收口：pumpX2 内部已扫多个窗口，再提交是白烧窗口
        }
        if (!(last.r && last.r.sent > 0)) break;                            // 小目录只做一轮：pumpX2 内部已分批
      }
      rep.sent += sentR;
      var ok = false;
      if (convDr && pgTot <= 120 && convDr.all >= pgTot) { ok = true; rep.trusted++; }   // 整页渲染满 + converted，省掉复验导航
      else if (capped) { deep = await H.audit(id); rep.deep++; ok = deep.broken === 0; if (ok) rep.deepClean++; }   // 渲染窗口装不下：滚动全扫才是结论
      else { await H.goto(id); q2 = await H.stSettled({ deadline: dl, expectTotal: pgTot || tot }); ok = !!(q2.settled && q2.st.bad === 0); rep.reVer++; }
      if (ok) { rep.repaired++; L.p2.done[id] = cleanMark; L.retry[id] = 0; if (L.needDrain) delete L.needDrain[id]; }
      else {
        rep.stillBad++;
        L.retry[id] = (L.retry[id] || 0) + 1;
        if (L.retry[id] >= 6) { L.p2.done[id] = 2; rep.gaveUp.push(id + ':' + JSON.stringify((q2 && q2.st) || (deep && { broken: deep.broken, videos: deep.videos }) || (convDr && convDr.reason))); }
        else { delete L.p2.done[id]; rep.pending++; }                       // 退回主扫描：下一格接着补做
        if (rep.samp.length < 6) rep.samp.push([id, pgTot, deep ? ('deep ' + deep.broken + '/vid ' + deep.videos) : (q2 ? (q2.st.bad + '/' + q2.st.all) : (convDr && convDr.reason))]);
      }
      if (rep.seen % persistEvery === 0) await H.persist(tag);
    } catch (e) {
      rep.errs.push([id, String((e && e.message) || e).slice(0, 70)]);
      if (/TAB|OWNED/i.test(String(e && e.message))) break;                 // 标签页易主：立刻收，别拿别人的页面记账
    }
  }
  rep.persist = await H.persist(tag);
  rep.needDrain = Object.keys(L.needDrain || {});
  rep.totSent = L.totSent;
  rep.p2all = Object.keys(L.p2.done).length;
  rep.pauses = rep.pauses.slice(0, 12);
  rep.errs = rep.errs.slice(0, 8);
  rep.ms = Date.now() - t0;
  return rep;
};

/* ---------- 逐目录引擎（提交优先，复检靠第二遍） ---------- */

var badOf = function (a) { var o = []; a.forEach(function (p, k) { if (p.broken && p.id) o.push(k); }); return o; };

H.pumpX2 = async function (id, budgetMs, opts) {
  var o = opts || {};
  var t0 = Date.now(), tot = ((L.folders[id] || {}).total || 0), cap = CFG.cap;
  var push = function (m) { L.tr.push({ t: Date.now() - t0, id: id, m: m }); if (L.tr.length > 900) L.tr.shift(); };
  var rec = function (e) { var r = Object.assign({}, L.res2[id] || {}, { id: id, total: tot, elapsed: Date.now() - t0, pass: 'submit' }, e); L.res2[id] = r; return r; };
  var ps, win;
  if (o.atReady) {
    // 上层（第二遍扫描）刚导航并过安定闸门，不必再花 3.3s 重进一次；读不到瓦片仍按老路重导航
    ps = H.parse(await H.snap()); win = ps.length;
    if (!win) { await H.goto(id); ps = H.parse(await H.snap()); win = ps.length; }
  } else {
    await H.goto(id);
    ps = H.parse(await H.snap()); win = ps.length;
  }
  if (!win) {
    // goto 会重导航，瓦片可能还没回来；先过渲染闸门，别把「没渲染」当「空目录已处理」
    var wrp = await H.waitRender(t0 + budgetMs);
    if (!wrp.ok) return rec({ sent: 0, batches: 0, quota: 0, stillBadWindow: 0, windowsSeen: 0, done: false, blocked: 'not-rendered' });
    ps = H.parse(await H.snap()); win = ps.length;
  }
  if (!win) { var r0 = rec({ sent: 0, batches: 0, quota: 0, stillBadWindow: 0, windowsSeen: 0, win: win, clean: true, noTiles: true, done: true, blocked: null }); L.vDone[id] = r0; return r0; }
  if (tot > 120 && win < 120) { await H.sizeSmall(); ps = H.parse(await H.snap()); win = ps.length; }
  // win 是「这次判干净覆盖了多少张」的证据：H.debtPaid 靠它决定能不能销 needDrain 欠账
  if (badOf(ps).length === 0 && tot <= win) { var r1 = rec({ sent: 0, batches: 0, quota: 0, stillBadWindow: 0, windowsSeen: 1, win: win, clean: true, done: true, blocked: null }); L.vDone[id] = r1; return r1; }
  var sub = L.subm[id] || (L.subm[id] = {});
  // 本轮内已提交的 id：broken 是瞬时状态，刚提交完仍会显示坏图，不去重就会重复提交并挤占配额
  var runDone = {};
  var badNew = function (a) { return badOf(a).filter(function (ix) { return !runDone[String(a[ix].id)]; }); };
  var sent = 0, batches = 0, quota = 0, blocked = null, w = 1, drained = 0;
  var onePage = tot <= win, maxWin = onePage ? 1 : Math.min(16, Math.ceil(tot / Math.max(60, win * 0.7)) + 1);
  for (; w <= maxWin; w++) {
    if ((Date.now() - t0) > (budgetMs - 20000)) { blocked = 'budget'; break; }
    var attempt = 0, windowDone = false;
    while (attempt < 4 && !windowDone) {
      attempt++;
      var bi = badNew(ps);
      if (!bi.length) { windowDone = true; break; }
      var k = Math.min(bi.length, cap), f0 = bi[0], last = Math.min(bi[k - 1], ps.length - 1);
      var got = await H.selSpan3(f0, last); batches++;
      push('sel ' + got + ' bad=' + bi.length + ' win=' + w);
      if (got < 1) {
        push('unsel ' + f0 + '-' + last + ' bad=' + bi.length);
        bi.forEach(function (ix) { if (ps[ix] && ps[ix].id) L.stuckIds[String(ps[ix].id)] = { folder: id, video: !!ps[ix].video, why: 'unselectable' }; });
        blocked = 'sel-fail'; windowDone = true; break;
      }
      var gp = await H.genPreview2(ps);
      push('gp ' + JSON.stringify({ ok: gp && gp.ok, dialog: gp && gp.dialog, reason: gp && gp.reason }) + ' sel=' + got + ' bad=' + bi.length);
      if (gp && gp.dialog) {
        quota++; await H.clearSel();
        if (L.pendingSamples.indexOf(String(id)) < 0) L.pendingSamples.push(String(id));
        var rem = budgetMs - (Date.now() - t0) - 40000;
        if (attempt < 4 && rem > 30000) { var d = await H.drain(Math.min(rem, 150000), 6, 8000, { total: tot }); drained++; push('drain ' + JSON.stringify({ r: d.reason, loaded: d.loaded, all: d.all, bad: d.bad, w: d.waited })); ps = H.parse(await H.snap()); continue; }
        blocked = 'quota'; windowDone = true; break;
      }
      if (!gp || !gp.ok) { await H.clearSel(); blocked = 'gp-' + ((gp && gp.reason) || 'fail'); windowDone = true; break; }
      var n = 0;
      ps.forEach(function (p, ix) { if (p.broken && p.id && ix >= f0 && ix <= last && !runDone[String(p.id)]) { sub[String(p.id)] = 1; runDone[String(p.id)] = 1; delete L.stuckIds[String(p.id)]; n++; } });
      sent += n; L.totSent = (L.totSent || 0) + n;
      if (L.pendingSamples.indexOf(String(id)) < 0) L.pendingSamples.push(String(id));
      await H.clearSel();
      ps = H.parse(await H.snap());   // 同窗口可能还剩超出 cap 的坏图，继续下一批
    }
    if (blocked === 'sel-fail') break;
    if (w === maxWin) break;
    await H.pageDown();
    var p2 = H.parse(await H.snap());
    if (!p2.length) break;
    var key = a => String(a[0].id) + '~' + String(a[a.length - 1].id);
    if (key(p2) === key(ps)) { if (badOf(p2).length === 0) break; blocked = 'stuck-window'; break; }
    ps = p2;
  }
  var fin = badOf(ps).length;
  var r = rec({ sent: sent, batches: batches, quota: quota, drained: drained, stillBadWindow: fin, blocked: blocked, done: !blocked, windowsSeen: w, win: ps.length, clean: (sent === 0 && fin === 0) });
  L.vDone[id] = r;
  return r;
};

// 连续跑队列；配额连续撞墙时做一次空间级排空再继续；每批写盘，chunk 可安全中断
H.workerX2 = async function (deadlineMs) {
  L.retry = L.retry || {};
  var t0 = Date.now(), out = [], quotaStreak = 0;
  while (L.vQueue.length) {
    var id = String(L.vQueue[0]), tot = ((L.folders[id] || {}).total || 0);
    var need = Math.min(420000, 60000 + Math.ceil(Math.max(1, tot) / CFG.cap) * 45000);
    if (deadlineMs - (Date.now() - t0) < need + 30000) break;
    var r;
    try { r = await H.pumpX2(id, need); }
    catch (e) { r = { id: id, total: tot, err: String((e && e.message) || e).slice(0, 90), blocked: 'err' }; }
    out.push([r.id, r.total, r.sent || 0, r.batches || 0, r.quota || 0, r.stillBadWindow === undefined ? '?' : r.stillBadWindow, (r.blocked || r.err || (r.clean ? 'clean' : 'ok'))].join('/'));
    quotaStreak = (r.blocked === 'quota') ? quotaStreak + 1 : 0;
    await H.persist('worker');
    var bad = !!r.err || r.blocked === 'quota' || r.blocked === 'budget' || r.blocked === 'stuck-window' || r.blocked === 'not-rendered' || String(r.blocked || '').indexOf('gp-') === 0;
    if (bad) L.retry[id] = (L.retry[id] || 0) + 1;
    if (bad && L.retry[id] <= 3) L.vQueue.push(L.vQueue.shift()); else L.vQueue.shift();
    if (quotaStreak >= 2) {   // 整个空间的队列满了，小批量继续提交只会撞配额
      var left = deadlineMs - (Date.now() - t0) - 60000;
      if (left > 40000) { var sd = await H.spaceDrain(left); out.push('SPACE_DRAIN/' + sd.reason + '/' + sd.pending + '/' + Math.round(sd.waited / 1000) + 's'); quotaStreak = 0; }
      else break;
    }
  }
  await H.persist('worker-end');
  return { rows: out, totSent: L.totSent, left: L.vQueue.length, pendingSamples: L.pendingSamples.slice(-6), next: L.vQueue.slice(0, 4).map(i => i + ':' + (((L.folders[i] || {}).total) || 0)) };
};

// 只读复检：跨窗口扫描一个目录，回报坏图/无 src/视频数，不提交任何东西。
// swept < 目录 total 说明窗口推不动（视口太小/虚拟挂载），此时 broken===0 只代表窗口内干净，
// 不是全目录结论：先最大化浏览器窗口再重扫。
H.audit = async function (id, maxPages) {
  await H.goto(id);
  var ps = H.parse(await H.snap()), win = ps.length;
  if (win && ((L.folders[id] || {}).total || 0) > 120 && win < 120) { await H.sizeSmall(); ps = H.parse(await H.snap()); }
  var swept = 0, broken = 0, noSrc = 0, videos = 0, seen = {};
  var pages = maxPages || 12;
  for (var i = 0; i < pages; i++) {
    if (!ps.length) break;
    var key = String(ps[0].id) + '~' + String(ps[ps.length - 1].id);
    ps.forEach(function (p) { if (p.id && !seen[p.id]) { seen[p.id] = 1; swept++; if (p.broken) broken++; if (p.noSrc) noSrc++; if (p.video) videos++; } });
    if (seen[key]) break;
    seen[key] = 1;
    await H.pageDown();
    ps = H.parse(await H.snap());
  }
  var res = { id: id, swept: swept, broken: broken, noSrc: noSrc, videos: videos, at: new Date().toISOString() };
  (L.aud = L.aud || {})[id] = res;
  return res;
};

/* ---------- 深度优先递归处理（边发现边提交） ---------- */

// 页面上下文里的 WebAPI POST。两个 shim 坑必须绕开：
//   ① page.evaluate 恒返回 null，只能走 locator('body').evaluate；
//   ② 这个 shim **会丢掉 evaluate 的第二个参数**（实测传 {hello:1} 收到 {}），
//      所以数据只能内联进函数源码字符串，不能当参数传。
H.synoToken = async function (force) {
  if (!force && globalThis.__synoTok) return globalThis.__synoTok;
  var t = await H.G(() => H.PW().locator('body').evaluate(function () {
    try {
      var es = performance.getEntriesByType('resource');
      for (var i = es.length - 1; i >= 0; i--) {
        var m = /[?&]SynoToken=([^&]+)/.exec(es[i].name);
        if (m) return decodeURIComponent(m[1]);
      }
    } catch (e) {}
    return '';
  }));
  globalThis.__synoTok = String(t || '');
  return globalThis.__synoTok;
};

H.apiPost = async function (api, params) {
  var tok = await H.synoToken();
  var call = async function (tk) {
    var src = '(async function () {'
      + ' var tok = ' + JSON.stringify(tk) + ', api = ' + JSON.stringify(api) + ', params = ' + JSON.stringify(params) + ';'
      + ' var res = await fetch("/webapi/entry.cgi/" + api, { method: "POST",'
      + '   headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-syno-token": tok },'
      + '   body: new URLSearchParams(params) });'
      + ' var txt = await res.text();'
      + ' try { return JSON.parse(txt); } catch (e) { return { success: false, err: "NOT_JSON", status: res.status, head: txt.slice(0, 120) }; }'
      + '})';
    return await H.G(() => H.PW().locator('body').evaluate(src));
  };
  var j = await call(tok);
  // 803 = 会话/token 失效：重读一次 token 再试一次（重登后 performance 里会有新的 SynoToken）
  if (j && j.success === false && Number(j.code) === 803) {
    var t2 = await H.synoToken(true);
    if (t2 && t2 !== tok) j = await call(t2);
  }
  return j;
};

// 子目录清单：分页 API，按 id 去重。**不要用 domSnapshot 切 folder-draggable-zone-**——
// 文件夹视图只虚拟挂载渲染窗口内的卡片，2026-11-11 实测 7227 的 130 个子目录快照里只有前 90 个，
// 窗口外的 40 支（1289 条条目）整支没被访问，父目录却标了 done。
H.listChildren = async function (id) {
  var api = CFG.space ? 'SYNO.FotoTeam.Browse.Folder' : 'SYNO.Foto.Browse.Folder';
  var seen = new Map(), off = 0, pages = 0;
  for (;;) {
    var j = await H.apiPost(api, { api: api, method: 'list', version: '2', id: String(id), offset: String(off), limit: '100' });
    if (!j || j.success === false || !j.data || !Array.isArray(j.data.list)) {
      return { ok: false, err: 'CHILDREN_API', code: j && j.code, why: (j && (j.err || j.head)) || 'no-json' };
    }
    var arr = j.data.list;
    arr.forEach(function (x) {
      seen.set(String(x.id), { id: String(x.id), name: String(x.name || '').split('/').pop() || '?' });
    });
    pages++;
    if (arr.length < 100) break;
    if (pages >= 40) return { ok: false, err: 'CHILDREN_API', why: 'page-cap' };  // 宁可暂停也不交半截清单
    off += arr.length;
  }
  return { ok: true, kids: Array.from(seen.values()) };
};

// 进入目录 → 提交当前坏图 → 等转换完成 → 递归子目录 → 回来复检 → 等转换完成 → 返回上级
// opts: { path, deadline, fresh }  fresh=true 时忽略已保存的 treeStack
H.processTree = async function (rootId, opts) {
  opts = opts || {};
  var deadline = opts.deadline || (Date.now() + 540000);
  var rootPath = opts.path || '';
  // 安全闸：没见过 load() 的 L 不允许写台账（2026-11-08 空 L 覆盖事故）
  if (!L.__loadedAt && !opts.allowUnloaded) {
    return { err: 'LEDGER_NOT_LOADED', hint: '先 await H.ready() 或 await H.load()，确认 loaded 后再跑' };
  }
  L.needDrain = L.needDrain || {};   // 复用旧 kernel 里的 L 时可能没这个字段

  // 恢复或初始化栈
  if (!opts.fresh && L.treeStack && L.treeStack.length > 0) {
    // 从上次中断处继续
  } else {
    L.treeStack = [{ id: String(rootId), path: rootPath, phase: 'enter' }];
  }
  var stack = L.treeStack;
  var count = 0, submitted = 0;

  while (stack.length > 0) {
    // 超时前保存栈并退出
    if (Date.now() > deadline - 60000) {
      await H.persist('tree-pause');
      return { paused: true, remaining: stack.length, processed: count, submitted: submitted };
    }

    var node = stack[stack.length - 1];

    if (node.phase === 'enter') {
      await H.goto(node.id);
      // 导航校验：URL 没落到目标目录说明页面没渲染完/被弹走，绝不能当成「空目录」标 done
      var curUrl = '';
      try { curUrl = String(await H.G(() => globalThis.__tab.url())); } catch (e) { curUrl = ''; }
      if (curUrl.indexOf('/folder/' + node.id) < 0) {
        await H.sleep(4000);
        await H.goto(node.id);
        try { curUrl = String(await H.G(() => globalThis.__tab.url())); } catch (e) { curUrl = ''; }
        if (curUrl.indexOf('/folder/' + node.id) < 0) {
          await H.persist('tree-nav-mismatch');
          return { paused: true, err: 'NAV_MISMATCH', node: node.id, url: curUrl, remaining: stack.length };
        }
      }
      // 渲染闸门：URL 对了不代表瓦片好了（实测 goto 后 11s 仍 all=0/folders=0 而 total=2）。
      // 不等就判「空叶子」会把整支子目录静默丢掉，所以等不到就暂停，绝不标 done。
      var wr = await H.waitRender(deadline);
      if (!wr.ok) {
        await H.persist('tree-not-rendered-' + node.id);
        return { paused: true, err: 'NOT_RENDERED', node: node.id, total: wr.st && wr.st.total, waited: wr.waited, remaining: stack.length };
      }
      // 渲染确认后拍快照：只用来做交叉校验，**不再当子目录清单**（快照只有渲染窗口那一段）
      var snap0 = await H.snap();
      var zones = snap0.split('folder-draggable-zone-');
      var domIds = [];
      for (var j = 1; j < zones.length; j++) {
        var idM = zones[j].slice(0, 4000).match(/^(\d+)/);
        if (idM) domIds.push(idM[1]);
      }
      // 子目录清单走分页 API：窗口外的分支一个都不能漏（7227：130 个子目录快照里只有 90 个）
      var ch = await H.listChildren(node.id);
      if (!ch.ok) {
        await H.persist('tree-children-api-' + node.id);
        return { paused: true, err: 'CHILDREN_API', node: node.id, why: ch.why, code: ch.code, remaining: stack.length, processed: count, submitted: submitted };
      }
      var subs = ch.kids;
      // 交叉校验：快照里出现而 API 没返回的 id 说明两边不同源，宁可暂停也不静默采信一方
      var knownIds = {};
      subs.forEach(function (s) { knownIds[String(s.id)] = 1; });
      var extraIds = domIds.filter(function (x) { return !knownIds[String(x)]; });
      if (extraIds.length > 0) {
        await H.persist('tree-children-mismatch-' + node.id);
        return { paused: true, err: 'CHILDREN_MISMATCH', node: node.id, extra: extraIds.slice(0, 5), remaining: stack.length, processed: count, submitted: submitted };
      }

      // 注册目录并提交当前坏图（total 与 st 复用闸门那次快照，省一次往返）
      var total = wr.st.total != null ? wr.st.total : await H.totalShown();
      L.folders[node.id] = { id: node.id, name: node.path, total: total || 0, kids: subs.length };
      var st = wr.st;
      // 上一格提交过但没排空完（中断 / 预算不足）：先补排空，再决定要不要提交
      if (L.needDrain[node.id]) {
        var pd = await H.drainNode(node, total || 0, deadline);
        await H.persist('tree-redrain-' + node.id);
        if (pd.pause) {
          await H.persist('tree-pause');
          return { paused: true, err: pd.pause, node: node.id, remaining: stack.length, processed: count, submitted: submitted };
        }
        st = await H.st();
      }
      if (st.bad > 0) {
        // 提交与排空是一个整体：预算不够就整段不做，宁可暂停也不能提交完就走
        var sd = await H.submitAndDrain(node, total || 0, deadline, 'enter', H.treeSubmitOpts(total));
        submitted += sd.submitted;
        if (sd.pause) {
          await H.persist('tree-pause');
          return { paused: true, err: sd.pause, node: node.id, remaining: stack.length, processed: count, submitted: submitted };
        }
      }
      count++;

      if (subs.length > 0) {
        // 有子目录：标记为 exit 阶段（子目录全部完成后复检），然后压入子目录
        node.phase = 'exit';
        for (var k = subs.length - 1; k >= 0; k--) {
          stack.push({ id: subs[k].id, path: node.path + '/' + subs[k].name, phase: 'enter' });
        }
      } else {
        // 叶子目录：直接完成，弹栈返回上级
        stack.pop();
        L.vDone[node.id] = { id: node.id, total: total || 0, done: true };
      }

    } else {
      // exit 阶段：子目录全部处理完，回来复检当前目录
      await H.goto(node.id);
      var wr2 = await H.waitRender(deadline);
      if (!wr2.ok) {
        await H.persist('tree-not-rendered-exit-' + node.id);
        return { paused: true, err: 'NOT_RENDERED', node: node.id, total: wr2.st && wr2.st.total, waited: wr2.waited, remaining: stack.length };
      }
      var st2 = wr2.st;
      var total2 = (L.folders[node.id] || {}).total || 0;
      if (L.needDrain[node.id]) {
        var pd2 = await H.drainNode(node, total2, deadline);
        await H.persist('tree-redrain-exit-' + node.id);
        if (pd2.pause) {
          await H.persist('tree-pause');
          return { paused: true, err: pd2.pause, node: node.id, remaining: stack.length, processed: count, submitted: submitted };
        }
        st2 = await H.st();
      }
      if (st2.bad > 0) {
        // 复检提交后同样必须等转换完成再返回上级
        var sd2 = await H.submitAndDrain(node, total2, deadline, 'exit', H.treeSubmitOpts(total2));
        submitted += sd2.submitted;
        if (sd2.pause) {
          await H.persist('tree-pause');
          return { paused: true, err: sd2.pause, node: node.id, remaining: stack.length, processed: count, submitted: submitted };
        }
      }
      stack.pop();
      L.vDone[node.id] = { id: node.id, total: total2, done: true };
    }
  }

  L.treeStack = [];
  await H.persist('tree-complete');
  return { done: true, processed: count, submitted: submitted, totSent: L.totSent };
};

/* ---------- 缺口补跑游标 + 逐项 HEAD 审计原语 ----------
 * 这两件事此前只活在一次性 cell 里：多根跨格游标手贴一遍、分页/去重/URL quoting/8 并发再手贴一遍，
 * 常量抄错就白烧一格，语义也没地方回归。收进库后由 scripts/gap_runner.mjs、scripts/head_audit.mjs 调用，
 * 判据由 test_gap_ops.mjs / test_head_audit.mjs 钉住。 */

// 本格该跑哪一根：栈非空就续栈底那一根（fresh:false），栈空取计划里第一个未完成的根（fresh:true）。
// 栈底不在本计划里 ⇒ stack-other-root，绝不硬跑（两个任务的游标会互相踩）。
H.gapNextRoot = function (plan, led) {
  var G2 = led || L, st = G2.treeStack || [], list = plan || [];
  var isDone = function (id) { var v = (G2.vDone || {})[String(id)]; return !!(v && v.done); };
  if (st.length) {
    var bottom = String(st[0].id);
    var hit = list.find(function (x) { return String(x.id) === bottom; });
    if (!hit) return { err: 'stack-other-root', id: bottom };
    return { id: String(hit.id), path: hit.path, fresh: false };
  }
  var next = list.find(function (x) { return !isDone(x.id); });
  if (!next) return { done: true };
  return { id: String(next.id), path: next.path, fresh: true };
};

// 缩略图 HEAD 探针 URL。cache_key / size 都要带 %22 引号（服务端按 JSON 字符串解析），
// 缺 SynoToken 会 803。404=缺、200=有；size="sm" 是网格那一档、"xl" 是灯箱那一档。
H.thumbHeadUrl = function (id, ck, size, tok) {
  return '/synofoto/api/v2/t/Thumbnail/get?id=' + id
    + '&cache_key=' + encodeURIComponent(JSON.stringify(String(ck)))
    + '&type=%22unit%22&size=' + encodeURIComponent(JSON.stringify(String(size || 'sm')))
    + '&SynoToken=' + encodeURIComponent(String(tok == null ? '' : tok));
};

// 按 id 去重、保留首次出现顺序：takentime 相同的条目跨页会重复出现。
H.dedupeItems = function (list) {
  var seen = {}, out = [];
  (list || []).forEach(function (x) {
    if (!x || x.id == null) return;
    var k = String(x.id);
    if (seen[k]) return;
    seen[k] = 1; out.push(x);
  });
  return out;
};

// 页内一次跑完全部条目的 HEAD 探针源码。三个 shim 约束：
//   ① 必须「求值后是一个函数」，IIFE 会被拒；② evaluate 的第二个参数会被丢掉 ⇒ 数据内联；
//   ③ 逐条往返太慢，8 并发实测 ~100 次 HEAD/秒（271 条约 5.5s）。
// rows: [{id, ck, type}]；返回 JSON 字符串 {smBad, xlBad, errs, n, types}。
// URL 构造与 H.thumbHeadUrl 同一口径，改一处要改两处。
H.headAuditSource = function (rows, tok) {
  return 'async function () {'
    + ' var rows = ' + JSON.stringify(rows || []) + ', tok = ' + JSON.stringify(String(tok == null ? '' : tok)) + ';'
    + ' var sizes = ["sm", "xl"], out = { smBad: [], xlBad: [], other: [], errs: [] }, types = {};'
    + ' rows.forEach(function (r) { var t = r.type || "?"; types[t] = (types[t] || 0) + 1; });'
    + ' var url = function (r, size) {'
    + '   return "/synofoto/api/v2/t/Thumbnail/get?id=" + r.id'
    + '     + "&cache_key=" + encodeURIComponent(JSON.stringify(String(r.ck)))'
    + '     + "&type=%22unit%22&size=" + encodeURIComponent(JSON.stringify(String(size)))'
    + '     + "&SynoToken=" + encodeURIComponent(tok);'
    + ' };'
    + ' var i = 0;'
    + ' var worker = async function () {'
    + '   while (i < rows.length) {'
    + '     var r = rows[i++];'
    + '     for (var s = 0; s < sizes.length; s++) {'
    + '       var size = sizes[s];'
    + '       try {'
    + '         var res = await fetch(url(r, size), { method: "HEAD" });'   // 404 会带 12KB HTML，别读 body
    + '         if (res.status === 404) (size === "sm" ? out.smBad : out.xlBad).push(r.id);'
    + '         else if (res.status !== 200) out.other.push([r.id, size, res.status]);'   // 500/803 不是「缺图」，别混判
    + '       } catch (e) { out.errs.push([r.id, size, String((e && e.message) || e).slice(0, 60)]); }'
    + '     }'
    + '   }'
    + ' };'
    + ' var ws = []; for (var k = 0; k < 8; k++) ws.push(worker());'
    + ' await Promise.all(ws);'
    + ' out.n = rows.length; out.types = types;'
    + ' return JSON.stringify(out);'
    + '}';
};

/* ---------- 台账持久化 ---------- */

// 台账的固定口径字段。之外的自有字段一律视为「附加证据」（apiAudit / repair / apiAuditMeta …），
// 必须一起落盘并读回：2026-11-11 发现 #14 的 3006 条逐项 HEAD 审计结果就是因为旧 persist
// 只写这份白名单而被静默丢掉（主台账和两个 .bak 里都查不到）。
var LEDGER_KEYS = ['at', 'tag', 'host', 'totSent', 'folders', 'res2', 'subm', 'stuckIds',
  'vQueue', 'pendingSamples', 'aud', 'retry', 'treeStack', 'vDone', 'needDrain', 'p2'];
var LEDGER_MEMONLY = { tr: 1 };   // 内存日志，不落盘
var isExtraKey = function (k) {
  return k.slice(0, 2) !== '__' && LEDGER_KEYS.indexOf(k) < 0 && !LEDGER_MEMONLY[k];
};
var clearExtras = function () { Object.keys(L).forEach(function (k) { if (isExtraKey(k)) delete L[k]; }); };

H.persist = async function (tag, opts) {
  opts = opts || {};
  try {
    var fs = await import('node:fs');
    var p = String(CFG.ledger).replace(/\\/g, '/');
    var dir = p.slice(0, p.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });   // 新机器上目录可能还不存在
    // 回归保护：盘上台账进度明显高于内存时拒绝覆盖（防「空 L / 旧 L」把台账洗掉）
    // 确实要重置时显式传 { force: true }
    if (!opts.force && fs.existsSync(CFG.ledger)) {
      try {
        var disk = JSON.parse(fs.readFileSync(CFG.ledger, 'utf8'));
        var diskDone = Object.keys(disk.vDone || {}).length;
        var memDone = Object.keys(L.vDone || {}).length;
        var diskSent = disk.totSent || 0, memSent = L.totSent || 0;
        if (diskDone > memDone + 5 || diskSent > memSent + 50) {
          fs.writeFileSync(CFG.ledger + '.conflict-' + Date.now(), JSON.stringify(disk));
          return 'PERSIST_REFUSED disk(vDone=' + diskDone + ',totSent=' + diskSent + ') > mem(vDone=' + memDone + ',totSent=' + memSent + ')';
        }
      } catch (e2) { /* 盘上文件坏了就不拦 */ }
      try { fs.copyFileSync(CFG.ledger, CFG.ledger + '.bak'); } catch (e3) { }
    }
    // 原子替换：先写 .tmp 再 rename。直接覆写 900KB 台账时，同一时刻的读者（监视进程、
    // 或恰好被回收后重启的 load）会读到半截 JSON —— 见 scripts/test_persist_atomic.mjs。
    var out = {
      at: new Date().toISOString(), tag: tag || '', host: CFG.host, totSent: L.totSent,
      folders: L.folders, res2: L.res2, subm: L.subm, stuckIds: L.stuckIds,
      vQueue: L.vQueue, pendingSamples: L.pendingSamples, aud: L.aud || {}, retry: L.retry,
      treeStack: L.treeStack || [], vDone: L.vDone || {}, needDrain: L.needDrain || {},
      p2: L.p2 && L.p2.done ? { done: L.p2.done } : { done: {} }
    };
    // 附加证据一起落盘（函数/undefined 跳过，保证 JSON 安全）
    Object.keys(L).forEach(function (k) {
      if (!isExtraKey(k)) return;
      var v = L[k];
      if (v === undefined || typeof v === 'function') return;
      out[k] = v;
    });
    fs.writeFileSync(CFG.ledger + '.tmp', JSON.stringify(out));
    fs.renameSync(CFG.ledger + '.tmp', CFG.ledger);
    return true;
  } catch (e) { return 'PERSIST_FAIL ' + String((e && e.message) || e).slice(0, 120); }
};

// kernel 被回收后从盘上恢复（boot() 之后调用；不依赖浏览器，boot 失败也能先 load）
H.load = async function () {
  var fs = await import('node:fs');
  var tryRead = function (fp) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return null; }
  };
  var reset = function (reason) {
    // 台账读不出来（或该任务还没有台账）：内存必须一起清零，避免串用上一个任务的 folders/游标
    Object.assign(L, { folders: {}, res2: {}, subm: {}, stuckIds: {}, vQueue: [], pendingSamples: [], totSent: 0, aud: {}, retry: {}, treeStack: [], vDone: {}, tr: [], needDrain: {}, p2: { done: {} } });
    clearExtras();   // 附加证据也要清，否则上一个任务的审计会串到新台账
    L.__loadedAt = new Date().toISOString();
    L.__ledgerPath = String(CFG.ledger);
    return { loaded: false, reason: reason, ledger: CFG.ledger };
  };
  // 盘上主文件不存在、或者只剩半截（覆写被打断）而 .bak 能读时，先拿 .bak 把主文件修好
  if (((!fs.existsSync(CFG.ledger)) || tryRead(CFG.ledger) === null) && fs.existsSync(CFG.ledger + '.bak')) {
    if (tryRead(CFG.ledger + '.bak')) { try { fs.copyFileSync(CFG.ledger + '.bak', CFG.ledger); } catch (e) { } }
  }
  if (!fs.existsSync(CFG.ledger)) return reset('no-ledger');  // 新机器首次运行：还没有台账，直接建队列
  var s = tryRead(CFG.ledger);
  if (!s) return reset('corrupt');   // 主文件和 .bak 都坏：如实报，绝不抛异常、也绝不带着半个游标继续跑
  // p2 游标规则：
  //   盘上有 -> 以盘上为准（同一文件时，内存里更多则保留内存，防止 re-import 清掉跑到一半的游标）
  //   盘上没有 -> 只有「还是同一个台账文件」（同内核 re-import）才保留内存，换任务必须清零，
  //             否则 2025 的游标会串到 2024 的台账上（同 folders/totSent 那类事故）。
  var sameLedger = L.__ledgerPath === String(CFG.ledger);
  var diskP2 = (s.p2 && s.p2.done) ? s.p2.done : null;
  var memP2 = (L.p2 && L.p2.done && sameLedger) ? L.p2.done : null;
  var p2done = !diskP2 ? (memP2 || {})
    : (!memP2 ? diskP2 : (Object.keys(diskP2).length >= Object.keys(memP2).length ? diskP2 : memP2));
  Object.assign(L, { folders: s.folders || {}, res2: s.res2 || {}, subm: s.subm || {}, stuckIds: s.stuckIds || {}, vQueue: s.vQueue || [], pendingSamples: s.pendingSamples || [], totSent: s.totSent || 0, aud: s.aud || {}, retry: s.retry || {}, treeStack: s.treeStack || [], vDone: s.vDone || {}, needDrain: s.needDrain || {}, p2: { done: p2done } });
  L.tr = [];
  // 附加证据：先清掉内存里上一个任务留下的，再以盘上为准（换台账不能串，同台账要能读回）
  clearExtras();
  Object.keys(s).forEach(function (k) { if (isExtraKey(k)) L[k] = s[k]; });
  L.__loadedAt = new Date().toISOString();
  L.__ledgerPath = String(CFG.ledger);
  return { loaded: true, at: s.at, tag: s.tag, folders: Object.keys(L.folders).length, queue: L.vQueue.length, totSent: L.totSent, treeStack: L.treeStack.length, vDone: Object.keys(L.vDone).length, p2: Object.keys(L.p2.done).length };
};

// 一键准备：先 load（不依赖浏览器），再 boot（失败只记录不抛），最后返回可判定结果
// 批量前必须看到 ok:true 才允许 processTree
H.ready = async function () {
  var out = {};
  out.load = await H.load();
  try { out.boot = await H.boot(); }
  catch (e) { out.boot = { err: 'BOOT_FAIL', why: String((e && e.message) || e).slice(0, 200) }; }
  out.ok = !!(out.boot && (out.boot.claimed || out.boot.created) && out.load && out.load.loaded !== undefined);
  return out;
};

/* ---------- 整支 missing 子树的补跑根集 + 假完成标记的检测与撤销 ---------- */

// 最小补跑根集：parent 不在 missing 里的那些 id。
// processTree(root) 用 API 递归枚举 root 的全部后代，所以从这些根进去恰好覆盖 missing（含孙目录），
// 不必对年度根重跑整棵树 —— 年度根的 vDone 已 done:true，照无人值守模板会被判 already-done 跳过；
// 删掉它的 vDone 再 fresh:true 则是整年重跑，还会撞 persist 回归保护。
// 注意：processTree 不按 vDone 跳过已完成子目录，所以根下若混有已完成的后代会被重跑一遍（只补提仍坏的，安全但费时）。
H.missingRoots = function (parents, missing) {
  var m = {};
  (missing || []).forEach(function (id) { m[String(id)] = 1; });
  return Object.keys(m).filter(function (id) {
    var p = parents ? parents[id] : null;
    return p == null || !m[String(p)];      // 孤儿（parent 查不到）也当根，宁可多跑不可漏跑
  }).sort(function (a, b) { return (+a) - (+b); });
};

// 完成标记可信吗？金标准只有两条：逐项 HEAD 全覆盖，或排空证据盖满**图片槽位**。
// bad=0 / loaded>=all / drain:converted 都只覆盖渲染窗口（81–198 张）：
// 7979 有 82 项、窗口 81，页面全绿、p2.done=1，窗外第 82 条 HEAD sm 实测 404。
// led = {folders, res2, vDone, p2}
// opts.head = 逐目录 HEAD 结果，两种口径都认：recheck.json 的 {total, smBad:[ids], xlBad:[ids], other:[…], nock}
//   与简写的 {n, smBad:数字, xlBad:数字}。other（非 200/404）与 nock（无 cache_key）都算结论不确定。
// opts.kids = {id:子目录数}，从 API 父链（tree-recheck.json 的 rows）算；台账 folders 里 1212/1257 条没有 kids。
// total 是页面「N 个项目」= 直属条目 + 子目录卡片，所以图片槽位 = total - kids；
// drain 落盘只有 {reason, loaded, all, bad, waited, at}，没有 folders。
// kids 三处都拿不到时报 unknown（不撤销）：把 total 当图片数会把纯容器 7227 判成「130 张全无证据」。
H.headStat = function (h) {
  if (!h) return null;
  var cnt = function (v) { return Array.isArray(v) ? v.length : (Number(v) || 0); };
  var n = h.total != null ? h.total : (h.items != null ? h.items : h.n);   // recheck.res=total / repair.dirRecheck=items / 简写=n
  return {
    n: Number(n) || 0,
    smBad: cnt(h.smBad), xlBad: cnt(h.xlBad), other: cnt(h.other), nock: Number(h.nock) || 0
  };
};

H.falseMarks = function (led, opts) {
  var o = opts || {}, l = led || {};
  var folders = l.folders || {}, res2 = l.res2 || {}, vDone = l.vDone || {};
  var p2done = (l.p2 && l.p2.done) || {}, head = o.head || {}, kidsMap = o.kids || {};
  var out = { bad: [], trusted: [], unknown: [], gaveup: 0, unmarked: 0 };
  Object.keys(folders).forEach(function (id) {
    var f = folders[id] || {}, tot = Number(f.total) || 0;
    var hs = H.headStat(head[id]);
    var known = f.kids != null, kids = Number(f.kids) || 0;
    if (!known && kidsMap[id] != null) { kids = Number(kidsMap[id]) || 0; known = true; }
    // HEAD 把直属条目列全了 ⇒ total 与条目数的差额就是子目录卡片数
    if (!known && hs) { kids = Math.max(0, tot - hs.n); known = true; }
    var slots = Math.max(0, tot - kids);
    var mark = p2done[id];
    if (mark === 2) { out.gaveup++; return; }        // 复检六次仍坏：已知坏，不是假干净，别动
    var done = !!(vDone[id] && vDone[id].done);
    if (!done && mark == null) { out.unmarked++; return; }
    var r = res2[id] || {}, d = r.drain, why = null;
    var rec = function (bucket, via) {
      var x = { id: id, total: tot, kids: known ? kids : null, all: d ? (Number(d.all) || 0) : null,
        mark: mark == null ? null : mark, vDone: done };
      if (via) x.via = via; else { x.why = why; x.smBad = hs ? hs.smBad : null; x.xlBad = hs ? hs.xlBad : null; }
      out[bucket].push(x);
    };
    // ① HEAD 实测：与 kids / 渲染窗口都无关，最硬的证据
    if (hs && (hs.smBad > 0 || hs.xlBad > 0)) { why = 'head-missing'; rec('bad'); return; }
    if (hs && hs.smBad === 0 && hs.xlBad === 0 && hs.other === 0 && hs.nock === 0 && hs.n >= slots) { rec('trusted', 'head'); return; }
    // ② 页面证据本身就是脏的：同样不需要 kids
    if (r.blocked) { why = 'blocked:' + r.blocked; rec('bad'); return; }
    if ((r.stillBadWindow || 0) > 0) { why = 'still-bad-window'; rec('bad'); return; }
    if (r.sent === 0 && r.clean === false) { why = 'zero-submit-dirty'; rec('bad'); return; }
    // ③ 排空证据盖满 total（slots <= total，所以不需要知道 kids）
    if (d && (d.reason === 'converted' || d.reason === 'empty') && (Number(d.all) || 0) >= tot) { rec('trusted', 'drain'); return; }
    if (!known) { why = 'kids-unknown'; rec('unknown'); return; }
    if (slots === 0) { rec('trusted', 'container'); return; }   // 纯容器：没有直属条目要转换
    if (d && (d.reason === 'converted' || d.reason === 'empty')) {
      if ((Number(d.all) || 0) >= slots) { rec('trusted', 'drain'); return; }
      why = 'window-partial';                        // 证据只盖窗口：7979 那一类
    } else why = d ? 'drain:' + d.reason : 'no-drain';
    rec('bad');
  });
  return out;
};

// 撤销不可信的完成标记并落盘。撤销会让内存 vDone 变少 ⇒ 必然撞 persist 的回归保护
// （disk.vDone > mem.vDone + 5 就拒绝覆盖并留 .conflict），所以这里一律 force:true。
// 不 force 的后果不是抛错而是**静默不生效**：persist 返回 'PERSIST_REFUSED…' 字符串，
// 下一次 load 又从盘上把假标记读回来。调用方必须看 ok（=== persist 返回 true）。
// 只删 vDone / p2.done，保留 res2 与审计证据；提交过却没排空的补一笔 needDrain 欠账。
// p2.done=2（已知仍坏）不动；kids 与 HEAD 都缺的进 unknown 桶，同样不动（先补证据再判）。
// 撤销后重跑：整支子树用 processTree(根)（会建档 folders 并写 vDone）；已建档的平铺目录用 p2Pass({ids})。
// p2Pass 自己不写 folders/vDone：判干净的分支只写 p2.done，脏目录分支经 submitAndDrain→pumpX2 才写 vDone。
// 所以撤销后只用 p2Pass 复跑，判干净的那些目录 vDone 不会回来（汇总口径会少）：要么走 processTree，要么按 HEAD 证据登记。
H.revokeFalseMarks = async function (opts) {
  var o = opts || {};
  // 与 processTree 同一道闸：没 load 就跑，空 L 配 force:true 会绕过回归保护把真台账洗成空。
  if (!L.__loadedAt) return { ok: false, err: 'LEDGER_NOT_LOADED', bad: [], revoked: 0, debt: 0, dryRun: !!o.dryRun, persist: null };
  var rep = H.falseMarks(L, o);
  var sentOf = function (id) { return ((L.res2 || {})[id] || {}).sent || 0; };
  var debtOf = function (b) { return sentOf(b.id) > 0 && !((L.res2 || {})[b.id] || {}).drain; };
  // revoked/debt 是「将会做什么」，dryRun 下同样要算出来（否则 dry run 报 0，调用方以为没影响）
  var res = { bad: rep.bad, trusted: rep.trusted.length, unknown: rep.unknown.length, unknownIds: rep.unknown.map(x => x.id),
    gaveup: rep.gaveup, unmarked: rep.unmarked,
    revoked: rep.bad.length, debt: rep.bad.filter(debtOf).length,
    dryRun: !!o.dryRun, persist: null, ok: false };
  if (o.dryRun) return res;
  L.vDone = L.vDone || {}; L.p2 = L.p2 || { done: {} }; L.p2.done = L.p2.done || {}; L.needDrain = L.needDrain || {};
  rep.bad.forEach(function (b) {
    var id = b.id;
    delete L.vDone[id];
    delete L.p2.done[id];
    if (debtOf(b)) L.needDrain[id] = { total: b.total || 0, at: Date.now(), sent: sentOf(id), why: 'revoke' };
  });
  res.persist = await H.persist(o.tag || 'revoke-false-marks', { force: true });
  res.ok = res.persist === true;
  return res;
};

say(JSON.stringify({
  loaded: true, host: CFG.host, ledger: CFG.ledger,
  bootHint: '先 await globalThis.__H.boot()；再 await H.probe() 校验判据',
  fns: Object.keys(H).filter(k => typeof H[k] === 'function')
}));
