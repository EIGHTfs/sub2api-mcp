/**
 * L0 核心契约层：Sub2API 管理 API 客户端
 * —— 不依赖 MCP、不依赖任何 agent 框架，可被任何宿主复用。
 */
import http from 'node:http';
import https from 'node:https';

const DEFAULTS = {
  url: 'http://127.0.0.1:8080',
  email: '',
  password: '',
  verifyTls: true,
  timeoutMs: 30000,
};

/** 发送一次 HTTP 请求（返回 {status, body}，永不抛网络异常） */
export function httpRequest({ method = 'GET', url, body, token, timeoutMs = 30000, verifyTls = true }) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: { error: String(e) } }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''), method, headers,
      rejectUnauthorized: isHttps ? verifyTls : undefined, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { parsed = { raw: raw.slice(0, 800) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', (e) => resolve({ status: 0, body: { error: String((e && e.message) || e) } }));
    if (data) req.write(data);
    req.end();
  });
}

export class Sub2ApiClient {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.url = String(o.url || DEFAULTS.url).replace(/\/+$/, '');
    this.email = o.email || '';
    this.password = o.password || '';
    this.verifyTls = o.verifyTls !== false;
    this.timeoutMs = Number(o.timeoutMs || DEFAULTS.timeoutMs);
    this._token = null;
  }

  /** 登录（带缓存；force=true 强制刷新） */
  async login(force = false) {
    if (this._token && !force) return this._token;
    if (!this.email || !this.password) {
      throw new Error('缺少管理员账号：请设置 SUB2API_EMAIL / SUB2API_PASSWORD，或在配置文件里填 sub2api.email/password');
    }
    const r = await httpRequest({
      method: 'POST', url: this.url + '/api/v1/auth/login',
      body: { email: this.email, password: this.password },
      timeoutMs: this.timeoutMs, verifyTls: this.verifyTls,
    });
    const d = (r.body && r.body.data) || {};
    const tok = d.access_token || d.token;
    if (r.status !== 200 || !tok) {
      throw new Error(`登录失败 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    this._token = tok;
    return tok;
  }

  /** 调用管理 API（401 自动重登一次） */
  async api(method, path, body, timeoutMs) {
    let tok = await this.login();
    let r = await httpRequest({ method, url: this.url + path, body, token: tok, timeoutMs: timeoutMs || this.timeoutMs, verifyTls: this.verifyTls });
    if (r.status === 401) {
      tok = await this.login(true);
      r = await httpRequest({ method, url: this.url + path, body, token: tok, timeoutMs: timeoutMs || this.timeoutMs, verifyTls: this.verifyTls });
    }
    return r;
  }

  /** 直接调网关业务接口（如 /v1/chat/completions，用 API Key 而非管理员 token） */
  async gateway(method, path, body, apiKey, timeoutMs) {
    return httpRequest({ method, url: this.url + path, body, token: apiKey, timeoutMs: timeoutMs || this.timeoutMs, verifyTls: this.verifyTls });
  }

  /** 健康检查（只取状态码） */
  async healthz() {
    const r = await httpRequest({ method: 'GET', url: this.url + '/healthz', timeoutMs: 10000, verifyTls: this.verifyTls });
    return r.status;
  }
}

export default Sub2ApiClient;
