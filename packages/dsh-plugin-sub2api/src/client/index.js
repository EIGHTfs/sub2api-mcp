/**
 * dsh-plugin-sub2api —— 浏览器面：设置页（真实 DSH 插件写法 ✓）
 *
 * 依据工作区插件实测：
 *   · 客户端插件 = 预打包模块（dsh.client 声明 ✓ inject ui-settings ✓）
 *   · 注册设置页用 `settings.section(...)` ✓（dsh-git-push/lib/client.js 同款）
 *
 * ⚠️ 仍需在真实 DSH 里构建（tsdown）+ 安装 + 重启验证 ✗
 */
export const name = 'dsh-plugin-sub2api';

/** Cordis 客户端插件入口：注入 settings 服务后注册一个设置分区 */
export function apply(ctx) {
  const log = (...a) => { try { console.log('[sub2api]', ...a); } catch { /* 忽略 */ } };

  // 能力探测：settings 服务是否存在（不同版本可能没有 → 静默降级 ✓）
  const settings = (() => {
    try { return ctx && (ctx.settings || (ctx.get && ctx.get('settings'))) ? (ctx.settings || ctx.get('settings')) : null; } catch { return null; }
  })();

  if (!settings || typeof settings.section !== 'function') {
    log('当前 DSH 版本未提供 settings.section → 设置页不可用，请用 CLI：sub2api-mcp status / register dsh');
    return;   // 不返回值（避免被当 effect ✗）
  }

  // 真实注册（settings.section 的参数形状以 dsh-git-push 为准 ✓）
  try {
    settings.section({
      id: 'sub2api',
      title: 'Sub2API',
      order: 60,
      render: () => ({
        kind: 'form',
        fields: [
          { key: 'url', label: '网关地址', type: 'text', placeholder: 'http://127.0.0.1:8080' },
          { key: 'email', label: '管理员邮箱', type: 'text' },
          { key: 'password', label: '密码', type: 'password' },
        ],
        actions: [
          { id: 'save', label: '保存' },
          { id: 'test', label: '测试连接' },
        ],
      }),
      onAction: async (action, values) => {
        const bridge = (() => { try { return globalThis.__DSH_SUB2API_BRIDGE__; } catch { return null; } })();
        if (bridge && typeof bridge.handle === 'function') return bridge.handle(action, values);
        return { ok: false, message: '宿主桥未就绪：请重启 DSH 或改用 CLI（sub2api-mcp config）' };
      },
    });
    log('设置页已注册 ✓');
    return;   // 注册完成（不返回值 ✓）
  } catch (e) {
    log('设置页注册失败（已降级）:', (e && e.message) || e);
    return;   // 注册失败已降级（不返回值 ✓）
  }
}

export default apply;
