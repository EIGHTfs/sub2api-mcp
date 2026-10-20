# sub2api-mcp

**Sub2API 的 MCP 服务器** —— 让任何支持 MCP 的 agent（DSH / Claude Desktop / Claude Code / Cursor / …）
直接管理 Sub2API 网关：用户、余额、上游账号、分组、API Key、用量、连通性测试。

- 纯 Node.js 标准库 ✓ **零运行时依赖** ✓ Node ≥ 18.17 ✓
- 与 agent 无关 ✓（核心层 L0+L1 不依赖任何框架 ✓）
- 工具权限**三档**：`readonly`（9）/ `readwrite`（20）/ `full`（21）✓
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

## 工具（21 个，按档位）

| 档位 | 工具 |
|---|---|
| **readonly**（9） | `sub2api_status` `list_users` `get_user` `list_accounts` `list_groups` `list_api_keys` `get_usage` `sync_upstream_models` `probe_accounts` |
| **readwrite**（+11） | `create_user` `update_user` `set_user_balance` `create_account` `update_account` `set_account_model_mapping` `bind_account_group` `create_group` `create_api_key` `chat_completion` `import_dsh_providers` |
| **full**（+1） | `delete_account` |

## 从 DSH 导入模型提供商

把 DSH 里已配置的提供商（**api 地址 + key + 模型清单**）一键导成 Sub2API 的上游账号。

```bash
# 1) 先预览（默认 dry-run，不写任何东西；key 已脱敏）
node scripts/import-dsh-providers.mjs

# 2) 真建（幂等：同名账号已存在则跳过）
node scripts/import-dsh-providers.mjs --write --probe

# 3) 只导其中几个 / 已存在则覆盖更新
node scripts/import-dsh-providers.mjs --write --update --only d,agnes
```

也可以在会话里让 AI 直接调 MCP 工具 `import_dsh_providers`（readwrite 档，默认 `dry_run: true`）。

### 配置自动发现（不绑定具体文件）

不同 DSH 版本的配置落点不同，导入器按「扫描 → 合并 → 去重」处理，并报告每个提供商来自哪个文件：

| 类型 | 扫描位置 |
|---|---|
| 提供商 | `<DSH_HOME>/` 与每个 `<DSH_HOME>/profiles/<name>/` 下的 `cordis.patch.yml` `cordis.yml` `config.{yml,yaml,json}` `dsh.config.json` |
| 凭据 | `<DSH_HOME>/` 与每个 profile 下的 `.credentials.{yaml,yml,json}` `credentials.{json,yaml}` |

key 取值优先级：提供商内联 `apiKey` → 凭据库 `refs.<apiKeyEnv>` → 进程环境变量 `apiKeyEnv`。

### 账号自检的测试模型（容易踩坑）

Sub2API 的账号自检 `POST /admin/accounts/:id/test` **会忽略传入的 model**，固定用平台自己的测试模型
（实测 `openai` → `gpt-5.4`，`opencode_go` → `glm-5.3`）。所以导入时会把该测试模型作为别名写进账号的
`model_mapping`，指向该账号的第一个真实模型；否则自检必然报 `model_not_found`。

- 默认按平台取（`--test-model` 可显式覆盖）
- 同平台存在「非本工具建的」账号时，会先对它实测一次，用读到的模型名更准

### 账号参数

| 参数 | 默认 | 来源 |
|---|---|---|
| `concurrency`（账号并发上限） | **5** | 环境变量 `SUB2API_IMPORT_CONCURRENCY` → CLI `--concurrency` / MCP 参数 `concurrency` 覆盖 |
| `platform` | 按 provider 的 `api` 协议推导 | `openai-completions` → `openai`，`anthropic` → `anthropic` |
| `model_mapping` | 该 provider 的全部模型（含测试模型别名） | 由 DSH 配置的 `models` 生成 |

> 并发数低于 1 会被修正为 5 —— 设为 0 会让账号几乎不可用。

### 安全约束

- **回环检测**：baseURL 指向网关自身或其它 Sub2API 实例时打印 ⚠ 警告 —— 这类 provider 不要导入，否则形成循环调用
- key 缺失的 provider 直接跳过并报告（不建空 key 账号）
- 工具/CLI 输出里的 key 一律脱敏

## 架构分层

```
L0 src/core/client.js     Sub2API API 客户端（无 MCP/agent 依赖）
   src/core/probe.js      账号探活（SSE 解析）
   src/core/dsh-import.js DSH 提供商发现与转换（多来源扫描 ✓ 零依赖 ✓）
L1 src/mcp/server.js      MCP 服务器（stdio JSON-RPC）
L2 src/adapters/index.js  各 agent 注册器（claude-desktop / claude-code / cursor / dsh / generic）
   src/cli.js             命令行：serve / register / status / tools / config / adapters
   scripts/import-dsh-providers.mjs   提供商导入 CLI（默认 dry-run ✓）
```

> **DSH 专用插件**（设置页 + 凭据托管 + 自动注册）在后续版本作为独立包
> `dsh-plugin-sub2api` 提供，依赖本包 ✓ —— 本包本身与 DSH 无关 ✓

## 安全建议

- 默认档位建议 `readonly` ✓（AI 只能看，不能改）
- 密码通过环境变量或 `600` 权限的配置文件传入 ✓；不要提交到仓库 ✗
- 生产环境建议单独建一个管理员账号给 MCP 用 ✓（便于审计/吊销）
