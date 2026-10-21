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

## 工具（22 个，按档位）

| 档位 | 工具 |
|---|---|
| **readonly**（9） | `sub2api_status` `list_users` `get_user` `list_accounts` `list_groups` `list_api_keys` `get_usage` `sync_upstream_models` `probe_accounts` |
| **readwrite**（+12） | `create_user` `update_user` `set_user_balance` `create_account` `update_account` `set_account_model_mapping` `bind_account_group` `create_group` `create_api_key` `chat_completion` `import_dsh_providers` `export_account_to_dsh` |
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

# 4) 显式指定入站协议策略（默认 adaptive 自适应，一般不用改）
node scripts/import-dsh-providers.mjs --write --api-protocol adaptive
```

也可以在会话里让 AI 直接调 MCP 工具 `import_dsh_providers`（readwrite 档，默认 `dry_run: true`）。

### 配置自动发现（按内容识别，不绑定文件名）

不同 DSH 版本/不同 profile/自定义布局下，承载配置与凭据的文件名完全不同。因此**不写死任何文件名**，
而是递归扫描 `<DSH_HOME>`（深度 ≤ 3）下所有 `.yml/.yaml/.json`，按**内容结构**判定用途：

| 判定 | 判据（只看内容，不看名字） |
|---|---|
| 配置文件 | 含 YAML `providers:` 段，或 JSON 的 `"providers"` 键 |
| 凭据文件 | 含 YAML `refs:` 段，或 JSON 的 `"refs"` 键 |

扫描边界：只收 `.yml/.yaml/.json`、单文件 ≤ 2MB、跳过 `node_modules`/`sessions`/`skills`/`cache`/`data`/
`logs`/`tmp`/`dist`/`build`/`.trash`/`local-plugins` 等明显非配置目录（防止扫爆海量会话与插件数据）。

多个候选时：**按修改时间取最新**（活跃配置通常是最近被改的那份，陈旧备份/历史目录天然靠后），
导出工具还可用 `patch_file` / `cred_file` 参数显式指定。

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
| `api_protocol`（入站协议策略） | **`adaptive`** | `SUB2API_IMPORT_API_PROTOCOL` → CLI `--api-protocol` / MCP 参数 `api_protocol` 覆盖 |
| `platform` | 按 provider 的 `api` 协议推导 | `openai-completions` → `openai`，`anthropic` → `anthropic` |
| `model_mapping` | 该 provider 的全部模型（含测试模型别名） | 由 DSH 配置的 `models` 生成 |

> 并发数低于 1 会被修正为 5 —— 设为 0 会让账号几乎不可用。

### 入站协议策略（api_protocol）—— 默认必须自适应

写进账号 `credentials.api_protocol`，决定上游按哪种协议语义解析请求体：

| 取值 | 行为 |
|---|---|
| `adaptive`（**默认**） | 按入站协议优先使用供应商原生端点，只有缺对应端点时才转换 ✓ |
| `openai` | 强制 OpenAI 语义。**部分上游会走 Responses**：请求体按 `input[] / ResponseInput` 反序列化 |
| `anthropic` | 强制 Anthropic 语义 |
| `responses` | 强制 Responses 语义 |

为什么默认不能用 `openai`：客户端发的是 chat/completions 语义（`messages` + `role:"tool"` + `tool_calls`），
而 Responses 语义要求 `{"type":"function_call"}` / `{"type":"function_call_output"}`，工具项没有对应 variant。
长会话里前面纯文本消息能通过，一碰到工具结果 item 就整条请求 400：

```
Invalid JSON data: Failed to deserialize the JSON body into the target type:
input: data did not match any variant of untagged enum ResponseInput at line 1 column 168435
```

`line 1 column 168435` 指单行 JSON 体第 ~164KB 处 —— 出错的是会话深处某一条工具相关 item，
且这是不可重试的客户端契约错误（重试无效）。所以导入时把 `api_protocol` 显式写成 `adaptive`，
让上游按入站协议挑端点，避免语义错配 ✓。

> 该字段服务端无枚举校验（任意字符串都会落库），所以拼错不会报错、只会静默走错语义 —— 代码侧只接受非空字符串，默认 `adaptive`。

### 安全约束

- **回环检测**：baseURL 指向网关自身或其它 Sub2API 实例时打印 ⚠ 警告 —— 这类 provider 不要导入，否则形成循环调用
- key 缺失的 provider 直接跳过并报告（不建空 key 账号）
- 工具/CLI 输出里的 key 一律脱敏

## 把账号导出回 DSH（反向）

把 Sub2API 里已有的上游账号，反向写回 DSH 的提供商配置与凭据库，让 DSH 侧直接可用该上游。

```text
export_account_to_dsh({
  account_id: 13,        // Sub2API 账号 id
  provider: "agnes",     // DSH 侧 provider 名（默认取账号名并规范化）
  api_key: "...",        // 自行指定的 API Key（写入凭据库；不传则尝试复用现有 ref）
  dry_run: true          // 默认 true：只返回将被写入的块，不落盘
})
```

写入的两处落点（**都由内容指纹自动发现，不绑定文件名**）：

| 目标 | 判据 | 内容 |
|---|---|---|
| 配置文件（含 `providers:` 段的 YAML） | 按内容结构识别 | `llm` 插件 `config.providers.<provider>`：`apiKeyEnv` / `api` / `baseURL` / `models[]` |
| 凭据文件（含 `refs:` 段的 YAML） | 按内容结构识别 | `refs.<ENV>: <api_key>`（写后权限收敛 600） |

多候选按修改时间取最新；可用 `patch_file` / `cred_file` 显式指定。识别不到目标文件时**明确报错**，
绝不猜路径、不凭空新建。

流程：读账号详情 → 取 `base_url`、`model_mapping` 的键（即 DSH 侧模型 id）、平台测试别名剔除 →
定位含 `providers:` 段的 patch 文件（复用导入侧的多来源发现，不绑定固定路径）→ 生成 provider 块 →
`dry_run` 只预览，`dry_run:false` 才写；**写盘前自动备份 `<文件>.bak-<时间戳>`**。

### key 的限制（重要）

Sub2API 的账号详情**不回显明文 api_key**（实测只给 `credentials_status.has_api_key: true`；
`/credentials`、`/key`、`/reveal`、`/api-key`、`/secret` 一律 404）。所以导出时：

| 情况 | 行为 |
|---|---|
| 调用方直接传 `api_key` 参数 | 写入凭据库 `refs.<ENV>` ✓（**推荐做法**：key 由你自己填） |
| 详情里能读到 `credentials.api_key` | 写入凭据库 `refs.<ENV>` ✓ |
| 读不到，但 DSH 侧已有同名 `refs.<ENV>` | 复用现有 key，不覆盖 ✓ |
| 都没有 | 只写 provider 配置，回报 `needsApiKey: true` + 需补的 ENV 名 ✗ |

绝不写空串/占位符冒充 key —— 那会让 DSH 侧以为配好了，实际请求 401。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `account_id` | 必填 | Sub2API 账号 id |
| `provider` | 账号名规范化（去 `dsh:` 前缀） | DSH provider id |
| `api` | 按 platform 推导 | `openai` → `openai-completions`，`anthropic` → `anthropic` |
| `api_key_env` | `<PROVIDER>_API_KEY` | 凭据环境变量名 |
| `api_key` | 无 | 直接指定 Key 写入凭据库（Sub2API 不回显 key，通常由你自行填写） |
| `replace` | `false` | 同名 provider 已存在时默认拒绝覆盖 |
| `dry_run` | `true` | 只预览 |
| `test_models` | `gpt-5.4` / `glm-5.3` / `claude-3-5-sonnet-20241022` | 从模型清单剔除的平台测试别名 |
| `patch_file` | 自动发现 | 显式指定写入的配置文件（默认：含 `providers:` 段的 YAML，多候选取最新） |
| `cred_file` | 自动发现 | 显式指定凭据文件（默认：含 `refs:` 段的 YAML） |

## 架构分层

```
L0 src/core/client.js     Sub2API API 客户端（无 MCP/agent 依赖）
   src/core/probe.js      账号探活（SSE 解析）
   src/core/dsh-import.js DSH 提供商发现与转换（多来源扫描 ✓ 零依赖 ✓）
   src/core/dsh-export.js Sub2API 账号反向导出到 DSH 配置（带备份 ✓ 凭据 600 ✓）
L1 src/mcp/server.js      MCP 服务器（stdio JSON-RPC）
L2 src/adapters/index.js  各 agent 注册器（claude-desktop / claude-code / cursor / dsh / generic）
   src/cli.js             命令行：serve / register / status / tools / config / adapters
   scripts/import-dsh-providers.mjs   提供商导入 CLI（默认 dry-run ✓）
```

> **DSH 专用插件**（设置页 + 凭据托管 + 自动注册）在后续版本作为独立包
> `dsh-plugin-sub2api` 提供，依赖本包 ✓ —— 本包本身与 DSH 无关 ✓

## 版本记录

| 版本 | 主要内容 |
|---|---|
| **0.1.1** | 新增 `export_account_to_dsh`（账号反向写回 DSH 配置，支持自行指定 key）；`create_account`/`update_account` 与账号 API 字段对齐；新增 `set_account_model_mapping`；导入显式写 `api_protocol`（默认 `adaptive`，修 OpenAI Responses 语义导致的 400）；配置与凭据文件改按内容指纹发现，去掉固定文件名清单 |
| 0.1.0 | 首个发布：账号/用户/分组/API Key/用量/探活等 20 个工具 + 从 DSH 导入提供商 |

## 安全建议

- 默认档位建议 `readonly` ✓（AI 只能看，不能改）
- 密码通过环境变量或 `600` 权限的配置文件传入 ✓；不要提交到仓库 ✗
- 生产环境建议单独建一个管理员账号给 MCP 用 ✓（便于审计/吊销）
