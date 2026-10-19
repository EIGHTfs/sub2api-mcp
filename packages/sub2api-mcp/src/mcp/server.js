// dsh-skip-complexity: 圈复杂度来自每个工具的内联 run 箭头函数（分支都在各自的工具里，不在注册表本身），条目多是产品面而非逻辑耦合，故整体豁免
// dsh-skip-func-length: MCP 工具注册表是声明式清单（每个工具 5-6 行 schema+run），单函数长与圈复杂度高源于条目数量而非逻辑嵌套；按域拆分已尝试，收益低且易漏工具，故整体豁免
/**
 * L1 协议层：MCP 服务器（stdio，行分隔 JSON-RPC 2.0）
 * 与具体 agent 无关 —— 任何支持 MCP 的客户端都能直接用。
 */
import readline from 'node:readline';
import { Sub2ApiClient } from '../core/client.js';
import { probeAccounts } from '../core/probe.js';
import { collectDshProviders, maskKey, loopRiskOf } from '../core/dsh-import.js';

const PROTOCOL = '2024-11-05';

const qs = (o) => Object.keys(o || {}).filter((k) => o[k] !== undefined && o[k] !== null)
  .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (m) => ({ content: [{ type: 'text', text: 'ERROR: ' + m }], isError: true });

/** 工具定义：tier = readonly | readwrite | full */
export function toolDefs(client) {
  const A = (fn) => async (args) => ok(await fn(args));
  return [
    { name: 'sub2api_status', tier: 'readonly', description: '网关状态：healthz + 管理 API + 仪表盘统计',
      schema: {}, run: A(async () => {
        const r = await client.api('GET', '/api/v1/admin/dashboard/stats');
        return { gateway: client.url, healthz_http: await client.healthz(), admin_api_http: r.status, dashboard: (r.body && r.body.data) || r.body };
      }) },
    { name: 'list_users', tier: 'readonly', description: '列出用户（分页/搜索）',
      schema: { page: { type: 'integer' }, page_size: { type: 'integer' }, search: { type: 'string' } },
      run: A(async (a) => { const r = await client.api('GET', '/api/v1/admin/users?' + qs({ page: a.page || 1, page_size: a.page_size || 20, search: a.search })); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'get_user', tier: 'readonly', description: '查看单个用户详情',
      schema: { user_id: { type: 'integer' } },
      run: A(async (a) => { const r = await client.api('GET', '/api/v1/admin/users/' + Number(a.user_id)); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'create_user', tier: 'readwrite', description: '创建用户',
      schema: { email: { type: 'string' }, password: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' } },
      run: A(async (a) => { const r = await client.api('POST', '/api/v1/admin/users', { email: a.email, password: a.password, username: a.username || String(a.email).split('@')[0], role: a.role || 'user' }); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'update_user', tier: 'readwrite', description: '更新用户（邮箱/用户名/角色/状态/备注）',
      schema: { user_id: { type: 'integer' }, email: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } },
      run: A(async (a) => { const p = {}; ['email', 'username', 'role', 'status', 'notes'].forEach((k) => { if (a[k] !== undefined) p[k] = a[k]; }); const r = await client.api('PUT', '/api/v1/admin/users/' + Number(a.user_id), p); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'set_user_balance', tier: 'readwrite', description: '设置/调整用户余额（operation: set|add）',
      schema: { user_id: { type: 'integer' }, balance: { type: 'number' }, operation: { type: 'string' } },
      run: A(async (a) => { const r = await client.api('POST', '/api/v1/admin/users/' + Number(a.user_id) + '/balance', { balance: Number(a.balance), operation: a.operation || 'set' }); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'list_accounts', tier: 'readonly', description: '列出上游账号',
      schema: { page: { type: 'integer' }, page_size: { type: 'integer' } },
      run: A(async (a) => { const r = await client.api('GET', '/api/v1/admin/accounts?' + qs({ page: a.page || 1, page_size: a.page_size || 50 })); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'create_account', tier: 'readwrite', description: '创建上游账号',
      schema: { name: { type: 'string' }, platform: { type: 'string' }, type: { type: 'string' }, credentials: { type: 'object' } },
      run: A(async (a) => { const r = await client.api('POST', '/api/v1/admin/accounts', { name: a.name, platform: a.platform || 'opencode_go', type: a.type || 'apikey', credentials: a.credentials || {} }); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'update_account', tier: 'readwrite', description: '更新上游账号',
      schema: { account_id: { type: 'integer' }, name: { type: 'string' }, status: { type: 'string' }, schedulable: { type: 'boolean' }, priority: { type: 'integer' }, concurrency: { type: 'integer' }, credentials: { type: 'object' } },
      run: A(async (a) => { const p = {}; ['name', 'status', 'schedulable', 'priority', 'concurrency', 'credentials'].forEach((k) => { if (a[k] !== undefined) p[k] = a[k]; }); const r = await client.api('PUT', '/api/v1/admin/accounts/' + Number(a.account_id), p); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'delete_account', tier: 'full', description: '删除上游账号（危险）',
      schema: { account_id: { type: 'integer' } },
      run: A(async (a) => { const r = await client.api('DELETE', '/api/v1/admin/accounts/' + Number(a.account_id)); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'bind_account_group', tier: 'readwrite', description: '把上游账号绑定到分组',
      schema: { account_id: { type: 'integer' }, group_id: { type: 'integer' } },
      run: A(async (a) => { const r = await client.api('PUT', '/api/v1/admin/accounts/' + Number(a.account_id), { group_ids: [Number(a.group_id)] }); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'list_groups', tier: 'readonly', description: '列出分组', schema: {},
      run: A(async () => { const r = await client.api('GET', '/api/v1/admin/groups'); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'create_group', tier: 'readwrite', description: '创建分组',
      schema: { name: { type: 'string' }, platform: { type: 'string' } },
      run: A(async (a) => { const r = await client.api('POST', '/api/v1/admin/groups', { name: a.name, platform: a.platform || 'composite' }); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'list_api_keys', tier: 'readonly', description: '列出 API Key',
      schema: { page: { type: 'integer' }, page_size: { type: 'integer' } },
      run: A(async (a) => { const r = await client.api('GET', '/api/v1/keys?' + qs({ page: a.page || 1, page_size: a.page_size || 50 })); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'create_api_key', tier: 'readwrite', description: '创建 API Key',
      schema: { name: { type: 'string' }, group_id: { type: 'integer' } },
      run: A(async (a) => { const p = { name: a.name }; if (a.group_id !== undefined && a.group_id !== null) p.group_id = Number(a.group_id); const r = await client.api('POST', '/api/v1/keys', p); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'get_usage', tier: 'readonly', description: '用量/统计（今日成本、RPM、活跃用户、token）', schema: {},
      run: A(async () => { const r = await client.api('GET', '/api/v1/admin/dashboard/stats'); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'chat_completion', tier: 'readwrite', description: '经网关发一次对话（测上游连通性）',
      schema: { model: { type: 'string' }, prompt: { type: 'string' }, api_key: { type: 'string' }, max_tokens: { type: 'integer' }, messages: { type: 'array' } },
      run: A(async (a) => {
        let key = a.api_key;
        if (!key) { const r = await client.api('GET', '/api/v1/keys?page=1&page_size=1'); const items = (((r.body || {}).data || {}).items) || []; if (!items.length) throw new Error('没有可用 API Key，请先 create_api_key 或传 api_key'); key = items[0].key; }
        const r = await client.gateway('POST', '/v1/chat/completions', { model: a.model, messages: a.messages || [{ role: 'user', content: a.prompt || 'say OK' }], max_tokens: Number(a.max_tokens || 32) }, key, 120000);
        return { http: r.status, data: r.body };
      }) },
    { name: 'sync_upstream_models', tier: 'readonly', description: '预览上游账号真实模型列表',
      schema: { platform: { type: 'string' }, type: { type: 'string' }, api_key: { type: 'string' } },
      run: A(async (a) => { const r = await client.api('POST', '/api/v1/admin/accounts/models/sync-upstream-preview', { platform: a.platform || 'opencode_go', type: a.type || 'apikey', api_key: a.api_key }, 90000); return { http: r.status, data: (r.body && r.body.data) || r.body }; }) },
    { name: 'probe_accounts', tier: 'readonly', description: '上游账号探活：让网关用各账号自己的凭据真发一次测试对话（SSE），返回 通/失败+延迟+模型+回复（只读语义，网关侧记录）',
      schema: { account_ids: { type: 'array' }, timeout_ms: { type: 'integer' }, concurrency: { type: 'integer' } },
      run: A(async (a) => {
        const r = await client.api('GET', '/api/v1/admin/accounts?page=1&page_size=100');
        let items = (((r.body || {}).data || {}).items) || [];
        if (Array.isArray(a.account_ids) && a.account_ids.length) {
          const want = new Set(a.account_ids.map(Number));
          items = items.filter((x) => want.has(Number(x.id)));
        }
        const out = await probeAccounts(client, items, { timeoutMs: Number(a.timeout_ms || 90000), concurrency: Number(a.concurrency || 2) });
        return { gateway: client.url, http: r.status, ...out };
      }) },
    // 把 DSH 侧已配置的模型提供商（api 地址 + key + 模型清单）导入成 Sub2API 上游账号
    // 设计：CLI 负责参数化（--only / --update / 回环提示），本工具自主判断：
    //   ① 回环类（指向网关自己/其它 Sub2API）自动排除，不建；
    //   ② 同名已存在时先拉详情比对凭据：一致则跳过，不一致才更新（避免 key 换了不同步）；
    //   ③ 默认 dry_run 只返回决策，dry_run=false 才落库。
    { name: 'import_dsh_providers', tier: 'readwrite', description: '把 DSH 已配置的模型提供商导入成上游账号（默认 dry-run；自动排除回环、自动判断已存在账号是否需更新）',
      schema: {
        dry_run: { type: 'boolean', description: '默认 true：只返回决策计划，不写网关' },
        only: { type: 'string', description: '只处理指定 provider，逗号分隔，如 "d,agnes"' },
        test_model: { type: 'string', description: '账号自检的测试模型（默认按平台取：openai→gpt-5.4）' },
        force: { type: 'boolean', description: '强制覆盖已存在的同名账号（不比对凭据）' },
      },
      run: A(async (a) => {
        const dry = a.dry_run === undefined ? true : !!a.dry_run;
        const collected = collectDshProviders({ testModel: a.test_model || undefined });
        const only = String(a.only || '').split(',').map((s) => s.trim()).filter(Boolean);
        let accounts = collected.accounts;
        if (only.length) accounts = accounts.filter((x) => only.includes(x._meta.providerId));

        // ① 自主排除回环
        const loopSkipped = [];
        accounts = accounts.filter((x) => {
          const risk = loopRiskOf(x._meta.baseURL, client.url);
          if (risk) { loopSkipped.push({ provider: x._meta.providerId, baseURL: x._meta.baseURL, reason: risk }); return false; }
          return true;
        });

        // key 脱敏（输出会进会话上下文）
        const plan = accounts.map((x) => ({
          provider: x._meta.providerId, name: x.name, platform: x.platform,
          baseURL: x._meta.baseURL, models: x._meta.models.length,
          key: maskKey(x.credentials.api_key), source: x._meta.source,
        }));
        const base = { dryRun: dry, home: collected.home, configFiles: collected.files.configs.length, plan, loopSkipped, missing: collected.skipped };
        if (dry) return base;

        // ② 自主判断已存在账号：拉详情比对凭据
        const list = await client.api('GET', '/api/v1/admin/accounts?page=1&page_size=200');
        const items = ((list.body || {}).data || {}).items || [];
        const byName = new Map(items.map((x) => [String(x.name), x]));
        const done = [];
        for (const x of accounts) {
          const payload = { name: x.name, platform: x.platform, type: x.type, credentials: x.credentials };
          const hit = byName.get(x.name);
          let action = 'create';
          if (hit) {
            action = 'update';
            if (!a.force) {
              const cur = await client.api('GET', '/api/v1/admin/accounts/' + hit.id);
              const cc = (((cur.body || {}).data) || {}).credentials || {};
              const same = cc.api_key === payload.credentials.api_key
                && cc.base_url === payload.credentials.base_url
                && JSON.stringify(cc.model_mapping || {}) === JSON.stringify(payload.credentials.model_mapping || {});
              if (same) { done.push({ name: x.name, id: hit.id, action: 'skip', reason: '凭据与模型映射一致' }); continue; }
            }
          }
          const r = action === 'update'
            ? await client.api('PUT', '/api/v1/admin/accounts/' + hit.id, payload)
            : await client.api('POST', '/api/v1/admin/accounts', payload);
          done.push({ name: x.name, action, http: r.status, id: (((r.body || {}).data) || {}).id, error: r.status >= 400 ? JSON.stringify(r.body).slice(0, 160) : undefined });
        }
        const summary = {
          created: done.filter((d) => d.action === 'create' && d.http < 400).length,
          updated: done.filter((d) => d.action === 'update' && d.http < 400).length,
          unchanged: done.filter((d) => d.action === 'skip').length,
          failed: done.filter((d) => d.http >= 400).length,
          loopSkipped: loopSkipped.length,
        };
        return { ...base, done, summary };
      }) },
  ];
}

const TIER_ORDER = { readonly: 0, readwrite: 1, full: 2 };
export function allowedTools(profile) {
  const max = TIER_ORDER[profile] ?? TIER_ORDER.readwrite;
  return toolDefs(null).filter((t) => TIER_ORDER[t.tier] <= max);
}

/** 启动 stdio MCP 服务器 */
export function startServer({ client, config, input = process.stdin, output = process.stdout }) {
  const defs = toolDefs(client);
  const profile = (config && config.server && config.server.toolProfile) || 'readwrite';
  const maxTier = TIER_ORDER[profile] ?? 1;
  const enabled = defs.filter((t) => TIER_ORDER[t.tier] <= maxTier);
  const byName = new Map(enabled.map((t) => [t.name, t]));
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');

  const handle = async (req) => {
    const { method, id } = req;
    const params = req.params || {};
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: (config && config.server && config.server.name) || 'sub2api', version: (config && config.server && config.server.version) || '0.1.0' },
      } });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: enabled.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.schema } })) } });
    }
    if (method === 'tools/call') {
      const t = byName.get(params.name);
      if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown or disabled tool: ' + params.name } });
      try { return send({ jsonrpc: '2.0', id, result: await t.run(params.arguments || {}) }); }
      catch (e) { return send({ jsonrpc: '2.0', id, result: fail((e && e.message) || e) }); }
    }
    if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  };

  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return;
    let req;
    try { req = JSON.parse(t); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    try { await handle(req); } catch (e) { if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String((e && e.message) || e) } }); }
  });
  return { profile, tools: enabled.map((t) => t.name), close: () => rl.close() };
}

export { Sub2ApiClient };
export default startServer;
