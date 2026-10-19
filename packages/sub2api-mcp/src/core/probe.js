/**
 * 上游账号探活 —— 走网关自己的真实探活接口：
 *   POST /api/v1/admin/accounts/:id/test
 *   → 网关用该账号的凭据真发一次 /v1/chat/completions，SSE 流式返回
 *   → 事件: {type:'test_start',model} / {type:'status',text} / {type:'content',text} / 错误事件
 *
 * 为什么不用"直连上游"：网关 API **不下发上游 api_key** ✗（安全设计），
 * 客户端拿不到密钥 → 只能让网关自己测 ✓
 *
 * 只读语义：不改账号配置；会产生一次极小的测试调用（网关上记在探活账上）
 */
import { httpRequest } from './client.js';

/** 解析 SSE 文本 → 事件数组 */
export function parseSse(raw) {
  const events = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { events.push(JSON.parse(payload)); } catch { /* 忽略非 JSON */ }
  }
  return events;
}

/** 从事件里归纳探活结果 */
export function summarizeEvents(events) {
  const start = events.find((e) => e && e.type === 'test_start') || {};
  const errEv = events.find((e) => e && (e.type === 'error' || e.type === 'test_error' || e.error));
  const content = events.filter((e) => e && e.type === 'content').map((e) => e.text || '').join('');
  const statusTexts = events.filter((e) => e && e.type === 'status').map((e) => e.text || '');
  return {
    ok: !errEv && !!content,
    model: start.model || null,
    reply: content.slice(0, 120),
    status: statusTexts.join(' / ').slice(0, 160) || null,
    error: errEv ? (errEv.message || errEv.error || JSON.stringify(errEv)).slice(0, 200) : null,
  };
}

/** 探活单个账号（token 由调用方给 ✓） */
export async function probeAccount(client, accountId, { timeoutMs = 90000 } = {}) {
  const t0 = Date.now();
  const r = await httpRequest({
    method: 'POST',
    url: client.url + '/api/v1/admin/accounts/' + Number(accountId) + '/test',
    body: {},
    token: await client.login(),
    timeoutMs,
    verifyTls: client.verifyTls !== false,
  });
  const latencyMs = Date.now() - t0;
  if (r.status !== 200) {
    const msg = (r.body && (r.body.message || r.body.error)) || '';
    return { id: Number(accountId), ok: false, latencyMs, http: r.status, error: 'HTTP ' + r.status + (msg ? ': ' + String(msg).slice(0, 160) : ''), model: null, reply: '', status: null };
  }
  const raw = (r.body && typeof r.body === 'object' && r.body.raw) ? r.body.raw : '';
  const s = summarizeEvents(parseSse(raw));
  return { id: Number(accountId), ok: s.ok, latencyMs, http: 200, model: s.model, reply: s.reply, status: s.status, error: s.error };
}

/** 并发探活多个账号（默认并发 2，避免同时打满上游 ✓） */
export async function probeAccounts(client, accounts, { timeoutMs = 90000, concurrency = 2 } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const a = list[i++];
      let probe;
      try { probe = await probeAccount(client, a.id, { timeoutMs }); }
      catch (e) { probe = { id: a.id, ok: false, latencyMs: null, http: 0, error: String((e && e.message) || e) }; }
      results.push({
        id: a.id, name: a.name, platform: a.platform, type: a.type,
        status: a.status, schedulable: a.schedulable, priority: a.priority,
        gatewayError: a.error_message || null,
        lastUsedAt: a.last_used_at || null,
        hasApiKey: !!((a.credentials_status || {}).has_api_key),
        probe,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  results.sort((x, y) => Number(x.id) - Number(y.id));
  const ok = results.filter((r) => r.probe && r.probe.ok).length;
  return { total: results.length, ok, failed: results.length - ok, accounts: results };
}

export default { probeAccount, probeAccounts, parseSse, summarizeEvents };
