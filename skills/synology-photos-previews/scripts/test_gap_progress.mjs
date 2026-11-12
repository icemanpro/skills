// 补跑进度汇总脚本（gap_progress.cjs）的测试：离线读 jsonl + 台账 + 计划，不碰浏览器。
// 为什么要有它：长泵期间台账数分钟不更新是正常的，判「卡死 vs 在跑」只能看 jsonl 新行；
// 而脚本必须换机可跑 —— 路径全部来自 argv/env，缺参数就报用法退出，绝不内置作者本机路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'gap_progress.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-prog-'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const plan = [{ id: '100', path: '年/甲' }, { id: '200', path: '年/乙' }];
const ledger = {
  folders: { '100': { total: 3 }, '200': { total: 5 }, '201': { total: 1 } },
  vDone: { '100': { done: true } }, totSent: 7, treeStack: [{ id: '200', path: '年/乙', phase: 'enter' }],
  needDrain: {}, at: '2026-11-11T10:00:00.000Z', tag: 'tree-submit-enter-200'
};
const lines = [
  { at: 't1', root: '100', path: '年/甲', newFolders: 2, sent: 3, r: { done: true } },
  { at: 't2', root: '200', path: '年/乙', newFolders: 1, sent: 4, r: { paused: true, remaining: 9 } },
  { at: 't3', stop: 'tab-hidden', vis: 'hidden', waitedVis: 240000 }
];
const logPath = path.join(tmp, 'run.jsonl');
const ledPath = path.join(tmp, 'ledger.json');
const planPath = path.join(tmp, 'plan.json');
fs.writeFileSync(logPath, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
fs.writeFileSync(ledPath, JSON.stringify(ledger));
fs.writeFileSync(planPath, JSON.stringify({ plan: plan }));

function run(args, env) {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT].concat(args), {
    encoding: 'utf8', env: Object.assign({}, process.env, env || {})
  }));
}

await test('汇总格数/新增目录/新增提交/根进度/停机原因', () => {
  const o = run([logPath, ledPath, planPath]);
  assert.equal(o.lines, 3, 'lines = 日志行数（每根一行 + 每格收尾一行）');
  assert.equal(o.stops, 1, 'stops = 带 stop 字段的行数');
  assert.equal(o.cells, 1, 'cells = 已收尾的格数，不是行数（一格可能跑多根）');
  assert.equal(o.dirsAdded, 3);
  assert.equal(o.sentAdded, 7);
  assert.equal(o.first, 't1');
  assert.equal(o.last, 't3');
  assert.deepEqual(o.roots, { total: 2, done: 1, left: 1, bottom: ledger.treeStack[0] });
  assert.equal(o.ledgerNow.folders, 3);
  assert.equal(o.ledgerNow.totSent, 7);
  assert.equal(o.ledgerNow.stack, 1);
  assert.equal(o.stopReasons['tab-hidden'], 1);
  assert.equal(o.stopReasons['pause-no-err'], 1, 'paused 无 err 要单独归类，别混进 finished-root');
  assert.equal(o.stopReasons['finished-root'], 1);
  assert.equal(o.perRoot.length, 2);
  assert.deepEqual(o.perRoot.find((x) => x.path === '年/甲'), { path: '年/甲', cells: 1, dirs: 2, sent: 3 });
});

await test('一格跑多根：cells 数格数、perRoot.cells 数该根被几格碰过', () => {
  const two = path.join(tmp, 'two-cells.jsonl');
  const rows = [
    { at: 'c1r1', root: '100', path: '年/甲', newFolders: 2, sent: 3, r: { done: true } },
    { at: 'c1r2', root: '200', path: '年/乙', newFolders: 1, sent: 4, r: { paused: true } },
    { at: 'c1end', stop: 'paused', next: '200' },
    { at: 'c2r1', root: '200', path: '年/乙', newFolders: 1, sent: 2, r: { done: true } },
    { at: 'c2end', stop: 'all-done' }
  ];
  fs.writeFileSync(two, rows.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const o = run([two, ledPath, planPath]);
  assert.equal(o.lines, 5);
  assert.equal(o.cells, 2, '两格各跑了几根，格数仍是 2');
  assert.equal(o.stops, 2);
  assert.equal(o.stopReasons.paused, 1);
  assert.equal(o.stopReasons['all-done'], 1);
  assert.equal(o.perRoot.find((x) => x.path === '年/乙').cells, 2, '同一根被两格碰过要累加');
  assert.equal(o.dirsAdded, 4);
  assert.equal(o.sentAdded, 9);
});

await test('计划文件是裸数组时也认（两种落盘形状都见过）', () => {
  const bare = path.join(tmp, 'plan-bare.json');
  fs.writeFileSync(bare, JSON.stringify(plan));
  const o = run([logPath, ledPath, bare]);
  assert.equal(o.roots.total, 2);
});

await test('空日志：cells 0，不抛异常（格子还没收尾时也要能读）', () => {
  const empty = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const o = run([empty, ledPath, planPath]);
  assert.equal(o.cells, 0);
  assert.equal(o.lines, 0);
  assert.equal(o.stops, 0);
  assert.equal(o.dirsAdded, 0);
  assert.deepEqual(o.perRoot, []);
  // 根进度来自台账，与日志有没有内容无关：同一份台账在上一例里就是 done 1 / left 1
  assert.equal(o.roots.done, 1);
  assert.equal(o.roots.left, 1);
});

await test('缺参数：报用法并以退出码 2 结束，绝不回退到作者本机路径', () => {
  let code = 0, err = '';
  try { execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status; err = String(e.stderr || ''); }
  assert.equal(code, 2, '缺参数应当退出码 2');
  assert.ok(/usage|用法/i.test(err), 'stderr 应给出用法: ' + err.slice(0, 120));
  assert.ok(!/C:[\/\\]Users/i.test(err), '用法里不得含个人绝对路径');
});

await test('环境变量可代替 argv（换机/无人值守时不用改脚本）', () => {
  const o = run([], { SYNOPHOTOS_GAP_LOG: logPath, SYNOPHOTOS_GAP_LEDGER: ledPath, SYNOPHOTOS_GAP_PLAN: planPath });
  assert.equal(o.lines, 3);
  assert.equal(o.cells, 1);
});

console.log(`\ngap_progress: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);