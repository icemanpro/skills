// 发布卫生回归测试：换机可跑 + 无个人/业务信息 + 文档与代码一致。
// 背景（2026-11-11 发布前审查）：10 个测试硬编码 file:///C:/Users/<作者>/...，
// 库默认 host 是作者内网 NAS、__legacyLedger 指向个人台账，文档含真实业务路径。
// 这些在本机全绿也暴露不了 —— 本文件把「可发布」变成可失败的断言。
// 注意：本文件自身必须引用这些字符串做扫描 Pattern，所以内容扫描排除本文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SELF = 'test_publish_hygiene.mjs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); fail++; }
}

function walk(dir) {
  let out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out = out.concat(walk(p));
    else if (/\.(md|mjs|cjs)$/.test(ent.name) && ent.name !== SELF) out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const read = (f) => fs.readFileSync(f, 'utf8');
const hits = (needle) => files.filter((f) => read(f).includes(needle)).map((f) => path.relative(ROOT, f));

await test('全 skill 无个人绝对路径（C:/Users/<用户名>）', () => {
  const bad = hits('C:/Users/' + 'deng').concat(hits('C:\\\\Users\\\\' + 'deng'));
  assert.deepEqual(bad, [], '仍含个人路径: ' + bad.join(', '));
});

await test('全 skill 无作者内网 NAS 地址', () => {
  const bad = hits('192.168.' + '10.146');
  assert.deepEqual(bad, [], '仍含内网地址: ' + bad.join(', '));
});

await test('全 skill 无真实业务地名（黄冈/浠水）', () => {
  const bad = hits('黄冈').concat(hits('浠水'));
  assert.deepEqual(bad, [], '仍含业务地名: ' + bad.join(', '));
});

await test('库无 __legacyLedger 个人台账回退', () => {
  const lib = read(path.join(HERE, 'synophotos_lib.mjs'));
  assert.ok(!lib.includes('__legacyLedger'), 'synophotos_lib.mjs 仍有 __legacyLedger');
  assert.ok(!lib.includes('群晖预览台账'), 'synophotos_lib.mjs 仍引用个人台账文件名');
});

await test('所有测试文件用相对路径 import 库/脚本（换机可跑）', () => {
  const bad = [];
  for (const f of fs.readdirSync(HERE)) {
    if (!/^test_.*\.mjs$/.test(f) || f === SELF) continue;
    const s = read(path.join(HERE, f));
    if (/file:\/\/\/[A-Za-z]:/.test(s) || /[A-Za-z]:[\/\\]Users[\/\\]/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], '仍硬编码绝对路径: ' + bad.join(', '));
});

// —— host 必填闸：功能测试（假 agent，不连真浏览器）——
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syno-hygiene-'));
delete process.env.SYNOPHOTOS_HOST;
delete process.env.SYNOPHOTOS_LEDGER;
globalThis.__CFG = { host: '', ledger: path.join(dir, 'l.json'), app: 'SYNO.Foto.AppInstance', space: 'shared_space', rootFolder: '1' };
await import('./synophotos_lib.mjs?t=' + Date.now());
const H = globalThis.__H, CFG = globalThis.__CFG;

await test('host 未配置：boot 返回 NO_HOST，不碰浏览器模块', async () => {
  globalThis.__createBrowserAgent = async () => { throw new Error('不该走到浏览器模块'); };
  const r = await H.boot();
  assert.equal(r && r.err, 'NO_HOST', '期望 NO_HOST，实际 ' + JSON.stringify(r));
});

await test('host 配置后：boot 正常放行（闸口不过度拦截）', async () => {
  CFG.host = 'nas.example:5001';
  CFG.base = 'https://' + CFG.host + '/?launchApp=' + CFG.app;
  const tabUrl = CFG.base + '#/shared_space/folder/1';
  const fakeTab = { tabId: 't1', title: 'Photos', url: tabUrl };
  const claimed = { url: async () => tabUrl, playwright: {} };
  const browser = {
    user: { openTabs: async () => [fakeTab], claimTab: async () => claimed },
    tabs: { new: async () => { throw new Error('不该新建'); } }
  };
  globalThis.__createBrowserAgent = async () => ({ browsers: { list: async () => [{ id: 'b1' }], get: async () => browser } });
  const r = await H.boot();
  assert.ok(r && !r.err, '配置 host 后 boot 仍报错: ' + JSON.stringify(r));
  assert.equal(r.claimed, 'Photos');
});

await test('dom-notes 不再写「processTree 用快照分割抓子目录」（事故旧行为）', () => {
  const s = read(path.join(ROOT, 'references', 'dom-notes.md'));
  assert.ok(!s.includes('用同一分割'), 'dom-notes.md 仍描述旧的快照枚举行为');
  assert.ok(s.includes('listChildren'), 'dom-notes.md 应写明 processTree 走 listChildren API');
});

await test('SKILL.md 的 description/Overview 不再写「右键」流程（工具条才可靠）', () => {
  const s = read(path.join(ROOT, 'SKILL.md'));
  assert.ok(!s.includes('右键「生成预览」'), '仍有「右键「生成预览」」表述');
  assert.ok(!s.includes('右键提交'), 'description 仍写右键提交');
});

await test('SKILL.md 写明 host 必填（与 NO_HOST 闸一致）', () => {
  const s = read(path.join(ROOT, 'SKILL.md'));
  assert.ok(s.includes('NO_HOST'), 'SKILL.md 未写 NO_HOST');
  assert.ok(!s.includes('host 内置'), 'SKILL.md 仍写 host 有内置默认值');
});

await test('frontmatter 合规（name 合法、description 非空、总长 ≤1024）', () => {
  const s = read(path.join(ROOT, 'SKILL.md'));
  const m = s.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, '缺 frontmatter');
  assert.ok(m[1].length <= 1024, 'frontmatter 超 1024 字符: ' + m[1].length);
  const name = m[1].match(/^name:\s*(.+)$/m);
  assert.ok(name && /^[a-z0-9-]+$/.test(name[1].trim()), 'name 不合法');
  const desc = m[1].match(/^description:\s*(.+)$/m);
  assert.ok(desc && desc[1].trim().length > 20, 'description 缺失或过短');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);