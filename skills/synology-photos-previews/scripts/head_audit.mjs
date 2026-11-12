// 单目录「全目录结论」审计：API 分页取全部条目 → 页内一次逐项 HEAD（sm + xl）。
// 装载后只定义 globalThis.__headAudit，**不自动跑**：
//   await import('file:///<本 skill 目录>/scripts/head_audit.mjs');
//   nodeRepl.write(JSON.stringify(await globalThis.__headAudit('6000')));            // 只读，不写台账
//   nodeRepl.write(JSON.stringify(await globalThis.__headAudit('6000', {write:true})));// 落 L.headAudit[id] + persist
// 为什么不能只看页面：DOM 的 bad=0 / loaded>=all / drain:converted 都只覆盖渲染窗口（实测 81–198 张），
// 82 项 / 窗口 81 的目录照样漏判（7979 窗外那条 HEAD sm 连测 3 次 404）。
// 通过判据 = smBad/xlBad/errs/other/nock 全为 0 且 n === 目录条目数；元数据 thumbnail.sm:"ready" 不可信。
// 分页/去重/URL/并发的判据由 scripts/test_head_audit.mjs 钉住（8 例）。
// 整棵树批量审计（页内递归枚举 + 分格游标）见 references/recheck-recipe.md，别在 node 侧逐目录调本函数。

globalThis.__headAudit = async function (id, opts) {
  var H = globalThis.__H, L = globalThis.__LED;
  var o = opts || {};
  var api = (globalThis.__CFG && globalThis.__CFG.space) ? 'SYNO.FotoTeam.Browse.Item' : 'SYNO.Foto.Browse.Item';
  var fid = String(id), off = 0, pages = 0, raw = [];
  for (;;) {
    var j = await H.apiPost(api, {
      api: api, method: 'list', version: '7', folder_id: fid,
      additional: JSON.stringify(['thumbnail']),
      sort_by: JSON.stringify('takentime'), sort_direction: JSON.stringify('asc'),
      offset: String(off), limit: '100'
    });
    if (!j || j.success === false || !j.data || !Array.isArray(j.data.list)) {
      // 803 / NOT_JSON 先核对登录态：掉登录是人工停机点，不自动重试
      return { ok: false, id: fid, err: 'ITEMS_API', code: j && j.code, why: (j && (j.err || j.head)) || 'no-json', pages: pages };
    }
    var arr = j.data.list;
    raw = raw.concat(arr); pages++;
    if (arr.length < 100) break;
    if (pages >= 60) return { ok: false, id: fid, err: 'PAGE_CAP', pages: pages };
    off += arr.length;
  }
  var items = H.dedupeItems(raw);                       // takentime 相同的条目跨页会重复
  var rows = items.map(function (x) {
    var th = (x.additional && x.additional.thumbnail) || {};
    return { id: String(x.id), ck: th.cache_key == null ? '' : String(th.cache_key), type: String(x.type || '?') };
  });
  var probe = rows.filter(function (r) { return !!r.ck; });
  var nock = rows.length - probe.length;                // 没有 cache_key = 测不了，如实报出，别混进 smBad
  var types = {};
  rows.forEach(function (r) { types[r.type] = (types[r.type] || 0) + 1; });

  var tok = await H.synoToken();
  var src = H.headAuditSource(probe, tok);
  var res = await H.G(() => H.PW().locator('body').evaluate(src));
  var p;
  try { p = typeof res === 'string' ? JSON.parse(res) : (res || null); } catch (e) { p = null; }
  if (!p) return { ok: false, id: fid, err: 'HEAD_NO_RESULT', n: rows.length, pages: pages };

  var rep = {
    id: fid, total: ((L.folders || {})[fid] || {}).total || 0, n: rows.length, pages: pages,
    nock: nock, types: types, videos: types.video || 0,
    smBad: p.smBad || [], xlBad: p.xlBad || [], other: p.other || [], errs: p.errs || [],
    at: new Date().toISOString()
  };
  rep.ok = rep.n > 0 && !rep.nock && !rep.smBad.length && !rep.xlBad.length && !rep.other.length && !rep.errs.length;
  if (o.write) {
    L.headAudit = L.headAudit || {};
    L.headAudit[fid] = rep;
    await H.persist(o.tag || ('head-audit-' + fid));
  }
  return rep;
};