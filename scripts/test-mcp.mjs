import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const HOME = process.env.DSH_HOME || '/volume1/@appdata/DeepSeekHarness-NAS/0.2.0-rc.2/.dsh';
const cfg = JSON.parse(fs.readFileSync(HOME + '/mcp.json', 'utf8'));
const e = cfg.mcpServers.sub2api;
const profile = process.env.TEST_PROFILE || e.env.MCP_TOOL_PROFILE || 'readonly';
const env = Object.assign({}, process.env, e.env, { MCP_TOOL_PROFILE: profile });

const proc = spawn(e.command, e.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout, terminal: false });
const pending = new Map(); let seq = 0;
rl.on('line', (l) => { try { const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} });
const rpc = (method, params, notify) => new Promise((res) => {
  const id = notify ? undefined : ++seq; const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params; if (id !== undefined) msg.id = id;
  if (notify) { proc.stdin.write(JSON.stringify(msg) + '\n'); return res(null); }
  pending.set(id, res); proc.stdin.write(JSON.stringify(msg) + '\n');
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r && r.error) return { rpcError: r.error };
  const res = (r && r.result) || {};
  return { isError: !!res.isError, text: (res.content || []).map(c => c.text || '').join('') };
};

console.log(`\n═══ 档位: ${profile} ═══`);
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sim', version: '0' } });
console.log('  initialize     :', init.result.protocolVersion, '|', init.result.serverInfo.name, init.result.serverInfo.version);
await rpc('notifications/initialized', undefined, true);
const tl = await rpc('tools/list', {});
const names = tl.result.tools.map(t => t.name);
console.log('  tools/list     :', names.length, '个');

for (const [name, args] of [
  ['sub2api_status', {}],
  ['list_users', { page_size: 5 }],
  ['list_accounts', {}],
  ['get_usage', {}],
]) {
  const r = await call(name, args);
  if (r.rpcError) { console.log(`  ${name.padEnd(15)}: ✗ rpc error: ${r.rpcError.message}`); continue; }
  const d = JSON.parse(r.text);
  if (name === 'sub2api_status') console.log(`  ${name.padEnd(15)}: ✓ http=${d.admin_api_http} healthz=${d.healthz_http} cost=${(d.dashboard||{}).today_actual_cost}`);
  if (name === 'list_users') console.log(`  ${name.padEnd(15)}: ✓ ${((d.data||{}).items||[]).length} 用户 → ${((d.data||{}).items||[]).map(u=>u.email+'('+u.role+')').join(',')}`);
  if (name === 'list_accounts') { const a=((d.data||{}).items||[]); console.log(`  ${name.padEnd(15)}: ✓ ${a.length} 账号 → ${a.map(x=>x.id+':'+(x.name||'').slice(0,22)).join(' | ')}`); }
  if (name === 'get_usage') console.log(`  ${name.padEnd(15)}: ✓ http=${d.http} rpm=${(d.data||{}).rpm} activeUsers=${(d.data||{}).active_users}`);
}

const chat = await call('chat_completion', { model: 'deepseek-v4-flash', prompt: 'reply exactly: OK', max_tokens: 16 });
if (chat.rpcError) console.log('  chat_completion: ✗ 被拒（' + profile + ' 档）: ' + chat.rpcError.message);
else if (chat.isError) console.log('  chat_completion: ✗ 工具内错误: ' + chat.text.slice(0, 120));
else {
  const d = JSON.parse(chat.text);
  const c = ((((d.data||{}).choices||[{}])[0]).message || {}).content || '';
  console.log('  chat_completion: ✓ http=' + d.http + ' 回复=' + JSON.stringify(c.slice(0, 30)));
}
const cu = await call('create_user', { email: 'probe@example.com', password: 'x' });
console.log('  create_user    : ' + (cu.rpcError ? '✗ 被拒（' + profile + ' 档）: ' + cu.rpcError.message : '✓ 可执行: ' + cu.text.slice(0, 80)));

proc.stdin.end(); proc.kill();
