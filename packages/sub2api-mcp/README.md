# sub2api-mcp

**Sub2API 的 MCP 服务器** —— 让任何支持 MCP 的 agent（DSH / Claude Desktop / Claude Code / Cursor / …）
直接管理 Sub2API 网关：用户、余额、上游账号、分组、API Key、用量、连通性测试。

- 纯 Node.js 标准库 ✓ **零运行时依赖** ✓ Node ≥ 18.17 ✓
- 与 agent 无关 ✓（核心层 L0+L1 不依赖任何框架 ✓）
- 工具权限**三档**：`readonly`（8）/ `readwrite`（17）/ `full`（18）✓
- 自带**多 agent 注册器**：一条命令写入对应 agent 的 MCP 配置 ✓

## 安装 / 运行

```bash
# 直接用（无需安装）
npx sub2api-mcp status

# 或全局安装
npm i -g sub2api-mcp
sub2api-mcp serve
```

## 配置

优先级：**环境变量 > 配置文件 > 默认**

| 环境变量 | 说明 |
|---|---|
| `SUB2API_URL` | 网关地址（默认 `http://127.0.0.1:8080`） |
| `SUB2API_EMAIL` / `SUB2API_PASSWORD` | 管理员账号（必填） |
| `SUB2API_VERIFY_TLS` | https 证书校验（默认 1） |
| `MCP_TOOL_PROFILE` | `readonly` / `readwrite` / `full`（默认 readwrite） |
| `MCP_CONFIG` | 配置文件路径 |

配置文件查找顺序：`$MCP_CONFIG` → `./sub2api-mcp.config.json` → `~/.config/sub2api-mcp/config.json` → 包内 `mcp.config.json`
（模板见 `mcp.config.example.json`）

## 命令

```bash
sub2api-mcp serve                     # 作为 stdio MCP 服务器运行（agent 调它）
sub2api-mcp status                    # 自检：healthz / 管理API / 账号数 / 今日成本
sub2api-mcp tools [--profile readonly] # 列出当前档位可用工具
sub2api-mcp config [--show-secrets]    # 打印解析后的配置（默认脱敏）
sub2api-mcp adapters                   # 列出支持的 agent 与默认配置路径

# 注册到各 agent（写对方配置，自动备份，幂等）
sub2api-mcp register claude-desktop
sub2api-mcp register claude-code [--path ./.mcp.json]
sub2api-mcp register cursor
sub2api-mcp register dsh [--path <DSH 的 MCP 配置>]
sub2api-mcp register generic --print   # 只打印 JSON，不写盘
sub2api-mcp unregister <agent>
sub2api-mcp inspect <agent>
```

`register` 生成的条目形如：

```json
{
  "mcpServers": {
    "sub2api": {
      "command": "/path/to/node",
      "args": ["/path/to/sub2api-mcp/src/cli.js", "serve"],
      "env": {
        "SUB2API_URL": "http://127.0.0.1:8080",
        "SUB2API_EMAIL": "admin@...",
        "SUB2API_PASSWORD": "...",
        "MCP_TOOL_PROFILE": "readonly"
      }
    }
  }
}
```

## 工具（18 个，按档位）

| 档位 | 工具 |
|---|---|
| **readonly**（8） | `sub2api_status` `list_users` `get_user` `list_accounts` `list_groups` `list_api_keys` `get_usage` `sync_upstream_models` |
| **readwrite**（+9） | `create_user` `update_user` `set_user_balance` `create_account` `update_account` `bind_account_group` `create_group` `create_api_key` `chat_completion` |
| **full**（+1） | `delete_account` |

## 架构分层

```
L0 src/core/client.js     Sub2API API 客户端（无 MCP/agent 依赖）
L1 src/mcp/server.js      MCP 服务器（stdio JSON-RPC）
L2 src/adapters/index.js  各 agent 注册器（claude-desktop / claude-code / cursor / dsh / generic）
   src/cli.js             命令行：serve / register / status / tools / config / adapters
```

> **DSH 专用插件**（设置页 + 凭据托管 + 自动注册）在后续版本作为独立包
> `dsh-plugin-sub2api` 提供，依赖本包 ✓ —— 本包本身与 DSH 无关 ✓

## 安全建议

- 默认档位建议 `readonly` ✓（AI 只能看，不能改）
- 密码通过环境变量或 `600` 权限的配置文件传入 ✓；不要提交到仓库 ✗
- 生产环境建议单独建一个管理员账号给 MCP 用 ✓（便于审计/吊销）
