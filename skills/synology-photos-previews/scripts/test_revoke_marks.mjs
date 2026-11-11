// 假完成标记的检测与撤销 + 整支 missing 子树的最小补跑根集。
// 事故（2026-11-11 全树复查）：目录 7979 有 82 项、渲染窗口只挂载 81 张，
// 页面 {all:81, loaded:81, bad:0}、res2.drain=converted、vDone.done=true、p2.done=1，
// 而窗外第 82 条（121626）HEAD sm 实测 404。旧自查只抓 `sent===0 && clean===false`，
// 这一类「证据只盖窗口」的假完成一个都抓不到。
// 另外：撤销标记会让内存 vDone 数量下降，H.persist 的回归保护（disk > mem+5）会拒绝写入
// 并留 .conflict，撤销必须显式 force 且校验返回值，否则下一次 load 又把假标记读回来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-revoke-'));
const ledger = path.join(dir, 'ledger.json').replace(/\\/g, '/');
const seed = {
  at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {},
  stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}, p2: { done: {} }
};
fs.writeFileSync(ledger, JSON.stringify(seed));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED;
const readDisk = () => JSON.parse(fs.readFileSync(ledger, 'utf8'));

// 三个真实样本 + 三个必须保留的对照
// 注意 drain 记录的真实字段只有 {reason, loaded, all, bad, waited, at}（drainNode 落盘口径），
// 没有 folders；子目录数只能读 folders[id].kids。total 是页面「N 个项目」= 直属条目 + 子目录卡片。
const sample = () => ({
  folders: {
    '7979': { id: '7979', total: 82, kids: 0 },
    '8123': { id: '8123', total: 40, kids: 0 },
    '9001': { id: '9001', total: 12, kids: 0 },
    '5000': { id: '5000', total: 16, kids: 0 },   // 证据充分：converted 且 all>=total
    '7227': { id: '7227', total: 130, kids: 130 }, // 纯容器：0 直属条目
    '5100': { id: '5100', total: 100, kids: 10 }   // 混合容器：90 张图全加载完
  },
  res2: {
    '7979': { id: '7979', sent: 3, batches: 1, clean: true, drain: { reason: 'converted', loaded: 81, all: 81, bad: 0 } },
    '8123': { id: '8123', sent: 0, batches: 0, blocked: 'budget', clean: false, stillBadWindow: 40 },
    '9001': { id: '9001', sent: 2, batches: 1, clean: true },
    '5000': { id: '5000', sent: 16, batches: 1, clean: false, drain: { reason: 'converted', loaded: 16, all: 16, bad: 0 } },
    '7227': { id: '7227', sent: 0, clean: true, drain: { reason: 'empty', loaded: 0, all: 0, bad: 0 } },
    '5100': { id: '5100', sent: 90, batches: 2, clean: false, drain: { reason: 'converted', loaded: 90, all: 90, bad: 0 } }
  },
  vDone: {
    '7979': { done: true }, '8123': { done: true }, '9001': { done: true },
    '5000': { done: true }, '7227': { done: true }, '5100': { done: true }
  },
  p2: { done: { '7979': 1, '8123': 1, '9001': 3, '5000': 1, '7227': 3, '5100': 1 } }
});
const badIds = (r) => r.bad.map(x => String(x.id)).sort();

await test('missingRoots：只返回 parent 不在 missing 里的 id（整支子树的最小根集）', async () => {
  const parents = { '412': '0', '2254': '412', '2226': '412', '90001': '2254', '90002': '90001', '90003': '90001', '90004': '2254', '90005': '2254', '90006': '2226', '90007': '90006', '32341': '412' };
  const missing = ['90001', '90002', '90003', '90004', '90006', '90007', '32341'];
  const roots = H.missingRoots(parents, missing).map(String).sort();
  assert.deepEqual(roots, ['32341', '90001', '90004', '90006'].sort(), '最小根集不对: ' + JSON.stringify(roots));
});

await test('missingRoots：每个 missing id 都是某个根的后代（覆盖性，孙目录不能漏）', async () => {
  const parents = { '412': '0', '2254': '412', '90001': '2254', '90002': '90001', '90003': '90002', '90004': '2254' };
  const missing = ['90001', '90002', '90003', '90004'];
  const roots = new Set(H.missingRoots(parents, missing).map(String));
  for (const id of missing) {
    let cur = String(id), hops = 0;
    while (!roots.has(cur) && hops++ < 50) cur = String(parents[cur]);
    assert.ok(roots.has(cur), id + ' 往上走不到任何根，会被漏跑');
  }
});

await test('missingRoots：parent 缺失（孤儿）或根本身在 missing 里，都当根处理', async () => {
  const roots = H.missingRoots({ '412': '0' }, ['412', '8888']).map(String).sort();
  assert.deepEqual(roots, ['412', '8888'].sort(), '孤儿/根被丢掉: ' + JSON.stringify(roots));
});

await test('falseMarks：抓「证据只盖渲染窗口」（7979：converted 但 all 81 < total 82）', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(badIds(r).includes('7979'), '窗口内假完成没被抓到: ' + JSON.stringify(badIds(r)));
  assert.equal(r.bad.find(x => x.id === '7979').why, 'window-partial');
});

await test('falseMarks：抓「零提交且页面仍脏」（8123：sent 0 / clean false / blocked budget）', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(badIds(r).includes('8123'), '零提交假完成没被抓到');
});

await test('falseMarks：抓「有提交但没有 drain 证据」（9001：p2.done=3 也不算数）', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(badIds(r).includes('9001'), '无排空证据的 p2.done=3 没被抓到');
});

await test('falseMarks：证据充分的不许撤销（converted 且 all >= total）', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(!badIds(r).includes('5000'), '把证据充分的目录误撤销了');
});

await test('falseMarks：纯容器（total == kids，drain empty）不许撤销', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(!badIds(r).includes('7227'), '把纯容器误判成窗口内证据不足');
});

await test('falseMarks：混合容器按图片槽位算（total-kids），90 张全加载完不算窗口内证据不足', async () => {
  const r = H.falseMarks(sample(), {});
  assert.ok(!badIds(r).includes('5100'), '把 total=100/kids=10/all=90 的混合容器误撤销了');
  const s = sample();
  s.res2['5100'].drain = { reason: 'converted', loaded: 81, all: 81, bad: 0 };
  const r2 = H.falseMarks(s, {});
  assert.ok(badIds(r2).includes('5100'), '混合容器只挂载 81/90 张却没被抓到');
});

await test('falseMarks：提交过但窗口仍坏（stillBadWindow>0、无 blocked、无 drain）不采信', async () => {
  const s = sample();
  s.res2['5000'] = { id: '5000', sent: 16, batches: 1, clean: false, stillBadWindow: 7 };
  const r = H.falseMarks(s, {});
  const hit = r.bad.find(x => x.id === '5000');
  assert.ok(hit, '窗口仍坏却被当成完成');
  assert.equal(hit.why, 'still-bad-window');
});

await test('falseMarks：drain 不是 converted/empty（stalled）一律不采信', async () => {
  const s = sample();
  s.res2['5000'].drain = { reason: 'stalled', loaded: 9, all: 16, bad: 0 };
  const r = H.falseMarks(s, {});
  const hit = r.bad.find(x => x.id === '5000');
  assert.ok(hit, 'stalled 被当成完成');
  assert.equal(hit.why, 'drain:stalled');
});

await test('falseMarks：逐项 HEAD 证据全覆盖时采信（smBad=0 xlBad=0 且 n+kids>=total）', async () => {
  const s = sample();
  const head = { '7979': { n: 82, smBad: 0, xlBad: 0 }, '9001': { n: 12, smBad: 0, xlBad: 0 } };
  const r = H.falseMarks(s, { head: head });
  assert.ok(!badIds(r).includes('7979'), '有 HEAD 全量证据仍被撤销');
  assert.ok(!badIds(r).includes('9001'), '有 HEAD 全量证据仍被撤销');
  assert.ok(badIds(r).includes('8123'), 'HEAD 没覆盖的目录不该被放过');
});

await test('falseMarks：HEAD 证据只覆盖一部分条目时不采信（n+kids < total）', async () => {
  const s = sample();
  const r = H.falseMarks(s, { head: { '7979': { n: 81, smBad: 0, xlBad: 0 } } });
  assert.ok(badIds(r).includes('7979'), '只核了 81/82 条就被当成全目录干净');
});

await test('falseMarks：p2.done=2（复检六次仍坏）不是假干净，不许动', async () => {
  const s = sample();
  s.p2.done['8123'] = 2;
  const r = H.falseMarks(s, {});
  assert.ok(!badIds(r).includes('8123'), '把已知仍坏的标记当成假干净撤销了');
  assert.equal(r.gaveup, 1);
});

await test('falseMarks：没有任何完成标记的目录不进撤销清单', async () => {
  const s = sample();
  delete s.vDone['9001']; delete s.p2.done['9001'];
  const r = H.falseMarks(s, {});
  assert.ok(!badIds(r).includes('9001'), '本来就没标记的目录被算进撤销');
});

await test('revokeFalseMarks：删掉 vDone 与 p2.done，并真的落盘（读盘验证）', async () => {
  await H.load();
  const s = sample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed', { force: true });
  const before = readDisk();
  assert.equal(Object.keys(before.vDone).length, 6);
  const r = await H.revokeFalseMarks({});
  assert.equal(r.ok, true, '撤销没落盘: ' + JSON.stringify(r.persist));
  assert.equal(L.vDone['7979'], undefined);
  assert.equal(L.p2.done['7979'], undefined);
  assert.equal(L.vDone['5000'].done, true, '证据充分的被误删');
  const d = readDisk();
  assert.equal(d.vDone['7979'], undefined, '盘上假标记还在');
  assert.equal(d.p2.done['7979'], undefined, '盘上 p2 假标记还在');
  assert.equal(d.vDone['5000'].done, true);
});

await test('revokeFalseMarks：撤销 >5 个时不能被 persist 回归保护拒绝（disk vDone > mem+5）', async () => {
  await H.load();
  const folders = {}, res2 = {}, vDone = {}, p2 = { done: {} };
  for (let i = 0; i < 12; i++) {
    const id = String(6000 + i);
    folders[id] = { id: id, total: 90, kids: 0 };
    res2[id] = { id: id, sent: 1, clean: true, drain: { reason: 'converted', loaded: 81, all: 81, bad: 0 } };
    vDone[id] = { done: true }; p2.done[id] = 1;
  }
  Object.assign(L, { folders, res2, vDone, p2, needDrain: {}, totSent: 12 });
  const pr = await H.persist('seed12', { force: true });
  assert.equal(pr, true);
  const r = await H.revokeFalseMarks({});
  assert.equal(r.revoked, 12, '应撤销 12 个: ' + JSON.stringify(r));
  assert.equal(r.ok, true, '被回归保护拒绝了: ' + JSON.stringify(r.persist));
  assert.equal(Object.keys(readDisk().vDone).length, 0, '盘上没清掉');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.indexOf('.conflict-') >= 0), [], '撤销不该产生 .conflict 文件');
});

await test('revokeFalseMarks：dryRun 只报不改（内存与盘都不动）', async () => {
  await H.load();
  const s = sample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed-dry', { force: true });
  const before = JSON.stringify(readDisk());
  const r = await H.revokeFalseMarks({ dryRun: true });
  assert.ok(r.bad.length >= 3, 'dryRun 也要报出清单');
  assert.equal(L.vDone['7979'].done, true, 'dryRun 改了内存');
  assert.equal(JSON.stringify(readDisk()), before, 'dryRun 写了盘');
});

await test('revokeFalseMarks：提交过但没排空的目录要补 needDrain 欠账', async () => {
  await H.load();
  const s = sample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed-debt', { force: true });
  await H.revokeFalseMarks({});
  assert.ok(L.needDrain['9001'], 'sent=2 且无 drain，应记欠排空');
  assert.equal(L.needDrain['9001'].sent, 2);
  assert.equal(L.needDrain['8123'], undefined, '零提交的不该记欠账');
  assert.ok(readDisk().needDrain['9001'], '欠账没落盘');
});

// ---- 真实文件的字段口径（2026-11-11 读盘实测，不是构造出来的）----
// recheck-2026-20261111.json: res['7979'] = {total:82, nock:0, videos:0, smBad:["121626"], xlBad:[], other:[]}
//   ⇒ 缺失是**数组**不是数字，计数字段叫 **total** 不是 n。
// ledger-2026.json: folders['7979'] = {id,name,total:82}（**没有 kids**，1257 条里 1212 条如此）；
//   res2['7979'] 没有 drain（只有 repair 子对象）；folders['7227']={id,name,total:130} 且 res2['7227'] === undefined。
//   ⇒ 纯容器（0 直属条目）会被当成「130 张图全无证据」误撤销。
const realHead = () => ({
  '7979': { total: 82, nock: 0, videos: 0, smBad: ['121626'], xlBad: [], other: [] },
  '5000': { total: 16, nock: 0, videos: 0, smBad: [], xlBad: [], other: [] },
  '9001': { total: 12, nock: 0, videos: 0, smBad: [], xlBad: [], other: [] },
  '7227': { total: 0, nock: 0, videos: 0, smBad: [], xlBad: [], other: [] }
});
const realSample = () => {
  const s = sample();
  Object.keys(s.folders).forEach(k => { delete s.folders[k].kids; });   // 真实台账没有 kids
  delete s.res2['7227'];                                               // 真实台账纯容器没有 res2
  delete s.res2['7979'].drain;                                         // 真实 7979 只有 repair，没有 drain
  return s;
};

await test('falseMarks：真实 recheck 口径（smBad/xlBad 数组 + total 计数）零缺失必须采信', async () => {
  const r = H.falseMarks(realSample(), { head: realHead() });
  assert.ok(!badIds(r).includes('5000'), 'HEAD 全 200 却被撤销（数组口径没认）: ' + JSON.stringify(r.bad));
  assert.ok(!badIds(r).includes('9001'), 'HEAD 全 200 却被撤销（total 计数没认）');
  assert.ok(r.trusted.some(x => x.id === '5000' && x.via === 'head'), '5000 不是按 head 采信的');
});

await test('falseMarks：HEAD 实测有缺失 ⇒ why=head-missing，并报出 sm/xl 缺失条数', async () => {
  const r = H.falseMarks(realSample(), { head: realHead() });
  const hit = r.bad.find(x => x.id === '7979');
  assert.ok(hit, 'HEAD 实测 404 的目录没进撤销清单');
  assert.equal(hit.why, 'head-missing', '实际原因应是 HEAD 实测缺失，不是窗口推断: ' + hit.why);
  assert.equal(hit.smBad, 1);
  assert.equal(hit.xlBad, 0);
});

await test('falseMarks：7979 修好后（smBad 空数组、total 82 全覆盖）必须采信', async () => {
  const h = realHead(); h['7979'].smBad = [];
  const r = H.falseMarks(realSample(), { head: h });
  assert.ok(!badIds(r).includes('7979'), '已修复并 HEAD 复验通过仍被撤销');
});

await test('falseMarks：HEAD 有 other（非 200/404）或 nock>0 时结论不确定，不采信', async () => {
  const h1 = realHead(); h1['7979'].smBad = []; h1['7979'].other = [['121626', 'sm', 500]];
  assert.ok(badIds(H.falseMarks(realSample(), { head: h1 })).includes('7979'), 'other 非空却当成全干净');
  const h2 = realHead(); h2['7979'].smBad = []; h2['7979'].nock = 3;
  assert.ok(badIds(H.falseMarks(realSample(), { head: h2 })).includes('7979'), 'nock>0（无法 HEAD）却当成全干净');
});

await test('falseMarks：纯容器没有 res2 记录也不算假完成（kids 已知 ⇒ 0 图片槽位）', async () => {
  const s = sample(); delete s.res2['7227'];
  const r = H.falseMarks(s, {});
  assert.ok(!badIds(r).includes('7227'), '把纯容器当成「130 张图无证据」: ' + JSON.stringify(r.bad.find(x => x.id === '7227')));
});

await test('falseMarks：kids 缺失时用 opts.kids（API 父链算出的子目录数）补上', async () => {
  const kids = { '7979': 0, '8123': 0, '9001': 0, '5000': 0, '7227': 130, '5100': 10 };
  const r = H.falseMarks(realSample(), { kids: kids });
  assert.ok(!badIds(r).includes('7227'), '有 kids 映射仍把纯容器误判');
  assert.ok(!badIds(r).includes('5100'), '有 kids 映射仍把混合容器误判');
  const hit = r.bad.find(x => x.id === '7979');
  assert.ok(hit, 'kids 补齐后 7979 的窗口内证据不足应被抓到');
  assert.equal(hit.why, 'no-drain', '真实 7979 没有 drain 字段: ' + hit.why);
});

await test('falseMarks：kids 未知（台账没记、也没给 head/kids）⇒ 进 unknown 桶，不当假完成', async () => {
  const r = H.falseMarks(realSample(), {});
  const unk = r.unknown.map(x => String(x.id));
  assert.ok(unk.includes('7227'), 'kids 未知的纯容器应报 unknown 而不是 bad: ' + JSON.stringify(r.bad));
  assert.ok(unk.includes('7979'), 'kids 未知且有 head 缺失以外的目录应报 unknown');
  assert.ok(!badIds(r).includes('7227'), '证据不足以下结论却判成假完成');
  assert.ok(!badIds(r).includes('5100'), 'kids 未知却按 total 当图片数判窗口不足');
});

await test('falseMarks：kids 未知但 HEAD 实测有缺失，仍要抓（缺失证据与 kids 无关）', async () => {
  const r = H.falseMarks(realSample(), { head: { '7979': realHead()['7979'] } });
  const hit = r.bad.find(x => x.id === '7979');
  assert.ok(hit && hit.why === 'head-missing', 'HEAD 实测缺失被 kids 未知挡掉了: ' + JSON.stringify(r.unknown));
});

await test('falseMarks：drain.all >= total 时不需要 kids 也能采信（slots <= total）', async () => {
  const r = H.falseMarks(realSample(), {});
  assert.ok(!badIds(r).includes('5000'), 'all=16=total 已盖满仍被撤销');
  assert.ok(r.trusted.some(x => x.id === '5000' && x.via === 'drain'), '5000 应按 drain 采信');
  assert.ok(!r.unknown.some(x => x.id === '5000'), '证据已充分却报 unknown');
});

await test('falseMarks：kids 未知但页面证据本身就是脏的（blocked / stillBadWindow）仍要抓', async () => {
  const r = H.falseMarks(realSample(), {});
  const hit = r.bad.find(x => x.id === '8123');
  assert.ok(hit, 'blocked:budget 的假完成被 kids 未知挡掉了');
  assert.equal(hit.why, 'blocked:budget');
});

await test('falseMarks：修复复验口径 dirRecheck={items,smBad:0,xlBad:0} 也要认（计数字段第三种写法）', async () => {
  // recheck-2026-20261111.json 的 repair.dirRecheck 与 newDirsAudited[] 都用 items 计数
  const r = H.falseMarks(realSample(), { head: { '7979': { items: 82, smBad: 0, xlBad: 0 } } });
  const t = r.trusted.find(x => x.id === '7979');
  assert.ok(t && t.via === 'head', '修复复验通过却没被采信: ' + JSON.stringify(r.bad.concat(r.unknown)));
  assert.equal(t.kids, 0, 'items 没认出来 ⇒ 把 82 张图当成 82 个子目录: ' + JSON.stringify(t));
});

await test('revokeFalseMarks：unknown 桶不撤销（先补 head/kids 再判）', async () => {
  await H.load();
  const s = realSample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed-unknown', { force: true });
  const r = await H.revokeFalseMarks({});
  assert.ok(r.unknown >= 4, 'unknown 计数没回报: ' + JSON.stringify(r));
  assert.equal(L.vDone['7227'].done, true, 'kids 未知却撤销了纯容器');
  assert.equal(L.p2.done['5100'], 1, 'kids 未知却撤销了混合容器');
  assert.equal(readDisk().vDone['7227'].done, true, '盘上也被误删');
});

await test('revokeFalseMarks：dryRun 要报「将会撤销/将会补欠账」的数量，不是恒 0', async () => {
  // GREEN 复测发现：dryRun 在累加前 return，revoked/debt 恒 0 ⇒ 配方里打印 dry.debt 是误导。
  // dry run 的用途就是「先看会做什么」，所以这两个数必须在 dryRun 下也算出来。
  await H.load();
  const s = sample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed-dry-count', { force: true });
  const before = JSON.stringify(readDisk());
  const r = await H.revokeFalseMarks({ dryRun: true });
  assert.equal(r.revoked, r.bad.length, 'dryRun 没报将会撤销的个数: ' + JSON.stringify(r.revoked));
  assert.equal(r.revoked, 3, 'sample 里应撤销 3 个（7979/8123/9001）');
  assert.equal(r.debt, 1, 'dryRun 没报将会补的欠账（只有 9001 sent>0 且无 drain）: ' + JSON.stringify(r.debt));
  assert.equal(L.vDone['7979'].done, true, 'dryRun 改了内存');
  assert.equal(L.needDrain['9001'], undefined, 'dryRun 记了欠账');
  assert.equal(JSON.stringify(readDisk()), before, 'dryRun 写了盘');
});

await test('revokeFalseMarks：没 load 台账时拒绝执行（空 L + force 会把真台账洗掉）', async () => {
  // 与 processTree 的 LEDGER_NOT_LOADED 闸同一类事故（2026-11-08）：kernel 回收后重装库，
  // 没 load 就跑，空 L 配 force:true 会绕过回归保护，把盘上的真台账覆盖成空。
  await H.load();
  const s = sample();
  Object.assign(L, { folders: s.folders, res2: s.res2, vDone: s.vDone, p2: s.p2, needDrain: {}, totSent: 7 });
  await H.persist('seed-noload', { force: true });
  const before = JSON.stringify(readDisk());
  const saved = L.__loadedAt;
  delete L.__loadedAt;
  try {
    const r = await H.revokeFalseMarks({});
    assert.equal(r.ok, false, '没 load 却报成功');
    assert.equal(r.err, 'LEDGER_NOT_LOADED');
    assert.equal(r.revoked, 0);
    assert.equal(JSON.stringify(readDisk()), before, '没 load 却写了盘');
  } finally { L.__loadedAt = saved; }
});

console.log('\nrevoke_marks: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;