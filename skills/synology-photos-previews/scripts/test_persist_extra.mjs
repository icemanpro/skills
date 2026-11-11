// 台账额外字段（审计证据）必须落盘并能读回。
// 事故（2026-11-11 发现）：#14 大目录补审把 3006 条逐项 HEAD 结果写进 L.apiAudit / L.repair / L.apiAuditMeta，
// 但 H.persist 只写一份固定白名单 ⇒ 这些字段从未落盘。实测 ledger-2026.json 与两个 .bak 里
// apiAudit / repair / apiAuditMeta 全部 MISSING，审计证据只剩报告正文，台账里查不回来。
// 同时换任务时额外字段必须清零，不能把 2026 的审计串给 2024（与 p2 游标同一类事故）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-persist-extra-'));
const ledger = path.join(dir, 'ledger-a.json').replace(/\\/g, '/');
const ledger2 = path.join(dir, 'ledger-b.json').replace(/\\/g, '/');
const seed = {
  at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {},
  stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}, p2: { done: {} }
};
fs.writeFileSync(ledger, JSON.stringify(seed));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED;
const readDisk = (p) => JSON.parse(fs.readFileSync(p || ledger, 'utf8'));

await test('审计类额外字段必须落盘（apiAudit / repair / apiAuditMeta）', async () => {
  await H.load();
  L.apiAudit = { '2696': { items: 2702, smBad: 40, xlBad: 0 } };
  L.repair = { '2696': { fixed: 40, batches: [40] } };
  L.apiAuditMeta = { at: '2026-11-11', method: 'FotoTeam.Browse.Item + HEAD' };
  const pr = await H.persist('audit');
  assert.equal(pr, true, 'persist 失败: ' + pr);
  const d = readDisk();
  assert.deepEqual(d.apiAudit, L.apiAudit, 'apiAudit 被白名单丢掉了');
  assert.deepEqual(d.repair, L.repair, 'repair 被白名单丢掉了');
  assert.deepEqual(d.apiAuditMeta, L.apiAuditMeta, 'apiAuditMeta 被白名单丢掉了');
});

await test('内部状态不落盘（__loadedAt / __ledgerPath）', async () => {
  await H.load();
  const pr = await H.persist('internal');
  assert.equal(pr, true);
  const d = readDisk();
  assert.equal(d.__loadedAt, undefined);
  assert.equal(d.__ledgerPath, undefined);
});

await test('load 把额外字段读回内存（往返一致）', async () => {
  const payload = { '7227': { items: 1289, smBad: 0 } };
  const d = readDisk();
  d.apiAudit = payload;
  fs.writeFileSync(ledger, JSON.stringify(d));
  delete L.apiAudit;
  const r = await H.load();
  assert.equal(r.loaded, true);
  assert.deepEqual(L.apiAudit, payload, '盘上的审计证据读不回来');
});

await test('换台账：额外字段必须清零，不能把上一个任务的审计串过来', async () => {
  await H.load();
  L.apiAudit = { '2696': { items: 2702 } };
  await H.persist('a');
  fs.writeFileSync(ledger2, JSON.stringify(seed));
  globalThis.__CFG.ledger = ledger2;
  try {
    const r = await H.load();
    assert.equal(r.loaded, true);
    assert.equal(L.apiAudit, undefined, '2026 的审计串到了另一个台账: ' + JSON.stringify(L.apiAudit));
  } finally {
    globalThis.__CFG.ledger = ledger;
    await H.load();
  }
});

await test('已知字段口径不变：p2 仍只落 done，tr 不落盘', async () => {
  await H.load();
  L.p2 = { done: { '1': 3 }, cursor: 'should-not-persist' };
  L.tr = [{ t: 1, id: '1', m: 'x' }];
  await H.persist('known');
  const d = readDisk();
  assert.deepEqual(d.p2, { done: { '1': 3 } }, 'p2 口径被改坏了: ' + JSON.stringify(d.p2));
  assert.equal(d.tr, undefined, 'tr 是内存日志，不该落盘');
});

await test('额外字段里的函数/undefined 不落盘（JSON 安全）', async () => {
  await H.load();
  L.someHelper = function () { return 1; };
  L.someUndef = undefined;
  L.auditNote = 'ok';
  const pr = await H.persist('fn');
  assert.equal(pr, true, 'persist 失败: ' + pr);
  const d = readDisk();
  assert.equal(d.someHelper, undefined);
  assert.equal(d.someUndef, undefined);
  assert.equal(d.auditNote, 'ok');
  delete L.someHelper; delete L.someUndef; delete L.auditNote;
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;