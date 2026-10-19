#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_mcp.py — 用 stdio 模拟 MCP 客户端，验证 sub2api_mcp.py 全链路"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = dict(os.environ)
ENV.setdefault("SUB2API_URL", "http://127.0.0.1:8080")
ENV.setdefault("SUB2API_EMAIL", "admin@sa6400.local")
ENV.setdefault("SUB2API_PASSWORD", "")   # 必须用环境变量提供 ✓ 不硬编码 ✗

proc = subprocess.Popen([sys.executable, os.path.join(HERE, "sub2api_mcp.py")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        env=ENV, text=True, bufsize=1)
_id = [0]

def rpc(method, params=None, notify=False):
    _id[0] += 1
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None: msg["params"] = params
    if not notify: msg["id"] = _id[0]
    proc.stdin.write(json.dumps(msg) + "\n"); proc.stdin.flush()
    if notify: return None
    line = proc.stdout.readline()
    return json.loads(line) if line.strip() else None

def call(name, args=None):
    r = rpc("tools/call", {"name": name, "arguments": args or {}})
    res = (r or {}).get("result") or {}
    txt = ""
    for c in (res.get("content") or []):
        if c.get("type") == "text": txt += c.get("text") or ""
    return res.get("isError", False), txt

print("═══ ① initialize ═══")
r = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
print("  protocolVersion:", r["result"]["protocolVersion"], "| server:", r["result"]["serverInfo"]["name"], r["result"]["serverInfo"]["version"])
rpc("notifications/initialized", notify=True)

print("═══ ② tools/list ═══")
r = rpc("tools/list", {})
tools = r["result"]["tools"]
print("  工具数:", len(tools))
print("  前 6 个:", [t["name"] for t in tools[:6]])

print("═══ ③ tools/call: sub2api_status ═══")
err, txt = call("sub2api_status")
print("  isError:", err)
print("  " + txt.replace("\n", "\n  ")[:600])

print("═══ ④ tools/call: list_users ═══")
err, txt = call("list_users", {"page_size": 5})
print("  isError:", err)
d = json.loads(txt) if txt.startswith("{") else {}
users = ((d.get("data") or {}).get("items") or [])
print("  用户数:", len(users))
for u in users[:3]:
    print("   -", u.get("id"), u.get("email"), u.get("role"), "balance=", u.get("balance"))

print("═══ ⑤ tools/call: list_accounts ═══")
err, txt = call("list_accounts")
d = json.loads(txt) if txt.startswith("{") else {}
accs = ((d.get("data") or {}).get("items") or [])
print("  isError:", err, "| 账号数:", len(accs))
for a in accs:
    print("   -", a.get("id"), (a.get("name") or "")[:34], a.get("platform"), a.get("status"), "prio=", a.get("priority"))

print("═══ ⑥ tools/call: chat_completion（deepseek-v4-flash ✓）═══")
err, txt = call("chat_completion", {"model": "deepseek-v4-flash", "prompt": "reply exactly: OK", "max_tokens": 16})
print("  isError:", err)
try:
    d = json.loads(txt)
    body = d.get("data") or {}
    if "choices" in body:
        print("  ✓ 回复:", repr((((body.get("choices") or [{}])[0].get("message") or {}).get("content") or "")[:40]), "| http:", d.get("http"))
    else:
        print("  ", json.dumps(d, ensure_ascii=False)[:300])
except Exception:
    print("  ", txt[:300])

print("═══ ⑦ tools/call: get_usage ═══")
err, txt = call("get_usage")
print("  isError:", err, "| 前 200 字符:", txt[:200].replace("\n", " "))

print("═══ ⑧ 错误处理（未知工具 ✓）═══")
r = rpc("tools/call", {"name": "not_exist_tool", "arguments": {}})
print("  error:", (r or {}).get("error"))

proc.stdin.close()
proc.terminate()
print("═══ 测试结束 ═══")
