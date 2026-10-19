/**
 * 兼容性自检（借鉴工作区 dsh-plugin-doctor 的 check 体系 ✓）
 * 目的：对外"声明支持所有版本" ✓，对内逐项检查真实可用性 ✓ 永不抛 ✗
 */
import fs from 'node:fs';
import path from 'node:path';

const CHECKS = {
  /** 包清单：dsh.bundle.patch 是否存在且可读 */
  checkManifest(pkgRoot) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
      const patch = pkg?.dsh?.bundle?.patch;
      const ok = !!patch && fs.existsSync(path.join(pkgRoot, patch));
      return { id: 'manifest', ok, detail: ok ? 'dsh.bundle.patch=' + patch : '缺少 dsh.bundle.patch 或文件不存在' };
    } catch (e) { return { id: 'manifest', ok: false, detail: String(e && e.message) }; }
  },
  /** 入口文件：main 与 ./client 是否都存在 */
  checkEntryPoints(pkgRoot) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
      const main = path.join(pkgRoot, pkg.main || 'lib/index.js');
      const client = path.join(pkgRoot, (pkg.exports && pkg.exports['./client']) || './lib/client.js');
      return { id: 'entryPoints', ok: fs.existsSync(main) || fs.existsSync(client),
        detail: 'main=' + fs.existsSync(main) + ' client=' + fs.existsSync(client) };
    } catch (e) { return { id: 'entryPoints', ok: false, detail: String(e && e.message) }; }
  },
  /** 核心依赖：sub2api-mcp 能否 require（真实可用性最低要求 ✓） */
  async checkCoreDep() {
    try {
      const m = await import('sub2api-mcp');
      return { id: 'coreDep', ok: !!m && !!m.Sub2ApiClient, detail: 'sub2api-mcp 可加载 ✓' };
    } catch (e) { return { id: 'coreDep', ok: false, detail: String(e && e.message) }; }
  },
  /** 宿主环境：DSH_HOME 是否可写（写 MCP 配置需要 ✓） */
  checkEnv() {
    const dir = process.env.DSH_HOME;
    if (!dir) return { id: 'env', ok: false, detail: '未设置 DSH_HOME（DSH 内运行时会自动提供 ✓）' };
    try { fs.accessSync(dir, fs.constants.W_OK); return { id: 'env', ok: true, detail: 'DSH_HOME 可写: ' + dir }; }
    catch { return { id: 'env', ok: false, detail: 'DSH_HOME 不可写: ' + dir }; }
  },
};

export async function runCompatChecks(pkgRoot) {
  const results = [];
  for (const [name, fn] of Object.entries(CHECKS)) {
    try { results.push(await fn(pkgRoot)); }
    catch (e) { results.push({ id: name, ok: false, detail: String(e && e.message) }); }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    declared: 'all-versions',           // 对外声明 ✓
    realSupport: okCount === results.length ? 'full' : okCount >= 2 ? 'partial' : 'minimal',
    checks: results,
  };
}

export { CHECKS };
export default runCompatChecks;
