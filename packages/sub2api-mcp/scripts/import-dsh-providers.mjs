#!/usr/bin/env node
/**
 * import-dsh-providers.mjs —— 把 DSH 已配置的模型提供商导入成 Sub2API 上游账号
 *
 * 用法（默认 dry-run ✓ 不写任何东西 ✗）：
 *   node scripts/import-dsh-providers.mjs                  # 只打印将要建哪些账号（key 脱敏 ✓）
 *   node scripts/import-dsh-providers.mjs --write          # 真建（幂等：同名已存在则跳过 ✓）
 *   node scripts/import-dsh-providers.mjs --write --update # 已存在则更新凭据 ✓
 *   node scripts/import-dsh-providers.mjs --only d,agnes   # 只导指定 provider ✓
 *   node scripts/import-dsh-providers.mjs --probe          # 建完立刻探活 ✓
 *   node scripts/import-dsh-providers.mjs --concurrency 8 # 账号并发上限（默认取 env SUB2API_IMPORT_CONCURRENCY，缺省 5）
 *   node scripts/import-dsh-providers.mjs --test-model gpt-5.4   # 指定测试模型别名（默认 auto ✓）
 *
 * 关于「测试模型」：Sub2API 的账号自检固定用它的全局测试模型，且 /test 会忽略传入的 model ✗。
 * 所以导入时把该测试模型作为别名映射到账号的第一个真实模型 ✓，否则探活必然 model_not_found ✗。
 * 默认 --test-model auto：先对一个 active 账号跑一次 test，从 test_start.model 读出真实测试模型 ✓。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Sub2ApiClient } from '../src/core/client.js';
import { collectDshProviders, maskKey, loopRiskOf } from '../src/core/dsh-import.js';
import { probeAccount } from '../src/core/probe.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const write = has('--write');
const update = has('--update');
const wantProbe = has('--probe');
const only = (opt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── 1) 网关配置 + 客户端（dry-run 也要：回环检测 + 自动探测测试模型 ✓）
const cfg = loadConfig(opt('--config', ''));
const homeGuess = opt('--dsh-home', '') || (typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : '');
const credFile = homeGuess ? path.join(homeGuess, 'sub2api-credentials.json') : '';
if (credFile && fs.existsSync(credFile)) {
  try {
    const d = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    if (d && d.email) { cfg.sub2api.url = d.url || cfg.sub2api.url; cfg.sub2api.email = d.email; cfg.sub2api.password = d.password; }
  } catch { /* 忽略坏文件 */ }
}
const client = new Sub2ApiClient(cfg.sub2api);

// ── 2) 测试模型：按平台决定 ✓
// 实测事实：
//   · Sub2API 的 /test 会忽略传入的 model ✗，固定用「该平台的测试模型」✓
//   · opencode_go 平台 → glm-5.3 ✓   openai 平台 → gpt-5.4 ✓（platform 不同默认值不同 ✗）
//   · 账号一旦加了 model_mapping 别名，读到的是别名目标 ✗（不能拿它反推）
// 策略：显式 --test-model > 同平台的「非本工具建的」账号实测 > 平台默认值表 > gpt-5.4
const PLATFORM_TEST_MODEL = { openai: 'gpt-5.4', opencode_go: 'glm-5.3', anthropic: 'claude-3-5-sonnet-20241022' };
const wantedPlatforms = [...new Set((collectDshProviders({ home: opt('--dsh-home', ''), testModel: null }).accounts || []).map((a) => a.platform))];
let testModel = opt('--test-model', '');
let testModelNote = '';
if (testModel) {
  testModelNote = '（命令行指定 ✓）';
} else {
  testModel = '';
  try {
    const list = await client.api('GET', '/api/v1/admin/accounts?page=1&page_size=50');
    const items = ((list.body || {}).data || {}).items || [];
    // 找一个「目标平台 + 不是本工具建的」账号去实测 ✓
    const native = items.filter((a) => !String(a.name || '').startsWith('dsh:') && wantedPlatforms.includes(a.platform));
    const cand = native.find((a) => a.status === 'active') || native[0];
    if (cand) {
      const p = await probeAccount(client, cand.id, { timeoutMs: 30000 });
      if (p && p.model) { testModel = p.model; testModelNote = '（同平台 ' + cand.platform + ' 账号 id=' + cand.id + ' 实测 ✓）'; }
    }
  } catch { /* 探测失败走平台表 */ }
  if (!testModel) {
    const p0 = wantedPlatforms[0] || 'openai';
    testModel = PLATFORM_TEST_MODEL[p0] || 'gpt-5.4';
    testModelNote = '（平台 ' + p0 + ' 默认值 ✓）';
  }
}
console.log('测试模型 : ' + testModel + ' ' + testModelNote);

// ── 3) 读 DSH 侧提供商（多来源自动发现 ✓）
const collected = collectDshProviders({ home: opt('--dsh-home', ''), testModel, concurrency: opt('--concurrency', '') });
console.log('DSH_HOME :', collected.home);
console.log('配置文件（自动发现 ' + collected.files.configs.length + ' 个）:');
for (const f of collected.files.configs) console.log('   - ' + f);
console.log('凭据文件（自动发现 ' + collected.files.credentials.length + ' 个）:');
for (const f of collected.files.credentials) console.log('   - ' + f);
console.log('providers:', collected.providers.length, '个 →', collected.providers.map((p) => p.id).join(', ') || '(无)');
const srcOf = new Map(collected.providers.map((p) => [p.id, p.source || '']));

let accounts = collected.accounts;
if (only.length) accounts = accounts.filter((a) => only.includes(a._meta.providerId));

// ── 4) 打印计划（key 脱敏 ✓）
// 回环判定与 MCP 工具共用同一份实现 ✓（core/dsh-import.js）
const loopRisk = (baseURL) => loopRiskOf(baseURL, cfg.sub2api.url);

console.log('\n计划导入的账号（' + (write ? '真写模式 ✓' : 'dry-run ✓ 不会写任何东西') + '）:');
console.log('  ' + 'provider'.padEnd(10) + '账号名'.padEnd(16) + 'platform'.padEnd(12) + 'baseURL'.padEnd(42) + '模型数'.padEnd(7) + 'key');
console.log('  ' + '-'.repeat(104));
let loops = 0;
for (const a of accounts) {
  const m = a._meta;
  const risk = loopRisk(m.baseURL);
  if (risk) loops++;
  console.log('  ' + String(m.providerId).padEnd(10) + String(a.name).padEnd(16) + String(a.platform).padEnd(12)
    + String(m.baseURL).slice(0, 40).padEnd(42) + String(m.models.length).padEnd(7) + maskKey(a.credentials.api_key)
    + (risk ? '  ' + risk : ''));
}
if (!accounts.length) console.log('  （没有可导入的账号 ✗）');
if (loops) console.log('\n⚠ 有 ' + loops + ' 个指向 Sub2API 自身/其它实例 —— 直接导入会形成回环调用，建议先排除（--only 指定其它 provider ✓）');
if (collected.skipped.length) {
  console.log('\n已跳过:');
  for (const s of collected.skipped) console.log('  - ' + s.id + ': ' + s.reason + '（' + String(s.source || '').split('/').pop() + '）');
}

if (!write) {
  console.log('\n各 provider 的配置来源:');
  for (const a of accounts) console.log('  ' + String(a._meta.providerId).padEnd(10) + ' ← ' + (srcOf.get(a._meta.providerId) || '').replace(collected.home + '/', ''));
  console.log('\n下一步：加 --write 真建（幂等 ✓）；加 --probe 建完立刻探活 ✓');
  process.exit(0);
}

// ── 5) 真写：幂等建/更新 ✓
const listRes = await client.api('GET', '/api/v1/admin/accounts?page=1&page_size=200');
if (listRes.status !== 200) {
  console.error('✗ 拉账号失败 HTTP ' + listRes.status + ': ' + JSON.stringify(listRes.body).slice(0, 200));
  process.exit(1);
}
const existing = ((listRes.body || {}).data || {}).items || [];
const byName = new Map(existing.map((a) => [String(a.name), a]));

let created = 0, updated = 0, skipped = 0, failed = 0;
const touchedIds = [];
for (const a of accounts) {
  const payload = { name: a.name, platform: a.platform, type: a.type, credentials: a.credentials, concurrency: a.concurrency };
  const hit = byName.get(a.name);
  if (hit && !update) { console.log('  = 跳过（已存在）: ' + a.name); skipped++; continue; }
  if (hit && update) {
    const r = await client.api('PUT', '/api/v1/admin/accounts/' + hit.id, payload);
    if (r.status === 200) { console.log('  ↻ 已更新: ' + a.name + ' (id=' + hit.id + ')'); updated++; touchedIds.push(hit.id); }
    else { console.log('  ✗ 更新失败: ' + a.name + ' HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 140)); failed++; }
    continue;
  }
  const r = await client.api('POST', '/api/v1/admin/accounts', payload);
  const id = ((r.body || {}).data || {}).id;
  if (r.status === 200 || r.status === 201) { console.log('  + 已创建: ' + a.name + ' (id=' + id + ')'); created++; if (id) touchedIds.push(id); }
  else { console.log('  ✗ 创建失败: ' + a.name + ' HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 140)); failed++; }
}
console.log('\n结果: 新建 ' + created + ' / 更新 ' + updated + ' / 跳过 ' + skipped + ' / 失败 ' + failed);

// ── 6) 可选：立刻探活 ✓
if (wantProbe && touchedIds.length) {
  console.log('\n探活（每个账号真发一次测试对话 ✓）:');
  for (const id of touchedIds) {
    try {
      const p = await probeAccount(client, id, { timeoutMs: 90000 });
      console.log('  ' + (p.ok ? '✓ 通' : '✗ 失败') + '  id=' + id + '  ' + (p.latencyMs != null ? p.latencyMs + 'ms' : '') + '  '
        + (p.ok ? '模型=' + (p.model || '-') : String(p.error || '').slice(0, 110)));
    } catch (e) { console.log('  ✗ id=' + id + ' ' + String(e.message || e).slice(0, 110)); }
  }
}
process.exit(failed ? 1 : 0);
