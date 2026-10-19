#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sub2api_mcp.py — 把 Sub2API 的管理 API 包成 MCP 服务器（纯标准库，无第三方依赖）

为什么有它：Sub2API 自身**没有** MCP 服务器（只有 mcp_xml_inject 那个协议适配开关），
所以这里用它的 /api/v1 管理接口实现一个 MCP，让 AI 客户端（DSH / Claude Desktop 等）
能直接管理网关：用户、余额、上游账号、分组、API Key、用量、连通性测试。

传输：stdio，行分隔 JSON-RPC 2.0（MCP 规范）。
协议版本：2024-11-05（兼容主流客户端）。

配置（环境变量）：
  SUB2API_URL      默认 http://127.0.0.1:8080
  SUB2API_EMAIL    管理员邮箱（必填）
  SUB2API_PASSWORD 管理员密码（必填）
  SUB2API_VERIFY_TLS  默认 1

用法（手动调试）：
  SUB2API_EMAIL=... SUB2API_PASSWORD=... ./sub2api_mcp.py
  然后往 stdin 逐行发 JSON-RPC。
"""
import json
import os
import sys
import ssl
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "sub2api-admin"
SERVER_VERSION = "1.0.0"


# ────────────────────────── Sub2API 客户端 ──────────────────────────
class Sub2API(object):
    def __init__(self):
        self.base = (os.environ.get("SUB2API_URL") or "http://127.0.0.1:8080").rstrip("/")
        self.email = os.environ.get("SUB2API_EMAIL") or ""
        self.password = os.environ.get("SUB2API_PASSWORD") or ""
        self.verify_tls = (os.environ.get("SUB2API_VERIFY_TLS") or "1") not in ("0", "false", "False")
        self._token = None

    def _ctx(self):
        if self.base.startswith("https") and not self.verify_tls:
            c = ssl.create_default_context()
            c.check_hostname = False
            c.verify_mode = ssl.CERT_NONE
            return c
        return None

    def _http(self, method, path, body=None, token=None, timeout=30):
        url = self.base + path
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ctx()) as r:
                raw = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw) if raw.strip() else {}
            except ValueError:
                parsed = {"raw": raw[:500]}
            return e.code, parsed
        except Exception as e:  # noqa: BLE001
            return 0, {"error": str(e)}

    def login(self, force=False):
        if self._token and not force:
            return self._token
        if not self.email or not self.password:
            raise RuntimeError("缺少 SUB2API_EMAIL / SUB2API_PASSWORD 环境变量")
        st, body = self._http("POST", "/api/v1/auth/login",
                              {"email": self.email, "password": self.password})
        data = (body or {}).get("data") or {}
        tok = data.get("access_token") or data.get("token")
        if st != 200 or not tok:
            raise RuntimeError("登录失败 HTTP %s: %s" % (st, json.dumps(body, ensure_ascii=False)[:300]))
        self._token = tok
        return tok

    def api(self, method, path, body=None, timeout=30):
        tok = self.login()
        st, resp = self._http(method, path, body, tok, timeout)
        if st == 401:                      # token 过期/被撤销 → 重登一次
            tok = self.login(force=True)
            st, resp = self._http(method, path, body, tok, timeout)
        return st, resp


CLIENT = Sub2API()


def _ok(payload):
    return {"content": [{"type": "text",
                         "text": json.dumps(payload, ensure_ascii=False, indent=2)}]}


def _err(msg):
    return {"content": [{"type": "text", "text": "ERROR: " + str(msg)}], "isError": True}


def _q(**kw):
    return urllib.parse.urlencode({k: v for k, v in kw.items() if v is not None})


# ────────────────────────── 工具实现 ──────────────────────────
def t_status(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/dashboard/stats")
    # healthz 返回的是 HTML（SPA 兜底）→ 只取状态码 ✓ 不能当 JSON 解析 ✗
    st2 = 0
    try:
        req = urllib.request.Request(CLIENT.base + "/healthz", headers={"Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=10, context=CLIENT._ctx()) as r:
            st2 = r.status
    except urllib.error.HTTPError as e:
        st2 = e.code
    except Exception:
        st2 = 0
    return _ok({"gateway": CLIENT.base, "healthz_http": st2,
                "admin_api_http": st, "dashboard": body.get("data") if isinstance(body, dict) else body})


def t_list_users(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/users?" + _q(page=a.get("page", 1), page_size=a.get("page_size", 20),
                                                            search=a.get("search")))
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_get_user(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/users/%s" % int(a["user_id"]))
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_create_user(a):
    payload = {"email": a["email"], "password": a["password"],
               "username": a.get("username") or a["email"].split("@")[0],
               "role": a.get("role") or "user"}
    st, body = CLIENT.api("POST", "/api/v1/admin/users", payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_update_user(a):
    payload = {k: a[k] for k in ("email", "username", "role", "status", "notes") if a.get(k) is not None}
    st, body = CLIENT.api("PUT", "/api/v1/admin/users/%s" % int(a["user_id"]), payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_set_balance(a):
    payload = {"balance": float(a["balance"]), "operation": a.get("operation") or "set"}
    st, body = CLIENT.api("POST", "/api/v1/admin/users/%s/balance" % int(a["user_id"]), payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_list_accounts(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/accounts?" + _q(page=a.get("page", 1), page_size=a.get("page_size", 50)))
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_create_account(a):
    payload = {"name": a["name"], "platform": a.get("platform") or "opencode_go",
               "type": a.get("type") or "apikey", "credentials": a.get("credentials") or {}}
    st, body = CLIENT.api("POST", "/api/v1/admin/accounts", payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_update_account(a):
    payload = {k: a[k] for k in ("name", "status", "schedulable", "priority", "concurrency", "credentials") if a.get(k) is not None}
    st, body = CLIENT.api("PUT", "/api/v1/admin/accounts/%s" % int(a["account_id"]), payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_delete_account(a):
    st, body = CLIENT.api("DELETE", "/api/v1/admin/accounts/%s" % int(a["account_id"]))
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_bind_account_group(a):
    st, body = CLIENT.api("PUT", "/api/v1/admin/accounts/%s" % int(a["account_id"]),
                          {"group_ids": [int(a["group_id"])]})
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_list_groups(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/groups")
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_create_group(a):
    payload = {"name": a["name"], "platform": a.get("platform") or "composite"}
    st, body = CLIENT.api("POST", "/api/v1/admin/groups", payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_list_api_keys(a):
    st, body = CLIENT.api("GET", "/api/v1/keys?" + _q(page=a.get("page", 1), page_size=a.get("page_size", 50)))
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_create_api_key(a):
    payload = {"name": a["name"]}
    if a.get("group_id") is not None:
        payload["group_id"] = int(a["group_id"])
    st, body = CLIENT.api("POST", "/api/v1/keys", payload)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_usage(a):
    st, body = CLIENT.api("GET", "/api/v1/admin/dashboard/stats")
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


def t_chat(a):
    key = a.get("api_key")
    if not key:
        st, body = CLIENT.api("GET", "/api/v1/keys?page=1&page_size=1")
        items = ((body.get("data") or {}).get("items") or []) if isinstance(body, dict) else []
        if not items:
            return _err("没有可用的 API Key，请先 create_api_key 或传 api_key 参数")
        key = items[0]["key"]
    payload = {"model": a["model"],
               "messages": a.get("messages") or [{"role": "user", "content": a.get("prompt") or "say OK"}],
               "max_tokens": int(a.get("max_tokens") or 32)}
    st, body = CLIENT._http("POST", "/v1/chat/completions", payload, token=key, timeout=120)
    return _ok({"http": st, "data": body})


def t_sync_models(a):
    payload = {"platform": a.get("platform") or "opencode_go", "type": a.get("type") or "apikey",
               "api_key": a.get("api_key")}
    st, body = CLIENT.api("POST", "/api/v1/admin/accounts/models/sync-upstream-preview", payload, timeout=90)
    return _ok({"http": st, "data": body.get("data") if isinstance(body, dict) else body})


TOOLS = [
    ("sub2api_status", "查看 Sub2API 网关状态（healthz + 管理 API + 仪表盘统计）",
     {}, t_status),
    ("list_users", "列出用户（分页/搜索）",
     {"page": {"type": "integer"}, "page_size": {"type": "integer"}, "search": {"type": "string"}}, t_list_users),
    ("get_user", "查看单个用户详情", {"user_id": {"type": "integer"}}, t_get_user),
    ("create_user", "创建用户", {"email": {"type": "string"}, "password": {"type": "string"},
                             "username": {"type": "string"}, "role": {"type": "string"}}, t_create_user),
    ("update_user", "更新用户（邮箱/用户名/角色/状态/备注）",
     {"user_id": {"type": "integer"}, "email": {"type": "string"}, "username": {"type": "string"},
      "role": {"type": "string"}, "status": {"type": "string"}, "notes": {"type": "string"}}, t_update_user),
    ("set_user_balance", "设置/调整用户余额（operation: set|add）",
     {"user_id": {"type": "integer"}, "balance": {"type": "number"}, "operation": {"type": "string"}}, t_set_balance),
    ("list_accounts", "列出上游账号", {"page": {"type": "integer"}, "page_size": {"type": "integer"}}, t_list_accounts),
    ("create_account", "创建上游账号",
     {"name": {"type": "string"}, "platform": {"type": "string"}, "type": {"type": "string"},
      "credentials": {"type": "object"}}, t_create_account),
    ("update_account", "更新上游账号（名称/状态/可调度/优先级/并发/凭据）",
     {"account_id": {"type": "integer"}, "name": {"type": "string"}, "status": {"type": "string"},
      "schedulable": {"type": "boolean"}, "priority": {"type": "integer"},
      "concurrency": {"type": "integer"}, "credentials": {"type": "object"}}, t_update_account),
    ("delete_account", "删除上游账号", {"account_id": {"type": "integer"}}, t_delete_account),
    ("bind_account_group", "把上游账号绑定到分组",
     {"account_id": {"type": "integer"}, "group_id": {"type": "integer"}}, t_bind_account_group),
    ("list_groups", "列出分组", {}, t_list_groups),
    ("create_group", "创建分组", {"name": {"type": "string"}, "platform": {"type": "string"}}, t_create_group),
    ("list_api_keys", "列出 API Key", {"page": {"type": "integer"}, "page_size": {"type": "integer"}}, t_list_api_keys),
    ("create_api_key", "创建 API Key", {"name": {"type": "string"}, "group_id": {"type": "integer"}}, t_create_api_key),
    ("get_usage", "查看用量/统计", {}, t_usage),
    ("chat_completion", "通过网关发起一次对话（测试上游连通性）",
     {"model": {"type": "string"}, "prompt": {"type": "string"}, "api_key": {"type": "string"},
      "max_tokens": {"type": "integer"}, "messages": {"type": "array"}}, t_chat),
    ("sync_upstream_models", "预览某个上游账号的真实模型列表",
     {"platform": {"type": "string"}, "type": {"type": "string"}, "api_key": {"type": "string"}}, t_sync_models),
]
TOOL_MAP = {n: (d, s, f) for n, d, s, f in TOOLS}


# ────────────────────────── MCP 协议（stdio JSON-RPC）──────────────────────────
def respond(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(req):
    method = req.get("method") or ""
    rid = req.get("id")
    params = req.get("params") or {}

    if method == "initialize":
        return respond({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}}})
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "ping":
        return respond({"jsonrpc": "2.0", "id": rid, "result": {}})
    if method == "tools/list":
        tools = [{"name": n, "description": d,
                  "inputSchema": {"type": "object", "properties": s,
                                  "required": [k for k in s if k in ("email", "password", "name", "model", "user_id", "account_id", "group_id", "balance")]}}
                 for n, d, s, _ in TOOLS]
        return respond({"jsonrpc": "2.0", "id": rid, "result": {"tools": tools}})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name not in TOOL_MAP:
            return respond({"jsonrpc": "2.0", "id": rid,
                            "error": {"code": -32601, "message": "unknown tool: %s" % name}})
        try:
            result = TOOL_MAP[name][2](args)
        except Exception as e:  # noqa: BLE001
            result = _err(e)
        return respond({"jsonrpc": "2.0", "id": rid, "result": result})
    # 未知方法
    if rid is not None:
        return respond({"jsonrpc": "2.0", "id": rid,
                        "error": {"code": -32601, "message": "method not found: %s" % method}})
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            respond({"jsonrpc": "2.0", "id": None,
                     "error": {"code": -32700, "message": "parse error"}})
            continue
        try:
            handle(req)
        except Exception as e:  # noqa: BLE001
            if req.get("id") is not None:
                respond({"jsonrpc": "2.0", "id": req["id"],
                         "error": {"code": -32603, "message": str(e)}})


if __name__ == "__main__":
    main()
