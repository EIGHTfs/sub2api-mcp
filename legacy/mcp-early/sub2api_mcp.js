#!/usr/bin/env node
/**
 * sub2api_mcp.js — Sub2API 管理 MCP 服务器（Node.js 版，纯标准库，无 npm 依赖）
 *
 * 与 Python 版（sub2api_mcp.py）工具集完全一致：18 个工具。
 * 配置优先级：环境变量 > mcp.config.json > 内置默认
 *   环境变量：SUB2API_URL / SUB2API_EMAIL / SUB2API_PASSWORD / SUB2API_VERIFY_TLS
 *            MCP_CONFIG（指定配置文件路径）/ MCP_ENABLE_WRITE / MCP_ENABLE_DELETE
 * 传输：stdio，行分隔 JSON-RPC 2.0（MCP 2024-11-05）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const readline = require('readline');

// ───────────────────────── 配置 ─────────────────────────
function loadConfig() {
  const cfgPath = process.env.MCP_CONFIG || path.join(__dirname, 'mcp.config.json');
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { fileCfg = {}; }
  const s = fileCfg.sub2api || {};
  const srv = fileCfg.server || {};
  const env = process.env;
  const bool = (v, d) => (v === undefined ? d : !(v === '0' || v === 'false' || v === 'False'));
  return {
    url: (env.SUB2API_URL || s.url || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    email: env.SUB2API_EMAIL || s.email || '',
    password: env.SUB2API_PASSWORD || s.password || '',
    verifyTls: bool(env.SUB2API_VERIFY_TLS, s.verifyTls !== false),
    timeoutMs: Number(env.SUB2API_TIMEOUT_MS || s.timeoutMs || 30000),
    name: env.MCP_SERVER_NAME || srv.name || 'sub2api-admin',
    version: srv.version || '1.0.0',
    enableWrite: bool(env.MCP_ENABLE_WRITE, srv.enableWriteTools !== false),
    enableDelete: bool(env.MCP_ENABLE_DELETE, srv.enableDeleteTools !== false),
  };
}
const CFG = loadConfig();

// ───────────────────────── HTTP 客户端 ─────────────────────────
let TOKEN = null;

function httpRequest(method, urlStr, body, token, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ status: 0, body: { error: String(e) } }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''), method, headers,
      rejectUnauthorized: isHttps ? CFG.verifyTls : undefined,
      timeout: timeoutMs || CFG.timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { parsed = { raw: raw.slice(0, 500) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e && e.message || e) } }));
    if (data) req.write(data);
    req.end();
  });
}

async function login(force) {
  if (TOKEN && !force) return TOKEN;
  if (!CFG.email || !CFG.password) throw new Error('缺少 SUB2API_EMAIL / SUB2API_PASSWORD（或 mcp.config.json 里的 sub2api.email/password）');
  const r = await httpRequest('POST', CFG.url + '/api/v1/auth/login', { email: CFG.email, password: CFG.password });
  const d = (r.body && r.body.data) || {};
  const tok = d.access_token || d.token;
  if (r.status !== 200 || !tok) throw new Error('登录失败 HTTP ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 300));
  TOKEN = tok;
  return TOKEN;
}

async function api(method, p, body, timeoutMs) {
  let tok = await login();
  let r = await httpRequest(method, CFG.url + p, body, tok, timeoutMs);
  if (r.status === 401) { tok = await login(true); r = await httpRequest(method, CFG.url + p, body, tok, timeoutMs); }
  return r;
}

const qs = (o) => Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null)
  .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

// ───────────────────────── 工具实现 ─────────────────────────
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const err = (m) => ({ content: [{ type: 'text', text: 'ERROR: ' + m }], isError: true });

const IMPL = {
  async sub2api_status(a) {
    const r = await api('GET', '/api/v1/admin/dashboard/stats');
    let hz = 0;
    try { const h = await httpRequest('GET', CFG.url + '/healthz'); hz = h.status; } catch (e) { hz = 0; }
    return ok({ gateway: CFG.url, healthz_http: hz, admin_api_http: r.status, dashboard: (r.body && r.body.data) || r.body });
  },
  async list_users(a) {
    const r = await api('GET', '/api/v1/admin/users?' + qs({ page: a.page || 1, page_size: a.page_size || 20, search: a.search }));
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async get_user(a) { const r = await api('GET', '/api/v1/admin/users/' + Number(a.user_id)); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async create_user(a) {
    const payload = { email: a.email, password: a.password, username: a.username || String(a.email).split('@')[0], role: a.role || 'user' };
    const r = await api('POST', '/api/v1/admin/users', payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async update_user(a) {
    const payload = {};
    ['email', 'username', 'role', 'status', 'notes'].forEach((k) => { if (a[k] !== undefined) payload[k] = a[k]; });
    const r = await api('PUT', '/api/v1/admin/users/' + Number(a.user_id), payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async set_user_balance(a) {
    const payload = { balance: Number(a.balance), operation: a.operation || 'set' };
    const r = await api('POST', '/api/v1/admin/users/' + Number(a.user_id) + '/balance', payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async list_accounts(a) {
    const r = await api('GET', '/api/v1/admin/accounts?' + qs({ page: a.page || 1, page_size: a.page_size || 50 }));
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async create_account(a) {
    const payload = { name: a.name, platform: a.platform || 'opencode_go', type: a.type || 'apikey', credentials: a.credentials || {} };
    const r = await api('POST', '/api/v1/admin/accounts', payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async update_account(a) {
    const payload = {};
    ['name', 'status', 'schedulable', 'priority', 'concurrency', 'credentials'].forEach((k) => { if (a[k] !== undefined) payload[k] = a[k]; });
    const r = await api('PUT', '/api/v1/admin/accounts/' + Number(a.account_id), payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async delete_account(a) { const r = await api('DELETE', '/api/v1/admin/accounts/' + Number(a.account_id)); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async bind_account_group(a) { const r = await api('PUT', '/api/v1/admin/accounts/' + Number(a.account_id), { group_ids: [Number(a.group_id)] }); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async list_groups(a) { const r = await api('GET', '/api/v1/admin/groups'); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async create_group(a) { const r = await api('POST', '/api/v1/admin/groups', { name: a.name, platform: a.platform || 'composite' }); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async list_api_keys(a) { const r = await api('GET', '/api/v1/keys?' + qs({ page: a.page || 1, page_size: a.page_size || 50 })); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async create_api_key(a) {
    const payload = { name: a.name };
    if (a.group_id !== undefined && a.group_id !== null) payload.group_id = Number(a.group_id);
    const r = await api('POST', '/api/v1/keys', payload);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
  async get_usage(a) { const r = await api('GET', '/api/v1/admin/dashboard/stats'); return ok({ http: r.status, data: (r.body && r.body.data) || r.body }); },
  async chat_completion(a) {
    let key = a.api_key;
    if (!key) {
      const r = await api('GET', '/api/v1/keys?page=1&page_size=1');
      const items = (((r.body || {}).data || {}).items) || [];
      if (!items.length) return err('没有可用的 API Key，请先 create_api_key 或传 api_key 参数');
      key = items[0].key;
    }
    const payload = { model: a.model, messages: a.messages || [{ role: 'user', content: a.prompt || 'say OK' }], max_tokens: Number(a.max_tokens || 32) };
    const r = await httpRequest('POST', CFG.url + '/v1/chat/completions', payload, key, 120000);
    return ok({ http: r.status, data: r.body });
  },
  async sync_upstream_models(a) {
    const r = await api('POST', '/api/v1/admin/accounts/models/sync-upstream-preview',
      { platform: a.platform || 'opencode_go', type: a.type || 'apikey', api_key: a.api_key }, 90000);
    return ok({ http: r.status, data: (r.body && r.body.data) || r.body });
  },
};

const TOOLS = [
  ['sub2api_status', '查看 Sub2API 网关状态（healthz + 管理 API + 仪表盘统计）', {}],
  ['list_users', '列出用户（分页/搜索）', { page: { type: 'integer' }, page_size: { type: 'integer' }, search: { type: 'string' } }],
  ['get_user', '查看单个用户详情', { user_id: { type: 'integer' } }],
  ['create_user', '创建用户', { email: { type: 'string' }, password: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' } }],
  ['update_user', '更新用户（邮箱/用户名/角色/状态/备注）', { user_id: { type: 'integer' }, email: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }],
  ['set_user_balance', '设置/调整用户余额（operation: set|add）', { user_id: { type: 'integer' }, balance: { type: 'number' }, operation: { type: 'string' } }],
  ['list_accounts', '列出上游账号', { page: { type: 'integer' }, page_size: { type: 'integer' } }],
  ['create_account', '创建上游账号', { name: { type: 'string' }, platform: { type: 'string' }, type: { type: 'string' }, credentials: { type: 'object' } }],
  ['update_account', '更新上游账号', { account_id: { type: 'integer' }, name: { type: 'string' }, status: { type: 'string' }, schedulable: { type: 'boolean' }, priority: { type: 'integer' }, concurrency: { type: 'integer' }, credentials: { type: 'object' } }],
  ['delete_account', '删除上游账号', { account_id: { type: 'integer' } }],
  ['bind_account_group', '把上游账号绑定到分组', { account_id: { type: 'integer' }, group_id: { type: 'integer' } }],
  ['list_groups', '列出分组', {}],
  ['create_group', '创建分组', { name: { type: 'string' }, platform: { type: 'string' } }],
  ['list_api_keys', '列出 API Key', { page: { type: 'integer' }, page_size: { type: 'integer' } }],
  ['create_api_key', '创建 API Key', { name: { type: 'string' }, group_id: { type: 'integer' } }],
  ['get_usage', '查看用量/统计', {}],
  ['chat_completion', '通过网关发起一次对话（测试上游连通性）', { model: { type: 'string' }, prompt: { type: 'string' }, api_key: { type: 'string' }, max_tokens: { type: 'integer' }, messages: { type: 'array' } }],
  ['sync_upstream_models', '预览某个上游账号的真实模型列表', { platform: { type: 'string' }, type: { type: 'string' }, api_key: { type: 'string' } }],
];

// 工具开关（配置化 ✓）：写工具 / 删工具可分别关闭
const WRITE_TOOLS = new Set(['create_user', 'update_user', 'set_user_balance', 'create_account', 'update_account', 'bind_account_group', 'create_group', 'create_api_key']);
const DELETE_TOOLS = new Set(['delete_account']);
function toolEnabled(name) {
  if (DELETE_TOOLS.has(name) && !CFG.enableDelete) return false;
  if (WRITE_TOOLS.has(name) && !CFG.enableWrite) return false;
  return true;
}

// ───────────────────────── MCP 协议 ─────────────────────────
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(req) {
  const method = req.method || '';
  const id = req.id;
  const params = req.params || {};
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: CFG.name, version: CFG.version } } });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    const tools = TOOLS.filter(([n]) => toolEnabled(n)).map(([n, d, s]) => ({ name: n, description: d, inputSchema: { type: 'object', properties: s } }));
    return send({ jsonrpc: '2.0', id, result: { tools } });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (!toolEnabled(name) || !IMPL[name]) {
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown or disabled tool: ' + name } });
    }
    let result;
    try { result = await IMPL[name](params.arguments || {}); }
    catch (e) { result = err(e && e.message || e); }
    return send({ jsonrpc: '2.0', id, result });
  }
  if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch (e) { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  try { await handle(req); } catch (e) { if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e && e.message || e) } }); }
});
