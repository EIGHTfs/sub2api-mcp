/**
 * 凭据存储（宿主侧）—— 落 <DSH_HOME>/sub2api-credentials.json（600 ✓）
 * 客户端设置页通过宿主路由 POST 进来 ✓，宿主据此生成 mcp.json 的 env ✓
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { httpRequest } from './http.js';

export const CRED_FILE = 'sub2api-credentials.json';
export const DEFAULT_URL = 'http://127.0.0.1:8080';

export function dshHome(_ctx) {
  // 只用环境变量：ctx.home / ctx.env 是 cordis 服务，未 inject 就访问会抛
  // "cannot get property \"home\" without inject" ✗（2026-10-19 实测，勿改回去）
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

export function credPath(ctx) { return path.join(dshHome(ctx), CRED_FILE); }

/** 读凭据（不存在/损坏 → null ✓ 不抛 ✗） */
export function readCredentials(ctx) {
  try {
    const p = credPath(ctx);
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d && d.email ? { url: String(d.url || DEFAULT_URL), email: String(d.email), password: String(d.password || '') } : null;
  } catch { return null; }
}

/** 写凭据（600 ✓ 原子写 ✓） */
export function writeCredentials(ctx, creds) {
  const p = credPath(ctx);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ url: creds.url, email: creds.email, password: creds.password }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
  return p;
}

/** 探测网关：healthz + 登录 + 仪表盘统计（失败返回 {ok:false, error} ✓） */
export async function probeGateway(creds, timeoutMs = 8000) {
  const url = String(creds.url || DEFAULT_URL).replace(/\/+$/, '');
  const health = await httpRequest({ method: 'GET', url: url + '/healthz', timeoutMs });
  const login = await httpRequest({
    method: 'POST', url: url + '/api/v1/auth/login',
    body: { email: creds.email, password: creds.password }, timeoutMs,
  });
  const tok = (login.body && login.body.data && (login.body.data.access_token || login.body.data.token)) || '';
  if (login.status !== 200 || !tok) {
    return { ok: false, healthz: health.status, error: '登录失败 HTTP ' + login.status + ': ' + JSON.stringify(login.body).slice(0, 200) };
  }
  const stats = await httpRequest({ method: 'GET', url: url + '/api/v1/admin/dashboard/stats', token: tok, timeoutMs });
  const accounts = await httpRequest({ method: 'GET', url: url + '/api/v1/admin/accounts?page=1&page_size=1', token: tok, timeoutMs });
  const d = (stats.body && stats.body.data) || {};
  const acc = (accounts.body && accounts.body.data) || {};
  return {
    ok: true, healthz: health.status,
    accounts: (acc.items || []).length > 0 ? (acc.total != null ? acc.total : (acc.items || []).length) : 0,
    activeUsers: d.active_users, normalAccounts: d.normal_accounts, errorAccounts: d.error_accounts,
    todayCost: d.today_actual_cost, rpm: d.rpm, activeKeys: d.active_api_keys,
  };
}

export default { CRED_FILE, DEFAULT_URL, dshHome, credPath, readCredentials, writeCredentials, probeGateway };
