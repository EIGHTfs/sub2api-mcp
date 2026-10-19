/**
 * 把 sub2api MCP 注册给 DSH —— 自包含（不依赖跨包 CLI ✗）：
 *   ① DSH MCP 注入 API（ctx.mcp）→ 直接调 ✓
 *   ② 自己写 <DSH_HOME>/mcp.json（备份 ✓ 幂等 ✓ 凭据进 env ✓）
 *   ③ 不行 → 返回可执行命令 ✓
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME = 'sub2api';

export function dshHome(ctx) {
  try {
    const h = (ctx && (ctx.home || (ctx.env && ctx.env.DSH_HOME))) || process.env.DSH_HOME || '';
    if (h) return String(h);
  } catch { /* ignore */ }
  return path.join(os.homedir(), '.dsh');
}

/** MCP 服务器入口（核心包；优先环境变量，其次常见位置 ✓） */
export function resolveMcpCli() {
  const cands = [
    process.env.SUB2API_MCP_CLI,
    path.join(dshHome(null), 'sub2api-mcp', 'src', 'cli.js'),
    '/volume10/DeepSeekHarness/projects/sub2api-mcp/packages/sub2api-mcp/src/cli.js',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return cands[0];
}

/** 生成 mcpServers 条目（含凭据 env ✓） */
export function buildEntry(ctx, creds) {
  const env = { MCP_TOOL_PROFILE: process.env.MCP_TOOL_PROFILE || 'readonly' };
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
