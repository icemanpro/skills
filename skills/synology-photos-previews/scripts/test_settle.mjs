// 「图片状态安定」闸门测试。
// 背景（2026-11-11 实测同一台 5754）：卡片先渲染出来，坏图标记（synofoto-item-image-broken）
// 是图片请求超时/失败之后才挂上去的。导航后时间线（all/bad/loaded）：
//   2705: 645ms 0/0/0 → 1320ms 12/0/0 → 1934ms 12/12/0
//   2711: 649ms 0/0/0 → 1272ms 43/0/0 → 1904ms 43/22/0 → 2536ms 43/43/0
// 也就是说 1.3s 读到 bad=0 完全可能是「还没判出来」，不是「真的没有坏图」。
// 第二遍扫描里如果只看 bad===0 就标 done，会把整个目录漏掉。
// 安定判据：每张渲染出来的卡片都要有确定状态 —— bad + loaded >= all（且 all>0），
// 或者页面明确是空目录（0 个项目 / 无项目）。不安定就一直读到预算用完，
// 用完仍不安定时返回 settled:false，上层绝不标 done。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
['st', 'sleep'].forEach((k) => { ORIG[k] = H[k]; });
function restore() { Object.assign(H, ORIG); }

// 依次吐出 frames 里的快照；每次 st() 记录一行
function scene(frames) {
  const log = [];
  let i = 0;
  H.st = async () => { const f = frames[Math.min(i, frames.length - 1)]; i++; log.push(f); return f; };
  H.sleep = async () => {};
  return { log, get reads() { return log.length; } };
}
const S = (o) => Object.assign({ all: 0, bad: 0, loaded: 0, nosrc: 0, checked: 0, folders: 0, total: null, emptyView: false }, o);

await test('刚渲染完还没判出坏图：不能当成干净，要继续读到安定', async () => {
  const s = scene([S({ all: 12, total: 12 }), S({ all: 12, bad: 12, total: 12 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 12 });
    assert.equal(r.settled, true, '应最终安定');
    assert.equal(r.st.bad, 12, '最终必须看见 12 张坏图');
    assert.ok(s.reads >= 2, '一次读就下结论了');
  } finally { restore(); }
});

await test('bad=0 且全部 loaded：判为干净（bad+loaded>=all）', async () => {
  const s = scene([S({ all: 9, loaded: 9, total: 9 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 9 });
    assert.equal(r.settled, true);
    assert.equal(r.st.bad, 0);
    assert.equal(s.reads, 1, '已安定却还多读');
  } finally { restore(); }
});

await test('部分卡片悬而未决（22/43 坏，其余既非坏也非好）：不安定，继续等', async () => {
  const s = scene([S({ all: 43, bad: 22, total: 43 }), S({ all: 43, bad: 22, loaded: 21, total: 43 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 43 });
    assert.equal(r.settled, true);
    assert.equal(r.st.bad + r.st.loaded, 43);
  } finally { restore(); }
});

await test('预算用完仍不安定 → settled:false，上层不得标 done', async () => {
  const s = scene([S({ all: 43, bad: 5, total: 43 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 43, maxMs: 1500 });
    assert.equal(r.settled, false);
    assert.ok(s.reads > 1, '没有重试');
  } finally { restore(); }
});

await test('卡片数少于目录总数（虚拟化没渲染全）：不算安定', async () => {
  const s = scene([S({ all: 100, loaded: 100, total: 162 }), S({ all: 100, loaded: 100, total: 162 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 162, maxMs: 1200 });
    assert.equal(r.settled, false, '只渲染 100/162 却判安定');
  } finally { restore(); }
});

await test('空目录（0 个项目 / 无项目）算安定', async () => {
  let s = scene([S({ total: 0 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 0 });
    assert.equal(r.settled, true);
  } finally { restore(); }
  H.st = async () => S({ emptyView: true }); H.sleep = async () => {};
  try {
    const r2 = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 0 });
    assert.equal(r2.settled, true);
  } finally { restore(); }
});

await test('deadline 紧张时立刻收手，不吃掉上层的窗口', async () => {
  const s = scene([S({ all: 43, bad: 5, total: 43 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 1000, expectTotal: 43 });
    assert.equal(r.settled, false);
    assert.ok(s.reads <= 2, 'deadline 已到还在狂读：' + s.reads);
  } finally { restore(); }
});

// 实测事故（2026-11-11，满窗 27 的 gaveUp）：目录 3361 里 5 张照片 + 9 个子目录，
// 页面 all=5 loaded=5 bad=0，但 total=14（含子目录）。旧判据拿 all 去比 want=14，
// 永远「不安定」-> 上层 ok=false -> retry 累加 -> 最后被错误标成「仍坏」。
await test('目录里同时有子目录：all + folders 达到 total 且无坏图，就算安定', async () => {
  const s = scene([S({ all: 5, loaded: 5, folders: 9, total: 14 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 14 });
    assert.equal(r.settled, true, '5 张已加载 + 9 个子目录 = 14 项，判不安定');
    assert.equal(r.st.bad, 0);
  } finally { restore(); }
});

await test('子目录凑不满 total 且仍有卡片没判状态：不能算安定', async () => {
  const s = scene([S({ all: 5, loaded: 3, folders: 9, total: 14 })]);
  try {
    const r = await H.stSettled({ deadline: Date.now() + 60000, expectTotal: 14, maxMs: 1200 });
    assert.equal(r.settled, false, '还有 2 张卡片状态未定却判安定');
  } finally { restore(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
