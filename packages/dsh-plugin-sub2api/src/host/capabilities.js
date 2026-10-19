/**
 * 能力自检（capabilities probe）
 *
 * 设计原则（用户 2026-10-19 定）：
 *   · 对外：package.json 声明宽 peer 范围 —— "支持所有 DSH 版本" ✓
 *   · 对内：运行时【逐能力探测】✓ 探测不到就降级 ✓ 绝不因版本差异崩溃 ✗
 *
 * 每个能力返回 { available: boolean, via: string|null, note?: string }
 * 全部探测都包在 try/catch 里 —— 不同 DSH 版本 API 形状不同也不会抛 ✗
 */

const CAPABILITIES = [
  {
    id: 'credentials',
    label: 'DSH 凭据存储',
    // 优先 DSH 凭据服务；兼容多种命名（不同版本可能叫法不同）
    probe(ctx) {
      const cands = [
        () => ctx.credentials && (ctx.credentials.set || ctx.credentials.save) && 'ctx.credentials',
        () => ctx.get && ctx.get('credentials') && (ctx.get('credentials').set || ctx.get('credentials').save) && "ctx.get('credentials')",
        () => ctx.secretStorage && ctx.secretStorage.set && 'ctx.secretStorage',
      ];
      for (const f of cands) { try { const r = f(); if (r) return { via: r }; } catch { /* 继续试下一个 */ } }
      return null;
    },
    fallback: '改用插件配置文件（权限 600）保存账号密码',
  },
  {
    id: 'settingsSlot',
    label: '设置页插槽',
    probe(ctx) {
      const cands = [
        () => ctx.client && ctx.client.slots && 'ctx.client.slots',
        () => ctx.clientModules && 'ctx.clientModules',
        () => ctx.get && ctx.get('clientModules') && "ctx.get('clientModules')",
      ];
      for (const f of cands) { try { const r = f(); if (r) return { via: r }; } catch { /* 继续 */ } }
      return null;
    },
    fallback: '不渲染设置页，改用 CLI（sub2api-mcp config / register dsh）',
  },
  {
    id: 'mcpRegistration',
    label: 'MCP 注册注入点',
    probe(ctx) {
      const cands = [
        () => ctx.mcp && (ctx.mcp.register || ctx.mcp.addServer) && 'ctx.mcp',
        () => ctx.agents && ctx.agents.registerMcpServer && 'ctx.agents',
        () => ctx.get && ctx.get('mcp') && "ctx.get('mcp')",
      ];
      for (const f of cands) { try { const r = f(); if (r) return { via: r }; } catch { /* 继续 */ } }
      return null;
    },
    fallback: '调用 sub2api-mcp register dsh 写配置文件（自动备份 ✓ 幂等 ✓）',
  },
  {
    id: 'configDir',
    label: 'DSH 配置目录可写',
    probe(ctx) {
      // 只用环境变量（ctx.home 是 cordis 服务，未 inject 访问会抛 ✗）
      const dir = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) || '';
      if (!dir) return null;
      return { via: 'DSH_HOME=' + dir, note: dir };
    },
    fallback: '使用 $HOME/.dsh 或插件自身目录',
  },
];

/** 探测所有能力；永不抛异常 ✓ */
export function detectCapabilities(ctx = {}) {
  const results = {};
  for (const cap of CAPABILITIES) {
    let r = null;
    try { r = cap.probe(ctx); } catch (e) { r = null; }
    results[cap.id] = r
      ? { id: cap.id, label: cap.label, available: true, via: r.via, note: r.note || null }
      : { id: cap.id, label: cap.label, available: false, via: null, fallback: cap.fallback };
  }
  const missing = Object.values(results).filter((r) => !r.available);
  const level = missing.length === 0 ? 'full'
    : missing.length <= 2 ? 'degraded'
    : 'minimal';
  return {
    level,                        // full | degraded | minimal
    supported: true,              // 声明支持所有版本 ✓（真实能力见 level／missing）
    missing: missing.map((m) => ({ id: m.id, label: m.label, fallback: m.fallback })),
    capabilities: results,
  };
}

/** 人读摘要（doctor 命令 / 日志用） */
export function summarize(report) {
  const lines = [];
  lines.push(`能力等级: ${report.level}（声明支持所有 DSH 版本 ✓，以下为实际探测结果）`);
  for (const c of Object.values(report.capabilities)) {
    lines.push(`  ${c.available ? '✓' : '✗'} ${c.label}${c.available ? ' → ' + c.via : ' → 降级：' + c.fallback}`);
  }
  return lines.join('\n');
}

export { CAPABILITIES };
export default detectCapabilities;
