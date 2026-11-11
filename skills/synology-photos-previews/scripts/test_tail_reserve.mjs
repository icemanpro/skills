// 尾巴预算：进脏目录之前要能判断「剩下的窗口够不够把它跑完」。
// 背景（2026-11-11 实测满窗 34~37）：小目录的尾巴截止是写死的 250s，
// 但脏区的目录大多只有几到几十张图 —— 一个 20 项的目录实测 ~40s（17s 固定开销 + 1.1s/张），
// 写死 250s 让每格白扔 200s（约 35% 窗口），845 个目录的 2026 二轮要多烧近两小时。
// 预算按目录大小算，但不得小于 submitAndDrain 跑完一个小目录所需的最小窗口（H.smallBudget().window），
// 否则外层放行了、内层却什么都没提，等于白导航。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-tail-'));
const ledger = path.join(dir, 'ledger-test.json').replace(/\\/g, '/');
fs.writeFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), tag: 't', host: 'test', totSent: 0, folders: {}, res2: {}, subm: {}, stuckIds: {}, vQueue: [], pendingSamples: [], aud: {}, retry: {}, treeStack: [], vDone: {}, needDrain: {} }));
globalThis.__CFG = { host: 'test', ledger: ledger, app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs');
const H = globalThis.__H;

await test('小目录预算按实测成本算，不再吃固定 250s', async () => {
  const r = H.tailReserve(20);
  assert.ok(typeof r === 'number' && isFinite(r), '要返回毫秒数: ' + r);
  assert.ok(r < 250000, '20 项的目录不该按 250s 预留: ' + r);
  assert.ok(r >= H.smallBudget().window, '不得小于 submitAndDrain 跑完一个小目录的最小窗口: ' + r);
});

await test('满页 120 项按 1.1s/张 + 固定开销，约 3 分钟且不超过 170s', async () => {
  const r = H.tailReserve(120);
  assert.ok(r >= 120000, '满页目录至少要 2 分钟: ' + r);
  assert.ok(r <= 170000, '预算虚高就又变成白扔窗口: ' + r);
});

await test('预算随条目数单调不减（空目录取最低值）', async () => {
  assert.equal(H.tailReserve(0), H.smallBudget().window, '空目录应取最低预留');
  assert.ok(H.tailReserve(50) >= H.tailReserve(30), '条目多预算必须更大');
  assert.ok(H.tailReserve(500) === H.tailReserve(120), '>120 走大目录分支，这里按整页封顶');
});

// 外层放行与内层所需必须是同一个数（2026-11-11 审计 4 实测：小目录 5 个 SUBMIT_BUDGET 饿死）。
await test('最低预留 = smallBudget 各段之和（外层放行即内层可提交）', async () => {
  const b = H.smallBudget();
  assert.equal(b.window, b.safety + b.reserve + b.minPump + b.slack, 'smallBudget 自身要自洽: ' + JSON.stringify(b));
  assert.ok(b.reserve >= 20000, '排空至少要 20s（goto 3.3 + minDwell 8 + 一轮 8s 轮询）: ' + b.reserve);
  assert.ok(b.minPump > 20000, 'pumpX2 进窗口前先扣 20s 截止，pump 低于它一批都提不出去: ' + b.minPump);
  assert.ok(b.slack > 3000, '外层判定到内层取时之间要跑安定闸门/上一次的 persist，没有抖动余量就等于卡在边界饿死: ' + b.slack);
  assert.equal(H.tailReserve(5), b.window, '外层放行的最低窗口必须等于内层所需，否则小目录白导航一场');
});

await test('放行线上 splitBudget 判可用；少了抖动余量就判不可用（slack 是承重的）', async () => {
  const b = H.smallBudget(), now = Date.now();
  const o = { safety: b.safety, reserve: b.reserve, minPump: b.minPump };
  const r = H.splitBudget(now + b.window, now, o);
  assert.equal(r.pump, b.minPump + b.slack, '边界上 pump 应等于 minPump + slack: ' + JSON.stringify(r));
  assert.equal(r.ok, true, '外层放行了内层却判不可用: ' + JSON.stringify(r));
  assert.equal(H.splitBudget(now + b.safety + b.reserve + b.minPump, now, o).ok, false,
    '去掉 slack 后边界必须判不可用，否则上面那条断言没测到 slack');
});

await test('默认口径（90+120+30）不受小目录改动影响', async () => {
  assert.equal(H.splitBudget(240000, 0).ok, false, '默认门槛被降低了');
  assert.equal(H.splitBudget(240001, 0).ok, true, '默认门槛被抬高了');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
