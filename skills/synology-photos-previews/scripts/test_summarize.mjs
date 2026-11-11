// summarize_ledger.cjs 必须报告新的排空审计字段，并且不能把 stillBadWindow=0 当成已收敛。
// 背景：broken class 在提交瞬间消失，旧口径「badWin=0 且无 blocked」= 已收敛 是错的；
// 真正的收敛证据是 res2[id].drain.reason ∈ {converted, empty}。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./summarize_ledger.cjs', import.meta.url));
const fixture = {
  at: '2026-11-10T00:00:00.000Z', host: 'test', totSent: 29,
  folders: { '1': { id: '1', name: 'A', total: 16 }, '2': { id: '2', name: 'B', total: 4 }, '3': { id: '3', name: 'C', total: 9 } },
  res2: {
    '1': { id: '1', pass: 'submit', sent: 16, total: 16, stillBadWindow: 0, clean: false, done: true, drain: { reason: 'converted', loaded: 16, all: 16, bad: 0, waited: 15000 } },
    '2': { id: '2', pass: 'submit', sent: 4, total: 4, stillBadWindow: 0, clean: false, done: true, drain: { reason: 'empty', loaded: 0, all: 0, bad: 0, waited: 20000 } },
    '3': { id: '3', pass: 'submit', sent: 9, total: 9, stillBadWindow: 0, clean: false, done: true, drain: { reason: 'stalled', loaded: 5, all: 9, bad: 4, waited: 60000 } }
  },
  subm: { '1': { a: 1 } }, stuckIds: {}, vQueue: [], pendingSamples: [], treeStack: [],
  vDone: { '1': { done: true }, '2': { done: true }, '3': { done: true } },
  needDrain: { '3': { total: 9, sent: 9 } }, retry: { '3': 1 },
  p2: { done: { '1': 1, '2': 1, '3': 2 } }
};

const tmp = path.join(os.tmpdir(), 'synophotos-summary-test-' + Date.now() + '.json');
fs.writeFileSync(tmp, JSON.stringify(fixture));
const out = execFileSync(process.execPath, [SCRIPT, tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

test('报告 drain 判据分布', () => {
  assert.ok(out.includes('drain 判据分布'), '缺少排空判据汇总行');
  const line = out.split('\n').find((l) => l.includes('drain 判据分布'));
  assert.ok(/converted["']?\s*:\s*1/.test(line), 'converted 计数不对: ' + line);
  assert.ok(/stalled["']?\s*:\s*1/.test(line), 'stalled 计数不对: ' + line);
  assert.ok(/empty["']?\s*:\s*1/.test(line), 'empty 计数不对: ' + line);
});

test('报告未补排空的 needDrain 目录', () => {
  assert.ok(/needDrain/.test(out), '缺少 needDrain 行');
  const line = out.split('\n').find((l) => l.includes('needDrain'));
  assert.ok(/:\s*1/.test(line), 'needDrain 计数不对: ' + line);
  assert.ok(line.includes('3'), '没列出待补排空目录 id: ' + line);
});

test('drain=stalled 的目录即使 badWin=0 也要列入仍未收敛', () => {
  const idx = out.indexOf('仍未收敛');
  assert.ok(idx >= 0, '缺少仍未收敛段落');
  const section = out.slice(idx);
  assert.ok(/^\s*3\s*\|/m.test(section), 'stalled 目录没被列入: ' + section.slice(0, 400));
});

test('drain=converted/empty 的目录不应列入仍未收敛', () => {
  const idx = out.indexOf('仍未收敛');
  const section = idx >= 0 ? out.slice(idx) : '';
  assert.ok(!/^\s*1\s*\|/m.test(section), 'converted 目录被误报为未收敛');
  assert.ok(!/^\s*2\s*\|/m.test(section), 'empty 目录被误报为未收敛');
});

// 二轮游标 p2.done：1=复检干净/已转换，2=6 次仍未收敛（必须单列），未覆盖=还没复检到的目录。
// 背景：报告口径以 p2 为准（res2 是首轮记账，判据已被证明不可靠），
// 所以 p2===2 的目录即使首轮 drain=converted 也必须出现在「仍未收敛」里。
test('报告二轮游标 p2 的三段计数', () => {
  const line = out.split('\n').find((l) => /二轮游标/.test(l));
  assert.ok(line, '缺少二轮游标行');
  assert.ok(/3\s*\/\s*3/.test(line), '游标覆盖数不对: ' + line);
  assert.ok(/干净\s*2/.test(line), '干净计数不对: ' + line);
  assert.ok(/仍坏\s*1/.test(line), '仍坏计数不对: ' + line);
  assert.ok(/未覆盖\s*0/.test(line), '未覆盖计数不对: ' + line);
});

test('p2=2 的目录即使首轮 drain=converted 也要列入仍未收敛', () => {
  const f = JSON.parse(JSON.stringify(fixture));
  f.res2['3'].drain = { reason: 'converted', loaded: 9, all: 9, bad: 0, waited: 5000 };
  f.res2['3'].stillBadWindow = 0;
  f.p2 = { done: { '1': 1, '2': 1, '3': 2 } };
  const t = path.join(os.tmpdir(), 'synophotos-summary-p2-' + Date.now() + '.json');
  fs.writeFileSync(t, JSON.stringify(f));
  let o = '';
  try { o = execFileSync(process.execPath, [SCRIPT, t], { encoding: 'utf8' }); }
  finally { fs.unlinkSync(t); }
  const idx = o.indexOf('仍未收敛');
  assert.ok(idx >= 0, '缺少仍未收敛段落');
  assert.ok(/^\s*3\s*\|/m.test(o.slice(idx)), 'p2=2 的目录没被列入: ' + o.slice(idx, idx + 400));
  assert.ok(/p2=2/.test(o.slice(idx)), '列了但没标明是二轮仍坏: ' + o.slice(idx, idx + 400));
});

test('未覆盖的目录数要如实报出（防把首轮记账当成全部复检完）', () => {
  const f = JSON.parse(JSON.stringify(fixture));
  f.p2 = { done: { '1': 1 } };
  const t = path.join(os.tmpdir(), 'synophotos-summary-gap-' + Date.now() + '.json');
  fs.writeFileSync(t, JSON.stringify(f));
  let o = '';
  try { o = execFileSync(process.execPath, [SCRIPT, t], { encoding: 'utf8' }); }
  finally { fs.unlinkSync(t); }
  const line = o.split('\n').find((l) => /二轮游标/.test(l));
  assert.ok(/1\s*\/\s*3/.test(line), '覆盖数不对: ' + line);
  assert.ok(/未覆盖\s*2/.test(line), '未覆盖数不对: ' + line);
});

test('没有 drain 字段的旧台账仍能汇总（向后兼容）', () => {
  const old = JSON.parse(JSON.stringify(fixture));
  Object.values(old.res2).forEach((r) => { delete r.drain; });
  delete old.needDrain;
  const t2 = path.join(os.tmpdir(), 'synophotos-summary-old-' + Date.now() + '.json');
  fs.writeFileSync(t2, JSON.stringify(old));
  let o2 = '';
  try { o2 = execFileSync(process.execPath, [SCRIPT, t2], { encoding: 'utf8' }); }
  finally { fs.unlinkSync(t2); }
  assert.ok(o2.includes('累计提交条目'), '旧台账汇总失败');
  assert.ok(!/NaN|undefined/.test(o2), '旧台账出现 NaN/undefined: ' + o2.slice(0, 300));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);