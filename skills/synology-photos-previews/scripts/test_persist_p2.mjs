// 第二轮复检的游标 L.p2.done 必须落盘。
// 背景（2026-11-11 实测）：persist() 的字段白名单里没有 p2，load() 也不恢复 p2，
// 于是台账盘上永远 done=0，而内存里已经跑了 500+ 个目录。node_repl 内核一旦被回收，
// 整个第二轮游标就丢，下一格从 0 重跑 —— 白烧几小时浏览器时间。
// 这两条断言就是这个 bug 的回归保护。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-p2-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');

function seedLedger(extra) {
  fs.writeFileSync(ledger, JSON.stringify(Object.assign({
    at: new Date().toISOString(), tag: 'p2', host: 'test', totSent: 100,
    folders: { '1': { id: '1', name: 'A', total: 3 }, '2': { id: '2', name: 'B', total: 5 } },
    res2: {}, subm: {}, stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {},
    treeStack: [], vDone: { '1': { done: true } }, needDrain: {}
  }, extra || {})));
}

seedLedger();
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED, CFG = globalThis.__CFG;
assert.equal(CFG.ledger, ledger, '测试必须把 ledger 指到临时文件');

await test('persist 把 p2.done 写进台账文件', async () => {
  const r = await H.load();
  assert.equal(r.loaded, true);
  L.p2 = { done: { '1': 1, '2': 1 } };
  assert.equal(await H.persist('p2'), true, 'persist 不应拒绝');
  const disk = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.ok(disk.p2, '盘上必须有 p2 字段');
  assert.equal(Object.keys(disk.p2.done).length, 2, '盘上游标数应为 2');
});

await test('load 从台账恢复 p2.done（内核被回收后接着跑）', async () => {
  seedLedger({ p2: { done: { '1': 1, '2': 1, '7': 1 } } });
  delete L.p2;                                   // 模拟全新内核
  const r = await H.load();
  assert.equal(r.loaded, true);
  assert.ok(L.p2, 'load 后内存必须有 p2');
  assert.equal(Object.keys(L.p2.done).length, 3, '游标必须完整恢复');
  assert.equal(L.p2.done['7'], 1);
});

await test('没有 p2 的旧台账 load 后得到一个空游标而不是崩', async () => {
  seedLedger();
  delete L.p2;
  const r = await H.load();
  assert.equal(r.loaded, true);
  assert.ok(L.p2 && typeof L.p2.done === 'object', '应补成 {done:{}}');
  assert.equal(Object.keys(L.p2.done).length, 0);
});

await test('p2 增长不会被 PERSIST_REFUSED 挡住（守卫只看 vDone/totSent）', async () => {
  L.totSent = 100;                               // 与盘上一致
  L.p2 = { done: {} };
  for (let i = 0; i < 300; i++) L.p2.done[String(i)] = 1;
  assert.equal(await H.persist('p2'), true);
  const disk = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(disk.p2.done).length, 300);
});

await test('游标体积可控：1835 个 done 只让台账增加不到 40KB', async () => {
  L.p2 = { done: {} };
  for (let i = 1000; i < 1000 + 1835; i++) L.p2.done[String(i)] = 1;
  await H.persist('p2');
  const bytes = fs.statSync(ledger).size;
  assert.ok(bytes < 200000, '台账文件不应膨胀到 ' + bytes + ' 字节');
});

await test('同内核 re-import 后 load 不能清掉跑到一半的游标（盘上还没 p2 的场合）', async () => {
  seedLedger();                                  // 盘上：无 p2
  L.p2 = { done: { '1': 1 } }; L.p2.done['42'] = 1;
  L.__ledgerPath = String(ledger);               // 同一个台账文件
  await H.load();
  assert.equal(Object.keys(L.p2.done).length, 2, '内存游标必须活着');
});

await test('换任务（另一个台账文件）时游标必须清零，不能把 2025 的 done 串给 2024', async () => {
  const ledger2 = path.join(dir, 'ledger-other.json').replace(/\\/g, '/');
  fs.writeFileSync(ledger2, JSON.stringify({
    at: new Date().toISOString(), tag: '', host: 'test', totSent: 0,
    folders: { '9': { id: '9', name: 'Z', total: 1 } }, res2: {}, subm: {}, stuckIds: {},
    vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {}
  }));
  L.p2 = { done: { '1': 1, '2': 1, '3': 1 } };   // 上一个任务的游标还挂在内存
  L.__ledgerPath = String(ledger);
  CFG.ledger = ledger2;
  await H.load();
  assert.equal(Object.keys(L.p2.done).length, 0, '新台账必须从空游标开始');
  CFG.ledger = ledger;
});

console.log('\npersist_p2: ' + pass + ' passed, ' + fail + ' failed');fs.rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
