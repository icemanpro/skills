#!/usr/bin/env node
// 缺口补跑进度汇总（离线，只读 jsonl + 台账 + 计划，不碰浏览器）。
//   node gap_progress.cjs <run.jsonl> <ledger.json> <plan.json>
//   或用环境变量 SYNOPHOTOS_GAP_LOG / SYNOPHOTOS_GAP_LEDGER / SYNOPHOTOS_GAP_PLAN
// 为什么看 jsonl 而不是只看台账：长泵（pumpX2 预算最长 420s）期间台账数分钟不更新是正常的，
// 判「卡死 vs 在跑」的唯一可靠信号是日志有没有新行。
// 路径全部来自 argv/env：换机可跑，脚本里不内置任何作者本机路径。
'use strict';
const fs = require('fs');

const argv = process.argv.slice(2);
const logPath = argv[0] || process.env.SYNOPHOTOS_GAP_LOG;
const ledPath = argv[1] || process.env.SYNOPHOTOS_GAP_LEDGER;
const planPath = argv[2] || process.env.SYNOPHOTOS_GAP_PLAN;
if (!logPath || !ledPath || !planPath) {
  process.stderr.write('usage: node gap_progress.cjs <run.jsonl> <ledger.json> <plan.json>\n' +
    '  也可用环境变量 SYNOPHOTOS_GAP_LOG / SYNOPHOTOS_GAP_LEDGER / SYNOPHOTOS_GAP_PLAN 代替三个参数\n');
  process.exit(2);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function readLines(p) {
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
  const out = [];
  txt.split('\n').forEach((l) => {
    const s = l.trim();
    if (!s) return;
    try { out.push(JSON.parse(s)); } catch (e) { /* 半行（格子正在写）跳过 */ }
  });
  return out;
}

const lines = readLines(logPath);
const led = readJson(ledPath, {}) || {};
const planDoc = readJson(planPath, []);
const plan = Array.isArray(planDoc) ? planDoc : (Array.isArray(planDoc && planDoc.plan) ? planDoc.plan : []);
const vDone = led.vDone || {};
const isDone = (id) => { const v = vDone[String(id)]; return !!(v && v.done); };

const stopReasons = {};
const bump = (k) => { stopReasons[k] = (stopReasons[k] || 0) + 1; };
const perRoot = [];
const byPath = {};
let dirsAdded = 0, sentAdded = 0, stopLines = 0;

lines.forEach((o) => {
  if (o.stop) { stopLines++; bump(o.stop); return; }
  if (!o.root) { bump('unknown'); return; }
  const r = o.r || {};
  bump(r.err ? String(r.err) : (r.paused ? 'pause-no-err' : 'finished-root'));
  dirsAdded += Number(o.newFolders) || 0;
  sentAdded += Number(o.sent) || 0;
  const key = o.path || String(o.root);
  if (!byPath[key]) { byPath[key] = { path: key, cells: 0, dirs: 0, sent: 0 }; perRoot.push(byPath[key]); }
  byPath[key].cells++;
  byPath[key].dirs += Number(o.newFolders) || 0;
  byPath[key].sent += Number(o.sent) || 0;
});

const doneCount = plan.filter((p) => isDone(p.id)).length;
const stack = led.treeStack || [];
const out = {
  // cells = 已收尾的格数（gap_runner 每个出口都写恰好一行 stop）；lines = 日志行数（每根一行 + 每格一行）。
  // 旧的手贴循环日志只在异常出口写 stop，那种日志的 cells 会偏少，看 lines 与 last 判断有没有在推进。
  cells: stopLines,
  lines: lines.length,
  stops: stopLines,
  first: lines.length ? lines[0].at : null,
  last: lines.length ? lines[lines.length - 1].at : null,
  dirsAdded: dirsAdded,
  sentAdded: sentAdded,
  roots: { total: plan.length, done: doneCount, left: plan.length - doneCount, bottom: stack.length ? stack[0] : null },
  ledgerNow: {
    folders: Object.keys(led.folders || {}).length,
    totSent: Number(led.totSent) || 0,
    stack: stack.length,
    needDrain: Object.keys(led.needDrain || {}).length,
    vDone: Object.keys(vDone).length,
    at: led.at || null,
    tag: led.tag || null
  },
  stopReasons: stopReasons,
  perRoot: perRoot
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');