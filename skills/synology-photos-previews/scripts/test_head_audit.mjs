// 单目录逐项 HEAD 审计（全目录结论的唯一硬证据）的可跑原语。
// 为什么收进库：DOM 的 bad=0 / loaded>=all / drain:converted 都只覆盖渲染窗口（实测 81–198 张），
// 82 项 / 窗口 81 的目录照样漏判（7979 窗外那条 HEAD sm 连测 3 次 404）。
// 逐项 HEAD 此前只活在一次性 cell 里：分页、去重、URL  quoting、8 并发、写台账各写一遍，抄错就白烧一格。
// 这里只替换浏览器边界（apiPost/synoToken/G/PW/persist），被测的是真实的分页/去重/记账控制流。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H, L = globalThis.__LED;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

/* ---------- URL 与去重（纯函数） ---------- */

await test('thumbHeadUrl：cache_key 要带 %22 引号并 encodeURIComponent，size/token 都在位', () => {
  assert.equal(typeof H.thumbHeadUrl, 'function', 'H.thumbHeadUrl 未实现');
  assert.equal(H.thumbHeadUrl('121626', 'abc def', 'sm', 'TOK'),
    '/synofoto/api/v2/t/Thumbnail/get?id=121626&cache_key=%22abc%20def%22&type=%22unit%22&size=%22sm%22&SynoToken=TOK');
  assert.equal(H.thumbHeadUrl('7', 'k', 'xl', 'TOK').includes('size=%22xl%22'), true);
});

await test('dedupeItems：按 id 去重、保留首次出现顺序（takentime 相同的条目跨页会重复）', () => {
  assert.equal(typeof H.dedupeItems, 'function', 'H.dedupeItems 未实现');
  const out = H.dedupeItems([{ id: 5 }, { id: 6 }, { id: 5 }, { id: '6' }, { id: 7 }]);
  assert.deepEqual(out.map((x) => String(x.id)), ['5', '6', '7']);
});

await test('headAuditSource：是「求值后为函数」的源码（IIFE 会被 shim 拒），两档尺寸 + 8 并发 + 数据内联', () => {
  assert.equal(typeof H.headAuditSource, 'function', 'H.headAuditSource 未实现');
  const rows = [{ id: 121626, ck: 'k1', type: 'photo' }];
  const src = H.headAuditSource(rows, 'TOK');
  assert.ok(/^async function\s*\(/.test(src), '源码必须以函数开头，不能是 IIFE: ' + src.slice(0, 40));
  assert.ok(src.includes('"sm"') && src.includes('"xl"'), '必须同时实测 sm 与 xl');
  assert.ok(src.includes('121626') && src.includes('k1'), 'shim 会丢 evaluate 第二个参数，数据必须内联');
  assert.ok(/k\s*<\s*8/.test(src), '并发 8（实测 ~100 次 HEAD/秒）');
  assert.ok(src.includes('method: "HEAD"') || src.includes("method: 'HEAD'"), '必须用 HEAD，不读 body');
});

/* ---------- 编排（__headAudit） ---------- */

await import('./head_audit.mjs?t=' + Date.now());
const headAudit = globalThis.__headAudit;

const ORIG = {};
function stub(o) {
  ['apiPost', 'synoToken', 'G', 'PW', 'persist'].forEach((k) => { if (!(k in ORIG)) ORIG[k] = H[k]; });
  Object.assign(H, o);
  L.folders = { '6000': { id: '6000', name: '年/某目录', total: 102 } };
  L.headAudit = {};
}
function restore() { Object.assign(H, ORIG); }

// 100 + 3 条，其中 id 100 跨页重复 ⇒ 去重后 102 条
function fakeApi(calls) {
  return async (api, p) => {
    calls.push({ api: api, offset: p.offset, limit: p.limit, folder: p.folder_id, version: p.version });
    const off = Number(p.offset);
    const mk = (i) => ({ id: i, type: 'photo', additional: { thumbnail: { cache_key: 'ck' + i, sm: 'ready' } } });
    if (off === 0) return { data: { list: Array.from({ length: 100 }, (_, k) => mk(k + 1)) } };
    if (off === 100) return { data: { list: [mk(100), mk(101), mk(102)] } };
    return { data: { list: [] } };
  };
}
function fakePage(captured, rep) {
  return {
    G: async (fn) => fn(),
    PW: () => ({ locator: () => ({ evaluate: async (src) => { captured.push(src); return JSON.stringify(rep); } }) }),
    synoToken: async () => 'TOK'
  };
}

await test('headAudit：分页翻到 <100 为止、跨页按 id 去重，参数走 FotoTeam/version 7', async () => {
  assert.equal(typeof headAudit, 'function', 'globalThis.__headAudit 未实现');
  const calls = [], captured = [];
  stub(Object.assign(fakePage(captured, { smBad: [101], xlBad: [], errs: [], n: 102, types: { photo: 102 } }), {
    apiPost: fakeApi(calls), persist: async () => true
  }));
  try {
    const rep = await headAudit('6000');
    assert.deepEqual(calls.map((c) => c.offset), ['0', '100'], '分页没翻到不足一页为止');
    assert.equal(calls[0].api, 'SYNO.FotoTeam.Browse.Item', '共享空间必须用 FotoTeam（Foto 是个人空间，返回 HTML）');
    assert.equal(calls[0].version, '7');
    assert.equal(rep.n, 102, '跨页重复的 id 没去重');
    assert.equal(rep.total, 102);
    assert.deepEqual(rep.smBad, [101]);
    assert.equal(captured.length, 1, '一次 evaluate 跑完全部条目，别逐条往返');
  } finally { restore(); }
});

await test('headAudit：默认不写台账；write:true 才落 headAudit[id] 并 persist', async () => {
  const calls = [], captured = [];
  let persists = 0;
  stub(Object.assign(fakePage(captured, { smBad: [], xlBad: [], errs: [], n: 102, types: {} }), {
    apiPost: fakeApi(calls), persist: async (tag) => { persists++; return true; }
  }));
  try {
    await headAudit('6000');
    assert.equal(Object.keys(L.headAudit).length, 0, '默认不该写台账');
    assert.equal(persists, 0);
    const rep = await headAudit('6000', { write: true });
    assert.equal(persists, 1);
    assert.equal(L.headAudit['6000'].n, 102);
    assert.ok(L.headAudit['6000'].at, '审计证据要带时间戳');
    assert.equal(rep.id, '6000');
  } finally { restore(); }
});

await test('headAudit：没有 cache_key 的条目计入 nock，不混进 smBad（判据要能如实报「测不了」）', async () => {
  const captured = [];
  stub(Object.assign(fakePage(captured, { smBad: [], xlBad: [], errs: [[9, 'no-ck']], n: 2, types: {} }), {
    apiPost: async () => ({ data: { list: [
      { id: 8, type: 'photo', additional: { thumbnail: { cache_key: 'ck8' } } },
      { id: 9, type: 'video', additional: {} }
    ] } }),
    persist: async () => true
  }));
  try {
    const rep = await headAudit('6000');
    assert.equal(rep.n, 2);
    assert.equal(rep.nock, 1, '缺 cache_key 的条目数要如实报出');
  } finally { restore(); }
});

/* ---------- 页内源码实跑（把生成的函数真的执行一遍，fetch 打桩） ----------
 * 只断言字符串形状证明不了行为：404 与 500/803 必须分开，否则一次服务端抖动就被报成「缺图」。 */

function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const evalSrc = (src) => (0, eval)('(' + src + ')');
const sizeOf = (url) => /size=%22(\w+)%22/.exec(url)[1];
const idOf = (url) => /[?&]id=([^&]+)/.exec(url)[1];

await test('headAuditSource 实跑：只有 404 算缺，其它状态进 other；URL 与 thumbHeadUrl 同口径', async () => {
  const rows = [{ id: '1', ck: 'a', type: 'photo' }, { id: '2', ck: 'b', type: 'video' }, { id: '3', ck: 'c', type: 'photo' }];
  const calls = [];
  let inflight = 0, peak = 0;
  const out = await withFetch(async (url, init) => {
    calls.push({ url: url, method: init && init.method });
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 1));
    inflight--;
    const id = idOf(url), size = sizeOf(url);
    if (id === '1' && size === 'sm') return { status: 404 };
    if (id === '2' && size === 'xl') return { status: 404 };
    if (id === '3') return { status: 500 };
    return { status: 200 };
  }, async () => JSON.parse(await evalSrc(H.headAuditSource(rows, 'TOK'))()));
  assert.deepEqual(out.smBad, ['1'], 'sm 缺图判定错了');
  assert.deepEqual(out.xlBad, ['2'], 'xl 缺图判定错了');
  assert.deepEqual(out.other, [['3', 'sm', 500], ['3', 'xl', 500]], '500 被当成缺图了');
  assert.equal(calls.length, 6, '每条都要测 sm 与 xl 两档');
  assert.ok(calls.every((c) => c.method === 'HEAD'), '必须用 HEAD');
  assert.ok(calls.some((c) => c.url === H.thumbHeadUrl('1', 'a', 'sm', 'TOK')), '页内 URL 与 H.thumbHeadUrl 不同口径');
  assert.ok(peak <= 8 && peak > 1, '并发应当 >1 且 <=8，实测 ' + peak);
  assert.equal(out.n, 3);
  assert.deepEqual(out.types, { photo: 2, video: 1 });
});

await test('headAuditSource 实跑：fetch 抛错进 errs，不混进 smBad/xlBad', async () => {
  const rows = [{ id: '9', ck: 'k9', type: 'photo' }];
  const out = await withFetch(async () => { throw new Error('net down'); },
    async () => JSON.parse(await evalSrc(H.headAuditSource(rows, 'TOK'))()));
  assert.deepEqual(out.smBad, []);
  assert.deepEqual(out.xlBad, []);
  assert.equal(out.errs.length, 2, '两档各记一次错');
  assert.equal(out.errs[0][0], '9');
});

console.log(`\nhead_audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);