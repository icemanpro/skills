#!/usr/bin/env node
// 汇总 Synology Photos 预览台账：node scripts/summarize_ledger.cjs <二轮台账.json> [首轮台账.json]
const fs = require('fs');
const path = require('path');

const ledPath = process.argv[2];
if (!ledPath) { console.log('用法: node summarize_ledger.cjs <二轮台账.json> [首轮台账.json]'); process.exit(2); }
const s = JSON.parse(fs.readFileSync(path.resolve(ledPath), 'utf8'));

const asArr = v => (Array.isArray(v) ? v : Object.keys(v || {}));
const folders = s.folders || {}, res = s.res2 || {}, subm = s.subm || {}, stuck = s.stuckIds || {};

// 目录名/条目数可能只存在于首轮台账里（旧版 persist 不写 folders），缺失时回退补齐
const firstPath = process.argv[3];
if (firstPath) {
  const first = JSON.parse(fs.readFileSync(path.resolve(firstPath), 'utf8'));
  const list = Array.isArray(first.folders) ? first.folders : Object.values(first.folders || {});
  for (const f of list) {
    if (f && f.id != null && !folders[String(f.id)]) folders[String(f.id)] = { id: String(f.id), name: f.name, total: f.total };
  }
}

let sentSum = 0, cleanN = 0, doneN = 0;
const byStatus = {}, byPass = {}, byDrain = {};
let noDrainRecord = 0;
for (const [id, r] of Object.entries(res)) {
  const st = r.blocked || r.err || (r.clean ? 'clean' : 'ok');
  byStatus[st] = (byStatus[st] || 0) + 1;
  byPass[r.pass || 'other'] = (byPass[r.pass || 'other'] || 0) + 1;
  sentSum += (r.sent || 0);
  if (r.clean) cleanN++;
  if (r.done) doneN++;
  if (r.drain && r.drain.reason) byDrain[r.drain.reason] = (byDrain[r.drain.reason] || 0) + 1;
  else if ((r.sent || 0) > 0) noDrainRecord++;   // 旧版引擎提交的目录：没有转换完成的证据
}
// 收敛证据只认 drain.reason；stillBadWindow 不可信（broken class 在提交瞬间就消失）
const converged = (r) => r.drain && (r.drain.reason === 'converted' || r.drain.reason === 'empty');

const submittedIds = Object.keys(subm).reduce((a, k) => a + asArr(subm[k]).length, 0);
const stuckByFolder = {};
for (const [itemId, v] of Object.entries(stuck)) {
  const fid = String((v && v.folder) || '?');
  (stuckByFolder[fid] = stuckByFolder[fid] || []).push(itemId + ((v && v.video) ? '(v)' : ''));
}

console.log('台账时间戳          :', s.at, s.host ? 'host ' + s.host : '');
console.log('目录数(已映射)      :', Object.keys(folders).length);
console.log('累计提交条目 totSent :', s.totSent, '| subm 去重合计:', submittedIds, '| res2.sent 合计:', sentSum);
console.log('已判定目录          :', Object.keys(res).length, '| done:', doneN, '| clean(无需提交):', cleanN);
console.log('引擎 pass 分布      :', JSON.stringify(byPass));
console.log('状态分布            :', JSON.stringify(byStatus));
console.log('drain 判据分布      :', JSON.stringify(byDrain), '| 提交过但无排空记录(旧引擎):', noDrainRecord);
const needDrain = s.needDrain || {};
console.log('待补排空 needDrain  :', Object.keys(needDrain).length, '|', Object.keys(needDrain).slice(0, 15).join(' '));
console.log('重试记账 retry      :', Object.keys(s.retry || {}).length);
// 二轮游标才是「复检过」的口径：res2 是首轮记账，判据已被证明不可信，不能拿它当全量完成。
const p2done = (s.p2 && s.p2.done) || {};
const p2Ids = Object.keys(p2done);
const p2Bad = new Set(p2Ids.filter((k) => p2done[k] === 2));
const folderIds = Object.keys(folders);
console.log('二轮游标 p2.done    :', p2Ids.length + '/' + folderIds.length,
  '| 干净', p2Ids.length - p2Bad.size, '| 仍坏', p2Bad.size,
  '| 未覆盖', folderIds.filter((k) => !p2done[k]).length);
console.log('剩余待处理队列      :', (s.vQueue || []).length, '|', (s.vQueue || []).slice(0, 15).map(i => i + ':' + ((folders[i] || {}).total || 0)).join(' '));
const tStack = s.treeStack || [], vDone = s.vDone || {};
console.log('processTree 栈剩余  :', tStack.length, '| vDone 完成目录:', Object.keys(vDone).length);
if (tStack.length) {
  console.log('  栈顶待处理        :', tStack.slice(-5).map(n => n.id + ':' + n.phase + ':' + (n.path || '')).join(' | '));
}
console.log('探针目录            :', (s.pendingSamples || []).slice(-8).join(' '));
console.log('不可选中条目 stuckIds:', Object.keys(stuck).length, '项 /', Object.keys(stuckByFolder).length, '个目录');
for (const [fid, arr] of Object.entries(stuckByFolder)) {
  console.log('  folder', fid, (folders[fid] || {}).name || '', '->', arr.length, '项:', arr.slice(0, 10).join(' '));
}

const unsolved = Object.entries(res).filter(([, r]) => !r.clean && (r.stillBadWindow > 0 || r.blocked || (r.drain && !converged(r))));
// 二轮复检跑满 6 次仍坏的目录，即使首轮记账写着 converted 也要单列
for (const id of p2Bad) if (!unsolved.some(([i]) => i === id)) unsolved.push([id, res[id] || { total: (folders[id] || {}).total }]);
if (unsolved.length) {
  console.log('仍未收敛（含仅待处理）:');
  for (const [id, r] of unsolved.slice(0, 40)) {
    console.log('  ', [id, (folders[id] || {}).name || '', 'total=' + (r.total == null ? '?' : r.total), 'sent=' + (r.sent || 0),
      'badWin=' + (r.stillBadWindow == null ? '?' : r.stillBadWindow), 'drain=' + ((r.drain && r.drain.reason) || '无记录'),
      r.drain ? ('loaded=' + r.drain.loaded + '/' + r.drain.all) : '', p2Bad.has(id) ? 'p2=2' : '', r.blocked || r.err || 'ok'].filter(x => x !== '').join(' | '));
  }
  if (unsolved.length > 40) console.log('   ...(共', unsolved.length, '个)');
}

if (process.argv[3]) {
  const f1 = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), 'utf8'));
  const list = Array.isArray(f1.folders) ? f1.folders : Object.values(f1.folders || {});
  const f1Sent = Object.keys(f1.submittedIds || {}).reduce((a, k) => a + asArr(f1.submittedIds[k]).length, 0);
  console.log('首轮台账            :', list.length, '个目录，提交', f1Sent, '条（与会话累计分开报，勿相加当成同一口径）');
}
