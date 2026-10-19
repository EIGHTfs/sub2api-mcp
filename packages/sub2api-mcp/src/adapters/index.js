/**
 * L2 适配层：把 MCP 服务器注册到各 agent（写各自的 MCP 配置文件）
 * 统一接口：register / unregister / inspect —— 新增 agent 只需加一个条目。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (p) => (p ? String(p).replace(/^~(?=$|\/)/, os.homedir()) : p);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj, { dryRun } = {}) {
  if (dryRun) return { written: false, path: p, preview: obj };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let backup = null;
  if (fs.existsSync(p)) { backup = p + '.bak.' + Date.now(); fs.copyFileSync(p, backup); }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  return { written: true, path: p, backup };
}

/** 生成 mcpServers 条目（command 用绝对路径 node + 本包 CLI ✓） */
export function buildEntry({ nodePath, cliPath, cfg }) {
  const env = { SUB2API_URL: cfg.sub2api.url };
  if (cfg.sub2api.email) env.SUB2API_EMAIL = cfg.sub2api.email;
  if (cfg.sub2api.password) env.SUB2API_PASSWORD = cfg.sub2api.password;
  env.MCP_TOOL_PROFILE = cfg.server.toolProfile;
  if (cfg.sub2api.verifyTls === false) env.SUB2API_VERIFY_TLS = '0';
  return { command: nodePath || process.execPath, args: [cliPath || path.join(process.cwd(), 'src/cli.js'), 'serve'], env };
}

/** 各 agent 的配置位置与格式 */
export const ADAPTERS = {
  'claude-desktop': {
    label: 'Claude Desktop',
    defaultPath() {
      if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    },
    serverKey: 'mcpServers',
  },
  'claude-code': {
    label: 'Claude Code',
    defaultPath() { return path.join(process.cwd(), '.mcp.json'); },
    serverKey: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    defaultPath() { return path.join(process.cwd(), '.cursor', 'mcp.json'); },
    serverKey: 'mcpServers',
  },
  dsh: {
    label: 'DSH（DeepSeek Harness）',
    defaultPath(cfg) { return expand((cfg.registry && cfg.registry.dshConfigPath) || '~/.dsh/mcp.json'); },
    serverKey: 'mcpServers',
  },
  generic: {
    label: '通用（只打印，不写文件）',
    defaultPath() { return null; },
    serverKey: 'mcpServers',
  },
};

function resolvePath(name, cfg, opts) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`未知 agent: ${name}（支持: ${Object.keys(ADAPTERS).join(', ')}）`);
  return opts.path || expand((cfg.registry && cfg.registry[`${name}Path`])) || a.defaultPath(cfg);
}

export function register(name, cfg, opts = {}) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`未知 agent: ${name}`);
  const entry = buildEntry({ ...opts, cfg });
  if (name === 'generic' || opts.print || opts.dryRun && !resolvePath(name, cfg, opts)) {
    return { adapter: name, written: false, entry: { [a.serverKey]: { [cfg.server.name]: entry } } };
  }
  const target = resolvePath(name, cfg, opts);
  const doc = readJson(target) || {};
  doc[a.serverKey] = doc[a.serverKey] || {};
  doc[a.serverKey][cfg.server.name] = entry;
  const res = writeJson(target, doc, opts);
  return { adapter: name, label: a.label, ...res, entry: { [a.serverKey]: { [cfg.server.name]: entry } } };
}

export function unregister(name, cfg, opts = {}) {
  const a = ADAPTERS[name];
  if (!a || name === 'generic') return { adapter: name, written: false, skipped: true };
  const target = resolvePath(name, cfg, opts);
  const doc = readJson(target);
  if (!doc || !doc[a.serverKey] || !doc[a.serverKey][cfg.server.name]) {
    return { adapter: name, path: target, changed: false };
  }
  delete doc[a.serverKey][cfg.server.name];
  const res = writeJson(target, doc, opts);
  return { adapter: name, ...res, changed: true };
}

export function inspect(name, cfg, opts = {}) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`未知 agent: ${name}`);
  const target = resolvePath(name, cfg, opts);
  if (!target) return { adapter: name, path: null, registered: null };
  const doc = readJson(target);
  const e = doc && doc[a.serverKey] && doc[a.serverKey][cfg.server.name];
  return { adapter: name, label: a.label, path: target, registered: !!e, entry: e || null };
}

export function listAdapters() {
  return Object.keys(ADAPTERS).map((k) => ({ id: k, label: ADAPTERS[k].label, defaultPath: ADAPTERS[k].defaultPath({}) }));
}

export default { ADAPTERS, register, unregister, inspect, listAdapters, buildEntry };
