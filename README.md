# sub2api-mcp —— Sub2API 的 MCP 生态

把 **Sub2API 网关**暴露成 **MCP 工具**，让 AI agent 直接管理网关（用户 / 余额 / 上游账号 / 分组 / API Key / 用量 / 连通性）。

> 项目根：`/volume10/DeepSeekHarness/projects/sub2api-mcp/`

## 分层（核心通用 + 各 agent 包装）

```
L0 核心契约层    纯 API 客户端（无 MCP / 无 agent 依赖）
L1 协议层        MCP 服务器（stdio JSON-RPC，18 工具，三档权限）
L2 适配层        各 agent 的注册器（claude-desktop / claude-code / cursor / dsh / generic）
L3 宿主包装层    DSH 插件（设置页 + 凭据托管 + 自动注册）
   ↑ L0~L2 与任何 agent 无关 ✓；L3 只是「DSH 这个 agent」的一层薄包装 ✓
```

**结论**：MCP 是核心 ✓，插件是可替换的包装层 ✓。以后新增 agent = 加一个适配器（或一个薄插件），核心不动 ✓。

## 包

| 路径 | 说明 | 状态 |
|---|---|---|
| [`packages/sub2api-mcp/`](packages/sub2api-mcp/README.md) | **通用 MCP 服务器**（npm 包，任何 MCP 客户端可用）| ✅ 完成：18 工具 / 三档权限 / 5 个 agent 注册器 / 冒烟测试 8 项全绿 |
| [`packages/dsh-plugin-sub2api/`](packages/dsh-plugin-sub2api/README.md) | **DSH 插件**（设置侧边栏 + 自动注册 + 能力自检）| 🔶 骨架完成：能力自检 + 兼容自检通过；设置页 UI 待构建联调 |
| `legacy/mcp-early/` | 早期 Python / Node 原型（保留参考，不再维护）| 🗄️ 归档 |

## 快速开始（通用包，任意 agent）

```bash
cd /volume10/DeepSeekHarness/projects/sub2api-mcp/packages/sub2api-mcp

# 1) 配账号（或改用环境变量 SUB2API_EMAIL / SUB2API_PASSWORD）
cp mcp.config.example.json sub2api-mcp.config.json && chmod 600 sub2api-mcp.config.json
vi sub2api-mcp.config.json

# 2) 自检
node src/cli.js status

# 3) 注册到你的 agent（自动写配置 + 备份 + 幂等）
node src/cli.js register claude-desktop
node src/cli.js register claude-code
node src/cli.js register dsh
node src/cli.js register generic --print     # 只打印 JSON，不写盘
```

`register` 生成的条目形如：

```json
{
  "mcpServers": {
    "sub2api": {
      "command": "<node 绝对路径>",
      "args": ["<包路径>/src/cli.js", "serve"],
      "env": {
        "SUB2API_URL": "http://127.0.0.1:8080",
        "SUB2API_EMAIL": "admin@…",
        "SUB2API_PASSWORD": "…",
        "MCP_TOOL_PROFILE": "readonly"
      }
    }
  }
}
```

## 工具档位（默认 `readonly` ✓ 安全）

| 档位 | 工具数 | 能力 |
|---|---|---|
| `readonly` | 8 | 只看：状态 / 用户 / 账号 / 分组 / Key / 用量 / 上游模型 |
| `readwrite` | 17 | + 增改：用户 / 余额 / 账号 / 分组 / Key / 对话测试 |
| `full` | 18 | + `delete_account`（危险） |

## 配置

优先级：**环境变量 > 配置文件 > 默认**

| 变量 | 说明 |
|---|---|
| `SUB2API_URL` | 网关地址（默认 `http://127.0.0.1:8080`） |
| `SUB2API_EMAIL` / `SUB2API_PASSWORD` | 管理员账号 |
| `SUB2API_VERIFY_TLS` | https 证书校验（默认 1） |
| `MCP_TOOL_PROFILE` | `readonly` / `readwrite` / `full` |
| `MCP_CONFIG` | 配置文件路径 |

配置文件查找：`$MCP_CONFIG` → `./sub2api-mcp.config.json` → `~/.config/sub2api-mcp/config.json` → 包内 `mcp.config.json`

## 文档

- 设计文档：[`../../docs/PLUGIN-DESIGN.md`](../../docs/PLUGIN-DESIGN.md)（分层 / 决策记录 / 版本兼容策略）

## 安全建议

- 默认 `readonly` ✓（AI 只能看，不能改）
- 密码走环境变量或 `600` 权限配置文件 ✓；不要提交进仓库 ✗
- 生产环境建议给 MCP 单独建一个管理员账号 ✓（便于审计 / 吊销）
