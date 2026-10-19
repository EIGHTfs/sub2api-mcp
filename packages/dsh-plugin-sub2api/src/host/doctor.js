#!/usr/bin/env node
/** doctor.js — 打印当前环境的 DSH 能力自检结果（可在 DSH 内外运行） */
import { detectCapabilities, summarize } from './capabilities.js';

// 尽力拿一个"像 Cordis ctx"的对象：DSH 注入时用真 ctx；独立运行则探测全局
function getCtx() {
  const g = globalThis;
  return (g.__DSH_PLUGIN_CTX__) || (g.__dsh_ctx__) || {};
}

const report = detectCapabilities(getCtx());
console.log('═══ DSH 插件能力自检 ═══');
console.log(summarize(report));
console.log('\n原始结果:');
console.log(JSON.stringify(report, null, 2));
