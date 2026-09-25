/**
 * dsh-planner 宿主（node）半边。
 *
 * 两件事：
 *   1. 把 `lib/store.js`（纯 node:fs 的持久化层）挂成几条 exact HTTP 路由，
 *      供浏览器半边读写计划；
 *   2. 保留第①步的 `GET /dsh-planner/ping` 自检路由，作为常驻健康指示。
 *
 * 只用 `node:*` 内置模块 + 一个相对 import（`./store.js`）。这不是风格偏好，是硬约束：
 * 本插件是 `link:` 安装的，Node 按 realpath 解析，非内置的裸模块名一律
 * ERR_MODULE_NOT_FOUND（实测）。相对导入不受影响，因为它不查 node_modules。
 *
 * 路由形状是实测定下来的：exact 路由上 POST 完全可用（`dsh-github-accel` 的
 * 同类路由对 POST 返回 200）；`dsh-balance-tracker` 之所以对 POST 返回 405，
 * 是它自己的 handler 主动拒绝，不是承载层的限制。
 */
import { createPlanStore, StoreError, todayKey } from './store.js';
import { createPlannerTools } from './tools.js';

export const name = 'dsh-planner';

/**
 * 需要的宿主服务。
 * `tools` 是模型工具注册表（`ctx.tools`）——加上它，Agent 才能在对话里读写计划。
 */
export const inject = ['webServer', 'tools'];

/** 路由前缀。 */
const PREFIX = '/dsh-planner';

/** 请求体上限：计划是本机数据，256KB 远远够用，同时挡住意外的大包。 */
const BODY_LIMIT = 256 * 1024;

/** 把 StoreError 的 code 翻译成 HTTP 状态码。 */
function statusFor(code) {
	switch (code) {
		case 'invalid':
		case 'invalid-date':
		case 'invalid-range':
			return 400;
		case 'past-date':
			return 409;
		case 'not-found':
			return 404;
		default:
			return 500;
	}
}

/** 发一段 JSON。`content-length` 显式给字节数，别让运行时去猜多字节字符。 */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text)
	});
	res.end(text);
}

/** 读并解析 JSON 请求体。 */
function readJsonBody(req, limit = BODY_LIMIT) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			if (text.trim() === '') {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new Error('请求体不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * 把一个纯函数包成 POST 路由：统一处理"方法不对""body 不合法""StoreError"三类失败。
 * @param handler - 接收已解析的 body，返回要合并进响应的字段。
 */
function postRoute(handler) {
	return async (req, res) => {
		if (req.method !== 'POST') {
			sendJson(res, 405, { ok: false, error: 'method', message: '这个路由只接受 POST' });
			return;
		}
		let body;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			sendJson(res, 400, { ok: false, error: 'bad-body', message: error.message });
			return;
		}
		try {
			sendJson(res, 200, { ok: true, ...handler(body) });
		} catch (error) {
			if (error instanceof StoreError) {
				sendJson(res, statusFor(error.code), { ok: false, error: error.code, message: error.message });
				return;
			}
			sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
		}
	};
}

/**
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx) {
	const store = createPlanStore();
	const tools = createPlannerTools(store);

	/* 注册模型工具。宿主面的注册落在全局层，所以每个会话都能看到，不需要任何名单或开关。
	   `register()` 返回的就是注销器，挂在 ctx.effect 上即随插件卸载一起撤销。 */
	ctx.effect(() => {
		const disposers = tools.map((tool) => ctx.tools.register(tool));
		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 卸载路径上不抛：一个工具没注销掉不该阻止其余清理。 */
				}
			}
		};
	}, 'dsh-planner: model tools');

	ctx.effect(() => {
		const disposers = [];

		/* 自检：加载器确实 apply 了这个插件，存储根在哪里，以及模型工具是否已注册。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/ping`,
				handler: (_req, res) =>
					sendJson(res, 200, {
						ok: true,
						plugin: name,
						step: 5,
						storage: store.plansDir,
						series: store.seriesFile,
						recurrence: true,
						tools: tools.map((tool) => tool.name)
					})
			})
		);

		/* 读一个日期区间：日历要密度圆点，下半部分要当天计划，一次往返拿全。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/state`,
				handler: (req, res) => {
					if (req.method !== 'GET') {
						sendJson(res, 405, { ok: false, error: 'method', message: '这个路由只接受 GET' });
						return;
					}
					const url = new URL(req.url ?? '/', 'http://dsh.invalid');
					const from = url.searchParams.get('from');
					const to = url.searchParams.get('to');
					if (from === null || to === null) {
						sendJson(res, 400, { ok: false, error: 'invalid-range', message: '需要 from 与 to 两个查询参数' });
						return;
					}
					try {
						/* 顺带回传宿主认为的"今天"，客户端可据此发现两边时钟不一致。 */
						sendJson(res, 200, { ok: true, days: store.readRange(from, to), today: todayKey() });
					} catch (error) {
						if (error instanceof StoreError) {
							sendJson(res, statusFor(error.code), { ok: false, error: error.code, message: error.message });
							return;
						}
						sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
					}
				}
			})
		);

		/* 新增或更新一条计划。是新增还是更新由 id 是否已存在决定，不由客户端声称。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/save`,
				handler: postRoute((body) => store.save(body))
			})
		);

		/* 删除一条。重复计划靠 body 里的 scope 区分「仅跳过这一天」与「整个系列一起删」，
		   并回传一条撤销操作供界面用。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/delete`,
				handler: postRoute((body) => {
					const result = store.remove(body);
					return { removed: result.removed, undo: result.undo };
				})
			})
		);

		/* 勾选/取消完成。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/toggle`,
				handler: postRoute((body) => ({ plan: store.setDone(body) }))
			})
		);

		/* 一键躺平：清空该日。删掉单次计划、把重复计划在该日置为"跳过"（系列定义不动），
		   回传条数与撤销操作。 */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/wipe`,
				handler: postRoute((body) => {
					const result = store.wipe(body);
					return { removed: result.removed, undo: result.undo, count: result.count };
				})
			})
		);

		/* 撤销：把 delete / wipe 回传的操作列表做回去。
		   （它刻意绕过"过去不许新建"——否则撤销一次对过去日期的删除会是假承诺。） */
		disposers.push(
			ctx.webServer.register({
				kind: 'exact',
				path: `${PREFIX}/undo`,
				handler: postRoute((body) => store.undo(body))
			})
		);

		return () => {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch {
					/* 卸载路径上不抛：一个路由没注销掉不该阻止其余清理。 */
				}
			}
		};
	}, 'dsh-planner: http routes');
}
