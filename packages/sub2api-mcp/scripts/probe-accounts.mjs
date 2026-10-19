#!/usr/bin/env node
/** probe-accounts.mjs —— 上游账号探活（只读 ✓ 不产生业务调用 ✓）
 *  用法: DSH_HOME=<.dsh> node scripts/probe-accounts.mjs [--ids 1,2,3] [--timeout 8000]
 *        node scripts/probe-accounts.mjs --config sub2api-mcp.config.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Sub2ApiClient } from '../src/core/client.js';
import { probeAccounts } from '../src/core/probe.js';

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
function credsFromDshHome() {
  const home = process.env.DSH_HOME || '';
  if (!home) return null;
  try {
    const f = path.join(home, 'sub2api-credentials.json');
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d && d.email ? d : null;
  } catch { return null; }
}
const cfg = loadConfig(opt('--config'));
const c = credsFromDshHome();
if (c) { cfg.sub2api.url = c.url || cfg.sub2api.url; cfg.sub2api.email = c.email; cfg.sub2api.password = c.password; }
const ids = (opt('--ids', '') || '').split(',').map(Number).filter(Boolean);
const timeoutMs = Number(opt('--timeout', 90000));
const client = new Sub2ApiClient(cfg.sub2api);
const r = await client.api('GET', '/api/v1/admin/accounts?page=1&page_size=100');
if (r.status !== 200) { console.error('✗ 拉账号失败 HTTP ' + r.status); process.exit(1); }
let items = (((r.body || {}).data || {}).items) || [];
if (ids.length) { const w = new Set(ids); items = items.filter((x) => w.has(Number(x.id))); }
console.log(`网关: ${client.url}  账号: ${items.length} 个  超时: ${timeoutMs}ms\n`);
const out = await probeAccounts(client, items, { timeoutMs, concurrency: Number(opt('--concurrency', 2)) });
const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
console.log('  ' + pad('ID', 4) + pad('状态', 9) + pad('优先级', 7) + pad('探活', 8) + pad('耗时', 9) + pad('模型', 12) + '回复/错误');
console.log('  ' + '-'.repeat(96));
for (const a of out.accounts) {
  const p = a.probe || {};
  console.log('  ' + pad(a.id, 4) + pad(a.status, 9) + pad(a.priority, 7) + pad(p.ok ? '✓ 通' : '✗ 失败', 8)
    + pad(p.latencyMs != null ? p.latencyMs + 'ms' : '-', 9) + pad(p.model || '-', 12)
    + (p.ok ? String(p.reply || '').replace(/\n/g, ' ').slice(0, 34) : String(p.error || '失败').slice(0, 34)));
}
console.log(`\n  结果: ✓ ${out.ok} 通 / ✗ ${out.failed} 失败（共 ${out.total}）`);
process.exit(out.failed ? 1 : 0);
