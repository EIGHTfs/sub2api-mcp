/** 零依赖 HTTP 客户端（宿主侧探测用 ✓ 不抛网络异常 ✗） */
import http from 'node:http';
import https from 'node:https';

export function httpRequest({ method = 'GET', url, body, token, timeoutMs = 8000, verifyTls = true }) {
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
        try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { parsed = { raw: raw.slice(0, 500) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: { error: String((e && e.message) || e) } }));
    if (data) req.write(data);
    req.end();
  });
}

export default httpRequest;
