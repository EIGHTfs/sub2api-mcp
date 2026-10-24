# Sub2API MCP 生态设计文档

> 本文是 sub2api-mcp 仓库的设计说明：分层、决策记录、版本兼容策略。
> 代码是真相源，本文只解释「为什么这么设计」；两者冲突时改本文对齐代码。

## 一、分层

```
L0 核心契约层    packages/sub2api-mcp/src/core/
                   client.js      HTTP + 登录缓存（无 MCP / 无 agent 依赖）
                   probe.js       账号探活（SSE 解析）
                   dsh-import.js  DSH 提供商发现 → Sub2API 账号
                   dsh-export.js  Sub2API 账号 → DSH 提供商配置（反向）
                 约束：零依赖、可被任何宿主复用、不 import 上层
L1 协议层        packages/sub2api-mcp/src/mcp/server.js
                   stdio JSON-RPC 2.0、工具注册表、三档权限
                 约束：只依赖 L0；工具条目是声明式数据（name/tier/schema/run）
L2 适配层        packages/sub2api-mcp/src/adapters/index.js
                   5 个 agent 统一 register / unregister / inspect
                 约束：只写配置文件（带备份 + 幂等），不碰业务逻辑
L3 宿主包装层    packages/dsh-plugin-sub2api/
                   src/host/   Cordis 插件（路由 + 凭据托管 + 能力自检）
                   lib/        客户端 UI（真实装载的那份）
                 约束：薄包装；所有能力都来自 L0/L1，不重复实现
```

**核心原则**：MCP（L0~L2）与任何 agent 无关；新增 agent = 加一个适配器或一个薄插件，核心不动。

## 二、关键决策记录

### D1 工具权限三档（readonly / readwrite / full）

档位是**累加**的：`readwrite` 能看到 readonly + readwrite 两类工具。因此文档里存在两种口径，
必须分清，否则数字必然抄错：

| 口径 | 含义 | 例（当前） |
|---|---|---|
| 该档独有 | 只属于该 tier 的条目数 | 9 / 12 / 1 |
| 累计可见 | `allowedTools(profile)` 的长度 | 9 / 21 / 22 |

数字**不手抄**：`server.js` 导出 `toolCatalog()` / `toolCounts()` / `toolVisibleCounts()`，
由 `scripts/gen-tool-counts.mjs` 生成进各文件的标记块，`check` 模式做门禁。

### D2 默认档位 = readonly

MCP 是给 AI 用的，默认只读最安全。`DEFAULT_TOOL_PROFILE` 定义在核心包
`src/config.js`，插件侧 `src/host/profile.js` 引用同一常量（双通道 import：安装态走
`sub2api-mcp/config`，源码态走相对路径）。**不要在别处再写档位字面量。**

### D3 客户端 UI 唯一源 = `packages/dsh-plugin-sub2api/lib/client.js`

`package.json` 的 `exports["./client"]` 指向它，宿主按这个路径装载。
曾并存一份 `src/client/index.js`（声明式 `kind:'form'`），它既无构建链、也无人引用，
且依赖一个全仓只有读取没有写入的全局桥 ⇒ 已删除。**新增客户端能力改 `lib/client.js`。**

### D4 凭据只走宿主

`POST /credentials` 由宿主写 600 权限文件。浏览器 localStorage **不存 password**
（只缓存 url/email 供表单回填）。早期在 fetch 失败的 catch 里把整份 values（含密码）
setItem 兜底，属于静默降级到不安全通道，已移除。

### D5 配置与凭据文件按「内容指纹」发现

不写死文件名：不同 DSH 版本/布局下，承载 `providers:` 的文件可能是 cordis.patch.yml、
cordis.yml、config.yaml、dsh.config.json… 判据只看内容结构（含 YAML `providers:` 段 /
`refs:` 段，或 JSON 的 `"providers"` / `"refs"` 键），多候选取最近修改。

### D6 默认入站协议 = adaptive

`credentials.api_protocol` 默认写 `adaptive`（按入站协议优先用供应商原生端点）。
强制 `openai` 会让部分上游按 Responses 语义（`input[] / ResponseInput`）解析，
而客户端发的是 chat/completions 语义（`messages` + `role:"tool"` + `tool_calls`），
工具项没有对应 variant ⇒ 长会话在某条工具 item 上报 400 `json_parse_error`（不可重试）。

## 三、版本兼容策略

两个 npm 包独立版本号、**发布顺序固定**：

1. `packages/sub2api-mcp`（核心，被依赖）
2. `packages/dsh-plugin-sub2api`（依赖核心，`dependencies: sub2api-mcp >=0.1.0 <0.2.0-0`）

同 0.x 线内插件可不改依赖区间；核心若发 0.2.0，插件需同步升依赖区间再发。

仓库根**没有 package.json**，因此不能对根发包（会让 npm 打包上层整棵树）。
分别 `cd` 到两个包目录发包。

客户端兼容：`lib/client.js` 只依赖宿主注入的 `@deepseek-ai/dsh-client-ui-settings*`
两个 inject 目标；宿主版本能力由 `src/host/capabilities.js` 运行时探测
（full / degraded / minimal 三级降级），探测失败不阻塞加载。

## 四、门禁（防漂移）

| 门禁 | 命令 | 作用 |
|---|---|---|
| 工具数一致性 | `node packages/sub2api-mcp/scripts/gen-tool-counts.mjs check` | 文档/客户端提示与 `toolCatalog()` 派生值不一致即 exit 1 |
| 冒烟 | `node packages/sub2api-mcp/test/smoke.mjs` | 三档工具数 + 只读工具实调 |

新门禁必须先用已知错误自证会变红（例：临时加一个假工具 → `check` 必须报漂移）。

## 五、目录速查

```
packages/sub2api-mcp/          通用 MCP 服务器（npm 包）
  src/core/                    L0 契约层（零依赖）
  src/mcp/server.js            L1 工具注册表 + stdio 服务
  src/adapters/index.js        L2 agent 注册器
  scripts/gen-tool-counts.mjs  工具数生成器（apply / check）
  test/smoke.mjs               冒烟
packages/dsh-plugin-sub2api/   DSH 插件
  src/host/                    宿主面（路由 / 凭据 / 能力自检 / 档位常量）
  lib/client.js                客户端 UI（唯一客户端源）
  cordis.patch.yml             bundle patch（顶层 - insert:）
legacy/mcp-early/              早期原型（归档，不再维护）
docs/PLUGIN-DESIGN.md          本文
```
