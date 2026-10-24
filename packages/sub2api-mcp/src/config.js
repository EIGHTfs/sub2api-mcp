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

/**
 * 默认工具档位（单一真相 ✓）
 *
 * 为什么收敛到一处：这里曾默认 `readwrite`，而插件侧与文档都宣称 `readonly` ⇒
 * 同一份 mcp.json 经 CLI 直接跑会拿到可写档，与「默认只读最安全」的承诺相反 ✗
 * 现在核心包定义常量，插件包（packages/dsh-plugin-sub2api）import 它，
 * 文档里的档位表述由 scripts/gen-tool-counts.mjs 从代码派生 ✓
 *
 * 为什么默认 readonly：MCP 是给 AI 用的，默认只读最安全（AI 只能看不能改）；
 * 需要写权限的人显式设 readwrite / full。
 */
export const DEFAULT_TOOL_PROFILE = 'readonly';

/** 三档工具权限：readonly | readwrite | full */
export function resolveToolProfile(raw) {
  const v = String(raw || '').toLowerCase();
  if (['readonly', 'read', 'ro'].includes(v)) return 'readonly';
  if (['full', 'all', 'admin'].includes(v)) return 'full';
  return 'readwrite';   // 未识别值的中性兜底（不是默认档位 ✗ 默认档位见 DEFAULT_TOOL_PROFILE）
}

export function loadConfig(explicitPath) {
  const { path: cfgPath, data } = readConfigFile(explicitPath);
  const s = data.sub2api || {};
  const srv = data.server || {};
  const env = process.env;
  // 默认档位取单一常量（env > 配置文件 > DEFAULT_TOOL_PROFILE ✓）
  const profile = resolveToolProfile(env.MCP_TOOL_PROFILE || srv.toolProfile || DEFAULT_TOOL_PROFILE);
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
      version: srv.version || '0.1.2',
      toolProfile: profile,
    },
    registry: data.registry || {},
  };
}

export { PKG_ROOT, CONFIG_NAME };
