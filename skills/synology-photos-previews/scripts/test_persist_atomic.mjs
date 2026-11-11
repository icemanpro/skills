// 台账写入必须是原子替换，且 load() 要能从「半截主文件」里靠 .bak 自救。
// 背景（2026-11-11 实测）：一个常驻监视进程在 05:04:22 读到
//   SyntaxError: Expected double-quoted property name in JSON at position 930625 (line 1 column 930626)
// —— 正是 persist() 用 fs.writeFileSync 直接覆写 900KB 台账时被读到的半截内容。
// 写的人没事，但如果内核恰好在同一时刻被回收，重启时 load() 会直接抛异常，
// 第二轮游标（p2.done，几千个目录的进度）就只能从零开始。
// 断言口径：load() 不许抛；主文件坏而 .bak 好时按 .bak 恢复；两个都坏时如实报 corrupt 并清内存。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-atomic-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');

const payload = {
  at: new Date().toISOString(), tag: 'p2', host: 'test', totSent: 100,
  folders: { '1': { id: '1', name: 'A', total: 3 }, '2': { id: '2', name: 'B', total: 5 } },
  res2: {}, subm: {}, stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {},
  treeStack: [], vDone: { '1': { done: true } }, needDrain: {},
  p2: { done: { '1': 1, '2': 1 } }
};

globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
fs.writeFileSync(ledger, JSON.stringify(payload));
await import('./synophotos_lib.mjs');
const H = globalThis.__H, L = globalThis.__LED, CFG = globalThis.__CFG;
assert.equal(CFG.ledger, ledger, '测试必须把 ledger 指到临时文件');

await test('persist 不留 .tmp，主文件可解析', async () => {
  await H.load();
  L.p2 = { done: { '1': 1, '2': 1 } };
  assert.equal(await H.persist('p2'), true, 'persist 不应拒绝');
  assert.equal(fs.existsSync(ledger + '.tmp'), false, '原子替换后临时文件必须不在');
  JSON.parse(fs.readFileSync(ledger, 'utf8'));
});

await test('主台账只剩半截时，load 用 .bak 恢复游标（不抛）', async () => {
  // 先正常跑一次，让 .bak 里有一份完整副本
  await H.persist('p2');
  const good = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger + '.bak', good);
  fs.writeFileSync(ledger, good.slice(0, Math.floor(good.length / 2)));   // 模拟覆写被打断
  L.p2 = { done: {} }; L.__ledgerPath = null;
  const r = await H.load();
  assert.equal(r.loaded, true, '半截主文件应当靠 .bak 恢复，不该 loaded:false: ' + JSON.stringify(r));
  assert.equal(Object.keys(L.p2.done).length, 2, '游标没恢复: ' + JSON.stringify(L.p2.done));
  JSON.parse(fs.readFileSync(ledger, 'utf8'));                            // 主文件要被修好
});

await test('主台账和 .bak 都坏时如实报 corrupt，不许抛异常', async () => {
  fs.writeFileSync(ledger, '{"folders": {"1": {"na');
  fs.writeFileSync(ledger + '.bak', '{"folders": {"1": {"na');
  L.p2 = { done: { '9': 1 } };
  const r = await H.load();
  assert.equal(r.loaded, false, '坏台账不能假装恢复: ' + JSON.stringify(r));
  assert.ok(/corrupt/.test(String(r.reason)), 'reason 要说清是文件坏了: ' + JSON.stringify(r));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
