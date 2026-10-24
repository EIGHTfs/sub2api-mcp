/**
 * dsh-plugin-sub2api —— 宿主面（Cordis 插件）
 *
 * 职责：
 *   1. 能力自检（声明支持所有版本 ✓ 内部判定真实支持度 ✓ 降级不崩 ✗）
 *   2. 注册设置页用的本地路由（webserver.register ✓ 同源 fetch ✓ 无需 CORS）
 *        GET  /dsh-plugin-sub2api/status       → 读凭据（脱敏）+ 探测网关
 *        POST /dsh-plugin-sub2api/credentials  → 存凭据（600）+ 重建 mcp.json
 *   3. 自动把 sub2api MCP 注册到 <DSH_HOME>/mcp.json（自包含 ✓）
 *   4. 卸载/禁用时清理 ✓
 */
import { detectCapabilities, summarize } from './capabilities.js';
import { registerToDsh, unregisterFromDsh, writeMcpConfig, buildEntry } from './register.js';
import { readCredentials, writeCredentials, probeGateway, credPath } from './credentials.js';
// 档位常量从 profile.js 单一来源引入（不要在本文件里再写 'readonly' 字面量 ✗）
// 再导出只为给外部一个稳定出口；register.js 直接 import ./profile.js，不经这里（避免循环引用 ✗）
import { PROFILES, DEFAULT_TOOL_PROFILE, isProfile } from './profile.js';
export { PROFILES, DEFAULT_TOOL_PROFILE, isProfile };
import fs from 'node:fs';
import path from 'node:path';

/** 落文件日志（start.sh 包装后 stdout 可能丢 ✗ → 诊断用这个 ✓） */
function fileLog(ctx, msg) {
  try {
    // 只用环境变量（ctx.home 是 cordis 服务，未 inject 访问会抛 ✗）
    const home = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) || '.';
    const line = new Date().toISOString() + ' ' + msg + '\n';
    const cands = [path.join(home, 'dsh-plugin-sub2api.log'), '/tmp/dsh-plugin-sub2api.log'];
    for (const f of cands) { try { fs.appendFileSync(f, line); return; } catch { /* 试下一个 */ } }
  } catch { /* ignore */ }
}

export const name = 'dsh-plugin-sub2api';

/** 需要 webserver 才能注册设置页用的本地路由 ✓（DSH 一定有 ✓） */
export const inject = ['webServer'];   // 注意：服务名是驼峰 webServer ✓（不是 webserver ✗）

const ROUTE_PREFIX = '/dsh-plugin-sub2api';

function sendJson(res, status, obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { /* 响应已结束 */ }
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

/** 工具档位（readonly | readwrite | full）—— 存 <DSH_HOME>/sub2api-settings.json ✓ */
// PROFILES / DEFAULT_TOOL_PROFILE 现在从 ./profile.js 单一来源引入 ✓
/**
 * 安全解析 DSH_HOME：ctx.home 在不同 DSH 版本里可能是字符串、对象或不存在，
 * 直接塞进 path.join 会抛 TypeError（线上 /profile 400 空 body 的根因），所以只认字符串。
 */
function safeHome(_ctx) {
  // 只用环境变量：ctx.home / ctx.env 是 cordis 服务，未 inject 访问会抛
  // "cannot get property \"home\" without inject" ✗（2026-10-19 实测，勿改回去）
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME;
  return '.';
}
function settingsPath(ctx) { return path.join(safeHome(ctx), 'sub2api-settings.json'); }
function readProfile(ctx) {
  try { const d = JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8')); if (PROFILES.includes(d.toolProfile)) return d.toolProfile; } catch { /* 回退 */ }
  try { const e = JSON.parse(fs.readFileSync(path.join(safeHome(ctx), 'mcp.json'), 'utf8')); const p = (((e.mcpServers || {}).sub2api || {}).env || {}).MCP_TOOL_PROFILE; if (PROFILES.includes(p)) return p; } catch { /* 回退 */ }
  return DEFAULT_TOOL_PROFILE;
}
function writeProfile(ctx, p) {
  const f = settingsPath(ctx);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ toolProfile: p }, null, 2) + '\n', { mode: 0o600 });
  return f;
}

function mask(s) { const v = String(s || ''); return v ? v.slice(0, 2) + '***' + v.slice(-2) : ''; }

export function apply(ctx) {
  const log = (m) => { fileLog(ctx, m); try { (ctx.logger?.info || console.log).call(ctx.logger || console, m); } catch { /* ignore */ } };
  let report;
  try { report = detectCapabilities(ctx || {}); log('[sub2api] ' + summarize(report)); }
  catch (e) { report = { level: 'minimal', capabilities: {} }; log('[sub2api] 能力自检异常: ' + ((e && e.message) || e)); }
  try { globalThis.__DSH_PLUGIN_CTX__ = ctx; globalThis.__DSH_PLUGIN_REPORT__ = report; } catch { /* ignore */ }

  // ── 自动注册 MCP（读凭据 → 写 mcp.json ✓）
  try {
    const creds = readCredentials(ctx);
    if (creds) {
      const r = registerToDsh(ctx, report, creds);
      log('[sub2api] MCP 注册: ' + (r.ok ? '已完成（' + r.via + '）' : '未完成 → ' + r.hint));
    } else {
      log('[sub2api] 尚未配置账号密码 —— 请在「设置 → Sub2API」填写，或写 <DSH_HOME>/' + credPath(ctx).split('/').pop());
    }
  } catch (e) { log('[sub2api] MCP 注册异常（已跳过）: ' + ((e && e.message) || e)); }

  // ── 本地路由（设置页用 ✓）—— 等 webserver 服务就绪再注册（关键 ✓）
  const registerRoutes = (wsc) => {
    const ws = wsc || null;
    if (!ws || typeof ws.register !== 'function') {
      log('[sub2api] webserver 不可用 → 设置页保存路由不可用（降级 ✓）；可用 CLI 写 mcp.json');
      return;
    }
    try {
      const dispose = ws.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = String(req.url || '');
          const sub = url.slice(ROUTE_PREFIX.length).split('?')[0] || '/';
          if (req.method === 'GET' && (sub === '/status' || sub === '' || sub === '/')) {
            const creds = readCredentials(ctx);
            // 未配置时也要回档位（否则前端滑块拿不到当前值 ✗）
            if (!creds) return sendJson(res, 200, { configured: false, url: null, email: null, toolProfile: readProfile(ctx), profiles: PROFILES });
            let probe = { ok: false, error: '未探测' };
            try { probe = await probeGateway(creds); } catch (e) { probe = { ok: false, error: String((e && e.message) || e) }; }
            return sendJson(res, 200, { configured: true, url: creds.url, email: creds.email, passwordMasked: mask(creds.password), toolProfile: readProfile(ctx), profiles: PROFILES, probe });
          }
          if (req.method === 'POST' && sub === '/credentials') {
            const body = await readBody(req);
            if (!body || !body.email || !body.password) return sendJson(res, 400, { ok: false, error: '需要 email 与 password' });
            const creds = { url: String(body.url || 'http://127.0.0.1:8080').replace(/\/+$/, ''), email: String(body.email), password: String(body.password) };
            const savedAt = writeCredentials(ctx, creds);
            let wrote = null;
            try { wrote = writeMcpConfig(ctx, buildEntry(ctx, creds)); } catch (e) { /* 记录但不失败 */ }
            let probe = { ok: false, error: '未探测' };
            try { probe = await probeGateway(creds); } catch (e) { probe = { ok: false, error: String((e && e.message) || e) }; }
            log('[sub2api] 凭据已保存：' + savedAt + ' | MCP：' + (wrote && wrote.target ? wrote.target : '失败') + ' | 探测：' + (probe.ok ? 'ok' : probe.error));
            return sendJson(res, 200, { ok: true, savedAt, mcpConfig: wrote && wrote.target, probe });
          }
          if (req.method === 'POST' && sub === '/profile') {
            // 整个分支包 try/catch：任何异常都要回 JSON（否则前端收到空 body 会报
            // "Failed to execute 'json' on 'Response'" ✗）
            try {
              const body = await readBody(req);
              const p = String((body && body.profile) || '');
              if (!PROFILES.includes(p)) return sendJson(res, 400, { ok: false, error: '档位必须是 ' + PROFILES.join(' / ') });
              const settingsFile = writeProfile(ctx, p);
              let wrote = null;
              try {
                const creds = readCredentials(ctx);
                const base = buildEntry(ctx, creds);
                wrote = writeMcpConfig(ctx, { ...base, env: { ...base.env, MCP_TOOL_PROFILE: p } });
              } catch (e) { /* 写 mcp.json 失败不影响档位落盘 */ }
              log('[sub2api] 工具档位已切换: ' + p + ' | settings: ' + settingsFile + ' | mcp.json: ' + (wrote && wrote.target ? '已更新' : '未更新'));
              return sendJson(res, 200, { ok: true, profile: p, settingsFile, mcpConfig: wrote && wrote.target });
            } catch (e) {
              log('[sub2api] 切换档位失败: ' + ((e && e.stack) || e));
              return sendJson(res, 500, { ok: false, error: '切换档位失败: ' + ((e && e.message) || e) });
            }
          }
          if (req.method === 'POST' && sub === '/logout') {
            let removed = false;
            try { fs.unlinkSync(credPath(ctx)); removed = true; } catch { removed = false; }
            try { unregisterFromDsh(ctx); } catch { /* ignore */ }
            log('[sub2api] 已退出登录：删除凭据=' + removed + ' + 移除 mcp.json 条目 ✓');
            return sendJson(res, 200, { ok: true, removed });
          }
          if (req.method === 'POST' && sub === '/probe') {
            const creds = readCredentials(ctx);
            if (!creds) return sendJson(res, 400, { ok: false, error: '尚未配置凭据' });
            let probe = { ok: false };
            try { probe = await probeGateway(creds); } catch (e) { probe = { ok: false, error: String((e && e.message) || e) }; }
            return sendJson(res, 200, { ok: true, probe });
          }
          return sendJson(res, 404, { ok: false, error: 'not found: ' + sub });
        },
      });
      log('[sub2api] 设置页路由已注册: ' + ROUTE_PREFIX + '/{status,credentials,probe}');
      try { if (ctx.on) ctx.on('dispose', () => { try { dispose(); } catch { /* ignore */ } }); } catch { /* ignore */ }
    } catch (e) { log('[sub2api] 路由注册失败（已降级）: ' + ((e && e.message) || e)); }
  };

  // cordis 服务注入回调：webserver 就绪后才注册（版本差异用能力探测兜底 ✓）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (c) => { registerRoutes((c && c.webServer) || (c && c.get && c.get('webServer')) || null); });
      log('[sub2api] 已通过 ctx.inject 等待 webServer 服务 ✓');
    } else {
      registerRoutes((ctx && ctx.webServer) || (ctx && ctx.get && ctx.get('webServer')) || null);
    }
  } catch (e) { log('[sub2api] inject 失败，走即时注册: ' + ((e && e.message) || e)); 
    try { registerRoutes((ctx && ctx.webServer) || (ctx && ctx.get && ctx.get('webServer')) || null); } catch { /* ignore */ } }

  // ── 生命周期清理
  try {
    if (ctx.on) ctx.on('dispose', () => { try { unregisterFromDsh(ctx); } catch { /* ignore */ } });
  } catch { /* ignore */ }
}

export { detectCapabilities, summarize };
export default apply;
