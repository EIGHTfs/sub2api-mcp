/**
 * DSH 提供商 → Sub2API 账号 的导入核心（零依赖 ✓ / 多来源自动发现 ✓）
 *
 * 为什么不能只读固定文件：不同 DSH 版本的配置落点不同 ✗
 *   - 新版：profiles/<profile>/cordis.patch.yml 里的 llm-*.config.providers
 *   - 旧版：<DSH_HOME>/config.yml / config.json
 *   - key：新版在 .credentials.yaml 的 refs 段；也可能写在 provider 的 apiKey 字段；
 *          也可能来自进程环境变量（apiKeyEnv 指向的变量）
 * 所以这里做「扫描 + 合并 + 去重」，并对每个 provider 记录来源文件 ✓
 *
 * 产物：可直接 POST /api/v1/admin/accounts 的 payload ✓
 *   { name, platform, type, credentials: { api_key, base_url, api_base_urls, model_mapping } }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 取 DSH_HOME：显式参数 > 环境变量 > ~/.dsh */
export function dshHome(explicit) {
  if (explicit) return explicit;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

const indentOf = (line) => (/^(\s*)/.exec(line) || ['', ''])[1].length;
const clean = (line) => line.replace(/\s+#.*$/, '').replace(/^\s+/, '');
const stripQuote = (s) => String(s || '').replace(/^['"]|['"]$/g, '');

/** 解析 YAML 文本里的 providers 段（只认 api / apiKey / apiKeyEnv / baseURL / models） */
export function parseProvidersFromPatch(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*providers:\s*$/.test(lines[i])) continue;
    const base = indentOf(lines[i]);
    let cur = null;
    let inModels = false;
    let modelsIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const ind = indentOf(raw);
      if (ind <= base) break;
      const body = clean(raw);
      if (ind === base + 2 && /^[A-Za-z0-9_.-]+:\s*$/.test(body)) {
        if (cur) out.push(cur);
        cur = { id: body.replace(/:\s*$/, ''), api: null, apiKey: null, apiKeyEnv: null, baseURL: null, models: [] };
        inModels = false;
        continue;
      }
      if (!cur) continue;
      if (ind === base + 4) {
        inModels = false;
        const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(body);
        if (!kv) continue;
        const k = kv[1], v = stripQuote(kv[2]);
        if (k === 'api') cur.api = v;
        else if (k === 'apiKey') cur.apiKey = v;
        else if (k === 'apiKeyEnv') cur.apiKeyEnv = v;
        else if (k === 'baseURL' || k === 'baseUrl') cur.baseURL = v;
        else if (k === 'models') { inModels = true; modelsIndent = ind; }
        continue;
      }
      if (inModels && ind > modelsIndent) {
        const m = /^-\s*id:\s*(.+)$/.exec(body);
        if (m) cur.models.push(stripQuote(m[1]).trim());
      }
    }
    if (cur) out.push(cur);
    break; // 一个文件只取第一个 providers 段
  }
  return out.filter((p) => p.id);
}

/** 解析 JSON 里的 providers（递归找 providers 键 ✓ 兼容旧版 config.json） */
export function parseProvidersFromJson(obj) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (node.providers && typeof node.providers === 'object' && !Array.isArray(node.providers)) {
      for (const [id, p] of Object.entries(node.providers)) {
        if (!p || typeof p !== 'object' || seen.has(id)) continue;
        seen.add(id);
        const models = Array.isArray(p.models) ? p.models.map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean) : [];
        out.push({ id, api: p.api || null, apiKey: p.apiKey || null, apiKeyEnv: p.apiKeyEnv || null, baseURL: p.baseURL || p.baseUrl || null, models });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(obj, 0);
  return out;
}

/** 解析凭据文件里的 refs 段（`  D_API_KEY: sk-xxx`），JSON 也支持 ✓ */
export function parseCredentialRefs(text) {
  const t = String(text || '');
  // JSON 形态：{"refs": {"D_API_KEY": "sk-..."}}
  if (/^\s*\{/.test(t)) {
    try {
      const d = JSON.parse(t);
      if (d && d.refs && typeof d.refs === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(d.refs)) if (typeof v === 'string') out[k] = v;
        return out;
      }
      return {};
    } catch { return {}; }
  }
  const refs = {};
  let inRefs = false, refsIndent = -1;
  for (const raw of t.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    const body = clean(raw);
    if (/^refs:\s*$/.test(body)) { inRefs = true; refsIndent = ind; continue; }
    if (!inRefs) continue;
    if (ind <= refsIndent) break;
    const m = /^([A-Za-z0-9_.-]+):\s*(.+)$/.exec(body);
    if (m) refs[m[1]] = stripQuote(m[2]);
  }
  return refs;
}

/**
 * 发现 DSH 的配置文件与凭据文件 —— 按「内容指纹」判定，不写死任何文件名 ✓
 *
 * 为什么不能写死文件名 ✗：不同 DSH 版本、不同 profile、不同部署方式下，
 *   承载 providers 的文件可能是 cordis.patch.yml / cordis.yml / config.yaml / dsh.config.json …
 *   承载凭据的可能是 .credentials.yaml / credentials.json / …
 *   一旦把名单写死，换版本或自定义布局就会漏读/漏写。
 * 判据（只看内容，不看名字）：
 *   · 含 YAML 的 `providers:` 段或 JSON 的 "providers" 键 → 配置文件候选
 *   · 含 YAML 的 `refs:` 段或 JSON 的 "refs" 键            → 凭据文件候选
 * 扫描边界（防扫爆 sessions/skills 等海量目录 ✓）：
 *   · 深度上限 maxDepth（默认 3，覆盖 <home>/ 与 <home>/profiles/<name>/）
 *   · 只收 .yml/.yaml/.json
 *   · 单文件体积上限 maxBytes（默认 2MB）
 *   · 跳过明显非配置的目录（依赖、版本库、会话日志、缓存、插件数据…）
 */
export function discoverFiles(home, opts = {}) {
  const maxDepth = Number(opts.maxDepth || 3);
  const maxBytes = Number(opts.maxBytes || 2 * 1024 * 1024);
  // 噪声目录：这些目录下不会出现 DSH 的 provider/凭据配置，扫它们只会徒增耗时 ✓
  const skipDirs = new Set(['node_modules', '.git', 'sessions', 'skills', 'cache', 'data', 'logs', 'log', 'tmp', 'dist', 'build', '.trash', 'local-plugins']);
  const isCfgName = /\.(ya?ml|json)$/i;
  const hasProvidersYaml = /^\s*providers:\s*$/m;
  const hasProvidersJson = /"providers"\s*:/;
  const hasRefsYaml = /^\s*refs:\s*$/m;
  const hasRefsJson = /"refs"\s*:/;
  const configs = [];
  const credentials = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // 目录项按名字排序，保证多次运行结果稳定 ✓
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth >= maxDepth || skipDirs.has(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile() || !isCfgName.test(ent.name)) continue;
      let text;
      try {
        if (fs.statSync(full).size > maxBytes) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      if (hasProvidersYaml.test(text) || hasProvidersJson.test(text)) configs.push(full);
      if (hasRefsYaml.test(text) || hasRefsJson.test(text)) credentials.push(full);
    }
  };
  walk(home, 0);
  return { configs, credentials };
}

/** api 协议 → Sub2API platform ✓ */
export function platformOf(api) {
  const a = String(api || '').toLowerCase();
  if (a.includes('anthropic')) return 'anthropic';
  if (a.includes('openai') || a.includes('chat')) return 'openai';
  return a || 'openai';
}

/** 汇总：扫描所有来源 → 合并 provider（同 id 取第一个有 baseURL 的 ✓）+ 合并 refs ✓ */
export function collectDshProviders({ home, testModel = 'gpt-5.4', concurrency, apiProtocol } = {}) {
  // 并发数：实参 > 环境变量 SUB2API_IMPORT_CONCURRENCY > 默认 5 ✓（0 会让账号几乎不可用 ✗）
  const conc = Number(concurrency !== undefined && concurrency !== null && concurrency !== ''
    ? concurrency
    : (process.env.SUB2API_IMPORT_CONCURRENCY || 5));
  // 入站协议策略 —— 决定上游按哪种协议语义解析请求体 ✓
  //   adaptive：按入站协议优先用供应商原生端点，只有缺对应端点时才转换（默认 ✓）
  //   openai / anthropic / responses：强制单一语义
  // 为什么默认 adaptive：强制 openai 平台时上游会按 Responses 语义（input/ResponseInput）解析，
  // 而客户端发的是 chat/completions 语义（messages + role:"tool" + tool_calls），
  // 工具项没有对应 variant，会话一长就在某个工具结果 item 上报 400 json_parse_error ✗
  // 取值优先级：实参 > 环境变量 SUB2API_IMPORT_API_PROTOCOL > adaptive ✓
  // （实测该字段无枚举校验，任意字符串都会落库 ✓，非法值不会报错但语义不明，故仅接受非空字符串）
  const proto = String(
    apiProtocol !== undefined && apiProtocol !== null && apiProtocol !== ''
      ? apiProtocol
      : (process.env.SUB2API_IMPORT_API_PROTOCOL || 'adaptive'),
  ).trim() || 'adaptive';
  const concurrencyOf = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5; };
  const h = dshHome(home);
  const files = discoverFiles(h);

  // ── 提供商：按发现顺序合并，记录来源 ✓
  const byId = new Map();
  for (const f of files.configs) {
    let list = [];
    try {
      const text = fs.readFileSync(f, 'utf8');
      list = /^\s*\{/.test(text) ? parseProvidersFromJson(JSON.parse(text)) : parseProvidersFromPatch(text);
    } catch { list = []; }
    for (const p of list) {
      const prev = byId.get(p.id);
      if (!prev) { byId.set(p.id, { ...p, source: f }); continue; }
      // 已有但缺 baseURL / key → 用后来的补齐 ✓
      if (!prev.baseURL && p.baseURL) { prev.baseURL = p.baseURL; prev.source = f; }
      if (!prev.apiKey && p.apiKey) prev.apiKey = p.apiKey;
      if (!prev.apiKeyEnv && p.apiKeyEnv) prev.apiKeyEnv = p.apiKeyEnv;
      if ((!prev.models || !prev.models.length) && p.models && p.models.length) prev.models = p.models;
    }
  }
  const providers = [...byId.values()];

  // ── 凭据：多个文件合并 ✓（先到先得）
  const refs = {};
  for (const f of files.credentials) {
    try { Object.assign(refs, parseCredentialRefs(fs.readFileSync(f, 'utf8'))); } catch { /* 忽略坏文件 */ }
  }

  const accounts = [];
  const skipped = [];
  for (const p of providers) {
    // key 优先级：provider 内联 apiKey > 凭据库 refs > 进程环境变量 ✓
    const key = p.apiKey || (p.apiKeyEnv && refs[p.apiKeyEnv]) || (p.apiKeyEnv && process.env[p.apiKeyEnv]) || '';
    if (!p.baseURL) { skipped.push({ id: p.id, reason: '缺 baseURL ✗', source: p.source }); continue; }
    if (!key) { skipped.push({ id: p.id, reason: '缺 key（' + (p.apiKeyEnv || '未声明 apiKeyEnv') + '）✗', source: p.source }); continue; }
    const models = p.models || [];
    const mapping = {};
    for (const m of models) mapping[m] = m;
    // Sub2API 的账号自检固定用全局测试模型（实测 gpt-5.4，且 test 接口会忽略传入的 model ✗），
    // 所以把测试模型别名映射到该账号的第一个真实模型，否则探活必然 503 model_not_found ✗
    if (models.length && testModel && !mapping[testModel]) mapping[testModel] = models[0];
    accounts.push({
      name: 'dsh:' + p.id,
      platform: platformOf(p.api),
      type: 'apikey',
      credentials: {
        api_key: key,
        base_url: p.baseURL,
        api_base_urls: { chat_completions: p.baseURL },
        // 协议策略必须显式写入：不写时上游按平台默认语义解析，openai 类平台会走 Responses ✗
        api_protocol: proto,
        model_mapping: mapping,
      },
      // 账号并发上限（Sub2API 字段名 = concurrency ✓）默认 5 ✓
      concurrency: concurrencyOf(conc),
      _meta: { providerId: p.id, api: p.api, baseURL: p.baseURL, models, source: p.source, concurrency: concurrencyOf(conc), apiProtocol: proto },
    });
  }
  return { home: h, files, providers, accounts, skipped };
}

/**
 * 回环风险判定 ✓（CLI 与 MCP 工具共用）
 * 指向网关自己 / 其它 Sub2API 实例的 baseURL 导入后会形成循环调用 ✗
 */
export function loopRiskOf(baseURL, gatewayUrl) {
  const u = String(baseURL || '');
  let host = '';
  try { host = new URL(String(gatewayUrl || '')).host; } catch { host = ''; }
  if (host && u.includes(host)) return '指向本网关（回环）';
  if (/sub2api/i.test(u)) return '指向 Sub2API 实例';
  if (/^http:\/\/[^/]*(sa6400|127\.0\.0\.1|localhost)[^/]*:8080/i.test(u)) return '疑似网关自身';
  return '';
}

/** 脱敏 key ✓ */
export function maskKey(k) {
  const s = String(k || '');
  return s ? s.slice(0, 6) + '***' + s.slice(-4) : '';
}

export default { dshHome, discoverFiles, collectDshProviders, parseProvidersFromPatch, parseProvidersFromJson, parseCredentialRefs, platformOf, maskKey };
