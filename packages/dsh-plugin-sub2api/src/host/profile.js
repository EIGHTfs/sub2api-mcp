/**
 * 工具档位常量（插件侧，与核心包同源 ✓）
 *
 * 为什么需要这个文件：默认档位曾被「核心包 config.js」与「插件侧」各写一份，值还不一致
 * （readwrite vs readonly）⇒ 同一份 mcp.json 在不同入口下权限不同，文档也只能二选一地说。
 * 现在插件侧只引用核心包的常量，两包永远一致 ✓
 *
 * ⚠️ 为什么要双通道 import 而不是直接 `import { X } from 'sub2api-mcp/config'`：
 *    裸包名只有在「插件已装进 profile 的 node_modules」时才解析得到；
 *    从仓库源码路径直接加载（minihost / doctor / 开发态联调）会 ERR_MODULE_NOT_FOUND ✗
 *    （install-plugin-dryrun-first 记录的同类坑）。所以：
 *      ① 先试核心包 exports 出口（安装态，权威）
 *      ② 失败再按仓库相对路径取（源码态）
 *    任一路成功即可，值一定来自核心包，不会在这里另造一份 ✗
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 取核心包的 config 模块（安装态 → exports；源码态 → 相对路径） */
async function loadCoreConfig() {
  try {
    return await import('sub2api-mcp/config');
  } catch { /* 走源码态 */ }
  // 本文件：<repo>/packages/dsh-plugin-sub2api/src/host/profile.js
  // 目标：<repo>/packages/sub2api-mcp/src/config.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cands = [
    path.resolve(here, '../../../sub2api-mcp/src/config.js'),          // 仓库内相邻
    path.resolve(here, '../../../../sub2api-mcp/src/config.js'),       // 多一层（兼容嵌套布局）
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return await import('file://' + c); } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 默认档位：优先核心包导出的 DEFAULT_TOOL_PROFILE；
 * 核心包完全取不到时才用本文件内的兜底值（并保持与核心包文档承诺一致 = readonly ✓）。
 * 兜底值存在的理由：插件要能在核心包缺失时也给设置页一个稳定答案，
 * 但它不是「第二个真相源」——正常情况下永远走核心包 ✓
 */
const FALLBACK_DEFAULT = 'readonly';

const core = await loadCoreConfig();
export const DEFAULT_TOOL_PROFILE = (core && core.DEFAULT_TOOL_PROFILE) || FALLBACK_DEFAULT;
export const PROFILE_SOURCE = core ? 'sub2api-mcp/config' : 'fallback';

/** 全部档位（顺序即设置页滑块顺序 ✓ 客户端 PROFILE_HINTS 也按这个顺序派生） */
export const PROFILES = ['readonly', 'readwrite', 'full'];

/** 是否是合法档位名 */
export function isProfile(v) { return PROFILES.includes(String(v)); }

export default { PROFILES, DEFAULT_TOOL_PROFILE, isProfile, PROFILE_SOURCE };
