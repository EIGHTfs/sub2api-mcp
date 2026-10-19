#!/usr/bin/env node
/**
 * sub2api-mcp —— 命令行入口
 *
 *   sub2api-mcp serve                      以 stdio MCP 服务器运行（供 agent 调用）
 *   sub2api-mcp register <agent> [--dry-run] [--print] [--path P]
 *   sub2api-mcp unregister <agent> [--path P]
 *   sub2api-mcp status                     连通性/账号数/余额自检
 *   sub2api-mcp tools [--profile readonly|readwrite|full]
 *   sub2api-mcp config [--show-secrets]    打印解析后的配置
 *   sub2api-mcp adapters                   列出支持的 agent
 *
 * 通用参数：--config <path>  --profile <tier>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Sub2ApiClient } from './core/client.js';
import { startServer, allowedTools } from './mcp/server.js';
import { register, unregister, inspect, listAdapters } from './adapters/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, 'cli.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--show-secrets') out.showSecrets = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--print') out.print = true;
    else if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

const mask = (s) => (s ? String(s).slice(0, 2) + '***' + String(s).slice(-2) : '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'serve';
  const cfg = loadConfig(args.config);
  if (args.profile) cfg.server.toolProfile = args.profile;
  const client = new Sub2ApiClient(cfg.sub2api);

  if (cmd === 'serve') {
    startServer({ client, config: cfg });
    return;
  }

  if (cmd === 'adapters') {
    console.log('支持的 agent：');
    for (const a of listAdapters()) console.log(`  ${a.id.padEnd(16)} ${a.label}` + (a.defaultPath ? `\n${' '.repeat(19)}默认路径: ${a.defaultPath}` : ''));
    return;
  }

  if (cmd === 'tools') {
    const tools = allowedTools(cfg.server.toolProfile);
    console.log(`工具权限档位: ${cfg.server.toolProfile} → ${tools.length} 个工具`);
    for (const t of tools) console.log(`  [${t.tier.padEnd(9)}] ${t.name.padEnd(22)} ${t.description}`);
    return;
  }

  if (cmd === 'config') {
    const c = JSON.parse(JSON.stringify(cfg));
    if (!args.showSecrets && c.sub2api.password) c.sub2api.password = mask(c.sub2api.password);
    console.log(`配置文件: ${cfg.configPath || '（未找到，使用默认/环境变量）'}`);
    console.log(JSON.stringify(c, null, 2));
    return;
  }

  if (cmd === 'status') {
    console.log(`网关: ${cfg.sub2api.url}`);
    let hz = 0;
    try { hz = await client.healthz(); } catch { hz = 0; }
    console.log(`  healthz: ${hz}`);
    try {
      const r = await client.api('GET', '/api/v1/admin/dashboard/stats');
      const d = (r.body && r.body.data) || {};
      console.log(`  管理 API: ${r.status}`);
      console.log(`  活跃用户: ${d.active_users} | 正常账号: ${d.normal_accounts} | 异常账号: ${d.error_accounts}`);
      console.log(`  今日成本: ${d.today_actual_cost} | RPM: ${d.rpm} | 活跃 Key: ${d.active_api_keys}`);
    } catch (e) {
      console.log(`  管理 API: ✗ ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'register' || cmd === 'unregister' || cmd === 'inspect') {
    const agent = args._[1];
    if (!agent) { console.error('用法: sub2api-mcp ' + cmd + ' <agent>'); process.exit(2); }
    const opts = { path: args.path, dryRun: args.dryRun, print: args.print, nodePath: process.execPath, cliPath: CLI_PATH };
    if (cmd === 'register') {
      const r = register(agent, cfg, opts);
      console.log(`✓ register ${agent}: ${r.written ? '已写入 ' + r.path + (r.backup ? '（备份 ' + r.backup + '）' : '') : '（未写盘，仅预览 ✓）'}`);
      if (r.entry) console.log(JSON.stringify(r.entry, null, 2));
      return;
    }
    if (cmd === 'unregister') {
      const r = unregister(agent, cfg, opts);
      console.log(`✓ unregister ${agent}: ${r.changed ? '已移除 ' + r.path : '未注册（无事可做）'}`);
      return;
    }
    const r = inspect(agent, cfg, opts);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.error(`未知命令: ${cmd}\n可用: serve | register <agent> | unregister <agent> | inspect <agent> | status | tools | config | adapters`);
  process.exit(2);
}

main().catch((e) => { console.error('✗ ' + ((e && e.message) || e)); process.exit(1); });
