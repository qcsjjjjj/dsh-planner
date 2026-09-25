/**
 * 一键跑完三套离线测试。
 *
 * 用 .mjs 而不是 .ps1：本机执行 .ps1 的是 Windows PowerShell 5.1，无 BOM 的 UTF-8
 * 文件里的中文注释会被按 GBK 解码，最坏情况会吞掉下一行语句（已踩过一次，代价是
 * 意外重启了 GUI）。测试脚本没必要冒这个风险。
 *
 * 用 `stdio: 'inherit'` 而不是管道——沙箱下捕获子进程输出会被拒。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
	['浏览器半边（日期数学 / 校验 / 排序 / 重叠 / 区间）', 'smoke-client.mjs'],
	['持久化层（node:fs / 原子写 / 撤销 / 损坏留档 / 重复计划）', 'smoke-store.mjs'],
	['宿主半边（真实 lib/index.js 的 7 条 HTTP 路由）', 'smoke-host.mjs'],
	['模型工具层（5 个工具 × 真实 schema 校验器）', 'smoke-tools.mjs']
];

const failed = [];
for (const [label, file] of suites) {
	console.log('');
	console.log('══════════════════════════════════════════════════════════════');
	console.log('  ' + label);
	console.log('══════════════════════════════════════════════════════════════');
	const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
	if (result.status !== 0) failed.push(label);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failed.length === 0) {
	console.log('全部通过。');
} else {
	console.log(`有 ${failed.length} 套失败：`);
	for (const label of failed) console.log('  - ' + label);
	process.exitCode = 1;
}
