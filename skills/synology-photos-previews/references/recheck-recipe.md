# 全树复查配方（API 枚举对账 + 逐项 HEAD 审计）

**什么时候用**：用户说「再检查一遍某年」「确认都生成好了」，或要交付一个全树结论。
**不要**用重跑 `p2Pass`、抽样几个目录、或读台账 `vDone`/`p2.done` 来代替 —— 那些都是 DOM/记账口径，
只覆盖渲染窗口与当时枚举到的集合。

**通过判据（四个都要满足）**：`smBad === 0 && xlBad === 0 && errs.length === 0 && nock === 0`，
且**审计到的目录数 === 递归枚举到的目录数**。少一个都不许写「全都生成好了」。

**为什么比 DOM 二轮划算**：实测 1257 个目录 / 20707 条直属条目 / 41414 次 HEAD，
枚举 54s + 审计 3 格（74s / 175s / 218s）≈ **7.5 分钟**；同样的树用 `p2Pass` 逐目录导航是**小时级**
（每目录地板 25–40s）。全量现验优先走这条路。

| 阶段 | 在哪一侧跑 | 实测吞吐 |
|---|---|---|
| 递归枚举子目录 | 页面上下文里一次 evaluate（并发 6） | 1257 次请求 / 54s ≈ 23 目录/s |
| 列条目 + HEAD sm/xl | 页面上下文里分块 evaluate（列条目并发 6、HEAD 并发 8） | ~95 次 HEAD/s；300 目录 ≈ 74s，480 目录 ≈ 175–218s |
| node 侧逐目录调 `H.listChildren` | ❌ 每次一趟桥往返（2–8s） | 1257 个目录 ≈ **42 分钟–2.8 小时**，别这么干 |

---

## Cell 1：页内一次递归枚举整树 + 与台账求差集

要点：**整棵树的递归放在页面里跑**，node 侧只发一次 evaluate、收一次结果。
分页取全、按 id 去重、任何一页失败就记 `errs`（绝不交半截清单当全树）。

```js
let H = globalThis.__H, L = globalThis.__LED;
let tok = await H.synoToken();                       // 每格开始重取，别复用上一格的
let ROOT = '414';                                    // 年度根目录
let src = '(async function(){ var tok=' + JSON.stringify(tok) + ', ROOT=' + JSON.stringify(ROOT) + ';'
 + ' async function post(api,p){ var r=await fetch("/webapi/entry.cgi/"+api,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded; charset=UTF-8","x-syno-token":tok},body:new URLSearchParams(p)}); var t=await r.text(); try{return JSON.parse(t);}catch(e){return {success:false,err:"NOT_JSON",status:r.status};} }'
 + ' async function kids(id){ var seen={},off=0,pages=0; for(;;){ var j=await post("SYNO.FotoTeam.Browse.Folder",{api:"SYNO.FotoTeam.Browse.Folder",method:"list",version:"2",id:String(id),offset:String(off),limit:"100"}); if(!j||j.success===false||!j.data||!Array.isArray(j.data.list)) return {ok:false,code:j&&j.code,err:j&&j.err}; var a=j.data.list; a.forEach(function(x){ seen[String(x.id)]=String(x.name||"").split("/").pop()||"?"; }); pages++; if(a.length<100)break; if(pages>=40)return {ok:false,err:"page-cap"}; off+=a.length; } return {ok:true,map:seen}; }'
 + ' var rows=[[ROOT,"0","<年度目录名>"]], queue=[ROOT], errs=[], reqs=0;'
 + ' async function worker(){ while(queue.length){ var id=queue.shift(); if(id===undefined)break; var r=await kids(id); reqs++; if(!r.ok){ errs.push({id:id,code:r.code,err:r.err}); continue; } Object.keys(r.map).forEach(function(k){ rows.push([k,String(id),r.map[k]]); queue.push(k); }); } }'
 + ' var ws=[]; for(var i=0;i<6;i++) ws.push(worker()); await Promise.all(ws);'
 + ' return {rows:rows, reqs:reqs, errs:errs}; })';
let r = await H.G(() => H.PW().locator('body').evaluate(src));
// rows = [id, parent, name]；parent 链足以重建整棵树，比返回嵌套对象省一大截传输
let api = {}; r.rows.forEach(x => { api[String(x[0])] = { parent: String(x[1]), name: x[2] }; });
let missing = Object.keys(api).filter(k => !L.folders[k]);   // 台账没记过的目录
let extra = Object.keys(L.folders).filter(k => !api[k] && k !== ROOT);  // 台账多记的（已删除？）
globalThis.__apiTree = api; globalThis.__treeRows = r.rows; globalThis.__missing = missing;
let fs = await import('node:fs');
fs.writeFileSync('<台账目录>/tree-recheck.json', JSON.stringify({ at: new Date().toISOString(), root: ROOT, reqs: r.reqs, errs: r.errs, rows: r.rows, missing: missing, extra: extra }));
nodeRepl.write(JSON.stringify({ dirs: r.rows.length, reqs: r.reqs, errs: r.errs, ledgerDirs: Object.keys(L.folders).length, missing: missing, extra: extra }));
```

**读差集**：`missing` 是「前缀截断」（台账里已有的都是 UI 排序前 N 个）⇒ 旧枚举 bug 漏跑的整支，必须补跑；
只有零星新 id（如 `32xxx`）⇒ 跑批之后新建的目录，按下面的审计结果决定要不要转换。
`errs` 非空 ⇒ 这不是一棵完整枚举，先解决接口/登录问题再继续。

---

## Cell 2..n：分块逐项 HEAD 审计（带游标，可续跑）

一个 cell 跑不完两万条，所以把「取一段目录 → 列条目 → HEAD」做成**带游标的全局函数**，
每格调用一次、每格结束把累计结果写独立 JSON。kernel 被回收也只丢一格。

```js
let H = globalThis.__H;
let RC = globalThis.__rc = globalThis.__rc || {
  at: new Date().toISOString(),
  order: Object.keys(globalThis.__apiTree).sort((a, b) => (+a) - (+b)),  // 跨格稳定顺序
  cursor: 0, res: {}, errs: []
};
globalThis.__rcStep = async function (nDirs) {
  let t0 = Date.now(), tok = await H.synoToken();
  let ids = RC.order.slice(RC.cursor, RC.cursor + nDirs);
  if (!ids.length) return { finished: true, cursor: RC.cursor, total: RC.order.length };
  let src = '(async function(){ var tok=' + JSON.stringify(tok) + ', dirs=' + JSON.stringify(ids) + ';'
  + ' async function post(api,p){ var r=await fetch("/webapi/entry.cgi/"+api,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded; charset=UTF-8","x-syno-token":tok},body:new URLSearchParams(p)}); var t=await r.text(); try{return JSON.parse(t);}catch(e){return {success:false,err:"NOT_JSON",status:r.status};} }'
  + ' async function listOf(id){ var seen={},off=0,pages=0; for(;;){ var j=await post("SYNO.FotoTeam.Browse.Item",{api:"SYNO.FotoTeam.Browse.Item",method:"list",version:"7",folder_id:String(id),additional:JSON.stringify(["thumbnail"]),sort_by:JSON.stringify("takentime"),sort_direction:JSON.stringify("asc"),offset:String(off),limit:"100"}); if(!j||j.success===false||!j.data||!Array.isArray(j.data.list))return {ok:false,code:j&&j.code,err:j&&j.err}; var a=j.data.list; a.forEach(function(x){ var th=(x.additional&&x.additional.thumbnail)||{}; seen[String(x.id)]={ck:th.cache_key==null?"":String(th.cache_key),ty:String(x.type||"")}; }); pages++; if(a.length<100)break; if(pages>=60)return {ok:false,err:"page-cap"}; off+=a.length; } return {ok:true,map:seen}; }'
  + ' async function head(id,ck,size){ var u="/synofoto/api/v2/t/Thumbnail/get?id="+id+"&cache_key=%22"+encodeURIComponent(ck)+"%22&type=%22unit%22&size=%22"+size+"%22&SynoToken="+encodeURIComponent(tok); try{ var r=await fetch(u,{method:"HEAD"}); return r.status; }catch(e){ return -1; } }'
  + ' var out={}, queue=dirs.slice(), tasks=[];'
  + ' async function listWorker(){ while(queue.length){ var id=queue.shift(); if(id===undefined)break; var r=await listOf(id); if(!r.ok){ out[id]={err:r.code||r.err||"ITEM_API"}; continue; } var m=r.map, ks=Object.keys(m); out[id]={total:ks.length,nock:0,videos:0,smBad:[],xlBad:[],other:[]}; ks.forEach(function(k){ var e=m[k]; if(!e.ck)out[id].nock++; if(e.ty==="video")out[id].videos++; if(e.ck){ tasks.push([id,k,e.ck,"sm"]); tasks.push([id,k,e.ck,"xl"]); } }); } }'
  + ' var lw=[]; for(var i=0;i<6;i++) lw.push(listWorker()); await Promise.all(lw);'
  + ' var tq=tasks.slice(), heads=0, st={};'
  + ' async function headWorker(){ while(tq.length){ var t=tq.shift(); if(!t)break; var s=await head(t[1],t[2],t[3]); heads++; st[s]=(st[s]||0)+1; var o=out[t[0]]; if(!o)continue; if(s===200)continue; if(s===404){ (t[3]==="sm"?o.smBad:o.xlBad).push(t[1]); } else { o.other.push([t[1],t[3],s]); } } }'
  + ' var hw=[]; for(var j=0;j<8;j++) hw.push(headWorker()); await Promise.all(hw);'
  + ' return {out:out, heads:heads, status:st}; })';
  let r = await H.G(() => H.PW().locator('body').evaluate(src));
  if (!r || !r.out) { RC.errs.push({ at: new Date().toISOString(), cursor: RC.cursor, why: 'NO_RESULT' }); return { fail: true, cursor: RC.cursor }; }
  Object.keys(r.out).forEach(k => { if (!r.out[k].err) RC.res[k] = r.out[k]; else RC.errs.push({ id: k, why: r.out[k].err }); });
  RC.cursor += ids.length;                     // 游标按 chunk 前进；失败目录进 errs，收尾单独重跑
  let agg = { dirs: 0, items: 0, smBad: 0, xlBad: 0, nock: 0, videos: 0, other: 0 };
  Object.keys(RC.res).forEach(k => { let o = RC.res[k]; agg.dirs++; agg.items += o.total; agg.smBad += o.smBad.length; agg.xlBad += o.xlBad.length; agg.nock += o.nock; agg.videos += o.videos; agg.other += o.other.length; });
  let fs = await import('node:fs');
  fs.writeFileSync('<台账目录>/recheck.json', JSON.stringify({ at: RC.at, updated: new Date().toISOString(), cursor: RC.cursor, orderTotal: RC.order.length, agg: agg, errs: RC.errs, res: RC.res }));
  return { ms: Date.now() - t0, chunk: ids.length, cursor: RC.cursor, orderTotal: RC.order.length, heads: r.heads, status: r.status, agg: agg, errs: RC.errs.length };
};
nodeRepl.write(JSON.stringify(await globalThis.__rcStep(300)));
```

后续每格只发一行：`nodeRepl.write(JSON.stringify(await globalThis.__rcStep(480)));`
（`timeout_ms` 给 480000、`yield_time_ms` 给 50000–58000，返回 cell_id 就用 `node_repl_wait` 收；
每格换一下 yield 值，别连发同一个等待。）

**分块粒度**：300–500 个目录一格（≈75–220s），留足收尾时间。别一格塞整棵树。
**续跑**：kernel 回收后重装库 → `H.ready()` → 重跑 Cell 1 拿回 `__apiTree`（或从 `tree-recheck.json` 读回）→
把 `__rc` 从 `recheck.json` 恢复（`cursor`/`res`/`errs`/`order`）→ 继续 `__rcStep`。审计是只读的，重做一格无副作用。
**收尾必须查 `errs`**：游标是按 chunk 前进的，接口失败的目录只在 `errs` 里，不会自动重做。
`errs` 非空就把 `RC.order` 换成那些 id、`RC.cursor = 0` 再跑一遍；若是 803/NOT_JSON 先核对登录态
（**掉登录是人工停机点，不自动重试**）。

**审计与修复标记的边界**：审计本身**不写** `vDone`/`p2.done`（别用只读结果污染修复引擎的游标）。
只有两种情况登记：① 该目录逐项 HEAD 全覆盖且 `smBad=xlBad=0` ⇒ 可按证据写 `p2.done=3` 并在
`folders[id]` 记 `src:'api-recheck-<日期>'`；② 有缺失 ⇒ 先修、再 HEAD 复验通过，然后才登记。
手工建档（台账里还没有这个目录）写 `{id, name:'<完整路径>', total, kids}` —— 字段是 **`name` 不是 `path`**：
`p2Pass` 取 `f.name || id` 当 `node.path`，写成 `path` 会让报告与排空日志里的路径退化成裸 id。
反过来，**台账里已有的标记也要用审计结果复核**：`H.falseMarks` / `H.revokeFalseMarks` 就是干这个的（Cell 5），
判据同样是「全覆盖 + 四个 0」，窗口内的 `converted`/`p2.done=1` 不算数。

---

## Cell 3：修实测缺失的那几条（尾部/窗外配方）

`smBad` 里的条目往往就在渲染窗口外，页面看着 `bad=0`。把排序切降序，尾巴变成窗口头部：

```js
// 排序按钮 data-testid="toolbar-sorting-btn"；菜单项是纯文本节点「降序」/「升序」（没有 role=menuitem）
await H.G(() => H.PW().locator('body').evaluate('(async function(){ var b=document.querySelector(\'[data-testid="toolbar-sorting-btn"]\'); b.click(); await new Promise(function(r){setTimeout(r,900);}); var d=null; document.querySelectorAll("*").forEach(function(el){ if(d)return; var t=(el.textContent||"").trim(); if((t==="降序"||t==="Descending")&&el.children.length===0) d=el; }); if(!d)return "no-desc"; (d.closest(\'[role="menuitem"],[role="option"],li,button\')||d).click(); await new Promise(function(r){setTimeout(r,2600);}); return "desc"; })'));
// 一次点掉窗口内所有 broken 卡片的 select-button（别逐张往返）
await H.G(() => H.PW().locator('body').evaluate('(async function(){ var bad=document.querySelectorAll(\'[data-testid="item-image-status"].synofoto-item-image-broken\'); var n=0; for(var i=0;i<bad.length;i++){ var c=bad[i].closest(\'[data-testid="file-clickable-area"]\'); if(!c)continue; if(c.querySelector(".synofoto-selectable-wrapper.checked")){n++;continue;} var b=c.querySelector(\'button[data-testid="select-button"]\'); if(b){b.click();n++;} } await new Promise(function(r){setTimeout(r,700);}); return {broken:bad.length,tapped:n}; })'));
await H.genToolbar();                                  // 工具条「生成预览」才是可用路径
let dr = await H.drain(150000, 6, 5000, { total: 82 }); // 判 converted（loaded>=all 且 >=8s）
// 修完把排序切回「升序」，再对该目录重新逐项 HEAD（不是只看 bad=0）
```

实测：目录 7979 共 82 项、窗口只挂载 81 张，缺的 `121626` 切降序后立刻进窗口并显示 broken，
选中 1 张 → 工具条 → `drain converted` **10.1s** → 全 82 条重新 HEAD，`sm`/`xl` 全 200。
`cache_key` 取自 `item.additional.thumbnail.cache_key`；元数据 `sm:"ready"` 与 HEAD 404 可以同时成立，判坏只认 HEAD。

---

## Cell 4：`missing` 整支子树的补跑入口

差集非空时，**补跑单位是「最小根集」，不是逐个 id、也不是年度根**。
`H.processTree(root)` 自己用 Folder 接口递归枚举 root 的全部后代，所以从「parent 不在 missing 里」的那些 id 进去，
恰好覆盖 missing（含孙目录）。年度根的 `vDone` 已是 `done:true`，照无人值守模板会被判 `already-done` 跳过；
手动删掉它的 `vDone` 再 `fresh:true` 则是**整年重跑**（几千个目录、十几小时），还会撞 persist 回归保护。

```js
let H = globalThis.__H, L = globalThis.__LED;
let fs = await import('node:fs');
let tr = JSON.parse(fs.readFileSync('<台账目录>/tree-recheck.json', 'utf8'));   // Cell 1 的产物
let parents = {}, names = {};
tr.rows.forEach(r => { parents[String(r[0])] = String(r[1]); names[String(r[0])] = String(r[2]); });
let missing = (tr.missing || []).filter(id => !L.folders[String(id)]);   // 差集是快照：先剔掉后来已建档的
let roots = H.missingRoots(parents, missing);           // 孤儿（parent 查不到）也当根：宁可多跑不可漏跑
// Cell 1 里年度根那行的名字是占位符 '<年度目录名>'，先校正，否则拼出来的 path 顶段是占位符
let ROOT = String(tr.root);
names[ROOT] = (L.folders[ROOT] || {}).name || names[ROOT];
// 真实路径沿 parent 链拼名字。别写 '<年度目录名>/'+id 这种合成路径：folders[id].name 是报告与日后对账的依据。
let chain = id => { let a = [], cur = String(id), hop = 0; while (cur && cur !== '0' && hop++ < 40) { a.push(cur); cur = parents[cur]; } return a; };
let pathOf = id => chain(id).slice().reverse().map(x => names[x] || x).join('/');
globalThis.__plan = roots.map(r => {                    // 挂 globalThis：跨格活下来（cell 内 var/let 会丢）
  let inside = Object.keys(parents).filter(id => chain(id).indexOf(r) >= 0);
  return { id: r, path: pathOf(r), dirs: inside.length,
    missing: missing.filter(m => chain(m).indexOf(r) >= 0).length,
    unrecorded: inside.filter(id => !L.folders[id]).length,          // >0 ⇒ 必须 processTree
    doneInside: inside.filter(id => L.vDone[id] && L.vDone[id].done).length };
});
nodeRepl.write(JSON.stringify({ missingSnapshot: (tr.missing || []).length, missingNow: missing.length,
  roots: globalThis.__plan.length, plan: globalThis.__plan.slice(0, 5) }));
```

实测（2026 年第二轮）：`missing = [32341,32342,32343,32344,32345]` → **4 个根**（32342 是 32341 的子目录，
从 32341 进去就一起跑了），真实路径形如 `<年度目录>/<地区>/<项目>/<子目录>`（沿 API 父链拼真实名字）。

**选 processTree 还是 p2Pass**（判据是「missing 里有没有**未建档**的目录」，即 `!L.folders[id]`）：

| 情况 | 入口 | 为什么 |
|---|---|---|
| missing 里有未建档目录（哪怕只有一个） | `H.processTree(root, {path, deadline, fresh})` | 只有它会枚举子目录、建 `folders[id]`、写 `vDone` |
| missing 全是已建档的平铺叶子 | `H.p2Pass({ids: 那几个叶子})` | 不递归不建档的活儿它干不了，但复验/补提比整支重跑省时间 |

根下已完成后代多不多**只影响耗时、不影响入口选择**：`processTree` 不按 `vDone` 跳过已完成后代，
整支进去会把它们重跑一遍（只补提仍坏的，安全但费时）。实测 2025 的混合根 **32333**：它自己未建档，
111 个后代里 **108 个已建档且 `vDone.done=true`** ⇒ 仍然必须 processTree，接受那 108 个重跑。
`p2Pass` 不递归、不建档：用它跑未建档目录，台账里依旧没有这些目录，**下次复查差集还是非空**。

**差集是快照，补跑前必须拿当前台账重算**：2025 的 `gap-audit-20261111.json` 记了 3016 个缺口目录 / 28597 条 / **57 个最小根**，
而其中 108 个在之后的轮次里已建档并完成。直接照旧清单跑就是白跑。重算只要一行：
`let missing = (tr.missing || []).filter(id => !L.folders[id]);`（`errs` 非空时先解决接口问题，别拿半截清单当全树）。

**多根跨格游标**（`timeout_ms: 600000`，每格原样重发这一份；`paused` 就立刻收尾，同 turn 紧接下一格，绝不原地 while 重试）：

```js
let H = globalThis.__H, L = globalThis.__LED, plan = globalThis.__plan;
let st = L.treeStack || [];
// 栈非空 ⇒ 栈底那个根还没跑完，先续它（fresh:false）；栈空 ⇒ 取下一个未完成的根（fresh:true）
let t = st.length ? plan.find(x => x.id === String(st[0].id))
                  : plan.find(x => !(L.vDone[x.id] && L.vDone[x.id].done));
if (!t) { nodeRepl.write(JSON.stringify({ stop: 'all-roots-done', roots: plan.length, folders: Object.keys(L.folders).length })); }
else {
  let r = await H.processTree(t.id, { path: t.path, deadline: Date.now() + 550000, fresh: !st.length });
  nodeRepl.write(JSON.stringify({ root: t.id, r: r, stack: L.treeStack.length,
    folders: Object.keys(L.folders).length, totSent: L.totSent,
    rootsLeft: plan.filter(x => !(L.vDone[x.id] && L.vDone[x.id].done)).length }));
}
```

游标就是台账本身（`vDone[root].done` 在 exit 阶段写），不另设进度文件；`__plan` 被 kernel 回收就重跑上面那个 plan cell。
**栈非空时绝不 `fresh:true`**（会覆盖掉正在跑的那棵树的栈）；一格只推进一个根，`paused` 说明本格时间已耗尽。
补跑完重跑 Cell 1 对账（差集应归零）+ Cell 2 逐项 HEAD，再按 Cell 5 登记标记。

---

## Cell 5：假 `vDone` / `p2.done` 的检测与撤销

`bad=0`、`loaded>=all`、`drain:converted`、`p2.done=1` 全是**渲染窗口内**的结论。
判「标记可不可信」用 `H.falseMarks(led, {head, kids})`，撤销用 `H.revokeFalseMarks(opts)`（内部已 `force:true`）。
旧自查 `res2.sent===0 && clean===false` 只抓得到「零提交却标 done」那一类，**抓不到 7979 那种窗口外缺失**。

**先把两份证据喂进去**（缺证据就判不了，见下面的 unknown）：

```js
let H = globalThis.__H, L = globalThis.__LED;
let fs = await import('node:fs');
let rc = JSON.parse(fs.readFileSync('<台账目录>/recheck.json', 'utf8'));
let tr = JSON.parse(fs.readFileSync('<台账目录>/tree-recheck.json', 'utf8'));
// head：逐目录 HEAD 结果。res 是修复**前**的审计，必须把修复后的复验盖上去，否则会把已修好的目录再撤销一次。
let head = Object.assign({}, rc.res);
if (rc.repair && rc.repair.dir) head[rc.repair.dir] = rc.repair.dirRecheck;      // {items, smBad:0, xlBad:0}
(rc.newDirsAudited || []).forEach(x => { head[String(x.id)] = x; });             // 补跑目录的复验
// kids：每个目录的子目录数，从 API 父链数出来。台账 folders 里 1257 条只有 45 条记了 kids（旧版不记）。
let kids = {}; tr.rows.forEach(r => { let p = String(r[1]); kids[p] = (kids[p] || 0) + 1; });
let rep = H.falseMarks(L, { head: head, kids: kids });
nodeRepl.write(JSON.stringify({ bad: rep.bad.length, trusted: rep.trusted.length, unknown: rep.unknown.length,
  gaveup: rep.gaveup, unmarked: rep.unmarked, badList: rep.bad.slice(0, 20) }));
```

`head` 的三种真实口径都认（`H.headStat` 归一化）：`res[id]={total, smBad:[ids], xlBad:[ids], other:[…], nock}`、
`repair.dirRecheck={items, smBad:0, xlBad:0}`、简写 `{n, smBad:数字, xlBad:数字}`。
`other`（非 200/404）与 `nock`（无 `cache_key`，无法 HEAD）都算**结论不确定**，不采信。
**只喂 `head` 也能判**：`kids` 缺失时引擎用 `total - head 条目数` 推出子目录卡片数（HEAD 把直属条目列全了）。
`kids` 映射里只有父目录有值、叶子没有 `0` 条目，这是正常的，不用补。

**四个桶的含义**（`bad` 才撤销）：

| 桶 | 含义 | 动作 |
|---|---|---|
| `bad` | 标记不可信。`why` ∈ `head-missing`（HEAD 实测缺，附 `smBad`/`xlBad` 条数）、`window-partial`（converted 但 `all < total-kids`）、`blocked:*`、`still-bad-window`、`zero-submit-dirty`、`no-drain`、`drain:stalled/timeout` | 撤销 → 重跑 → HEAD 复验 |
| `trusted` | 证据够。`via` ∈ `head`（全覆盖且四个 0）、`drain`（converted/empty 且 `all >= total-kids`）、`container`（`total == kids`，0 直属条目） | 不动 |
| `unknown` | `kids` 三处都拿不到（台账没记、没给 `kids`、也没给 `head`），算不出图片槽位 | **不撤销**，先补证据 |
| `gaveup` / `unmarked` | `p2.done=2`（六次仍坏，已知坏不是假干净）/ 本来就没标记 | 不动 |

**为什么必须喂 head/kids**（2026 年真实台账 1257 个目录，逐项 HEAD 41414 次的地面真值只有 7979 一条缺）：

| 喂进去的证据 | bad | trusted | unknown |
|---|---|---|---|
| head + kids（修复前） | **1**（7979，`head-missing`，smBad 1） | 1256 | 0 |
| head + kids（合并修复复验后） | **0** | 1257 | 0 |
| 只给 kids | 23 | 491 | 743 |
| 什么都不给 | 14 | 386 | 857 |

只按台账/DOM 证据判会报 23 个，而 HEAD 只证实 1 个 ⇒ **22 个是误撤销**（白跑几小时），另有 743 个根本判不了。
把 `total` 当图片数还会把纯容器 7227（130 全是子目录、`res2` 都没有）判成「130 张图全无证据」。

**撤销**（先 dryRun，再留副本，再真跑）。前置：`H.ready()` 且 `load.loaded===true`、目录数与台账对得上 ——
`revokeFalseMarks` 有 `LEDGER_NOT_LOADED` 闸，没 load 直接返回 `{ok:false, err:'LEDGER_NOT_LOADED'}`；
空 `L` 配 `force:true` 会绕过回归保护把真台账洗成空（2026-11-08 事故同类）。

```js
let dry = await H.revokeFalseMarks({ head: head, kids: kids, dryRun: true });   // 只报不改，内存与盘都不动
// revoked/debt 是「将会撤销几个 / 将会补几笔欠排空」，dryRun 下同样算得出来
nodeRepl.write(JSON.stringify({ willRevoke: dry.revoked, willDebt: dry.debt, unknown: dry.unknown, list: dry.bad }));
// bad 为空 ⇒ 不撤销、不重跑：没有证据支持撤销，只报「审计时点全干净」（结论只对审计时点有效，之后新上传不在覆盖内）。
// 确认清单后再跑真撤销。撤销会让内存 vDone 变少 ⇒ 必然撞 persist 回归保护，函数内部已 force:true。
// 注意 force:true 时 persist **不写 .bak**（.bak 只在非 force 分支里留），所以副本要自己留：
let fs2 = await import('node:fs');
fs2.copyFileSync(globalThis.__CFG.ledger, globalThis.__CFG.ledger + '.before-revoke');
let r = await H.revokeFalseMarks({ head: head, kids: kids, tag: 'revoke-2026' });
nodeRepl.write(JSON.stringify({ ok: r.ok, persist: r.persist, revoked: r.revoked, debt: r.debt, unknown: r.unknownIds.length }));
```

**必须看 `r.ok === true`**：不 force 时 `persist` 返回的是 `'PERSIST_REFUSED disk(...) > mem(...)'` **字符串而不是抛错**，
撤销静默不生效，下一次 `H.load()` 又把假标记读回来（`load` 的 p2 游标取盘/内存里键多的那一份）。

撤销只删 `vDone[id]` 与 `p2.done[id]`，**保留** `res2` / `retry` / `L.aud` / 审计证据（它们是历史，不是判据）；
`sent>0` 却没有 `drain` 的目录自动补一笔 `needDrain[id]={total,at,sent,why:'revoke'}`，重跑进该目录时先补排空。
注意 `res2[id].repair.drain` 是**字符串**（如 `'converted'`）、不是 `drain` 对象，引擎只读 `res2[id].drain`：
所以走过尾部补修的目录（如 7979，`sent:81`、只有 `repair`）撤销后仍会补一笔欠账 —— 这是保守口径，重入时多排空一次，无害。
`p2.done=2` 与 `unknown` 桶不动。**别手动删年度根的 `vDone`**：那等于让无人值守模板整年重跑。

**撤销后怎么把标记挣回来**：

- 整支子树 → `H.processTree(root)`（Cell 4）：它建 `folders[id]`、写 `vDone`。
- 平铺已建档目录 → `H.p2Pass({ids, cleanMark:1, skip:id=>!!L.p2.done[id]})`。注意 `p2Pass` 自己**不写** `folders`/`vDone`：
  判干净的分支只写 `p2.done`，脏目录分支经 `submitAndDrain → pumpX2` 才写 `vDone`。
  所以只用 p2Pass 复跑，判干净的那些目录 `vDone` 不会回来（汇总口径会少），要么走 processTree，要么按下一条登记。
- 逐项 HEAD 全覆盖且四个 0 → 按证据登记：`L.p2.done[id]=3`、`L.vDone[id]={id,total,done:true}`、
  `folders[id].src='api-recheck-<日期>'`，然后 `await H.persist('recheck-mark')`。**没有全覆盖就别登记。**

---

## 落盘与报告

- **独立 JSON 两份**：`tree-recheck.json`（枚举行 + 差集 + errs）、`recheck.json`（逐目录 `total/smBad/xlBad/nock/videos/other` + 游标 + 累计 agg + 修复与终态）。台账附加字段（如 `recheck2026`）只放汇总与指针，**逐项证据别只挂台账**。
- 修复记账写 `res2[id].repair = {smBrokenBefore, items, batches, fixed, drain, at, via}`；`totSent` 只加**实际提交**的条数（工具条直提也要算）。
- 报告里分开写：审计覆盖（目录数/条目数/HEAD 次数）、实测缺失、修复与复验、终态四个 0。
  `preview` 档在抽查里一律 404（含早已转换好的条目），**不纳入判据**；判据只有网格用的 `sm` 与灯箱用的 `xl`。

## 常见错误

| 错误 | 后果 |
|---|---|
| node 侧逐目录 `H.listChildren` / `H.apiPost` | 每目录一趟桥往返，1257 目录要 42 分钟–2.8 小时 |
| 一格塞整树 | 撞 600s cell 上限，结果全丢 |
| 只核 `sm` 不核 `xl` | 灯箱坏图漏判 |
| 拿 `additional.thumbnail.sm === "ready"` 当判据 | 实测 ready 而 HEAD 404 |
| 拿 `bad=0` / `loaded>=all` / `drain:converted` 收口 | 只覆盖窗口内那 81 张，窗外那条永远看不到 |
| 审计顺手写 `vDone`/`p2.done` | 只读结果污染修复游标，假干净被固化 |
| 收尾不查 `errs` | 接口失败的目录被游标跳过，结论少一块 |
| 逐个 missing id 调 processTree | 公共祖先被重复跑；最小根集见 Cell 4 |
| 删年度根 `vDone` + `fresh:true` 来补 missing | 整年重跑（几千目录、十几小时），还撞 persist 回归保护 |
| 用合成路径 `'<年度目录名>/'+id` 当 `opts.path` | `folders[id].name` 失真，报告与日后对账对不上 |
| 用 `p2Pass` 跑整支 missing | 不递归、不建档，下次复查差集依旧非空 |
| 只按台账/DOM 证据撤销完成标记 | 实测报 23 个而 HEAD 只证实 1 个 ⇒ 22 个误撤销 |
| 把 `total` 当图片数（不减 `kids`） | 纯容器 7227（130 全是子目录）被判「130 张全无证据」 |
| 喂修复**前**的 `rc.res` 当 head | 已修好并复验通过的目录被再撤销一次 |
| 撤销后不查 `r.ok === true` | persist 静默拒绝（返回字符串），`load` 又把假标记读回来 |
| 手工建档写 `path` 而不是 `name` | `p2Pass` 的 `node.path` 退化成裸 id（2026 台账 32341–32345 这 5 条就是） |
| 撤销前不自己留副本 | `force:true` 走的是不写 `.bak` 的分支，撤错了没有上一版可回 |
| 没 `H.load()` 就撤销 | 返回 `LEDGER_NOT_LOADED`；绕过这道闸则空 `L` + force 把真台账洗成空 |