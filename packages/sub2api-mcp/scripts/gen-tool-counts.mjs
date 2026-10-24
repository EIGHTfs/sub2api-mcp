#!/usr/bin/env node
/**
 * gen-tool-counts.mjs —— 工具数/档位文案的单一生成器（apply | check）
 *
 * 为什么要有它：工具数曾被手抄在四个地方（根 README、核心包 README、
 * 插件客户端 PROFILE_HINTS、host 默认档位常量），加一个工具就必然漏改几处，
 * 于是四处数字互相矛盾。现在**数字只从 server.js 的 toolCatalog() 派生**，
 * 由本脚本写进各文件的标记块内；标记块以外的内容一律不碰 ✓
 *
 * 用法：
 *   node scripts/gen-tool-counts.mjs apply    # 重写所有标记块内容
 *   node scripts/gen-tool-counts.mjs check    # 只比对不写，不一致 exit 1（门禁用）
 *   node scripts/gen-tool-counts.mjs check --verbose   # 打印每处期望值
 *
 * 纪律（drift-prevention）：标记块内是「生成区」，禁止手改；要改文案就改文案常量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolCounts, toolVisibleCounts } from '../src/mcp/server.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');

const own = toolCounts();
const vis = toolVisibleCounts();
const TOTAL = vis.full;

/** 各文件里的标记块（块外内容一律不碰 ✓） */
const TARGETS = [
  {
    file: path.join(REPO_ROOT, 'README.md'),
    markers: ['<!-- tool-counts:start -->', '<!-- tool-counts:end -->'],
    render: () => [
      '| 档位 | 可见工具数 | 能力 |',
      '|---|---|---|',
      `| \`readonly\` | ${vis.readonly} | 只看：状态 / 用户 / 账号 / 分组 / Key / 用量 / 上游模型 |`,
      `| \`readwrite\` | ${vis.readwrite} | + 增改：用户 / 余额 / 账号 / 分组 / Key / 对话测试 / DSH 导入导出 |`,
      `| \`full\` | ${vis.full} | + \`delete_account\`（危险） |`,
    ].join('\n'),
  },
  {
    file: path.join(REPO_ROOT, 'packages', 'sub2api-mcp', 'README.md'),
    markers: ['<!-- tool-counts:start -->', '<!-- tool-counts:end -->'],
    render: () => [
      `工具权限**三档**（累计可见口径，由 \`toolCatalog()\` 派生 ✓）：\`readonly\`（${vis.readonly}）/ \`readwrite\`（${vis.readwrite}）/ \`full\`（${vis.full}），共 ${TOTAL} 个。`,
      '',
      '| 档位 | 该档独有 | 累计可见 |',
      '|---|---|---|',
      `| **readonly** | ${own.readonly} | ${vis.readonly} |`,
      `| **readwrite** | ${own.readwrite} | ${vis.readwrite} |`,
      `| **full** | ${own.full} | ${vis.full} |`,
    ].join('\n'),
  },
  {
    // 插件设置页三档滑块提示：数组字面量，顺序 = readonly/readwrite/full
    file: path.join(REPO_ROOT, 'packages', 'dsh-plugin-sub2api', 'lib', 'client.js'),
    markers: ['// tool-counts:start', '// tool-counts:end'],
    render: () => `    const PROFILE_HINTS = ['${vis.readonly} 个工具 · 推荐', '${vis.readwrite} 个工具', '${vis.full} 个工具 · 含删除'];`,
  },
];

/** 替换标记块内容（标记行本身保留 ✓） */
function replaceBlock(text, start, end, body) {
  const si = text.indexOf(start);
  if (si < 0) return null;
  const ei = text.indexOf(end, si);
  if (ei < 0) return null;
  const before = text.slice(0, si + start.length);
  const after = text.slice(ei);
  return `${before}\n${body}\n${after}`;
}

const mode = process.argv[2] || 'check';
const verbose = process.argv.includes('--verbose');

let drifted = 0;
for (const t of TARGETS) {
  const rel = path.relative(REPO_ROOT, t.file);
  if (!fs.existsSync(t.file)) {
    console.log(`✗ ${rel} —— 文件不存在（跳过）`);
    drifted++;
    continue;
  }
  const text = fs.readFileSync(t.file, 'utf8');
  if (!text.includes(t.markers[0])) {
    console.log(`✗ ${rel} —— 缺少起始标记 ${t.markers[0]}（需先手工插入标记行）`);
    drifted++;
    continue;
  }
  const body = t.render();
  const next = replaceBlock(text, t.markers[0], t.markers[1], body);
  if (next === null) {
    console.log(`✗ ${rel} —— 缺少结束标记 ${t.markers[1]}`);
    drifted++;
    continue;
  }
  const same = next === text;
  if (verbose) console.log(`  ${rel}\n    期望:\n${body.split('\n').map((l) => '      ' + l).join('\n')}`);
  if (same) {
    console.log(`✓ ${rel}`);
    continue;
  }
  if (mode === 'apply') {
    fs.writeFileSync(t.file, next, 'utf8');
    console.log(`↻ ${rel} —— 已重写标记块`);
  } else {
    console.log(`✗ ${rel} —— 与派生值不一致（跑 apply 修正）`);
    drifted++;
  }
}

console.log(`\n派生值：独有 ${JSON.stringify(own)}｜累计 ${JSON.stringify(vis)}｜共 ${TOTAL} 个工具`);
if (mode !== 'apply' && drifted > 0) {
  console.log(`\n门禁失败：${drifted} 处漂移`);
  process.exit(1);
}
process.exit(0);
