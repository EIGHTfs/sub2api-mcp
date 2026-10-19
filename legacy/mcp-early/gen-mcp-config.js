#!/usr/bin/env node
/**
 * gen-mcp-config.js — 从 mcp.config.json 生成 MCP 注册配置（DSH / Claude Desktop）
 *
 * 用法：
 *   node gen-mcp-config.js                 # 打印注册 JSON（密码打码）
 *   node gen-mcp-config.js --show-secrets  # 打印含明文密码的注册 JSON
 *   node gen-mcp-config.js --write-dsh     # 直接写入 DSH 配置（先备份）
 *   node gen-mcp-config.js --write-claude  # 直接写入 Claude Desktop 配置（先备份）
 *   node gen-mcp-config.js --config /path/to/mcp.config.json
 *
 * 所有参数（网关地址、账号、node 路径、客户端配置路径）都来自 mcp.config.json ✓
 * 环境变量可覆盖：SUB2API_URL / SUB2API_EMAIL / SUB2API_PASSWORD / MCP_CONFIG
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getOpt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const cfgPath = getOpt('--config', process.env.MCP_CONFIG || path.join(__dirname, 'mcp.config.json'));
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
catch (e) {
  console.error('✗ 读不到配置: ' + cfgPath);
  console.error('  先复制模板: cp mcp.config.example.json mcp.config.json  然后填值');
  process.exit(1);
}
const s = cfg.sub2api || {}, srv = cfg.server || {}, rt = cfg.runtime || {}, cl = cfg.clients || {};
const env = process.env;
const url = (env.SUB2API_URL || s.url || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const email = env.SUB2API_EMAIL || s.email || '';
const password = env.SUB2API_PASSWORD || s.password || '';
const nodeBin = rt.node || process.execPath;
const serverName = srv.name || 'sub2api-admin';
const serverScript = path.join(__dirname, 'sub2api_mcp.js');

if (!email || !password || password === 'CHANGE_ME') {
  console.error('✗ 配置里缺少 sub2api.email / sub2api.password（或仍是 CHANGE_ME）');
  process.exit(1);
}

const entry = {
  command: nodeBin,
  args: [serverScript],
  env: { SUB2API_URL: url, SUB2API_EMAIL: email, SUB2API_PASSWORD: password },
};
const showSecrets = has('--show-secrets');
const printable = JSON.parse(JSON.stringify(entry));
if (!showSecrets) printable.env.SUB2API_PASSWORD = '***已隐藏（加 --show-secrets 显示）***';
const snippet = { mcpServers: { [serverName]: printable } };

const expand = (p) => (p || '').replace(/^~(?=$|\/)/, os.homedir());
function writeClient(label, configPath, serverKey) {
  const target = expand(configPath);
  if (!target) { console.error('✗ ' + label + ': 配置里没写 clients 路径'); return false; }
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { existing = {}; }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers[serverName] = entry;                 // 真实写入（含密码）
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
  if (fs.existsSync(target)) {
    const bak = target + '.bak.' + Date.now();
    fs.copyFileSync(target, bak);
    console.log('  ✓ 已备份原配置 → ' + bak);
  }
  fs.writeFileSync(target, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  console.log('  ✓ 已写入 ' + label + ': ' + target);
  return true;
}

if (has('--write-dsh')) {
  if (!writeClient('DSH', (cl.dsh || {}).configPath, serverName)) process.exit(1);
} else if (has('--write-claude')) {
  if (!writeClient('Claude Desktop', (cl.claudeDesktop || {}).configPath, serverName)) process.exit(1);
} else {
  console.log('// 注册配置（粘贴到客户端 mcpServers 里；密码' + (showSecrets ? '已显示' : '已打码，加 --show-secrets 查看') + '）');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('\n// 也可以直接写入：');
  console.log('//   node gen-mcp-config.js --write-dsh      # DSH（路径取 clients.dsh.configPath）');
  console.log('//   node gen-mcp-config.js --write-claude   # Claude Desktop');
}
