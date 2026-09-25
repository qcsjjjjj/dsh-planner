/**
 * 宿主半边的离线集成测试（不属于插件交付物，放在 .dev/ 下）。
 *
 * 不是"冒烟"级别：它 import 真实的 `lib/index.js`，用假 ctx 捕获注册的路由，
 * 然后用真实的 `Readable` 喂请求体、走真实的 handler，并检查状态码、响应头
 * 与响应体。存储落在临时 `DSH_HOME` 里，所以不会碰到你的真实数据。
 *
 * 目的很具体：**在重启 dsh web 之前**就把宿主半边验证到位。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-planner-host-'));
process.env.DSH_HOME = sandbox;

const mod = await import('../lib/index.js');
const { addDays, todayKey, weekdayOf } = await import('../lib/store.js');

const failures = [];
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!ok) failures.push(label);
};

/* ── 假 ctx ───────────────────────────────────────────────────────────────── */
const routes = new Map();
const registeredTools = new Map();
const fakeCtx = {
	webServer: {
		register: (route) => {
			if (routes.has(route.path)) throw new Error(`重复注册 ${route.path}`);
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		}
	},
	/* 宿主半边现在还注册模型工具，所以假 ctx 必须带上 tools（inject 里也声明了它）。 */
	tools: {
		register: (definition) => {
			if (registeredTools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
			registeredTools.set(definition.name, definition);
			return () => registeredTools.delete(definition.name);
		}
	},
	effect: (factory) => {
		const disposer = factory();
		if (typeof disposer !== 'function') failures.push('ctx.effect 没有返回清理函数');
		return disposer;
	}
};

check('导出 name', mod.name === 'dsh-planner', `-> ${mod.name}`);
check('inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'));
check('inject 含 tools（Agent 才看得到计划工具）', Array.isArray(mod.inject) && mod.inject.includes('tools'));
mod.apply(fakeCtx);

check('顺带注册了 5 个模型工具', registeredTools.size === 5, `-> ${[...registeredTools.keys()].join(',')}`);

const EXPECTED = [
	'/dsh-planner/ping',
	'/dsh-planner/state',
	'/dsh-planner/save',
	'/dsh-planner/delete',
	'/dsh-planner/toggle',
	'/dsh-planner/wipe',
	'/dsh-planner/undo'
];
check(`注册了 ${EXPECTED.length} 条 exact 路由`, routes.size === EXPECTED.length, `-> ${routes.size}`);
for (const routePath of EXPECTED) check(`  路由存在 ${routePath}`, routes.has(routePath));
check('全部是 exact 类型', [...routes.values()].every((route) => route.kind === 'exact'));

/* ── 驱动助手 ─────────────────────────────────────────────────────────────── */
function makeRequest(method, url, body) {
	const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
	req.method = method;
	req.url = url;
	return req;
}

function makeResponse() {
	const res = {
		statusCode: undefined,
		headers: undefined,
		text: '',
		writeHead(code, headers) {
			res.statusCode = code;
			res.headers = headers;
		},
		end(text) {
			res.text = text ?? '';
		}
	};
	return res;
}

async function call(routePath, method, url, body) {
	const route = routes.get(routePath);
	if (route === undefined) throw new Error(`没有这条路由: ${routePath}`);
	const res = makeResponse();
	await route.handler(makeRequest(method, url, body), res);
	let json = null;
	try {
		json = JSON.parse(res.text);
	} catch {
		/* 留成 null，由调用方断言 */
	}
	return { status: res.statusCode, headers: res.headers, json, raw: res.text };
}

const post = (routePath, payload) => call(routePath, 'POST', routePath, JSON.stringify(payload));
const state = (from, to) => call('/dsh-planner/state', 'GET', `/dsh-planner/state?from=${from}&to=${to}`);
const seriesCount = () => {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandbox, 'storages', 'planner', 'series.json'), 'utf8')).series.length;
	} catch {
		return 0;
	}
};

const TODAY = todayKey();
const PAST = addDays(TODAY, -2);
const FUTURE = addDays(TODAY, 4);
const DAILY_ANCHOR = addDays(TODAY, 1);

/* ══════════════════════ ping ══════════════════════ */
const ping = await call('/dsh-planner/ping', 'GET', '/dsh-planner/ping');
check('ping 返回 200', ping.status === 200);
check('ping 报告 step 5', ping.json?.step === 5, `-> ${ping.json?.step}`);
check('ping 列出已注册的模型工具', Array.isArray(ping.json?.tools) && ping.json.tools.length === 5, `-> ${JSON.stringify(ping.json?.tools)}`);
check('ping 报告支持重复', ping.json?.recurrence === true);
check('ping 报告存储根（在沙箱内）', String(ping.json?.storage).startsWith(sandbox));
check('ping 带正确的 content-length', ping.headers?.['content-length'] === Buffer.byteLength(ping.raw));

/* ══════════════════════ 单次计划 ══════════════════════ */
const emptyState = await state(PAST, FUTURE);
check('空区间返回 200 与空 days', emptyState.status === 200 && Object.keys(emptyState.json.days).length === 0);
check('state 回传宿主认为的今天', emptyState.json.today === TODAY);
check('缺 from/to 返回 400', (await call('/dsh-planner/state', 'GET', '/dsh-planner/state')).status === 400);
check('state 上 POST 返回 405', (await call('/dsh-planner/state', 'POST', '/dsh-planner/state', '{}')).status === 405);

const created = await post('/dsh-planner/save', {
	date: FUTURE,
	plan: { title: '评审', content: '带上数据', start: '14:00', end: '15:00', importance: 'high' }
});
check('新建单次计划返回 created:true 与 scope:one', created.status === 200 && created.json.created === true && created.json.scope === 'one');
check('新建落到了沙箱磁盘上', fs.existsSync(path.join(sandbox, 'storages', 'planner', 'plans', `${FUTURE}.json`)));
check('非法时间返回 400', (await post('/dsh-planner/save', { date: FUTURE, plan: { title: 'x', start: '10:00', end: '09:00' } })).status === 400);
check('过去日期新建返回 409', (await post('/dsh-planner/save', { date: PAST, plan: { title: '补记', start: '09:00', end: '10:00' } })).status === 409);
check('非法 JSON 体返回 400', (await call('/dsh-planner/save', 'POST', '/dsh-planner/save', '{ 不是 JSON')).status === 400);
check('save 上 GET 返回 405', (await call('/dsh-planner/save', 'GET', '/dsh-planner/save')).status === 405);

/* ══════════════════════ 重复计划 ══════════════════════ */
const daily = await post('/dsh-planner/save', {
	date: DAILY_ANCHOR,
	plan: { title: '每日站会', content: '', start: '09:00', end: '09:15', importance: 'medium', recurrence: 'daily' }
});
check('新建重复计划返回 scope:series', daily.status === 200 && daily.json.scope === 'series' && daily.json.created === true);
const dailyId = daily.json.plan.id;
check('series.json 已建立', seriesCount() === 1, `-> ${seriesCount()}`);
check('重复计划没有被写进日期文件', !fs.existsSync(path.join(sandbox, 'storages', 'planner', 'plans', `${DAILY_ANCHOR}.json`)));

const spanned = await state(DAILY_ANCHOR, addDays(DAILY_ANCHOR, 3));
check('区间里每天都能读到这次重复', [0, 1, 2, 3].every((offset) => (spanned.json.days[addDays(DAILY_ANCHOR, offset)] ?? []).some((p) => p.id === dailyId && p.isRecurring === true)));
check('锚点之前读不到', ((await state(addDays(DAILY_ANCHOR, -2), addDays(DAILY_ANCHOR, -1))).json.days[addDays(DAILY_ANCHOR, -1)] ?? []).every((p) => p.id !== dailyId));

/* 每周系列：锚在一个周三 */
let nextWednesday = addDays(TODAY, 1);
while (weekdayOf(nextWednesday) !== 3) nextWednesday = addDays(nextWednesday, 1);
const weekly = await post('/dsh-planner/save', {
	date: nextWednesday,
	plan: { title: '周会', start: '14:00', end: '15:00', importance: 'high', recurrence: 'weekly' }
});
const weeklyId = weekly.json.plan.id;
check('每周：次日不发生', ((await state(addDays(nextWednesday, 1), addDays(nextWednesday, 1))).json.days[addDays(nextWednesday, 1)] ?? []).every((p) => p.id !== weeklyId));
check('每周：下周三发生', ((await state(addDays(nextWednesday, 7), addDays(nextWednesday, 7))).json.days[addDays(nextWednesday, 7)] ?? []).some((p) => p.id === weeklyId));

/* 截止日期经路由生效 */
const UNTIL = addDays(TODAY, 2);
const bounded = await post('/dsh-planner/save', {
	date: DAILY_ANCHOR,
	plan: { title: '限时每日', start: '11:00', end: '11:30', importance: 'low', recurrence: 'daily', until: UNTIL }
});
const boundedId = bounded.json.plan.id;
check('截止日当天仍发生', ((await state(UNTIL, UNTIL)).json.days[UNTIL] ?? []).some((p) => p.id === boundedId));
check('截止日次日不发生', ((await state(addDays(UNTIL, 1), addDays(UNTIL, 1))).json.days[addDays(UNTIL, 1)] ?? []).every((p) => p.id !== boundedId));
check('截止日期早于锚点返回 400', (await post('/dsh-planner/save', { date: FUTURE, plan: { title: 'x', start: '09:00', end: '10:00', recurrence: 'daily', until: PAST } })).status === 400);

/* ══════════════════════ 按天独立的完成状态（Q19） ══════════════════════ */
check('勾选某一天返回该天的实例', (await post('/dsh-planner/toggle', { date: DAILY_ANCHOR, id: dailyId, done: true })).json.plan.done === true);
check('那天确实是完成', ((await state(DAILY_ANCHOR, DAILY_ANCHOR)).json.days[DAILY_ANCHOR] ?? []).find((p) => p.id === dailyId).done === true);
check('次日不受影响', ((await state(addDays(DAILY_ANCHOR, 1), addDays(DAILY_ANCHOR, 1))).json.days[addDays(DAILY_ANCHOR, 1)] ?? []).find((p) => p.id === dailyId).done === false);
await post('/dsh-planner/toggle', { date: DAILY_ANCHOR, id: dailyId, done: false });

/* ══════════════════════ 作用域：仅此一次 / 整个系列（Q17） ══════════════════════ */
const OVERRIDE_DAY = addDays(DAILY_ANCHOR, 2);
const oneEdit = await post('/dsh-planner/save', {
	date: OVERRIDE_DAY,
	scope: 'one',
	plan: { id: dailyId, title: '只改这次', content: '', start: '09:30', end: '10:30', importance: 'high', recurrence: 'daily' }
});
check('仅此一次编辑返回 scope:one', oneEdit.json.scope === 'one');
check('被改那天用了覆盖值', ((await state(OVERRIDE_DAY, OVERRIDE_DAY)).json.days[OVERRIDE_DAY] ?? []).find((p) => p.id === dailyId).title === '只改这次');
check('其它天不受影响', ((await state(DAILY_ANCHOR, DAILY_ANCHOR)).json.days[DAILY_ANCHOR] ?? []).find((p) => p.id === dailyId).title === '每日站会');
check('系列总数没变（没有意外新建）', seriesCount() === 3, `-> ${seriesCount()}`);

const seriesEdit = await post('/dsh-planner/save', {
	date: DAILY_ANCHOR,
	scope: 'series',
	plan: { id: dailyId, title: '全系列改名', content: '', start: '08:00', end: '08:45', importance: 'low', recurrence: 'daily' }
});
check('整个系列改名返回 scope:series', seriesEdit.json.scope === 'series');
check('锚点跟着改名', ((await state(DAILY_ANCHOR, DAILY_ANCHOR)).json.days[DAILY_ANCHOR] ?? []).find((p) => p.id === dailyId).title === '全系列改名');
check('其它天跟着改名', ((await state(addDays(DAILY_ANCHOR, 5), addDays(DAILY_ANCHOR, 5))).json.days[addDays(DAILY_ANCHOR, 5)] ?? []).find((p) => p.id === dailyId).title === '全系列改名');
check('此前"仅此一次"的那天仍保留覆盖值', ((await state(OVERRIDE_DAY, OVERRIDE_DAY)).json.days[OVERRIDE_DAY] ?? []).find((p) => p.id === dailyId).title === '只改这次');
check('把系列改成不重复返回 400', (await post('/dsh-planner/save', { date: DAILY_ANCHOR, scope: 'series', plan: { id: dailyId, title: 'x', start: '09:00', end: '10:00', recurrence: null } })).status === 400);

/* ══════════════════════ 跳过一次 / 删除整个系列 ══════════════════════ */
const SKIP_DAY = addDays(DAILY_ANCHOR, 1);
const skip = await post('/dsh-planner/delete', { date: SKIP_DAY, id: dailyId, scope: 'one' });
check('仅跳过该日：那天没了', ((await state(SKIP_DAY, SKIP_DAY)).json.days[SKIP_DAY] ?? []).every((p) => p.id !== dailyId));
check('仅跳过该日：系列还在', seriesCount() === 3);
check('仅跳过该日：次日照常发生', ((await state(addDays(SKIP_DAY, 1), addDays(SKIP_DAY, 1))).json.days[addDays(SKIP_DAY, 1)] ?? []).some((p) => p.id === dailyId));
check('仅跳过该日：回传 unskip 撤销操作', skip.json.undo?.[0]?.op === 'unskip');
await post('/dsh-planner/undo', { ops: skip.json.undo });
check('撤销跳过后那天回来了', ((await state(SKIP_DAY, SKIP_DAY)).json.days[SKIP_DAY] ?? []).some((p) => p.id === dailyId));

const seriesDelete = await post('/dsh-planner/delete', { date: DAILY_ANCHOR, id: dailyId, scope: 'series' });
check('删除整个系列：那天没了', ((await state(DAILY_ANCHOR, DAILY_ANCHOR)).json.days[DAILY_ANCHOR] ?? []).every((p) => p.id !== dailyId));
check('删除整个系列：其它天也没了', ((await state(addDays(DAILY_ANCHOR, 3), addDays(DAILY_ANCHOR, 3))).json.days[addDays(DAILY_ANCHOR, 3)] ?? []).every((p) => p.id !== dailyId));
check('删除整个系列：系列数 -1', seriesCount() === 2, `-> ${seriesCount()}`);
check('删除整个系列：回传 putSeries 撤销操作', seriesDelete.json.undo?.[0]?.op === 'putSeries');
await post('/dsh-planner/undo', { ops: seriesDelete.json.undo });
check('撤销删除整个系列后各天都回来', ((await state(DAILY_ANCHOR, DAILY_ANCHOR)).json.days[DAILY_ANCHOR] ?? []).some((p) => p.id === dailyId));
check('撤销后系列数恢复', seriesCount() === 3, `-> ${seriesCount()}`);

/* ══════════════════════ 单次计划的删除与撤销 ══════════════════════ */
const removedOne = await post('/dsh-planner/delete', { date: FUTURE, id: created.json.plan.id, scope: 'one' });
check('单次计划删除回传 removed 与 putPlan 撤销操作', removedOne.json.removed?.id === created.json.plan.id && removedOne.json.undo?.[0]?.op === 'putPlan');
check('删除不存在的返回 removed:null', (await post('/dsh-planner/delete', { date: FUTURE, id: 'nope' })).json.removed === null);
await post('/dsh-planner/undo', { ops: removedOne.json.undo });
check('撤销后单次计划回来', ((await state(FUTURE, FUTURE)).json.days[FUTURE] ?? []).some((p) => p.id === created.json.plan.id));

/* 撤销过去日期的删除：先注入（模拟当年建的），删掉，再撤销 */
await post('/dsh-planner/undo', {
	ops: [
		{
			op: 'putPlan',
			date: PAST,
			plan: {
				id: 'legacy-http',
				title: '旧会',
				content: '',
				start: '09:00',
				end: '10:00',
				importance: 'low',
				done: false,
				createdAt: '2026-01-01T00:00:00.000Z'
			}
		}
	]
});
const pastRemoved = await post('/dsh-planner/delete', { date: PAST, id: 'legacy-http' });
check('过去日期可以删除', pastRemoved.json.removed?.id === 'legacy-http');
await post('/dsh-planner/undo', { ops: pastRemoved.json.undo });
check('过去日期的撤销成功（绕过"过去不许新建"）', ((await state(PAST, PAST)).json.days[PAST] ?? []).some((p) => p.id === 'legacy-http'));

/* ══════════════════════ 躺平与重复计划（Q18） ══════════════════════ */
const WIPE_DAY = addDays(TODAY, 2);
await post('/dsh-planner/save', { date: WIPE_DAY, plan: { title: '那天的一次性事', start: '16:00', end: '17:00' } });
const seriesBefore = seriesCount();
const wiped = await post('/dsh-planner/wipe', { date: WIPE_DAY });
check('躺平返回条数与 undone', wiped.json.count === wiped.json.removed.length && wiped.json.count >= 2, `-> ${wiped.json.count}`);
check('躺平后该日为空', ((await state(WIPE_DAY, WIPE_DAY)).json.days[WIPE_DAY] ?? []).length === 0);
check('躺平没有删掉任何系列定义（Q18）', seriesCount() === seriesBefore, `-> ${seriesCount()} vs ${seriesBefore}`);
check('躺平的撤销列表含两类操作', wiped.json.undo.some((op) => op.op === 'putPlan') && wiped.json.undo.some((op) => op.op === 'unskip'));
await post('/dsh-planner/undo', { ops: wiped.json.undo });
check('躺平可整体撤销', ((await state(WIPE_DAY, WIPE_DAY)).json.days[WIPE_DAY] ?? []).length === wiped.json.count, `-> ${((await state(WIPE_DAY, WIPE_DAY)).json.days[WIPE_DAY] ?? []).length}`);

/* 在系列的锚点当天躺平，系列必须存活 */
const anchored = await post('/dsh-planner/save', {
	date: addDays(TODAY, 3),
	plan: { title: '锚点系列', start: '07:00', end: '07:30', importance: 'low', recurrence: 'daily' }
});
const anchorDay = addDays(TODAY, 3);
const anchorWipe = await post('/dsh-planner/wipe', { date: anchorDay });
check('在锚点当天躺平：当天清空', ((await state(anchorDay, anchorDay)).json.days[anchorDay] ?? []).every((p) => p.id !== anchored.json.plan.id));
check('在锚点当天躺平：系列仍在', seriesCount() === seriesBefore + 1);
check('在锚点当天躺平：次日照常发生', ((await state(addDays(anchorDay, 1), addDays(anchorDay, 1))).json.days[addDays(anchorDay, 1)] ?? []).some((p) => p.id === anchored.json.plan.id));
await post('/dsh-planner/undo', { ops: anchorWipe.json.undo });
check('在锚点当天躺平的撤销能恢复', ((await state(anchorDay, anchorDay)).json.days[anchorDay] ?? []).some((p) => p.id === anchored.json.plan.id));

/* ══════════════════════ 损坏的 series.json ══════════════════════ */
const seriesFile = path.join(sandbox, 'storages', 'planner', 'series.json');
const goodSeriesText = fs.readFileSync(seriesFile, 'utf8');
fs.writeFileSync(seriesFile, 'not json at all', 'utf8');
const brokenState = await state(TODAY, FUTURE);
check('series.json 损坏时 state 返回 500 而不是假装没数据', brokenState.status === 500, `-> ${brokenState.status}`);
check('series.json 损坏时被留档', fs.readdirSync(path.dirname(seriesFile)).some((n) => n.includes('series.json.corrupt-')));
fs.writeFileSync(seriesFile, goodSeriesText, 'utf8');
check('恢复后重复计划照常展开', ((await state(anchorDay, anchorDay)).json.days[anchorDay] ?? []).some((p) => p.id === anchored.json.plan.id));

/* ══════════════════════ 卸载路径 ══════════════════════ */
check('effect 返回的清理函数可调用', typeof fakeCtx.effect(() => () => {}) === 'function');

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failures.length === 0) {
	console.log('SMOKE OK — 宿主半边（含全部 HTTP 路由与重复计划）可以安全加载。');
} else {
	console.log(`SMOKE FAILED — ${failures.length} 项失败：`);
	for (const item of failures) console.log('  - ' + item);
	process.exitCode = 1;
}
