# Sub2API 管理 MCP 服务器

Sub2API 本身**没有** MCP 服务器（只有分组里的 `mcp_xml_inject` 协议适配开关），
本目录用它的 `/api/v1` 管理接口实现了一个 **MCP 服务器**，让 AI 客户端直接管理网关。

- 纯 Python 标准库 ✓ 无需 pip 安装任何包（NAS 上 Python 3.8 即可 ✓）
- stdio 传输，行分隔 JSON-RPC 2.0，协议版本 `2024-11-05`
- 18 个工具：用户 / 余额 / 上游账号 / 分组 / API Key / 用量 / 连通性测试 / 上游模型预览

## 配置（环境变量）

| 变量 | 说明 | 默认 |
|---|---|---|
| `SUB2API_URL` | 网关地址 | `http://127.0.0.1:8080` |
| `SUB2API_EMAIL` | 管理员邮箱（**必填**） | — |
| `SUB2API_PASSWORD` | 管理员密码（**必填**） | — |
| `SUB2API_VERIFY_TLS` | https 证书校验 | `1` |

## 工具清单（18 个）

| 工具 | 作用 |
|---|---|
| `sub2api_status` | 网关状态（healthz + 管理 API + 仪表盘统计） |
| `list_users` / `get_user` | 用户列表（分页/搜索）/ 用户详情 |
| `create_user` / `update_user` | 创建 / 更新用户（邮箱、用户名、角色、状态、备注） |
| `set_user_balance` | 设置或调整余额（`operation: set\|add`） |
| `list_accounts` / `create_account` / `update_account` / `delete_account` | 上游账号增删改查 |
| `bind_account_group` | 把上游账号绑定到分组 |
| `list_groups` / `create_group` | 分组查询 / 创建 |
| `list_api_keys` / `create_api_key` | API Key 查询 / 创建 |
| `get_usage` | 用量统计（今日成本、RPM、活跃用户、token 用量…） |
| `chat_completion` | 经网关发一次对话（测上游连通性） |
| `sync_upstream_models` | 预览上游账号真实模型列表 |

## 在 DSH / Claude Desktop 里注册

**DSH**（`~/.dsh/...` 的 MCP 配置，或 settings 里的 mcpServers）：
```json
{
  "mcpServers": {
    "sub2api-admin": {
      "command": "python3",
      "args": ["/volume10/DeepSeekHarness/mcp/sub2api_mcp.py"],
      "env": {
        "SUB2API_URL": "http://127.0.0.1:8080",
        "SUB2API_EMAIL": "admin@sa6400.local",
        "SUB2API_PASSWORD": "你的管理员密码"
      }
    }
  }
}
```

**Claude Desktop**（`claude_desktop_config.json`）同上格式 ✓

## 手动调试

```bash
export SUB2API_URL=http://127.0.0.1:8080
export SUB2API_EMAIL=admin@sa6400.local
export SUB2API_PASSWORD='...'
./sub2api_mcp.py
# 然后逐行输入 JSON-RPC：
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
# {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
# {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_users","arguments":{"page_size":5}}}
```

自动化测试：
```bash
python3 test_mcp.py     # 覆盖 initialize / tools/list / 6 个工具调用 / 错误处理
```

## 安全提示 ⚠️

- 该 MCP 用**管理员账号**操作网关 → 请只在受信环境注册 ✓
- 密码通过**环境变量**传入 ✓ 不要写进配置文件明文提交 ✗
- 建议给 MCP 单独建一个管理员账号（而非日常账号）✓ 便于审计与随时吊销 ✓

---

# Node.js 版（推荐）✓

Sub2API 的管理 MCP 也有 **Node.js 实现**（纯标准库，无 npm 依赖）：

```
sub2api_mcp.js           Node 版 MCP 服务器（18 个工具，与 Python 版一致）
mcp.config.example.json  配置模板（注册参数全部配置化 ✓）
mcp.config.json          你的实际配置（含密码 → 权限 600 ✓ 不要提交）
gen-mcp-config.js        注册配置生成器（从 config 读参数 → 输出/写入客户端配置）
test_mcp.js              Node 测试客户端
```

## 配置化 ✓（你要的"注册参数配置化"）

所有注册参数都来自 `mcp.config.json`，**代码里不写死** ✓：

```json
{
  "sub2api": { "url": "...", "email": "...", "password": "...", "verifyTls": true, "timeoutMs": 30000 },
  "server":  { "name": "sub2api-admin", "version": "1.0.0",
               "enableWriteTools": true, "enableDeleteTools": true },
  "runtime": { "node": "/var/packages/DeepSeekHarness-NAS/target/bin/node" },
  "clients": {
    "dsh":           { "configPath": "~/.dsh/mcp.json" },
    "claudeDesktop": { "configPath": "~/Library/Application Support/Claude/claude_desktop_config.json" }
  }
}
```

优先级：**环境变量 > mcp.config.json > 内置默认**
- `SUB2API_URL` / `SUB2API_EMAIL` / `SUB2API_PASSWORD` / `SUB2API_VERIFY_TLS`
- `MCP_CONFIG`（指定配置文件）/ `MCP_ENABLE_WRITE` / `MCP_ENABLE_DELETE`（工具开关）

## 生成注册配置 ✓

```bash
cp mcp.config.example.json mcp.config.json && chmod 600 mcp.config.json
vi mcp.config.json          # 填 url / email / password / node 路径

node gen-mcp-config.js                  # 打印注册 JSON（密码打码 ✓）
node gen-mcp-config.js --show-secrets   # 打印含密码版（真正粘贴用）
node gen-mcp-config.js --write-dsh      # 直接写入 DSH 配置（自动备份 ✓）
node gen-mcp-config.js --write-claude   # 直接写入 Claude Desktop（自动备份 ✓）
```

生成结果形如：

```json
{
  "mcpServers": {
    "sub2api-admin": {
      "command": "/var/packages/DeepSeekHarness-NAS/target/bin/node",
      "args": ["/volume10/DeepSeekHarness/mcp/sub2api_mcp.js"],
      "env": { "SUB2API_URL": "http://127.0.0.1:8080",
               "SUB2API_EMAIL": "admin@sa6400.local",
               "SUB2API_PASSWORD": "..." }
    }
  }
}
```

## 工具开关 ✓

- `server.enableWriteTools: false` → 隐藏 8 个写工具（create_user / update_user / set_user_balance / create_account / update_account / bind_account_group / create_group / create_api_key）
- `server.enableDeleteTools: false` → 隐藏 delete_account
- 只读场景建议两个都设 false ✓（AI 只能看不能改 ✓）

## 测试 ✓

```bash
node test_mcp.js     # 实测通过：initialize / 18 工具 / status / list_users / list_accounts / chat_completion / get_usage / 错误处理
```
