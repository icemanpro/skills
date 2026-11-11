// H.drainDecide 的回归测试：判据必须区分「坏图 class 消失」与「预览真的生成完」
// 实测依据（2026-11-10，folder 4112，16 张坏图）：
//   提交前 {all:16, loaded:0,  bad:16, nosrc:16}
//   点完「生成预览」同一秒 {all:16, loaded:2, bad:0, nosrc:0}  ← 旧 drain 在这里误判 zero 并立即离开
//   约十几秒后 {all:16, loaded:16, bad:0, nosrc:0}              ← 真正完成
// 另：folder 3822 只有 19 个子文件夹、没有图片瓦片，{all:0, folders:19, total:19} 属于空目录而非未渲染。
import assert from 'node:assert/strict';

const LIB = './synophotos_lib.mjs';
await import(LIB + '?t=' + Date.now());
const H = globalThis.__H;

const OPTS = { total: 16, maxMs: 180000, minDwellMs: 8000, stallNeed: 6, intMs: 6000, renderGraceMs: 20000 };
const s = (o) => Object.assign({ all: 0, loaded: 0, bad: 0, nosrc: 0, folders: 0 }, o);
const ctx = (o) => Object.assign({ elapsed: 30000, hist: [] }, o);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

test('drainDecide 存在且可调用', () => {
  assert.equal(typeof H.drainDecide, 'function', 'H.drainDecide 未实现');
});

test('提交后 bad=0 但只加载了 2/16：必须继续等（核心回归）', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 2, bad: 0, nosrc: 0 }), ctx({ elapsed: 1000 }), OPTS);
  assert.equal(r, null, '期望 null(继续等)，实际 ' + JSON.stringify(r));
});

test('提交后 bad=0 且 nosrc=0 但 loaded=0：必须继续等', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 0, bad: 0, nosrc: 0 }), ctx({ elapsed: 2000 }), OPTS);
  assert.equal(r, null);
});

test('全部 loaded 且已过最小停留：判定 converted', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 16, bad: 0, nosrc: 0 }), ctx({ elapsed: 20000 }), OPTS);
  assert.equal(r, 'converted');
});

test('全部 loaded 但停留不足 minDwell：仍要等（防瞬时假信号）', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 16, bad: 0, nosrc: 0 }), ctx({ elapsed: 1000 }), OPTS);
  assert.equal(r, null);
});

test('仍有坏图：继续等', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 10, bad: 6, nosrc: 6 }), ctx(), OPTS);
  assert.equal(r, null);
});

test('只有子文件夹的空目录：过了渲染宽限判 empty', () => {
  const r = H.drainDecide(s({ all: 0, folders: 19 }), ctx({ elapsed: 25000 }), Object.assign({}, OPTS, { total: 19 }));
  assert.equal(r, 'empty');
});

test('只有子文件夹但仍在渲染宽限内：继续等', () => {
  const r = H.drainDecide(s({ all: 0, folders: 19 }), ctx({ elapsed: 3000 }), Object.assign({}, OPTS, { total: 19 }));
  assert.equal(r, null);
});

test('有图片但瓦片还没渲染出来：判 not-rendered，绝不能当成完成', () => {
  const r = H.drainDecide(s({ all: 0, folders: 0 }), ctx({ elapsed: 25000 }), Object.assign({}, OPTS, { total: 52 }));
  assert.equal(r, 'not-rendered');
});

test('瓦片未渲染但在宽限内：继续等', () => {
  const r = H.drainDecide(s({ all: 0, folders: 0 }), ctx({ elapsed: 5000 }), Object.assign({}, OPTS, { total: 52 }));
  assert.equal(r, null);
});

test('loaded 长期不推进：判 stalled', () => {
  const hist = [s({ all: 16, loaded: 9 }), s({ all: 16, loaded: 9 }), s({ all: 16, loaded: 9 }),
                s({ all: 16, loaded: 9 }), s({ all: 16, loaded: 9 }), s({ all: 16, loaded: 9 })];
  const r = H.drainDecide(s({ all: 16, loaded: 9, bad: 7 }), ctx({ elapsed: 90000, hist }), OPTS);
  assert.equal(r, 'stalled');
});

test('loaded 在推进：即使未齐也不判 stalled', () => {
  const hist = [s({ all: 16, loaded: 3 }), s({ all: 16, loaded: 5 }), s({ all: 16, loaded: 7 }),
                s({ all: 16, loaded: 9 }), s({ all: 16, loaded: 11 }), s({ all: 16, loaded: 13 })];
  const r = H.drainDecide(s({ all: 16, loaded: 15, bad: 1 }), ctx({ elapsed: 90000, hist }), OPTS);
  assert.equal(r, null);
});

test('超过 maxMs：判 timeout', () => {
  const r = H.drainDecide(s({ all: 16, loaded: 9, bad: 7 }), ctx({ elapsed: 181000 }), OPTS);
  assert.equal(r, 'timeout');
});

test('目录真的没有项目（total=0）：判 empty', () => {
  const r = H.drainDecide(s({ all: 0, folders: 0 }), ctx({ elapsed: 25000 }), Object.assign({}, OPTS, { total: 0 }));
  assert.equal(r, 'empty');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
