#!/usr/bin/env node
/** test_mcp.js — 用 stdio 模拟 MCP 客户端，验证 sub2api_mcp.js */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const env = Object.assign({}, process.env, {
  SUB2API_URL: process.env.SUB2API_URL || 'http://127.0.0.1:8080',
  SUB2API_EMAIL: process.env.SUB2API_EMAIL || 'admin@sa6400.local',
  SUB2API_PASSWORD: process.env.SUB2API_PASSWORD || '',   // 必须用环境变量提供 ✓ 不硬编码 ✗
});
const proc = spawn(process.execPath, [path.join(__dirname, 'sub2api_mcp.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout, terminal: false });
const pending = new Map();
let seq = 0;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function rpc(method, params, notify) {
  return new Promise((resolve) => {
    const id = notify ? undefined : ++seq;
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    if (id !== undefined) msg.id = id;
    if (notify) { proc.stdin.write(JSON.stringify(msg) + '\n'); return resolve(null); }
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const res = (r && r.result) || {};
  const text = (res.content || []).map((c) => c.text || '').join('');
  return { isError: !!res.isError, text };
};
(async () => {
  console.log('═══ ① initialize ═══');
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  console.log('  ', init.result.protocolVersion, '|', init.result.serverInfo.name, init.result.serverInfo.version);
  await rpc('notifications/initialized', undefined, true);

  console.log('═══ ② tools/list ═══');
  const tl = await rpc('tools/list', {});
  console.log('  工具数:', tl.result.tools.length);
  console.log('  名称:', tl.result.tools.map((t) => t.name).join(', '));

  console.log('═══ ③ sub2api_status ═══');
  let r = await call('sub2api_status');
  let d = JSON.parse(r.text);
  console.log('  healthz:', d.healthz_http, '| admin_api:', d.admin_api_http, '| 今日成本:', (d.dashboard || {}).today_actual_cost);

  console.log('═══ ④ list_users ═══');
  r = await call('list_users', { page_size: 5 });
  d = JSON.parse(r.text);
  const users = ((d.data || {}).items) || [];
  console.log('  用户数:', users.length, users.map((u) => u.email + '(' + u.role + ')').join(', '));

  console.log('═══ ⑤ list_accounts ═══');
  r = await call('list_accounts');
  d = JSON.parse(r.text);
  const accs = ((d.data || {}).items) || [];
  console.log('  账号数:', accs.length);
  accs.forEach((a) => console.log('   -', a.id, (a.name || '').slice(0, 34), a.status, 'prio=' + a.priority));

  console.log('═══ ⑥ chat_completion（deepseek-v4-flash）═══');
  r = await call('chat_completion', { model: 'deepseek-v4-flash', prompt: 'reply exactly: OK', max_tokens: 16 });
  d = JSON.parse(r.text);
  const body = d.data || {};
  const content = ((((body.choices || [{}])[0]).message) || {}).content || '';
  console.log('  http:', d.http, '| 回复:', JSON.stringify(content.slice(0, 40)));

  console.log('═══ ⑦ get_usage ═══');
  r = await call('get_usage');
  d = JSON.parse(r.text);
  console.log('  http:', d.http, '| RPM:', (d.data || {}).rpm, '| 活跃用户:', (d.data || {}).active_users);

  console.log('═══ ⑧ 错误处理 ═══');
  const bad = await rpc('tools/call', { name: 'not_exist_tool', arguments: {} });
  console.log('  error:', JSON.stringify(bad.error));

  proc.stdin.end();
  proc.kill();
  console.log('═══ 测试结束 ═══');
})();
