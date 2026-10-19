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

/** 列出候选文件（各版本落点都扫 ✓ 不依赖单一文件） */
export function discoverFiles(home) {
  const cands = { configs: [], credentials: [] };
  const addIfFile = (arr, p) => { try { if (fs.statSync(p).isFile()) arr.push(p); } catch { /* 不存在 */ } };
  const CONFIG_NAMES = ['cordis.patch.yml', 'cordis.yml', 'cordis.patch.yaml', 'config.yml', 'config.yaml', 'config.json', 'dsh.config.json'];
  const CRED_NAMES = ['.credentials.yaml', '.credentials.yml', '.credentials.json', 'credentials.json', 'credentials.yaml'];

  // ① home 根
  for (const n of CONFIG_NAMES) addIfFile(cands.configs, path.join(home, n));
  for (const n of CRED_NAMES) addIfFile(cands.credentials, path.join(home, n));

  // ② profiles/<name>/（每个 profile 都看 ✓）
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(home, 'profiles')); } catch { profiles = []; }
  for (const n of profiles) {
    const dir = path.join(home, 'profiles', n);
    for (const f of CONFIG_NAMES) addIfFile(cands.configs, path.join(dir, f));
    for (const f of CRED_NAMES) addIfFile(cands.credentials, path.join(dir, f));
  }
  return cands;
}

/** api 协议 → Sub2API platform ✓ */
export function platformOf(api) {
  const a = String(api || '').toLowerCase();
  if (a.includes('anthropic')) return 'anthropic';
  if (a.includes('openai') || a.includes('chat')) return 'openai';
  return a || 'openai';
}

/** 汇总：扫描所有来源 → 合并 provider（同 id 取第一个有 baseURL 的 ✓）+ 合并 refs ✓ */
export function collectDshProviders({ home, testModel = 'gpt-5.4' } = {}) {
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
      credentials: { api_key: key, base_url: p.baseURL, api_base_urls: { chat_completions: p.baseURL }, model_mapping: mapping },
      _meta: { providerId: p.id, api: p.api, baseURL: p.baseURL, models, source: p.source },
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
