/**
 * 把 sub2api MCP 注册给 DSH —— 自包含（不依赖跨包 CLI ✗）：
 *   ① DSH MCP 注入 API（ctx.mcp）→ 直接调 ✓
 *   ② 自己写 <DSH_HOME>/mcp.json（备份 ✓ 幂等 ✓ 凭据进 env ✓）
 *   ③ 不行 → 返回可执行命令 ✓
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
// 默认档位从 profile.js 单一来源引入（禁止再写 'readonly' 字面量 ✗ 会再次分叉；
// 也不要 import index.js —— 那会构成循环引用 TDZ 风险 ✗）
import { DEFAULT_TOOL_PROFILE } from './profile.js';

const NAME = 'sub2api';

export function dshHome(_ctx) {
  // 只用环境变量：ctx.home / ctx.env 是 cordis 服务，未 inject 就访问会抛
  // "cannot get property \"home\" without inject" ✗（2026-10-19 实测，勿改回去）
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/** 工具档位（存 <DSH_HOME>/sub2api-settings.json ✓ 与 index.js 共用同一份文件） */
const PROFILES = ['readonly', 'readwrite', 'full'];
export function readProfileSetting(ctx) {
  try {
    const f = path.join(dshHome(ctx), 'sub2api-settings.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (PROFILES.includes(d.toolProfile)) return d.toolProfile;
  } catch { /* ignore */ }
  return null;
}

/**
 * MCP 服务器入口（核心包 ✓）—— 用 node 模块解析定位，避免写死路径 ✗：
 *   ① env SUB2API_MCP_CLI（显式覆盖）
 *   ② 依赖解析：sub2api-mcp 的入口 → 同目录 cli.js（npm 装插件时会带上依赖 ✓）
 *   ③ <DSH_HOME>/sub2api-mcp 兜底
 * ⚠️ 不要在这里加「某台机器的绝对路径」兜底：换机/换部署即失效，且会让人误以为
 *    那条路径是权威位置（早期就是这么写的，结果指向一台已经不存在的机器 ✗）
 */
export function resolveMcpCli() {
  const cands = [];
  if (process.env.SUB2API_MCP_CLI) cands.push(process.env.SUB2API_MCP_CLI);
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('sub2api-mcp');                 // .../node_modules/sub2api-mcp/src/index.js
    cands.push(path.join(path.dirname(entry), 'cli.js'));
    cands.push(path.join(path.dirname(path.dirname(entry)), 'src', 'cli.js'));
  } catch { /* 依赖未装上 → 走兜底 */ }
  // 兜底只留「与本插件同机同 DSH_HOME」的相对推导 ✓
  cands.push(path.join(dshHome(null), 'sub2api-mcp', 'src', 'cli.js'));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}

/** 生成 mcpServers 条目（含凭据 env ✓ 档位优先取已保存设置 ✓） */
export function buildEntry(ctx, creds) {
  // 档位来源优先级：显式 env > settings 文件里已保存的档位 > 只读兜底
  const env = { MCP_TOOL_PROFILE: process.env.MCP_TOOL_PROFILE || readProfileSetting(ctx) || DEFAULT_TOOL_PROFILE };
  if (creds && creds.email) {
    env.SUB2API_URL = creds.url || 'http://127.0.0.1:8080';
    env.SUB2API_EMAIL = creds.email;
    if (creds.password) env.SUB2API_PASSWORD = creds.password;
  }
  return { command: process.execPath, args: [resolveMcpCli(), 'serve'], env };
}

export function mcpConfigPath(ctx) {
  return process.env.SUB2API_MCP_CONFIG || path.join(dshHome(ctx), 'mcp.json');
}

/** 写 mcp.json（备份 ✓ 幂等 ✓ 600 ✓） */
export function writeMcpConfig(ctx, entry) {
  const target = mcpConfigPath(ctx);
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { doc = {}; }
  if (!doc || typeof doc !== 'object') doc = {};
  doc.mcpServers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
  doc.mcpServers[NAME] = entry;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backup = null;
  if (fs.existsSync(target)) { backup = target + '.bak.' + Date.now(); fs.copyFileSync(target, backup); }
  fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  return { target, backup, entry };
}

export function registerToDsh(ctx, report, creds) {
  const entry = buildEntry(ctx, creds);
  try {
    const mcp = ctx && ctx.mcp && (ctx.mcp.register || ctx.mcp.addServer) ? ctx.mcp : null;
    if (mcp) { (mcp.register || mcp.addServer).call(mcp, { name: NAME, ...entry }); return { ok: true, via: 'ctx.mcp API' }; }
  } catch { /* 落到 ② */ }
  try {
    const r = writeMcpConfig(ctx, entry);
    return { ok: true, via: 'mcp.json', ...r };
  } catch (e) {
    return { ok: false, hint: '无法写 MCP 配置（' + ((e && e.message) || e) + '）→ 手动：node <sub2api-mcp>/src/cli.js register dsh' };
  }
}

export function unregisterFromDsh(ctx) {
  try {
    const target = mcpConfigPath(ctx);
    const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (doc && doc.mcpServers && doc.mcpServers[NAME]) {
      delete doc.mcpServers[NAME];
      fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    }
    return { ok: true };
  } catch { return { ok: true, skipped: true }; }
}

export default { buildEntry, writeMcpConfig, registerToDsh, unregisterFromDsh, resolveMcpCli, mcpConfigPath };
