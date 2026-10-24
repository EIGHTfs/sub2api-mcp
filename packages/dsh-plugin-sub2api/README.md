# dsh-plugin-sub2api

DSH 插件：在**设置侧边栏**里填 Sub2API 网关地址 + 管理员账号密码，其余全自动 ✓

- 依赖核心包 **`sub2api-mcp`**（所有 MCP 能力都在那里 ✓ 本插件只是 DSH 包装层 ✓）
- 对外**声明支持所有 DSH 版本**（宽 peer 范围 ✓）
- 内部**运行时能力自检**（`src/host/capabilities.js` ✓）→ 真实支持度分三档：
  ```
  full      凭据存储 + 设置页插槽 + MCP 注入点 全部可用 ✓
  degraded  缺 1~2 项 → 对应功能降级（仍可用 ✓）
  minimal   缺 3 项以上 → 仅宿主兜底 + 打印 CLI 命令 ✓
  ```

## 当前状态（如实标注 ⚠️）

| 部分 | 状态 |
|---|---|
| `src/host/capabilities.js` 能力自检 | ✅ 已完成，三档判定双向测试通过 ✓ |
| `src/host/index.js` 宿主入口 | ✅ 已完成（apply + 降级 + 生命周期清理 ✓） |
| `src/host/register.js` MCP 注册适配 | ✅ 已完成（API → 配置文件 → 打印命令 三级降级 ✓） |
| `src/host/doctor.js` 自检命令 | ✅ 已完成（`node src/host/doctor.js` ✓） |
| `src/host/profile.js` 档位常量 | ✅ 与核心包 `DEFAULT_TOOL_PROFILE` 同源（双通道 import ✓） |
| `lib/client.js` 设置页 UI | ✅ 已装载联调（唯一客户端源；`src/client/` 死码已删除 ✓） |

## 命令

```bash
node src/host/doctor.js          # 能力自检报告（在 DSH 内外都能跑）
```

## 设计文档

见 [`docs/PLUGIN-DESIGN.md`](../../docs/PLUGIN-DESIGN.md)（含分层、决策记录、兼容策略 ✓）

## 版本记录

| 版本 | 主要内容 |
|---|---|
| **0.1.2** | 删除无构建链且无人引用的 `src/client/` 死码（`lib/client.js` 为唯一客户端源）；默认档位改从核心包 `DEFAULT_TOOL_PROFILE` 同源引用（新增 `src/host/profile.js`）；localStorage 不再回填密码；去掉两处失效的写死绝对路径 |
| 0.1.1 | 修三个线上 bug：inject 限制、空响应、档位不回写 |
| 0.1.0 | 首个发布：设置页 + 凭据托管 + 自动注册 + 能力自检三级降级 |

> 发布顺序：先 `packages/sub2api-mcp`（核心），再本包；两包版本号保持同步。
