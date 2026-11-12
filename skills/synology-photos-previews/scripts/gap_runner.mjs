// 多根缺口补跑的跨格 runner（一格推进多个根，paused 立即收尾）。
// 装载后只定义 globalThis.__gapRun，**不自动跑**：
//   await import('file:///<本 skill 目录>/scripts/gap_runner.mjs');
//   nodeRepl.write(JSON.stringify(await globalThis.__gapRun({
//     plan: globalThis.__plan,                       // [{id, path}]，来自独立落盘的计划 JSON
//     log: '<工作目录>/run-<任务>-<日期>.jsonl',      // 每根一行（格子中途写）+ 收尾必写一行 stop；判收尾只看新的 stop 行
//     cellMs: 565000,                                // cell timeout_ms 600000 留 35s 余量
//     waitVis: 240000                                // 开局等前台的上限；等不到就收尾，绝不提交
//   })));
// 前置：先 H.ready()（load 先于 boot），并把计划读进 globalThis.__plan。
// 本 runner 的三条硬规则（都曾造成整格空转或整支漏跑，详见 references/runbooks.md）：
//   ① deadline 一律 cellDeadline-15000，paused 后**绝不**原地重试；
//   ② 栈底不在本 plan（别的任务的根）就收尾，让归属任务先跑完；
//   ③ 标签页不可见（被遮挡/最小化/切走）就收尾 —— 扩展只在可见页转换，提交再多也不生效。
// 判据与顺序由 scripts/test_gap_ops.mjs 钉住（26 例）。
import fs from 'node:fs';

globalThis.__gapRun = async function (opts) {
  var o = opts || {};
  var H = globalThis.__H, L = globalThis.__LED;
  var plan = o.plan || globalThis.__plan || [];
  var cellMs = o.cellMs == null ? 565000 : Number(o.cellMs);
  var waitVis = o.waitVis == null ? 240000 : Number(o.waitVis);
  var t0 = Date.now(), cellDeadline = t0 + cellMs;
  var results = [], logErr = null;

  var log = function (rec) {
    if (!o.log) return;
    try {
      fs.appendFileSync(o.log, JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n');
    } catch (e) { logErr = String((e && e.message) || e).slice(0, 90); }   // 日志写不进去不打断跑批，但收尾要报出来
  };
  var left = function () { return plan.filter(function (x) { var v = ((L || {}).vDone || {})[String(x.id)]; return !(v && v.done); }).length; };
  // 收尾唯一出口：**任何** return 都先写恰好一行 stop 日志再返回。
  // 手册教的收尾判定是「jsonl 出现含 stop 的新行 = 该格已跑完，可以调 node_repl_wait」，
  // 漏写一个出口就会让 agent 等一个永远不出现的 stop 行（白等到 cellMs 上限）。
  // 反过来：逐根 {root,…} 行是格子中途写的，把它当收尾去 wait 会打断正在跑的 cell。
  var fin = function (extra) {
    log(Object.assign({}, extra || {}));
    var led = L || {};
    return Object.assign({
      results: results, folders: Object.keys(led.folders || {}).length, totSent: led.totSent || 0,
      rootsLeft: left(), needDrain: Object.keys(led.needDrain || {}).length, ms: Date.now() - t0, logErr: logErr
    }, extra || {});
  };

  if (!L || !L.__loadedAt) return fin({ stop: 'LEDGER_NOT_LOADED', err: 'LEDGER_NOT_LOADED' });   // 空台账跑批 = 把真台账洗掉
  if (!plan.length) return fin({ stop: 'NO_PLAN', err: 'NO_PLAN' });

  // 开局等前台：用户把 Photos 拖成独立可见窗口需要时间，等到就用本格剩余预算继续跑
  var g = await H.foregroundGate({ waitMs: waitVis });
  if (!g.ok) return fin({ stop: 'tab-hidden', vis: g.vis, waitedVis: g.waited });

  for (var i = 0; i <= plan.length; i++) {
    var t = H.gapNextRoot(plan, L);
    if (t.err === 'stack-other-root') return fin({ stop: 'stack-other-root', bottom: t.id });
    if (t.done) return fin({ stop: 'all-done' });
    if (Date.now() > cellDeadline - 120000) return fin({ stop: 'cell-budget', next: t.id });
    // 每根开跑前再确认一次前台（本格内不再等：等不到就收尾，让人把页面放回前台）
    var g2 = await H.foregroundGate({ waitMs: 0 });
    if (!g2.ok) return fin({ stop: 'tab-hidden', vis: g2.vis, next: t.id });

    var bf = Object.keys(L.folders || {}).length, bs = L.totSent || 0, r;
    try {
      r = await H.processTree(t.id, { path: t.path, deadline: cellDeadline - 15000, fresh: t.fresh });
    } catch (e) {
      var msg = String((e && e.message) || e).slice(0, 160);
      return fin({ stop: 'err', root: t.id, path: t.path, err: msg });   // 连接层报错不标 done、不吞异常、不继续下一根
    }
    var rec = {
      root: t.id, path: t.path, r: r,
      newFolders: Object.keys(L.folders || {}).length - bf, sent: (L.totSent || 0) - bs,
      nd: Object.keys(L.needDrain || {}).length, stack: (L.treeStack || []).length, rootsLeft: left()
    };
    results.push(rec); log(rec);
    if (r && r.paused) return fin({ stop: 'paused', next: t.id });
  }
  return fin({ stop: 'loop-cap' });
};