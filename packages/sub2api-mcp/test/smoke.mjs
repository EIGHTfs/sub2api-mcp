#!/usr/bin/env node
/** smoke.mjs — 冒烟测试：启动 MCP 服务器（stdio）并验证协议与只读工具 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const env = { ...process.env, MCP_CONFIG: path.join(HERE, '..', 'sub2api-mcp.config.json') };
const proc = spawn(process.execPath, [CLI, 'serve'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout, terminal: false });
const pending = new Map();
let seq = 0;
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (method, params, notify) => new Promise((resolve) => {
  const id = notify ? undefined : ++seq;
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  if (id !== undefined) msg.id = id;
  if (notify) { proc.stdin.write(JSON.stringify(msg) + '\n'); return resolve(null); }
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify(msg) + '\n');
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const res = (r && r.result) || {};
  return { isError: !!res.isError, text: (res.content || []).map((c) => c.text || '').join('') };
};

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
check('initialize', init.result && init.result.protocolVersion === '2024-11-05', init.result && init.result.serverInfo.name);
await rpc('notifications/initialized', undefined, true);

const tl = await rpc('tools/list', {});
const names = (tl.result.tools || []).map((t) => t.name);
check('tools/list（readonly 档 9 个）', names.length === 9, names.join(','));
check('readonly 不含写工具', !names.includes('create_user') && !names.includes('delete_account'));

let r = await call('sub2api_status');
const st = JSON.parse(r.text);
check('sub2api_status', st.admin_api_http === 200, 'healthz=' + st.healthz_http);

r = await call('list_users', { page_size: 5 });
const users = (((JSON.parse(r.text).data) || {}).items) || [];
check('list_users', users.length >= 1, users.map((u) => u.email).join(','));

r = await call('list_accounts');
const accs = (((JSON.parse(r.text).data) || {}).items) || [];
check('list_accounts', accs.length >= 1, accs.length + ' 个账号');

r = await call('get_usage');
check('get_usage', JSON.parse(r.text).http === 200);

const bad = await rpc('tools/call', { name: 'create_user', arguments: {} });
check('禁用工具被拒（readonly 档 ✓）', !!bad.error && /unknown or disabled/.test(bad.error.message));

proc.stdin.end();
proc.kill();
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
