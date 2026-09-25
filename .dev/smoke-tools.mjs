/**
 * 模型工具层的离线测试（不属于插件交付物，放在 .dev/ 下）。
 *
 * 两件事值得说明：
 *
 * 1. 它把**真实的** `lib/index.js` 装载起来，用假 ctx 捕获 `ctx.tools.register` 收到的定义，
 *    所以测的是产出代码本身，不是副本。
 * 2. 它尝试加载**真实的** `@deepseek-ai/dsh-tools`，用 `register()` 内部真正会调用的
 *    `assertSupportedJsonSchema` 校验每个工具的 `output.schema`，并用
 *    `validateJsonSchemaValue` 验证手写的 `parameters` 真的能挡住坏参数。
 *    插件本身不能 import 那个包（`link:` 安装、realpath 解析），但测试文件不受这条限制——
 *    于是"我手写的 raw JSON Schema 是否合法"这件事有了权威答案，而不是我自己的复述。
 *    **找不到 DSH 时这几条会自动跳过**，这样在没有装 DSH 的机器上（例如 CI）也能跑完。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDays, todayKey, weekdayOf } from '../lib/store.js';

/* 真实的 DSH 家目录必须在**覆盖 env 之前**记下来：下面要把 DSH_HOME 指向测试沙箱让 store
   在里面建目录，但寻找 @deepseek-ai/dsh-tools 得回到真实的家目录去找。 */
const REAL_DSH_HOME =
	process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh');

/* 必须在装载插件之前设好：store 是按 env 建根目录的。 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-planner-tools-'));
process.env.DSH_HOME = sandbox;

/**
 * 定位真实的 `@deepseek-ai/dsh-tools`。按"环境变量 → 裸包名 → DSH 各层 node_modules"
 * 顺序试；全找不到就回 null（此时调用方会跳过相关断言，而不是判失败）。
 *
 * 用发现而不是写死路径，是因为它在这台机器上位于 npx 缓存的一个哈希目录里，而
 * `_npx\<hash>` 会随 npx 版本变化——写死过一次，升级后立刻失效。
 */
async function loadRealValidator() {
	const { pathToFileURL } = await import('node:url');

	const candidates = [];
	if (process.env.DSH_TOOLS_PATH) candidates.push(pathToFileURL(process.env.DSH_TOOLS_PATH).href);
	candidates.push('@deepseek-ai/dsh-tools');
	for (const root of [
		path.join(REAL_DSH_HOME, 'profiles', 'web', 'node_modules'),
		path.join(REAL_DSH_HOME, 'profiles', 'node_modules'),
		path.join(REAL_DSH_HOME, 'node_modules')
	]) {
		candidates.push(pathToFileURL(path.join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href);
	}

	for (const candidate of candidates) {
		try {
			const loaded = await import(candidate);
			if (typeof loaded.assertSupportedJsonSchema === 'function') return loaded;
		} catch {
			/* 试下一个 */
		}
	}
	return null;
}

const failures = [];
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!ok) failures.push(label);
};
/* 必须是 async：工具的 execute 是 async 函数，里面的 throw 产生的是被拒绝的 Promise，
   同步 try 捕获不到——这一点踩过一次，20 条断言集体假失败。 */
const throws = async (label, fn, messagePart) => {
	try {
		await fn();
		check(label, false, '-> 没有抛错');
	} catch (error) {
		const ok = messagePart === undefined || String(error.message).includes(messagePart);
		check(label, ok, `-> ${error.message}`);
	}
};

/* 有些断言是 async 的，所以整体包在 main 里跑。 */
async function main() {
	/* ── 真实的 schema 校验器（找不到就跳过，不判失败） ──────────────────── */
	let assertSupportedJsonSchema = null;
	let validateJsonSchemaValue = null;
	const real = await loadRealValidator();
	if (real !== null) {
		assertSupportedJsonSchema = real.assertSupportedJsonSchema;
		validateJsonSchemaValue = real.validateJsonSchemaValue;
		check(
			'已加载真实的 dsh-tools 校验器（权威 schema 校验）',
			typeof assertSupportedJsonSchema === 'function' && typeof validateJsonSchemaValue === 'function'
		);
	} else {
		console.log('SKIP  未找到 @deepseek-ai/dsh-tools —— 跳过依赖真实校验器的断言（未安装 DSH 时属正常）');
	}

	/* ── 装载插件 ─────────────────────────────────────────────────────────── */
	const mod = await import('../lib/index.js');
	const registered = { tools: [], routes: [] };
	const fakeCtx = {
		tools: {
			register: (definition) => {
				registered.tools.push(definition);
				return () => {};
			}
		},
		webServer: {
			register: (route) => {
				registered.routes.push(route);
				return () => {};
			}
		},
		effect: (factory) => factory()
	};

	check('inject 含 tools（Agent 才看得到计划工具）', Array.isArray(mod.inject) && mod.inject.includes('tools'), `-> ${JSON.stringify(mod.inject)}`);
	check('inject 含 webServer', mod.inject.includes('webServer'));
	mod.apply(fakeCtx);

	check('注册了 5 个模型工具', registered.tools.length === 5, `-> ${registered.tools.length}`);
	const byName = {};
	for (const tool of registered.tools) byName[tool.name] = tool;

	const EXPECTED = ['planner_read', 'planner_write', 'planner_delete', 'planner_clear', 'planner_undo'];
	for (const name of EXPECTED) check(`  工具存在 ${name}`, byName[name] !== undefined);

	/* ── 结构契约：register() 会检查的那些 ───────────────────────────────── */
	for (const name of EXPECTED) {
		const tool = byName[name];
		if (tool === undefined) continue;
		check(`${name}: 有非空 description`, typeof tool.description === 'string' && tool.description.length > 80, `-> ${tool.description?.length ?? 0} 字符`);
		check(`${name}: execute 是函数`, typeof tool.execute === 'function');
		check(`${name}: output.render 是函数（register 强制要求）`, typeof tool.output?.render === 'function');
		check(`${name}: presentCall 是函数`, typeof tool.presentCall === 'function');
		check(`${name}: parameters 是 object 根`, tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object');
		check(`${name}: parameters 关掉了额外字段`, tool.parameters.additionalProperties === false);
		check(`${name}: parameters 没有用作者 DSL 的 required:true`, JSON.stringify(tool.parameters ?? {}).indexOf('"required":true') < 0);
		check(`${name}: parameters 里没有 $ref/allOf/anyOf/pattern（受支持子集之外）`, !/"\$(ref|defs)"|"allOf"|"anyOf"|"pattern"/.test(JSON.stringify(tool.parameters)));
		if (assertSupportedJsonSchema !== null) {
			try {
				assertSupportedJsonSchema(tool.output.schema);
				check(`${name}: output.schema 通过真实校验器`, true);
			} catch (error) {
				check(`${name}: output.schema 通过真实校验器`, false, `-> ${error.message}`);
			}
			/* 也顺手验一下 parameters 的合法子集（虽然 register 不校验它，模型要读它）。 */
			try {
				assertSupportedJsonSchema(tool.parameters);
				check(`${name}: parameters 也落在受支持子集内`, true);
			} catch (error) {
				check(`${name}: parameters 也落在受支持子集内`, false, `-> ${error.message}`);
			}
		}
		const view = tool.presentCall({ date: '2026-09-24', title: 'x', id: 'y', token: {} });
		check(`${name}: presentCall 返回合法卡片`, view?.card === 'generic' && typeof view.title === 'string' && ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'].includes(view.kind), `-> ${JSON.stringify(view?.kind)}`);
	}

	/* ── 名字：不能撞上任何已有工具 ─────────────────────────────────────── */
	const KNOWN = [
		'ask_user_question', 'bash', 'edit', 'read', 'read_image', 'write', 'glob', 'grep',
		'create_goal', 'get_goal', 'update_goal', 'job_kill', 'job_list', 'job_output', 'present',
		'pwsh', 'ralph', 'skill', 'str_replace_editor', 'list_subagent_models', 'interrupt_agent',
		'send_message', 'todo_write', 'web_fetch', 'web_search', 'run_code', 'find_dsh_plugin',
		'run_saved_workflow'
	];
	check('5 个名字都带 planner_ 前缀（第一方工具无一使用该前缀）', EXPECTED.every((name) => name.startsWith('planner_')));
	check('5 个名字与已知工具零冲突', EXPECTED.every((name) => KNOWN.indexOf(name) < 0));
	check('5 个名字互不重复', new Set(EXPECTED).size === 5);

	/* ── 参数 schema 真的能挡坏参数（用真实校验器） ─────────────────────── */
	if (validateJsonSchemaValue !== null) {
		const writeParams = byName.planner_write.parameters;
		check('planner_write: 合法参数通过', validateJsonSchemaValue(writeParams, { date: '2026-09-24', title: '开会' }, '').length === 0);
		check('planner_write: 缺 date 被挡', validateJsonSchemaValue(writeParams, { title: '开会' }, '').length > 0);
		check('planner_write: 缺 title 在 schema 层不再被挡（改由 handler 按新建/更新判定）', validateJsonSchemaValue(writeParams, { date: '2026-09-24' }, '').length === 0);
		check('planner_write: 多余字段被挡', validateJsonSchemaValue(writeParams, { date: '2026-09-24', title: '开会', nope: 1 }, '').length > 0);
		check('planner_write: 非法 importance 被挡', validateJsonSchemaValue(writeParams, { date: '2026-09-24', title: '开会', importance: 'urgent' }, '').length > 0);
		check('planner_write: 合法 recurrence 通过', validateJsonSchemaValue(writeParams, { date: '2026-09-24', title: '开会', recurrence: 'weekly' }, '').length === 0);

		const clearParams = byName.planner_clear.parameters;
		check('planner_clear: 必须带 confirm', clearParams.required.includes('confirm'));
		check('planner_clear: 缺 confirm 被挡', validateJsonSchemaValue(clearParams, { date: '2026-09-24' }, '').length > 0);
		check('planner_clear: confirm 必须是布尔', validateJsonSchemaValue(clearParams, { date: '2026-09-24', confirm: 'yes' }, '').length > 0);

		const undoParams = byName.planner_undo.parameters;
		check('planner_undo: token 是**可选**的（无参即撤销最近一次）', undoParams.properties.token !== undefined && (undoParams.required ?? []).length === 0);
		check('planner_undo: 空参数通过 schema', validateJsonSchemaValue(undoParams, {}, '').length === 0);
	}

	/* ── 行为：真跑 execute ─────────────────────────────────────────────── */
	const TODAY = todayKey();
	const PAST = addDays(TODAY, -2);
	const FUTURE = addDays(TODAY, 3);
	const exec = { signal: new AbortController().signal };
	const run = (name, args) => byName[name].execute(args, exec);

	/* read */
	const emptyRead = await run('planner_read', { date: FUTURE });
	check('read(单日): 空日返回空 days 与 total 0', emptyRead.total === 0 && Object.keys(emptyRead.days).length === 0);
	check('read(单日): 回传区间就是那一天', emptyRead.range.from === FUTURE && emptyRead.range.to === FUTURE);
	check('read: render 产出文本块', byName.planner_read.output.render({}, emptyRead)[0].type === 'text');

	const defaultRead = await run('planner_read', {});
	check('read(无参): 默认从今天起 7 天', defaultRead.range.from === TODAY && defaultRead.range.to === addDays(TODAY, 7), `-> ${defaultRead.range.from}..${defaultRead.range.to}`);
	await throws('read: from 与 to 必须成对', () => run('planner_read', { from: TODAY }), 'both');
	await throws('read: from 晚于 to 被拒', () => run('planner_read', { from: FUTURE, to: TODAY }), 'must not be later');
	await throws('read: 过宽区间被拒', () => run('planner_read', { from: '2020-01-01', to: '2026-12-31' }), 'too wide');
	await throws('read: 非法日期被拒', () => run('planner_read', { date: '2026/09/24' }), 'YYYY-MM-DD');

	/* write：新建 + 默认值 */
	const created = await run('planner_write', { date: FUTURE, title: '  牙医  ' });
	check('write: 新建 created=true', created.created === true);
	check('write: 标题被 trim', created.plan.title === '牙医');
	check('write: 默认时间 09:00-10:00', created.plan.start === '09:00' && created.plan.end === '10:00');
	check('write: 默认重要度 medium', created.plan.importance === 'medium');
	check('write: 回传 plan.date 与 id', created.plan.date === FUTURE && typeof created.plan.id === 'string');
	const createdId = created.plan.id;

	/* write：过去日期补记（界面禁止、工具允许） */
	const backfill = await run('planner_write', { date: PAST, title: '补记昨天的会', start: '14:00', end: '15:00' });
	check('write: 允许为过去日期新建', backfill.created === true && backfill.backfilled === true, `-> backfilled=${backfill.backfilled}`);
	check('write: 补记的 render 会提示这是过去日期', byName.planner_write.output.render({}, backfill)[0].text.includes('过去日期'));
	check(
		'write: 非过去日期不会误报 backfilled',
	(await run('planner_write', { date: FUTURE, title: '今天的事' })).backfilled === false
	);

	/* write：更新 */
	const updated = await run('planner_write', { date: FUTURE, id: createdId, title: '牙医（改）', start: '11:00', end: '12:00', importance: 'high' });
	check('write: 同 id 是更新', updated.created === false && updated.plan.title === '牙医（改）');
	check('write: 更新生效', updated.plan.start === '11:00' && updated.plan.importance === 'high');

	/* 更新时"未提及的字段沿用现值"。这是实测撞到的缺陷：模型只说"把这一次挪到 16 点"，
	   工具却把没提到的 importance 默认成 medium，把原本的"高"静默改成了"中"。 */
	const keeper = await run('planner_write', {
		date: FUTURE,
		title: '保留字段',
		content: '原始内容',
		start: '09:00',
		end: '10:00',
		importance: 'high'
	});
	const movedOnly = await run('planner_write', { date: FUTURE, id: keeper.plan.id, start: '16:00', end: '17:00' });
	check('未提及 title 时沿用', movedOnly.plan.title === '保留字段');
	check('未提及 importance 时沿用（不被掉成 medium）', movedOnly.plan.importance === 'high', `-> ${movedOnly.plan.importance}`);
	check('未提及 content 时沿用', movedOnly.plan.content === '原始内容');
	check('提及的 start/end 生效', movedOnly.plan.start === '16:00' && movedOnly.plan.end === '17:00');
	check('只改时间也能成功（title 不再是必填）', movedOnly.plan.id === keeper.plan.id);
	const clearedContent = await run('planner_write', { date: FUTURE, id: keeper.plan.id, content: '' });
	check('显式给空串可以清掉 content', clearedContent.plan.content === '');
	check('清 content 时 importance 仍沿用', clearedContent.plan.importance === 'high');

	/* 系列：显式清掉 until = 永不结束（与"不给 = 沿用"区分开）。 */
	const boundedSeries = await run('planner_write', {
		date: FUTURE,
		title: '限时系列',
		start: '08:00',
		end: '08:30',
		recurrence: 'daily',
		until: addDays(FUTURE, 3)
	});
	check('系列建时带 until', boundedSeries.plan.until === addDays(FUTURE, 3), `-> ${boundedSeries.plan.until}`);
	const seriesRenamedNoUntil = await run('planner_write', { date: FUTURE, id: boundedSeries.plan.id, title: '限时系列（改名）', scope: 'series' });
	check('系列未提及 until 时沿用', seriesRenamedNoUntil.plan.until === addDays(FUTURE, 3), `-> ${seriesRenamedNoUntil.plan.until}`);
	const untilCleared = await run('planner_write', { date: FUTURE, id: boundedSeries.plan.id, until: '', scope: 'series' });
	check('系列显式空串可清掉 until（永不结束）', untilCleared.plan.until === null, `-> ${untilCleared.plan.until}`);

	await throws('write: 新建时缺 title 被拒（handler 判定，schema 不再强制）', () => run('planner_write', { date: FUTURE }), 'is required when creating');
	await throws('write: 未知 id 被拒（而不是悄悄新建）', () => run('planner_write', { date: FUTURE, id: 'does-not-exist', title: 'x' }), 'no plan with id');
	await throws('write: 非法时间被拒', () => run('planner_write', { date: FUTURE, title: 'x', start: '9:00' }), 'HH:mm');
	await throws('write: 结束早于开始被拒', () => run('planner_write', { date: FUTURE, title: 'x', start: '10:00', end: '09:00' }), '结束时间必须晚于开始时间');
	await throws('write: 空标题被拒', () => run('planner_write', { date: FUTURE, title: '   ' }), 'non-empty');
	await throws('write: 非法 importance 被拒', () => run('planner_write', { date: FUTURE, title: 'x', importance: 'urgent' }), 'must be one of');
	await throws('write: 非法 recurrence 被拒', () => run('planner_write', { date: FUTURE, title: 'x', recurrence: 'yearly' }), 'must be one of');

	/* write：重复系列 */
	const series = await run('planner_write', { date: FUTURE, title: '每日站会', start: '09:00', end: '09:15', recurrence: 'daily' });
	const seriesId = series.plan.id;
	check('write: 建重复系列返回 scope:series', series.scope === 'series');
	const dayAfter = addDays(FUTURE, 1);
	check('write: 系列次日可见', (await run('planner_read', { date: dayAfter })).days[dayAfter].some((plan) => plan.id === seriesId));

	/* write：整个系列改名时，漏填的重复方式必须**沿用**而不是被清成不重复 */
	const seriesRenamed = await run('planner_write', { date: FUTURE, id: seriesId, title: '每日站会（改名）', scope: 'series' });
	check('write(scope=series): 漏填 recurrence 时沿用原值', seriesRenamed.plan.recurrence === 'daily', `-> ${seriesRenamed.plan.recurrence}`);
	check('write(scope=series): 改名对次日生效', (await run('planner_read', { date: dayAfter })).days[dayAfter].find((plan) => plan.id === seriesId).title === '每日站会（改名）');

	/* write：仅此一次 */
	const oneEdit = await run('planner_write', { date: dayAfter, id: seriesId, title: '只改这次', scope: 'one' });
	check('write(scope=one): 只影响这一天', oneEdit.plan.title === '只改这次');
	check('write(scope=one): 锚点不受影响', (await run('planner_read', { date: FUTURE })).days[FUTURE].find((plan) => plan.id === seriesId).title === '每日站会（改名）');

	/* delete：按 id */
	const deleted = await run('planner_delete', { date: FUTURE, id: createdId });
	check('delete: 回传被删的那条', deleted.removed?.id === createdId);
	check('delete: 回传 undo_token', Array.isArray(deleted.undo_token?.ops) && deleted.undo_token.ops.length > 0);
	check('delete: render 指向 planner_undo', byName.planner_delete.output.render({}, deleted)[0].text.includes('planner_undo'));
	check('delete: 删掉后当天读不到了', (await run('planner_read', { date: FUTURE })).days[FUTURE].every((plan) => plan.id !== createdId));

	/* delete：按标题（唯一 / 歧义 / 不存在） */
	await run('planner_write', { date: FUTURE, title: '唯一标题', start: '20:00', end: '21:00' });
	const byTitle = await run('planner_delete', { date: FUTURE, title: '唯一标题' });
	check('delete: 唯一标题可以定位', byTitle.removed?.title === '唯一标题');
	await throws('delete: 不存在的标题被拒', () => run('planner_delete', { date: FUTURE, title: '没这条' }), 'no plan titled');
	await run('planner_write', { date: FUTURE, title: '重名', start: '21:00', end: '22:00' });
	await run('planner_write', { date: FUTURE, title: '重名', start: '22:00', end: '23:00' });
	await throws('delete: 同名多条时报错并列出候选', () => run('planner_delete', { date: FUTURE, title: '重名' }), 'pass `id` instead');
	await throws('delete: id 与 title 同时给被拒', () => run('planner_delete', { date: FUTURE, id: 'x', title: 'y' }), 'only one of');
	await throws('delete: 都不给被拒', () => run('planner_delete', { date: FUTURE }), 'to say which plan');
	await throws('delete: 未知 id 被拒', () => run('planner_delete', { date: FUTURE, id: 'nope' }), 'nothing to delete');

	/* delete：跳过系列的一天（系列保留） */
	const skipped = await run('planner_delete', { date: dayAfter, id: seriesId, scope: 'one' });
	check('delete(scope=one): 这一天没了', (await run('planner_read', { date: dayAfter })).days[dayAfter]?.every((plan) => plan.id !== seriesId) ?? true);
	check('delete(scope=one): 次日照常发生', (await run('planner_read', { date: addDays(FUTURE, 2) })).days[addDays(FUTURE, 2)].some((plan) => plan.id === seriesId));
	const undoSkip = await run('planner_undo', { token: skipped.undo_token });
	check('undo: 能恢复被跳过的那一天', undoSkip.restored === true && (await run('planner_read', { date: dayAfter })).days[dayAfter].some((plan) => plan.id === seriesId));

	/* undo：恢复被删的单条 */
	await run('planner_undo', { token: deleted.undo_token });
	check('undo: 能恢复被删的单条计划', (await run('planner_read', { date: FUTURE })).days[FUTURE].some((plan) => plan.id === createdId));
	await throws('undo: 非法 token 被拒', () => run('planner_undo', { token: 'not-an-object' }), 'undo_token');
	await throws('undo: 缺 ops 的 token 被拒', () => run('planner_undo', { token: { nope: 1 } }), 'undo_token');

	/* clear */
	await throws('clear: 未传 confirm 被拒', () => run('planner_clear', { date: FUTURE }), 'confirm');
	await throws('clear: confirm 为假被拒', () => run('planner_clear', { date: FUTURE, confirm: false }), 'confirm');
	const beforeClear = (await run('planner_read', { date: FUTURE })).days[FUTURE].length;
	const seriesCountBefore = JSON.parse(fs.readFileSync(path.join(sandbox, 'storages', 'planner', 'series.json'), 'utf8')).series.length;
	const cleared = await run('planner_clear', { date: FUTURE, confirm: true });
	check('clear: 条数正确', cleared.count === beforeClear, `-> ${cleared.count} vs ${beforeClear}`);
	check('clear: 当天清空', ((await run('planner_read', { date: FUTURE })).days[FUTURE] ?? []).length === 0);
	check(
		'clear: 系列定义一条都没少（Q18 由结构保证）',
		JSON.parse(fs.readFileSync(path.join(sandbox, 'storages', 'planner', 'series.json'), 'utf8')).series.length === seriesCountBefore
	);
	check('clear: 系列次日照常发生', (await run('planner_read', { date: dayAfter })).days[dayAfter].some((plan) => plan.id === seriesId));
	check('clear: render 说清系列只是跳过', byName.planner_clear.output.render({}, cleared)[0].text.includes('系列本身保留'));
	await run('planner_undo', { token: cleared.undo_token });
	check('clear: 可整体撤销', (await run('planner_read', { date: FUTURE })).days[FUTURE].length === beforeClear);
	const emptyClear = await run('planner_clear', { date: addDays(TODAY, -30), confirm: true });
	check('clear: 空的一天不报错且说明未改动', emptyClear.count === 0 && byName.planner_clear.output.render({}, emptyClear)[0].text.includes('本来就没有计划'));

	/* 每周：参照的星期几 = date（新建时） */
	let wednesday = addDays(TODAY, 1);
	while (weekdayOf(wednesday) !== 3) wednesday = addDays(wednesday, 1);
	const weekly = await run('planner_write', { date: wednesday, title: '周会', start: '14:00', end: '15:00', recurrence: 'weekly' });
	check('write: 每周系列锚在指定日期', weekly.plan.seriesAnchor === wednesday);
	check('write: 每周次日不出现', ((await run('planner_read', { date: addDays(wednesday, 1) })).days[addDays(wednesday, 1)] ?? []).every((plan) => plan.id !== weekly.plan.id));
	check('write: 每周下周三出现', (await run('planner_read', { date: addDays(wednesday, 7) })).days[addDays(wednesday, 7)].some((plan) => plan.id === weekly.plan.id));

	/* 工作日系列锚在周末：锚点当天不发生。工具必须不崩，而且要说清楚为什么。 */
	let weekend = addDays(TODAY, 1);
	while (weekdayOf(weekend) !== 0 && weekdayOf(weekend) !== 6) weekend = addDays(weekend, 1);
	const weekendSeries = await run('planner_write', {
		date: weekend,
		title: '周末建的工作日系列',
		start: '10:00',
		end: '10:30',
		recurrence: 'weekdays'
	});
	check('write: 周末锚点仍回传非 null 的计划（否则 render 会崩）', weekendSeries.plan !== null && typeof weekendSeries.plan === 'object');
	check('write: 周末锚点 occursOnAnchor 为 false', weekendSeries.occursOnAnchor === false);
	check(
		'write: 周末锚点 firstDate 指向下一个工作日',
		weekendSeries.firstDate !== null && weekdayOf(weekendSeries.firstDate) >= 1 && weekdayOf(weekendSeries.firstDate) <= 5,
		`-> ${weekendSeries.firstDate}`
	);
	const weekendText = byName.planner_write.output.render({}, weekendSeries)[0].text;
	check('write: render 不崩，并说明当天不会有它', weekendText.includes('当天不会有这条计划'), `-> ${weekendText.split('\n').filter(Boolean).pop()}`);
	check('write: render 给出首次出现的日期', weekendText.includes(weekendSeries.firstDate));
	check('write: 锚点当天确实查不到它', ((await run('planner_read', { date: weekend })).days[weekend] ?? []).every((plan) => plan.id !== weekendSeries.plan.id));
	check(
		'write: 首次出现那天查得到它',
		(await run('planner_read', { date: weekendSeries.firstDate })).days[weekendSeries.firstDate].some((plan) => plan.id === weekendSeries.plan.id)
	);

	/* 永不发生的系列：until 早于第一个合法工作日。render 必须说明它不会出现在任何一天。 */
	const neverSeries = await run('planner_write', {
		date: weekend,
		title: '永不发生',
		start: '10:00',
		end: '10:30',
		recurrence: 'weekdays',
		until: weekend
	});
	check('write: 永不发生的系列 firstDate 为 null', neverSeries.firstDate === null);
	check(
		'write: 永不发生的系列 render 提示检查截止日期',
		byName.planner_write.output.render({}, neverSeries)[0].text.includes('检查截止日期')
	);

	/* read 的 render 里要带 id，否则模型没法删/改 */
	const listing = await run('planner_read', { date: wednesday });
	const listingText = byName.planner_read.output.render({}, listing)[0].text;
	check('read: 文本里带 id=（模型靠它删/改）', listingText.includes('id='));
	check('read: 文本里标出重复规则', listingText.includes('↻'));
	check('read: 文本里标出重要度', listingText.includes('高') || listingText.includes('中') || listingText.includes('低'));

	/* 不带参数的撤销。这是**常规**用法：模型看到的只有 render 文本，看不到结构化返回值，
	   所以它拿不到 undo_token——撤销必须能靠"刚才那一次"落盘记录完成。 */
	const undoSlot = path.join(sandbox, 'storages', 'planner', 'undo.json');
	const laterDate = addDays(TODAY, 9);
	await run('planner_write', { date: laterDate, title: '待撤销', start: '09:00', end: '10:00' });
	/* 按**标题**取，不按索引——那天还可能落着每天重复的系列（它 08:00 开始，会排在前面）。 */
	const laterPlans = (await run('planner_read', { date: laterDate })).days[laterDate];
	const laterPlan = laterPlans.find((plan) => plan.title === '待撤销');
	check('待撤销那条确实在那天', laterPlan !== undefined, `-> ${laterPlans.map((plan) => plan.title).join(' / ')}`);
	await run('planner_delete', { date: laterDate, id: laterPlan.id });
	check('delete: 落盘了"最后一次破坏性操作"', fs.existsSync(undoSlot));
	const noArgUndo = await run('planner_undo', {});
	check('undo(无参): 撤销成功', noArgUndo.restored === true && noArgUndo.operations > 0, `-> ${JSON.stringify(noArgUndo)}`);
	check('undo(无参): 回传可读的描述', typeof noArgUndo.description === 'string' && noArgUndo.description.includes('待撤销'), `-> ${noArgUndo.description}`);
	check('undo(无参): 计划确实回来了', ((await run('planner_read', { date: laterDate })).days[laterDate] ?? []).some((plan) => plan.id === laterPlan.id));
	check('undo(无参): 记录已被消费（文件清掉）', !fs.existsSync(undoSlot));
	await throws('undo(无参): 没有可撤销的东西时明确报错', () => run('planner_undo', {}), 'nothing to undo');

	/* ping 报告工具已注册 */
	const pingRoute = registered.routes.find((route) => route.path === '/dsh-planner/ping');
	check('ping 路由存在', pingRoute !== undefined);

	/* ── 收尾 ─────────────────────────────────────────────────────────── */
	fs.rmSync(sandbox, { recursive: true, force: true });
	console.log('');
	if (failures.length === 0) {
		console.log('SMOKE OK — 模型工具层可以信任。');
	} else {
		console.log(`SMOKE FAILED — ${failures.length} 项失败：`);
		for (const item of failures) console.log('  - ' + item);
		process.exitCode = 1;
	}
}

await main();
