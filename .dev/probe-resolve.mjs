/**
 * 模块解析探针：在一个位于**插件真实路径**下的文件里尝试 import 各种包。
 *
 * 起因：插件是 link: 安装的，真实路径在工作区（F:\dsh work part5\dsh-planner），
 * 不在 profile 的 node_modules 里。若 Node 按 realpath 解析，那么宿主半边根本
 * import 不到 @deepseek-ai/dsh-storage-domain，冻结设计里的 ctx.storageDomain
 * 方案就会在重启后才炸。
 *
 * 这个探针必须在**真实路径**下与**profile node_modules 路径**下各跑一次，
 * 因为 DSH 加载器可能走其中任意一条。
 */
const SPECS = [
	'@deepseek-ai/dsh-storage-domain',
	'@deepseek-ai/dsh-storage',
	'@deepseek-ai/dsh-storage-json',
	'@deepseek-ai/dsh-host-webserver',
	'@deepseek-ai/schemastery',
	'zod',
	'node:fs'
];

for (const spec of SPECS) {
	try {
		const loaded = await import(spec);
		const keys = Object.keys(loaded).slice(0, 10).join(', ');
		console.log(`OK    ${spec.padEnd(38)} ${keys}`);
	} catch (error) {
		console.log(`FAIL  ${spec.padEnd(38)} ${error.code ?? error.message}`);
	}
}

/* 顺便报告本文件的真实位置，以及 Node 眼中的解析基准。 */
const { fileURLToPath } = await import('node:url');
const { realpathSync } = await import('node:fs');
console.log('');
console.log('本探针文件 :', fileURLToPath(import.meta.url));
console.log('realpath   :', realpathSync(fileURLToPath(import.meta.url)));
