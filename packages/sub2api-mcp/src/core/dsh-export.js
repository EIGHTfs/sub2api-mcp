/**
 * Sub2API 账号 → DSH 提供商配置 的导出核心（零依赖 ✓）
 *
 * 目标：把 Sub2API 里已有的上游账号，反向写回 DSH 的提供商配置与凭据库，
 * 使 DSH 侧能直接用该上游（provider 名 + baseURL + 模型清单 + apiKeyEnv）。
 *
 * 写入落点：由「内容指纹」自动发现，不绑定任何文件名 ✓
 *   判据 = 文件内容里有没有对应结构段（跟名字无关）：
 *     · 含 YAML `providers:` 段（JSON 的 "providers" 键）→ 配置文件，往里写 provider 块
 *     · 含 YAML `refs:` 段（JSON 的 "refs" 键）          → 凭据文件，往里写 refs.<ENV>
 *   多个候选时按修改时间取最新（陈旧备份天然靠后），并可用 patch_file / cred_file 显式覆盖。
 *   为什么不能写死 ✗：不同版本/不同 profile/自定义布局下，承载 providers 与凭据的文件名完全不同
 *   （cordis.patch.yml、cordis.yml、config.yaml、dsh.config.json、.credentials.yaml、credentials.json …），
 *   写死名单必然在换版本时漏读/漏写。
 *
 * 为什么 key 常常导不出来 ✗
 *   Sub2API 的账号详情不回显明文 api_key（实测只给 credentials_status.has_api_key=true，
 *   且 /credentials /key /reveal /api-key /secret 一律 404；后端库也不在本机可直接查的位置），
 *   因此本模块的 key 取值优先级为：
 *     ① 调用方显式传入的 api_key（用户自己填，最常见 ✓）
 *     ② 账号详情里真读到 api_key（换别的部署可能支持）
 *     ③ DSH 侧已有同名 ref（复用，不覆盖 ✓）
 *   三者都没有 → 只写 provider 配置，回报 needsApiKey=true + 需要补的 ENV 名
 *   绝不写空串/占位符冒充 key（那会让 DSH 侧以为配好了，实际请求 401）✗
 *
 * 安全：
 *   · 任何写盘前先备份 <文件>.bak-<时间戳> ✓
 *   · 凭据文件写后权限收敛到 600 ✓
 *   · 返回值里的 key 一律脱敏（maskKey），真实值只写进凭据文件 ✓
 */
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, discoverFiles, maskKey } from './dsh-import.js';

// 平台测试模型名：Sub2API 账号自检用的固定模型，属于导入时加的别名，不应写进 DSH 的模型清单 ✗
const DEFAULT_TEST_MODELS = ['gpt-5.4', 'glm-5.3', 'claude-3-5-sonnet-20241022'];

const indentOf = (line) => (/^(\s*)/.exec(line) || ['', ''])[1].length;

/** provider 名规范化：允许字母数字 . _ -，其余转下划线（DSH 侧 provider id 要能出现在 YAML 键位） */
export function normalizeProviderId(raw) {
  const s = String(raw || '').trim().replace(/^dsh:/, '');
  const out = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'sub2api';
}

/** 由 provider id 推导凭据环境变量名：agnes → AGNES_API_KEY */
export function envNameOf(providerId) {
  return String(providerId).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() + '_API_KEY';
}

/** 由 Sub2API 的 platform 推导 DSH 的 api 协议名（可被显式参数覆盖） */
export function apiOfPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic';
  return 'openai-completions';
}

/** 取出该账号应导出到 DSH 的模型名清单（映射的「对外名」即 DSH 侧模型 id ✓，剔除平台测试别名） */
export function modelsOfAccount(account, testModels = DEFAULT_TEST_MODELS) {
  const cred = (account && account.credentials) || {};
  const mapping = cred.model_mapping || {};
  const names = Object.keys(mapping);
  const skip = new Set((testModels || []).map((x) => String(x).toLowerCase()));
  const out = [];
  for (const n of names) {
    if (!n || skip.has(String(n).toLowerCase())) continue;
    out.push(String(n));
  }
  return out;
}

/** 组装要写入的 provider YAML 块（缩进与现有块对齐：provider 键 6 空格，子键 8 空格，模型项 10 空格） */
export function buildProviderBlock(providerId, { api, apiKeyEnv, baseURL, models }, providerIndent = 6) {
  const pad = ' '.repeat(providerIndent);
  const pad2 = ' '.repeat(providerIndent + 2);
  const pad3 = ' '.repeat(providerIndent + 4);
  const lines = [];
  lines.push(pad + providerId + ':');
  lines.push(pad2 + 'apiKeyEnv: ' + apiKeyEnv);
  lines.push(pad2 + 'api: ' + api);
  lines.push(pad2 + 'baseURL: ' + baseURL);
  if (models && models.length) {
    lines.push(pad2 + 'models:');
    for (const m of models) {
      lines.push(pad3 + '- id: ' + m);
      lines.push(pad3 + '  name: ' + m);
    }
  }
  return lines.join('\n');
}

/** 定位 patch 文件里 providers 段的位置：返回 { startLine, endLine, providerIndent, existing: [ids], file } */
export function locateProvidersBlock(text) {
  const lines = String(text || '').split('\n');
  // 找 providers: 行（llm 插件 config 下）
  let pIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+providers:\s*$/.test(lines[i])) { pIdx = i; break; }
  }
  if (pIdx < 0) return null;
  const baseIndent = indentOf(lines[pIdx]);
  // provider 项 = providers 下第一层（baseIndent + 2）且以 `id:` 结尾的行
  let providerIndent = baseIndent + 2;
  for (let i = pIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    if (ind <= baseIndent) break;
    if (ind > baseIndent && /^[A-Za-z0-9._-]+:\s*$/.test(raw.trim())) { providerIndent = ind; break; }
  }
  // 段结束 = 下一个缩进 <= baseIndent 的非空行
  let endLine = lines.length;
  for (let i = pIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (indentOf(raw) <= baseIndent) { endLine = i; break; }
  }
  const existing = [];
  for (let i = pIdx + 1; i < endLine; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (indentOf(raw) === providerIndent) {
      const m = /^([A-Za-z0-9._-]+):\s*$/.exec(raw.trim());
      if (m) existing.push(m[1]);
    }
  }
  return { startLine: pIdx, endLine, providerIndent, existing, lines };
}

/** 在 patch 文本里插入/替换 provider 块，返回 { text, action } */
export function upsertProvider(text, providerId, block, { replace = false } = {}) {
  const loc = locateProvidersBlock(text);
  if (!loc) return { text: text + '\n', action: 'no-providers-section' };   // 调用方需先补 llm 插件段，这里不做猜测
  const { lines, providerIndent, existing, endLine } = loc;
  if (existing.includes(providerId)) {
    if (!replace) return { text, action: 'exists-refused' };
    // 找到该 provider 块的范围并整体替换
    let s = -1; let e = endLine;
    for (let i = loc.startLine + 1; i < endLine; i++) {
      const raw = lines[i];
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      if (indentOf(raw) === providerIndent && raw.trim() === providerId + ':') { s = i; continue; }
      if (s >= 0 && indentOf(raw) <= providerIndent) { e = i; break; }
    }
    if (s < 0) return { text, action: 'exists-refused' };
    const next = [...lines.slice(0, s), ...block.split('\n'), ...lines.slice(e)];
    return { text: next.join('\n'), action: 'replaced' };
  }
  // 追加到 providers 段末尾（endLine 前）
  const insertAt = endLine;
  const next = [...lines.slice(0, insertAt), ...block.split('\n'), ...lines.slice(insertAt)];
  return { text: next.join('\n'), action: 'added' };
}

/** 读取凭据文件里的 refs（只取键与值长度，值本身不外传） */
export function readRefs(text) {
  const lines = String(text || '').split('\n');
  const out = { names: [], hasKey: false };
  let inRefs = false; let refsIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^refs:\s*$/.test(raw)) { inRefs = true; refsIndent = 0; continue; }
    if (!inRefs) continue;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    if (ind === 0) { inRefs = false; continue; }
    if (!refsIndent) refsIndent = ind;
    if (ind === refsIndent) {
      const m = /^([A-Za-z0-9_.-]+):\s*(.+)$/.exec(raw.trim());
      if (m) { out.names.push(m[1]); out.hasKey = true; }
    }
  }
  return out;
}

/** 往凭据文本里写入/覆盖一个 ref（key 明文只写文件，不进返回值） */
export function upsertRef(text, envName, key) {
  const lines = String(text || '').split('\n');
  let refsIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/^refs:\s*$/.test(lines[i])) { refsIdx = i; break; }
  const line = '  ' + envName + ': ' + key;
  if (refsIdx < 0) {
    // 没有 refs 段就追加一个
    const next = [...lines, 'refs:', line];
    return { text: next.join('\n'), action: 'refs-created' };
  }
  // refs 段范围
  let end = lines.length;
  for (let i = refsIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (indentOf(raw) === 0) { end = i; break; }
  }
  // 已存在则替换该行
  for (let i = refsIdx + 1; i < end; i++) {
    const m = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i]);
    if (m && m[2] === envName) {
      const next = [...lines];
      next[i] = '  ' + envName + ': ' + key;
      return { text: next.join('\n'), action: 'ref-updated' };
    }
  }
  const next = [...lines.slice(0, end), line, ...lines.slice(end)];
  return { text: next.join('\n'), action: 'ref-added' };
}

/** 备份并写入（原子：先写临时文件再 rename）；凭据文件收 600 */
export function writeWithBackup(file, content, { mode } = {}) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = file + '.bak-' + ts;
  let backup = null;
  if (fs.existsSync(file)) { fs.copyFileSync(file, bak); backup = bak; }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return { backup };
}

/**
 * 主流程：读账号 → 组装 → （dry_run 只出计划）→ 写 patch 与凭据
 * @param {object} client  Sub2ApiClient
 * @param {object} opts    { accountId, provider, api, apiKeyEnv, apiKey, replace, dryRun, testModels, home, patchFile, credFile }
 */
export async function exportAccountToDsh(client, opts = {}) {
  const accountId = Number(opts.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error('account_id 必填且为正整数');
  const dryRun = opts.dryRun === undefined ? true : !!opts.dryRun;

  // ① 读账号详情（admin API）
  const r = await client.api('GET', '/api/v1/admin/accounts/' + accountId);
  const account = ((r.body || {}).data) || null;
  if (r.status !== 200 || !account || !account.id) {
    return { http: r.status, error: '账号不存在或读取失败: ' + JSON.stringify(r.body || {}).slice(0, 200) };
  }

  const cred = account.credentials || {};
  const baseURL = cred.base_url || (cred.api_base_urls || {}).chat_completions || '';
  if (!baseURL) return { http: r.status, error: '该账号没有 base_url，无法生成提供商配置 ✗' };

  const providerId = normalizeProviderId(opts.provider || account.name);
  const api = String(opts.api || apiOfPlatform(account.platform));
  const apiKeyEnv = String(opts.apiKeyEnv || envNameOf(providerId));
  const testModels = Array.isArray(opts.testModels) && opts.testModels.length ? opts.testModels : DEFAULT_TEST_MODELS;
  const models = modelsOfAccount(account, testModels);

  // ② 目标文件：走内容指纹发现（扫描含 providers: / refs: 段的文件）✓
  //    不写死任何文件名 ✗ —— 换版本/自定义布局时目标文件叫什么名字都可能变
  //    多个候选时的消歧策略（都可被 opts.patchFile / opts.credFile 显式覆盖）：
  //      · 只看 YAML（写入侧只实现 YAML 结构）
  //      · 按修改时间降序取最新 —— 活跃配置通常是最近被改动的那份，
  //        历史备份/陈旧目录里的同名文件自然排在后面 ✓
  const home = dshHome(opts.home);
  const files = discoverFiles(home);
  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  const byNewest = (a, b) => mtimeOf(b) - mtimeOf(a);
  const yamlConfigs = files.configs.filter((f) => /\.ya?ml$/i.test(f)).sort(byNewest);
  const yamlCreds = files.credentials.filter((f) => /\.ya?ml$/i.test(f)).sort(byNewest);
  const patchFile = (opts.patchFile && fs.existsSync(opts.patchFile)) ? opts.patchFile : (yamlConfigs[0] || null);
  const jsonOnlyConfigs = !patchFile && files.configs.length > 0 ? files.configs : [];
  // 凭据文件同样按内容识别 + 取最新；识别不到就留空，由调用方拿到明确提示，绝不猜路径 ✗
  const credFile = (opts.credFile && fs.existsSync(opts.credFile)) ? opts.credFile : (yamlCreds[0] || files.credentials[0] || '');

  // ③ key 取值优先级：调用方传入 > 账号详情里读到 > DSH 侧已有同名 ref 复用
  const keyFromParam = typeof opts.apiKey === 'string' && opts.apiKey.trim() ? opts.apiKey.trim() : '';
  const keyFromApi = typeof cred.api_key === 'string' && cred.api_key ? cred.api_key : '';
  const effectiveKey = keyFromParam || keyFromApi;
  let existingRefs = { names: [], hasKey: false };
  let credText = '';
  try {
    if (fs.existsSync(credFile)) {
      credText = fs.readFileSync(credFile, 'utf8');
      existingRefs = readRefs(credText);
    }
  } catch { /* 忽略 */ }
  const reuseExisting = !effectiveKey && existingRefs.names.includes(apiKeyEnv);
  const needsApiKey = !effectiveKey && !reuseExisting;

  // ④ 生成 patch 内容
  let patchResult = { text: '', action: 'skipped' };
  let patchBefore = '';
  let providerBlock = '';
  let insertAtLine = null;
  if (patchFile) {
    patchBefore = fs.readFileSync(patchFile, 'utf8');
    const loc = locateProvidersBlock(patchBefore);
    const indent = loc ? loc.providerIndent : 6;
    providerBlock = buildProviderBlock(providerId, { api, apiKeyEnv, baseURL, models }, indent);
    patchResult = upsertProvider(patchBefore, providerId, providerBlock, { replace: !!opts.replace });
    insertAtLine = loc ? loc.endLine + 1 : null;
  }

  const plan = {
    http: r.status,
    dryRun,
    account: { id: account.id, name: account.name, platform: account.platform, status: account.status },
    provider: providerId,
    api,
    apiKeyEnv,
    baseURL,
    models,
    modelCount: models.length,
    apiProtocol: cred.api_protocol || '(未设置)',
    // key 来源标注：param=调用方指定 / api=详情读到 / existing-ref=复用 / none=缺失
    keySource: keyFromParam ? 'param' : (keyFromApi ? 'api' : (reuseExisting ? 'existing-ref' : 'none')),
    keyMasked: effectiveKey ? maskKey(effectiveKey) : (reuseExisting ? '(复用 DSH 现有 ref)' : ''),
    needsApiKey,
    targets: { patchFile, credFile: credFile || null, discovered: { configs: files.configs, credentials: files.credentials } },
    patchAction: patchResult.action,
  };

  if (dryRun) {
    // 预览直接给「将被写入的完整块」+ 插入行号：
    // 不做行级 diff —— providers 段里可能已有同名模型行，行 diff 会把它们误判成"无变化"而漏掉 ✗
    return { ...plan, preview: { patch: providerBlock, insertAtLine, patchBytes: patchResult.text.length } };
  }

  // ⑤ 真写
  const writes = [];
  if (!patchFile) {
    const hint = jsonOnlyConfigs.length
      ? '发现的配置是 JSON 布局（' + jsonOnlyConfigs.join(', ') + '），当前写入只支持 YAML ✗'
      : '在 ' + home + ' 下没发现任何含 providers: 段的配置文件（请确认已配置 llm 插件）✗';
    return { ...plan, error: hint };
  }
  if (patchResult.action === 'exists-refused') {
    return { ...plan, error: '同名 provider 已存在 ✗ 需显式 replace=true 才覆盖' };
  }
  if (patchResult.action === 'added' || patchResult.action === 'replaced') {
    const w = writeWithBackup(patchFile, patchResult.text);
    writes.push({ file: patchFile, action: patchResult.action, backup: w.backup });
  }
  if (effectiveKey && credFile) {
    const up = upsertRef(credText, apiKeyEnv, effectiveKey);
    const w = writeWithBackup(credFile, up.text, { mode: 0o600 });
    writes.push({ file: credFile, action: up.action, backup: w.backup });
  }
  // 有 key 却没识别到凭据文件：不猜路径、不新建文件，明确回报 ✗
  const noCredFile = !!effectiveKey && !credFile;
  const noteParts = [];
  if (needsApiKey) noteParts.push('未写入 key：参数未提供且 Sub2API 不回显 api_key，需自行补 ' + apiKeyEnv + ' 到凭据库 ✗');
  if (noCredFile) noteParts.push('已在 ' + home + ' 下确认无任何含 refs: 段的凭据文件，key 未写入（可先用 DSH 自身保存一次凭据生成该文件）✗');
  return { ...plan, writes, note: noteParts.join('；') || undefined };
}

export default {
  normalizeProviderId, envNameOf, apiOfPlatform, modelsOfAccount, buildProviderBlock,
  locateProvidersBlock, upsertProvider, readRefs, upsertRef, writeWithBackup, exportAccountToDsh,
};
