#!/usr/bin/env node
/**
 * verify-plugin.mjs —— DSH 插件静态自检（规则对齐 dsh-useful-tools 的 verify_plugin ✓）
 *
 * 硬伤（problems，必须修 ✗）：
 *   1. 缺少 package.json / 入口文件不存在
 *   2. 入口没有导出 apply（宿主不会当插件装载）
 *   3. apply 函数体【顶层】return 对象/数组字面量（`return {` / `return [`）
 *      → cordis 判 "Invalid effect" 并卸载整条 fiber ✗
 *   4. cordis.patch.yml 缺顶层 `- insert:`（市场报 patch target not found ✗）
 *
 * 提示（warnings）：
 *   · 没找到 tools 注册调用（inject(["tools"]) / get("tools")）—— 不注册工具的插件可忽略
 *   · patch 的 id 与包名不一致（自定义 id 合法，确认有意）
 *
 * 用法：node scripts/verify-plugin.mjs <插件根目录> [更多目录…]
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SOURCE = 512 * 1024;

function resolveEntry(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return { ok: false, error: '缺少 package.json' };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { return { ok: false, error: 'package.json 解析失败: ' + e.message }; }
  let rel = pkg.main;
  if (!rel && pkg.exports) {
    const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.'];
    if (typeof dot === 'string') rel = dot;
    else if (dot && dot.default) rel = dot.default;
  }
  if (!rel) return { ok: false, error: 'package.json 没有 main / exports["."]' , pkg };
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, error: '入口文件不存在: ' + rel, pkg };
  return { ok: true, entry: abs, rel, pkg };
}

/** 取 apply 函数体（括号配对 + 跳过字符串） */
function applyBody(src) {
  const m = /export\s+(?:async\s+)?function\s+apply\b|export\s+const\s+apply\s*=|function\s+apply\s*\(/.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0, i = open, inStr = null, inTpl = false;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(open + 1, i - 1);
}

/** 顶层（深度 0）是否 return 对象/数组字面量 */
function topLevelLiteralReturn(body) {
  const hits = [];
  let depth = 0, inStr = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i], prev = body[i - 1], next = body[i + 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && next === '/') { i = body.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = body.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    else if (depth === 0 && body.startsWith('return', i) && /[\s({[]/.test(body[i + 6] || ' ')) {
      const rest = body.slice(i + 6).trimStart();
      if (rest[0] === '{' || rest[0] === '[') hits.push('return ' + rest.slice(0, 40));
    }
  }
  return hits;
}

function collectFiles(entry, depth = 0, seen = new Set()) {
  const out = [];
  if (depth > 3 || seen.has(entry) || !fs.existsSync(entry)) return out;
  seen.add(entry);
  const src = fs.readFileSync(entry, 'utf8').slice(0, MAX_SOURCE);
  out.push({ file: entry, src });
  const re = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    let target = m[1];
    if (!target.startsWith('.')) continue;
    let abs = path.resolve(path.dirname(entry), target);
    for (const cand of [abs, abs + '.js', abs + '.mjs', path.join(abs, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { out.push(...collectFiles(cand, depth + 1, seen)); break; }
    }
  }
  return out;
}

function readPatch(root) {
  const f = path.join(root, 'cordis.patch.yml');
  if (!fs.existsSync(f)) return { found: false };
  const text = fs.readFileSync(f, 'utf8');
  const hasInsert = /^-\s*insert:/m.test(text);
  const m = /^-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/m.exec(text) || /^\s*-\s*id:\s*(\S+)/m.exec(text);
  return { found: true, hasInsert, id: m ? m[1] : null };
}

export function analyze(root) {
  const problems = [], warnings = [];
  const r = resolveEntry(root);
  if (!r.ok) return { root, ok: false, problems: [r.error], warnings: [] };
  const files = collectFiles(r.entry);
  const allText = files.map((f) => f.src).join('\n');
  const hasApply = /export\s+(?:async\s+)?function\s+apply\b/.test(allText)
    || /export\s+const\s+apply\s*=/.test(allText)
    || /export\s*\{[^}]*\bapply\b[^}]*\}/.test(allText);
  if (!hasApply) problems.push('入口没有导出 apply（宿主不会当插件装载）');

  // apply 顶层字面量返回（逐个 apply 检查）
  for (const f of files) {
    const body = applyBody(f.src);
    if (body == null) continue;
    const hits = topLevelLiteralReturn(body);
    for (const h of hits) {
      problems.push(`apply 顶层 return 对象/数组字面量（${path.relative(root, f.file)}: ${h}）→ cordis 判 Invalid effect ✗`);
    }
  }

  const registersTools = /inject\(\s*\[\s*['"]tools['"]/.test(allText) || /get\(\s*['"]tools['"]\s*\)/.test(allText);
  if (!registersTools) warnings.push('没有 tools 注册调用（inject(["tools"]) / get("tools")）—— 不注册工具的插件可忽略');

  const patch = readPatch(root);
  const pkgName = r.pkg && r.pkg.name;
  if (patch.found && !patch.hasInsert) problems.push('cordis.patch.yml 缺顶层 `- insert:`（市场会报 patch target not found ✗）');
  if (patch.found && patch.id && pkgName && patch.id !== pkgName) warnings.push(`patch id (${patch.id}) 与包名 (${pkgName}) 不同 —— 自定义 id 合法，确认有意`);
  if (!patch.found) warnings.push('没有 cordis.patch.yml（若通过其他方式装配可忽略）');

  return {
    root, ok: problems.length === 0,
    entry: r.rel, hasApply, registersTools,
    patch, filesFollowed: files.length - 1,
    problems, warnings,
  };
}

// ── CLI ──
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const roots = process.argv.slice(2);
  if (!roots.length) { console.error('用法: node scripts/verify-plugin.mjs <插件根目录> [...]'); process.exit(2); }
  let bad = 0;
  for (const root of roots) {
    const r = analyze(path.resolve(root));
    console.log(`\n═══ ${path.basename(path.resolve(root))} ═══`);
    console.log(`  入口: ${r.entry || '(无)'}  apply=${r.hasApply}  tools=${r.registersTools}  patch.insert=${r.patch && r.patch.hasInsert}`);
    for (const p of r.problems) console.log('  ✗ 硬伤:', p);
    for (const w of r.warnings) console.log('  ⚠ 提示:', w);
    if (r.ok) console.log('  ✓ 无硬伤');
    else bad++;
  }
  process.exit(bad ? 1 : 0);
}
