// selSpan3 的单张分支测试。
// 实测（2026-11-10，目录 7047）：goto 后 focus() 无法把焦点移到卡片上，
// document.activeElement 仍是 null，body 上的 Space 什么也没选（selCount=0）；
// 同一页面上点 button[data-testid="select-button"] 立刻 selCount=1。
// 结果是 53 个 total=1 的目录全部 sel-fail、从未提交过。
// 单张分支必须优先用 select-button，Space 只作兜底。
import assert from 'node:assert/strict';

await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

const ORIG = {};
['G', 'PW', 'grid', 'selCount', 'clearSel'].forEach((k) => { ORIG[k] = H[k]; });
function restore() { Object.assign(H, ORIG); }

// 假页面：btnWorks 决定 select-button 是否真的选中；spaceWorks 决定 Space 是否选中
function scene({ cards = 1, btnWorks = true, btnThrows = false, spaceWorks = false } = {}) {
  const log = [];
  let sel = 0;
  const card = (i) => ({
    scrollIntoViewIfNeeded: async () => {},
    focus: async () => { log.push('focus'); },
    click: async (o) => {
      if (o && o.modifiers && o.modifiers.indexOf('Shift') >= 0) { sel = cards; log.push('shift'); }
    },
    locator: () => ({
      first: () => ({
        click: async () => {
          log.push('btn');
          if (btnThrows) throw new Error('select-button not clickable');
          if (btnWorks) sel = Math.max(sel, 1);
        }
      })
    })
  });
  const pw = {
    locator: () => ({ press: async (k) => { log.push('press:' + k); if (spaceWorks) sel = Math.max(sel, 1); } }),
    waitForTimeout: async () => {}
  };
  H.G = (fn) => fn();
  H.PW = () => pw;
  H.grid = () => ({ nth: (i) => card(i) });
  H.selCount = async () => sel;
  H.clearSel = async () => { sel = 0; log.push('clear'); };
  return { log, get sel() { return sel; } };
}

await test('单张：必须先用 select-button 选中（旧代码只按 Space）', async () => {
  const s = scene({ cards: 1, btnWorks: true });
  try {
    const n = await H.selSpan3(0, 0);
    assert.equal(n, 1, '单张没选中');
    assert.ok(s.log.indexOf('btn') >= 0, '没有点 select-button：' + JSON.stringify(s.log));
    assert.equal(s.log.indexOf('press:Space'), -1, '还在依赖 Space');
  } finally { restore(); }
});

await test('单张：select-button 点不动时退回 focus+Space', async () => {
  const s = scene({ cards: 1, btnThrows: true, spaceWorks: true });
  try {
    const n = await H.selSpan3(0, 0);
    assert.equal(n, 1, '两条路都没选中');
    assert.ok(s.log.indexOf('btn') >= 0);
    assert.ok(s.log.indexOf('focus') >= 0 && s.log.indexOf('press:Space') >= 0, '没有兜底：' + JSON.stringify(s.log));
  } finally { restore(); }
});

await test('单张：全都选不中时返回 0（上层据此标 sel-fail）', async () => {
  const s = scene({ cards: 1, btnWorks: false, spaceWorks: false });
  try {
    const n = await H.selSpan3(0, 0);
    assert.equal(n, 0);
  } finally { restore(); }
});

await test('多张：仍然先点首张 select-button，再 Shift 点末张', async () => {
  const s = scene({ cards: 3, btnWorks: true });
  try {
    const n = await H.selSpan3(0, 2);
    assert.equal(n, 3, '区间没选全: ' + n);
    assert.equal(s.log.filter((x) => x === 'btn').length, 1, '首张点了不止一次 select-button');
    assert.ok(s.log.indexOf('shift') >= 0, '没有 Shift 点末张');
  } finally { restore(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
