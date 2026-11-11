// H.drain 循环 + H.splitBudget 的回归测试。
// 两条实测根因：
//  1) 旧 drain 第一行 `if (st.bad === 0) return {reason:'zero'}`：提交后同一秒 bad 就归零（loaded 只有 2/16），
//     于是立刻返回，processTree 马上进子目录/回上级 —— 用户报的「没等预览生成就退回上一级」。
//  2) 旧 processTree 给 pumpX2 的预算是 deadline-now-90000，pump 会吃满它；
//     之后 drainBudget = min(180000, deadline-now-90000) 恰好 ≈20000，不满足 `> 20000`，排空被整段跳过。
//     所以必须先把排空时间预留出来，再决定能不能提交。
import assert from 'node:assert/strict';

const LIB = './synophotos_lib.mjs';
await import(LIB + '?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

// 用脚本化的页面状态驱动真实的 H.drain；只替换取样与等待这两个外部边界
function withPage(samples, fn) {
  const orig = { st: H.st, G: H.G, PW: H.PW };
  let i = 0;
  const seen = [];
  H.st = async () => { const s = samples[Math.min(i, samples.length - 1)]; i++; seen.push(s); return s; };
  H.G = (f) => f();
  H.PW = () => ({ waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)) });   // 真实计时，timeout 判据才有意义
  return Promise.resolve(fn(seen)).finally(() => Object.assign(H, orig));
}
const s = (o) => Object.assign({ all: 0, loaded: 0, bad: 0, nosrc: 0, folders: 0, checked: 0 }, o);

await test('drain 存在 splitBudget（提交前预留排空时间）', () => {
  assert.equal(typeof H.splitBudget, 'function', 'H.splitBudget 未实现');
});

await test('核心回归：提交后 bad=0 但 loaded=2/16，必须等到 16/16 才返回 converted', async () => {
  await withPage([s({ all: 16, loaded: 2, bad: 0 }), s({ all: 16, loaded: 9, bad: 0 }), s({ all: 16, loaded: 16, bad: 0 })], async (seen) => {
    const r = await H.drain(5000, 6, 1, { total: 16, minDwellMs: 0, renderGraceMs: 0 });
    assert.equal(r.reason, 'converted', '旧逻辑在这里返回 zero 并立即离开目录');
    assert.ok(seen.length >= 3, '只取样了 ' + seen.length + ' 次，说明提前返回了');
    assert.equal(r.loaded, 16);
    assert.equal(r.all, 16);
  });
});

await test('bad 波动但 loaded 卡住：判 stalled（旧版按 bad 判停滞会一路等到 timeout）', async () => {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push(s({ all: 16, loaded: 9, bad: k % 2 ? 6 : 7 }));
  await withPage(samples, async () => {
    const r = await H.drain(5000, 3, 1, { total: 16, minDwellMs: 0 });
    assert.equal(r.reason, 'stalled');
    assert.equal(r.loaded, 9);
  });
});

await test('只有子文件夹的目录：判 empty，不是 zero', async () => {
  await withPage([s({ all: 0, folders: 19, bad: 0 })], async () => {
    const r = await H.drain(5000, 6, 1, { total: 19, minDwellMs: 0, renderGraceMs: 0 });
    assert.equal(r.reason, 'empty');
  });
});

await test('有图片但瓦片没渲染出来：判 not-rendered，绝不能当完成', async () => {
  await withPage([s({ all: 0, folders: 0, bad: 0 })], async () => {
    const r = await H.drain(5000, 6, 1, { total: 52, minDwellMs: 0, renderGraceMs: 0 });
    assert.equal(r.reason, 'not-rendered');
  });
});

await test('渲染宽限内不许提前判 not-rendered', async () => {
  await withPage([s({ all: 0, folders: 0, bad: 0 }), s({ all: 0, folders: 0, bad: 0 }), s({ all: 52, loaded: 52, bad: 0 })], async (seen) => {
    const r = await H.drain(5000, 6, 1, { total: 52, minDwellMs: 0, renderGraceMs: 60000 });
    assert.equal(r.reason, 'converted');
    assert.ok(seen.length >= 3);
  });
});

await test('loaded 一直推进但没齐：到 maxMs 判 timeout', async () => {
  const samples = [];
  for (let k = 0; k < 40; k++) samples.push(s({ all: 200, loaded: k + 1, bad: 200 - k - 1 }));
  await withPage(samples, async () => {
    const r = await H.drain(40, 6, 5, { total: 200, minDwellMs: 0 });
    assert.equal(r.reason, 'timeout');
    assert.ok(r.waited >= 40, 'waited=' + r.waited);
  });
});

await test('minDwell 未过即使全 loaded 也要再等一轮（防瞬时假信号）', async () => {
  await withPage([s({ all: 16, loaded: 16, bad: 0 })], async (seen) => {
    const r = await H.drain(5000, 6, 1, { total: 16, minDwellMs: 60000, renderGraceMs: 0 });
    assert.notEqual(r.reason, 'converted');
    assert.ok(seen.length >= 2, '没有继续取样');
  });
});

await test('splitBudget：时间充足时 ok，且扣掉 pump 后仍留够排空时间', () => {
  const b = H.splitBudget(500000, 0);
  assert.equal(b.ok, true);
  assert.ok(b.pump > 30000 && b.pump <= 420000, 'pump=' + b.pump);
  assert.ok((500000 - 0 - 90000) - b.pump >= b.reserve, '排空时间被 pump 吃掉了');
  assert.ok(b.reserve >= 120000, 'reserve=' + b.reserve);
});

await test('splitBudget：剩余时间不够排空就不许提交（ok=false）', () => {
  const b = H.splitBudget(200000, 0);
  assert.equal(b.ok, false, '这种情况下提交完必然没时间等转换');
});

await test('splitBudget：pump 上限 420000', () => {
  const b = H.splitBudget(1000000, 0);
  assert.equal(b.pump, 420000);
  assert.equal(b.ok, true);
});

await test('splitBudget：边界 pump 必须严格大于 30000', () => {
  assert.equal(H.splitBudget(240000, 0).ok, false);
  assert.equal(H.splitBudget(240001, 0).ok, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);