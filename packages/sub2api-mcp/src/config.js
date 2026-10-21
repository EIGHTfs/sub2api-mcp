/**
 * 配置解析：环境变量 > 配置文件 > 内置默认
 *
 * 配置文件查找顺序（MCP_CONFIG 可显式指定）：
 *   1. $MCP_CONFIG
 *   2. $PWD/sub2api-mcp.config.json
 *   3. $HOME/.config/sub2api-mcp/config.json
 *   4. <包根>/mcp.config.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_NAME = 'sub2api-mcp.config.json';

export function findConfigPath(explicit) {
  const names = [CONFIG_NAME, 'mcp.config.json', 'sub2api-mcp.config.json'];
  const cands = [
    explicit || process.env.MCP_CONFIG,
    ...names.map((n) => path.join(process.cwd(), n)),
    path.join(os.homedir(), '.config', 'sub2api-mcp', 'config.json'),
    ...names.map((n) => path.join(PKG_ROOT, n)),
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch { /* not found */ } }
  return null;
}

export function readConfigFile(explicit) {
  const p = findConfigPath(explicit);
  if (!p) return { path: null, data: {} };
  try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { throw new Error(`配置文件解析失败 (${p}): ${e.message}`); }
}

const bool = (v, d) => (v === undefined ? d : !(v === '0' || v === 'false' || v === 'False'));

/** 三档工具权限：readonly | readwrite | full */
export function resolveToolProfile(raw) {
  const v = String(raw || '').toLowerCase();
  if (['readonly', 'read', 'ro'].includes(v)) return 'readonly';
  if (['full', 'all', 'admin'].includes(v)) return 'full';
  return 'readwrite';   // 默认
}

export function loadConfig(explicitPath) {
  const { path: cfgPath, data } = readConfigFile(explicitPath);
  const s = data.sub2api || {};
  const srv = data.server || {};
  const env = process.env;
  const profile = resolveToolProfile(env.MCP_TOOL_PROFILE || srv.toolProfile || 'readwrite');
  return {
    configPath: cfgPath,
    sub2api: {
      url: (env.SUB2API_URL || s.url || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
      email: env.SUB2API_EMAIL || s.email || '',
      password: env.SUB2API_PASSWORD || s.password || '',
      verifyTls: bool(env.SUB2API_VERIFY_TLS, s.verifyTls !== false),
      timeoutMs: Number(env.SUB2API_TIMEOUT_MS || s.timeoutMs || 30000),
    },
    server: {
      name: env.MCP_SERVER_NAME || srv.name || 'sub2api',
      version: srv.version || '0.1.1',
      toolProfile: profile,
    },
    registry: data.registry || {},
  };
}

export { PKG_ROOT, CONFIG_NAME };
