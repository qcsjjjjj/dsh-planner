/**
 * dsh-planner 的**模型工具层**：把 `lib/store.js` 暴露给 Agent。
 *
 * ── 为什么这里一个 DSH 包都不 import ──────────────────────────────────────────
 *
 * 本插件是 `link:` 安装的，Node 按 realpath 解析，于是宿主半边只能 import **内置模块**
 * 与**相对文件**（实测：`@deepseek-ai/dsh-tools` 从真实路径与 profile 符号链接路径
 * 都抛 ERR_MODULE_NOT_FOUND）。所以：
 *
 *   - `ctx.tools` 这个服务是**从 cordis 上下文上取的**，不需要 import 任何东西；
 *   - `parameters` / `output.schema` 手写 **raw JSON Schema**，而不是 `defineTool` 那套
 *     作者 DSL——`defineTool` 会调 `parameterSchemaSpecToJsonSchema` 做编译，而
 *     `ctx.tools.register()` 自己**只校验 `output.schema`**，`parameters` 原样透传。
 *     写作者 DSL 会得到一个模型看不懂的 schema。
 *
 * 这不是我的发明：本机已有的 `dsh-workflow-cards` 就是这么写的，它的头部注释写着
 * "Nothing here imports a DSH package: every service is read off the cordis context
 * at call time, and the tool is registered as a plain definition."
 *
 * ── 三条硬约束 ────────────────────────────────────────────────────────────────
 *
 * 1. **受支持的 schema 关键字只有** `type`（单一类型，不能是数组）/ `oneOf` / `properties` /
 *    `required` / `additionalProperties` / `items` / `enum` / `const`，外加注解
 *    `description` / `title` / `default` / `examples`。**没有 `$ref` / `allOf` / `anyOf` /
 *    `pattern`**，所以可选字段靠"不进 `required` 数组"表达，而不是 `anyOf`。
 * 2. **raw 定义不会被校验参数**（只有 `defineTool` 才包那层校验），而 `args` 还是深冻结的。
 *    所以下面每个 execute 都自己做窄化，并给出人能看懂、模型能照做的报错。
 * 3. **返回值会被 `output.schema` 校验**，不符就抛 `ToolOutputError`。凡形状动态的输出，
 *    一律声明成 `{ type:'object', additionalProperties:true }`（先例同此）。
 *
 * 报错一律靠 `throw`：运行时捕获后模型会看到 `Error: <消息>`。
 */
import { addDays, todayKey, weekdayOf, TITLE_MAX, CONTENT_MAX } from './store.js';

/** 一次读取最多跨多少天，挡住病态的宽区间。 */
const MAX_RANGE_DAYS = 366;
/** 读取时不带参数时的默认跨度：今天起 7 天。 */
const DEFAULT_SPAN_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IMPORTANCE_IDS = ['high', 'medium', 'low'];
const RECURRENCE_IDS = ['daily', 'weekly', 'weekdays'];
const IMPORTANCE_LABEL = { high: '高', medium: '中', low: '低' };
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/* ──────────────────────────── 参数窄化 ──────────────────────────── */
/* raw 定义没有自动校验，这一节就是替代品：每条报错都要说清"收到了什么、应该给什么"。 */

function requireDate(args, name = 'date') {
	const value = args?.[name];
	if (typeof value !== 'string' || !DATE_RE.test(value)) {
		throw new Error(`\`${name}\` must be a local date in YYYY-MM-DD form; got ${JSON.stringify(value)}`);
	}
	return value;
}

function optionalDate(args, name) {
	const value = args?.[name];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || !DATE_RE.test(value)) {
		throw new Error(`\`${name}\` must be a local date in YYYY-MM-DD form; got ${JSON.stringify(value)}`);
	}
	return value;
}

function requireText(args, name, max) {
	const value = args?.[name];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`\`${name}\` must be a non-empty string; got ${JSON.stringify(value)}`);
	}
	const text = value.trim();
	if (text.length > max) {
		throw new Error(`\`${name}\` must be at most ${max} characters; got ${text.length}`);
	}
	return text;
}

function optionalText(args, name, max) {
	const value = args?.[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string; got ${typeof value}`);
	if (value.length > max) throw new Error(`\`${name}\` must be at most ${max} characters; got ${value.length}`);
	return value;
}

function optionalTime(args, name) {
	const value = args?.[name];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || !TIME_RE.test(value)) {
		throw new Error(`\`${name}\` must be a 24-hour local time in HH:mm form; got ${JSON.stringify(value)}`);
	}
	return value;
}

function optionalEnum(args, name, allowed) {
	const value = args?.[name];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || allowed.indexOf(value) < 0) {
		throw new Error(
			`\`${name}\` must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}; got ${JSON.stringify(value)}`
		);
	}
	return value;
}

/** 两个日期之间的整天数（含首尾）。 */
function daysBetween(from, to) {
	const [fy, fm, fd] = from.split('-').map(Number);
	const [ty, tm, td] = to.split('-').map(Number);
	const start = Date.UTC(fy, fm - 1, fd);
	const end = Date.UTC(ty, tm - 1, td);
	return Math.round((end - start) / 86400000) + 1;
}

/* ──────────────────────────── 展示格式 ──────────────────────────── */

/** 用中文说清一条重复规则。 */
function recurrenceLabel(recurrence, anchor) {
	if (recurrence === 'daily') return '每天';
	if (recurrence === 'weekdays') return '每个工作日';
	if (recurrence === 'weekly') return '每周' + WEEKDAY_NAMES[weekdayOf(anchor)];
	return '';
}

/** 一条计划一行，带上删除/更新所需的 id。 */
function formatPlan(plan) {
	const head = [`  ${plan.start}-${plan.end}`, IMPORTANCE_LABEL[plan.importance] ?? plan.importance];
	if (plan.done === true) head.push('已完成');
	head.push(plan.title);
	head.push(`id=${plan.id}`);
	const marks = [];
	if (plan.isRecurring === true) marks.push('↻' + recurrenceLabel(plan.recurrence, plan.seriesAnchor ?? plan.date));
	if (plan.overridden === true) marks.push('这一次已单独修改');
	const content =
		typeof plan.content === 'string' && plan.content.trim() !== '' ? '\n      ' + plan.content.replace(/\n/g, '\n      ') : '';
	return head.join('  ') + (marks.length > 0 ? `  （${marks.join('；')}）` : '') + content;
}

/** 一整个日期区间，按日期分组。 */
function formatDays(days, from, to) {
	const keys = Object.keys(days).sort();
	if (keys.length === 0) return `${from} 到 ${to} 没有任何计划。`;
	const today = todayKey();
	const out = [];
	for (const key of keys) {
		out.push(key + (key === today ? '（今天）' : ''));
		for (const plan of days[key]) out.push(formatPlan(plan));
	}
	return out.join('\n');
}

/** 给动态形状的输出用：`register()` 只校验这个 schema。 */
const OPEN_OUTPUT = { type: 'object', additionalProperties: true };

/* ──────────────────────────── 五个工具 ──────────────────────────── */

/**
 * `planner_read` —— 读。
 * @param store - `lib/store.js` 建出来的存储实例。
 */
function readTool(store) {
	return {
		name: 'planner_read',
		description:
			"Read the user's personal planner (the 计划 tab of the Web GUI). Returns every plan for one date, or for an inclusive date range, " +
			"including each plan's `id` — which `planner_write`, `planner_delete` and `planner_clear` need. " +
			'Call it before changing anything the user described only vaguely, and again after a write when you want to confirm the result. ' +
			`With no arguments it returns today plus the next ${DEFAULT_SPAN_DAYS} days. All dates are local YYYY-MM-DD.`,
		parameters: {
			type: 'object',
			properties: {
				date: {
					type: 'string',
					description: 'A single local date (YYYY-MM-DD). When given, `from`/`to` are ignored.'
				},
				from: { type: 'string', description: 'First date of an inclusive range (YYYY-MM-DD). Pass together with `to`.' },
				to: { type: 'string', description: 'Last date of an inclusive range (YYYY-MM-DD). Pass together with `from`.' }
			},
			required: [],
			additionalProperties: false
		},
		output: {
			schema: OPEN_OUTPUT,
			render(_args, value) {
				return [{ type: 'text', text: formatDays(value.days, value.range.from, value.range.to) }];
			}
		},
		presentCall(args) {
			const scope =
				args !== null && typeof args === 'object' && typeof args.date === 'string'
					? args.date
					: args !== null && typeof args === 'object' && typeof args.from === 'string'
						? `${args.from} → ${args.to ?? '?'}`
						: '接下来一周';
			return { card: 'generic', title: `读取计划：${scope}`, kind: 'read', rawInput: args };
		},
		async execute(rawArgs, exec) {
			exec?.signal?.throwIfAborted?.();
			const args = rawArgs ?? {};

			const single = optionalDate(args, 'date');
			let from;
			let to;
			if (single !== undefined) {
				from = single;
				to = single;
			} else {
				const start = optionalDate(args, 'from');
				const end = optionalDate(args, 'to');
				if (start !== undefined && end !== undefined) {
					from = start;
					to = end;
				} else if (start !== undefined || end !== undefined) {
					throw new Error('pass both `from` and `to`, or neither');
				} else {
					from = todayKey();
					to = addDays(from, DEFAULT_SPAN_DAYS);
				}
			}
			if (from > to) throw new Error(`\`from\` (${from}) must not be later than \`to\` (${to})`);
			const span = daysBetween(from, to);
			if (span > MAX_RANGE_DAYS) throw new Error(`range too wide: ${span} days (max ${MAX_RANGE_DAYS})`);

			const days = store.readRange(from, to);
			let total = 0;
			for (const key of Object.keys(days)) total += days[key].length;
			return { range: { from, to }, total, today: todayKey(), days };
		}
	};
}

/** 这个 id 到底是这条日期上的单次计划，还是某个重复系列。 */
function seriesById(store, id) {
	const found = store.readSeries().find((entry) => entry.id === id);
	return found === undefined ? null : found;
}

/** 某条 id 是否存在于该日期（单次计划）或全局（重复系列）。 */
function planExists(store, date, id) {
	if (seriesById(store, id) !== null) return true;
	return store.readDay(date).some((plan) => plan.id === id && plan.isRecurring === false);
}

/**
 * `planner_write` —— 建 / 改。
 * @param store - 存储实例。
 */
function writeTool(store) {
	return {
		name: 'planner_write',
		description:
			"Create or update one plan in the user's personal planner. Without `id` it creates a new plan on `date`, and then `title` is required; " +
			'with `id` it updates that plan, and **every field you omit keeps its current value** (so you can move one occurrence without restating the rest). ' +
			"Set `recurrence` to make it repeat: `daily`, `weekly` (same weekday as `date`, or as the series' original start date when editing a whole series), " +
			'or `weekdays` (Monday–Friday); `until` optionally stops the repetition. ' +
			'When the plan already belongs to a recurring series, `scope` says whether the change applies to `one` occurrence (the default) or the whole `series`. ' +
			'Times are local `HH:mm` and `end` must be later than `start`. ' +
			'Creating a plan on a PAST date is allowed by this tool even though the GUI blocks it — do that only when the user explicitly asks you to record ' +
			'something retroactively, and mention the date in your reply so they can see it.',
		parameters: {
			type: 'object',
			properties: {
				date: { type: 'string', description: 'The local date the plan belongs to (YYYY-MM-DD).' },
				title: { type: 'string', description: `Short imperative title, at most ${TITLE_MAX} characters. Required when creating; optional when updating by \`id\`.` },
				content: { type: 'string', description: `Optional free-form detail, at most ${CONTENT_MAX} characters.` },
				start: { type: 'string', description: 'Start time HH:mm. Defaults to 09:00.' },
				end: { type: 'string', description: 'End time HH:mm, strictly later than `start`. Defaults to 10:00.' },
				importance: { type: 'string', enum: IMPORTANCE_IDS, description: 'Defaults to medium.' },
				recurrence: { type: 'string', enum: RECURRENCE_IDS, description: 'Omit for a one-off plan.' },
				until: { type: 'string', description: 'Last date the repetition happens (YYYY-MM-DD). Omit to repeat forever.' },
				id: { type: 'string', description: 'Update the plan with this id (from `planner_read`) instead of creating a new one.' },
				scope: {
					type: 'string',
					enum: ['one', 'series'],
					description: 'For a plan inside a recurring series: change only this occurrence (default) or the whole series.'
				}
			},
			required: ['date'],
			additionalProperties: false
		},
		output: {
			schema: OPEN_OUTPUT,
			render(_args, value) {
				const plan = value.plan;
				const lines = [
					`${value.created === true ? '已创建' : '已更新'}计划：${plan.start}-${plan.end}  ${plan.title}  id=${plan.id}`,
					`  日期 ${plan.date}  重要度 ${IMPORTANCE_LABEL[plan.importance] ?? plan.importance}` +
						(plan.recurrence === null ? '  不重复' : `  重复：${recurrenceLabel(plan.recurrence, plan.seriesAnchor ?? plan.date)}`)
				];
				if (value.backfilled === true) {
					lines.push(`  注意：这是为**过去日期**（${plan.date}）补记的计划——界面上的「新建」按钮不允许这样做，请向用户说明。`);
				}
				/* 锚点当天不发生：最典型的是"工作日"规则锚在周末。必须说清楚，否则
				   用户会以为没保存成功（那天的列表里确实看不到它）。 */
				if (value.occursOnAnchor === false) {
					lines.push(
						`  注意：${plan.date} 当天不会有这条计划（${recurrenceLabel(plan.recurrence, plan.seriesAnchor ?? plan.date)}规则不覆盖那一天）` +
							(value.firstDate === null ? '，且它不会在任何一天发生——请检查截止日期。' : `；它首次出现在 ${value.firstDate}。`)
					);
				}
				return [{ type: 'text', text: lines.join('\n') }];
			}
		},
		presentCall(args) {
			const title = args !== null && typeof args === 'object' && typeof args.title === 'string' ? args.title : '?';
			const updating = args !== null && typeof args === 'object' && typeof args.id === 'string';
			return { card: 'generic', title: `${updating ? '更新' : '新建'}计划「${title}」`, kind: 'edit', rawInput: args };
		},
		async execute(rawArgs, exec) {
			exec?.signal?.throwIfAborted?.();
			const args = rawArgs ?? {};

			const date = requireDate(args);
			const id = optionalText(args, 'id', 200);
			const scope = optionalEnum(args, 'scope', ['one', 'series']) ?? 'one';

			/* 更新时的"当前值"。**没给的字段一律沿用，绝不掉回默认值。**
			   理由很具体，而且是实测撞到的：模型说"把这一次挪到 16 点"时不会重复列出重要度，
			   若把未提及的字段默认成 medium，就会把原本的"高"静默改成"中"——一次对未提及
			   字段的数据丢失，界面上完全看不出来。 */
			let base = null;
			if (id !== undefined) {
				if (planExists(store, date, id) === false) {
					throw new Error(
						`no plan with id ${JSON.stringify(id)} exists on ${date} (nor as a recurring series). ` +
							'Read `planner_read` first, or omit `id` to create a new plan.'
					);
				}
				if (scope === 'series') {
					base = seriesById(store, id);
				} else {
					/* 只改这一次时要沿用**这一天实际生效的值**（系列基础值叠加当天覆盖），
					   也就是用户在界面上看到的那些；那天不发生则退回系列定义。 */
					base = store.readDay(date).find((plan) => plan.id === id) ?? seriesById(store, id);
				}
			}

			/** 参数里到底有没有给这个字段——用来区分"没给"（沿用）与"给空"（明确清掉）。 */
			const has = (name) => Object.prototype.hasOwnProperty.call(args, name);
			const inherited = (name) => (base === null ? undefined : base[name]);

			const rawTitle = has('title') ? requireText(args, 'title', TITLE_MAX) : inherited('title');
			if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
				throw new Error('`title` is required when creating a new plan (it is optional only when updating an existing one by `id`)');
			}

			const plan = {
				title: rawTitle.trim(),
				content: has('content') ? (optionalText(args, 'content', CONTENT_MAX) ?? '') : (inherited('content') ?? ''),
				start: optionalTime(args, 'start') ?? inherited('start') ?? '09:00',
				end: optionalTime(args, 'end') ?? inherited('end') ?? '10:00',
				importance: optionalEnum(args, 'importance', IMPORTANCE_IDS) ?? inherited('importance') ?? 'medium',
				/* 显式给 null / 空串 = 明确要清掉（例如"取消截止日期"）；不给 = 沿用。 */
				recurrence: has('recurrence')
					? (optionalEnum(args, 'recurrence', RECURRENCE_IDS) ?? null)
					: (inherited('recurrence') ?? null),
				until: has('until') ? (optionalDate(args, 'until') ?? null) : (inherited('until') ?? null)
			};
			if (id !== undefined) plan.id = id;

			const result = store.save({ date, plan, scope, allowPastCreate: true });
			/* 整份展开而不是逐个列举字段：store 的返回里有 `occursOnAnchor` / `firstDate`
			   这类 render 要用到的信息，逐个列举漏一个就会变成"警告永远不显示"甚至崩掉。 */
			return { ...result, created: result.created === true, backfilled: result.created === true && date < todayKey() };
		}
	};
}

/**
 * `planner_delete` —— 删一条（可撤销）。
 * @param store - 存储实例。
 */
function deleteTool(store) {
	return {
		name: 'planner_delete',
		description:
			"Delete one plan from the user's personal planner. Identify it by `id` (from `planner_read`), or by `title` when that title is unique on the date. " +
			'If the plan belongs to a recurring series, `scope` decides whether only this `one` occurrence is skipped (the default, and the series is preserved) ' +
			'or the whole `series` is removed. A single `planner_undo` with no arguments undoes the most recent delete. ' +
			'This is reversible — prefer it over `planner_clear` whenever a single plan is meant.',
		parameters: {
			type: 'object',
			properties: {
				date: { type: 'string', description: 'The local date the plan is on (YYYY-MM-DD).' },
				id: { type: 'string', description: 'The plan id from `planner_read`.' },
				title: { type: 'string', description: 'Exact title, as an alternative to `id` when it is unique on that date.' },
				scope: {
					type: 'string',
					enum: ['one', 'series'],
					description: 'For a plan inside a recurring series: skip only this occurrence (default) or delete the whole series.'
				}
			},
			required: ['date'],
			additionalProperties: false
		},
		output: {
			schema: OPEN_OUTPUT,
			render(_args, value) {
				const plan = value.removed;
				return [
					{
						type: 'text',
						text:
							`已删除：${plan.start}-${plan.end}  ${plan.title}（${plan.date}）` +
							(value.scope === 'series' ? '\n  整个重复系列已删除。' : plan.isRecurring === true ? '\n  仅跳过这一天，系列保留。' : '') +
							'\n  如需撤销，调用 planner_undo（不带参数即撤销刚才这一次）。'
					}
				];
			}
		},
		presentCall(args) {
			const what =
				args !== null && typeof args === 'object' && typeof args.title === 'string'
					? args.title
					: args !== null && typeof args === 'object' && typeof args.id === 'string'
						? args.id
						: '?';
			return { card: 'generic', title: `删除计划「${what}」`, kind: 'delete', rawInput: args };
		},
		async execute(rawArgs, exec) {
			exec?.signal?.throwIfAborted?.();
			const args = rawArgs ?? {};

			const date = requireDate(args);
			const id = optionalText(args, 'id', 200);
			const title = optionalText(args, 'title', TITLE_MAX);
			const scope = optionalEnum(args, 'scope', ['one', 'series']) ?? 'one';

			if (id === undefined && title === undefined) {
				throw new Error('pass `id` (from `planner_read`) or `title` to say which plan to delete');
			}
			if (id !== undefined && title !== undefined) {
				throw new Error('pass only one of `id` or `title`');
			}

			let resolved = id;
			if (resolved === undefined) {
				const matches = store.readDay(date).filter((plan) => plan.title === title);
				if (matches.length === 0) {
					throw new Error(`no plan titled ${JSON.stringify(title)} on ${date}`);
				}
				if (matches.length > 1) {
					const ids = matches.map((plan) => `${plan.id} (${plan.start})`).join(', ');
					throw new Error(
						`${matches.length} plans on ${date} are titled ${JSON.stringify(title)}; pass \`id\` instead. Candidates: ${ids}`
					);
				}
				resolved = matches[0].id;
			}

			const result = store.remove({ date, id: resolved, scope });
			if (result.removed === null || result.removed === undefined) {
				throw new Error(`nothing to delete: no plan with id ${JSON.stringify(resolved)} on ${date}`);
			}
			return { removed: result.removed, scope, undo_token: { ops: result.undo } };
		}
	};
}

/**
 * `planner_clear` —— 清空一整天（一键躺平的对应工具）。
 * 必须显式传 `confirm: true`：这是"参数上的减速带"，逼模型主动确认一次，
 * 而不是顺手调用一个删除就把一整天清掉。本会话的审批提示是禁用的，所以审批那条路不可用。
 * @param store - 存储实例。
 */
function clearTool(store) {
	return {
		name: 'planner_clear',
		description:
			"Clear one whole day in the user's personal planner — the same operation as the GUI's 一键躺平 button. " +
			'DESTRUCTIVE: every one-off plan on `date` is really deleted, while plans that belong to a recurring series are only skipped for that day, ' +
			'their series being preserved. Requires `confirm: true`; pass it ONLY when the user actually asked for the whole day to be cleared, ' +
			'never while tidying up. A `planner_undo` with no arguments restores it. To remove a single plan use `planner_delete` instead.',
		parameters: {
			type: 'object',
			properties: {
				date: { type: 'string', description: 'The local date to clear (YYYY-MM-DD).' },
				confirm: { type: 'boolean', description: 'Must be exactly true. Confirms the user asked for the whole day to be cleared.' }
			},
			required: ['date', 'confirm'],
			additionalProperties: false
		},
		output: {
			schema: OPEN_OUTPUT,
			render(_args, value) {
				if (value.count === 0) return [{ type: 'text', text: `${value.date} 本来就没有计划，未做改动。` }];
				const names = value.removed.map((plan) => plan.title).join('、');
				return [
					{
						type: 'text',
						text:
							`已清空 ${value.date} 的 ${value.count} 条计划：${names}\n` +
							'  其中属于重复系列的只是跳过了这一天，系列本身保留。\n' +
							'  如需撤销，调用 planner_undo（不带参数即撤销刚才这一次）。'
					}
				];
			}
		},
		presentCall(args) {
			const date = args !== null && typeof args === 'object' && typeof args.date === 'string' ? args.date : '?';
			return { card: 'generic', title: `清空 ${date} 的全部计划`, kind: 'delete', rawInput: args };
		},
		async execute(rawArgs, exec) {
			exec?.signal?.throwIfAborted?.();
			const args = rawArgs ?? {};

			const date = requireDate(args);
			if (args.confirm !== true) {
				throw new Error(
					'`confirm` must be exactly true. planner_clear deletes every plan on that date; ' +
						'pass confirm: true only when the user asked for the whole day to be cleared. ' +
						'To remove a single plan, use planner_delete.'
				);
			}

			const result = store.wipe({ date });
			return { date, count: result.count, removed: result.removed, undo_token: { ops: result.undo } };
		}
	};
}

/**
 * `planner_undo` —— 撤销上一次删除/清空。
 * 工具没有界面那个 5 秒撤销条，所以必须自带退路，否则删错了就是单程票。
 * @param store - 存储实例。
 */
function undoTool(store) {
	return {
		name: 'planner_undo',
		description:
			'Undo the most recent `planner_delete` or `planner_clear`. Call it with NO arguments — that is the normal case, and it restores whatever the last destructive call removed. ' +
			'Pass `token` only when you hold an explicit `undo_token` for one specific earlier call. Each undo can be used once; plans that already exist again are left alone.',
		parameters: {
			type: 'object',
			properties: {
				token: {
					type: 'object',
					additionalProperties: true,
					description: 'Optional. The `undo_token` from one specific earlier planner_delete / planner_clear; omit it to undo the most recent one.'
				}
			},
			required: [],
			additionalProperties: false
		},
		output: {
			schema: OPEN_OUTPUT,
			render(_args, value) {
				const what = typeof value.description === 'string' && value.description !== '' ? `：${value.description}` : '';
				return [{ type: 'text', text: `已撤销（${value.operations} 项操作已回放）${what}` }];
			}
		},
		presentCall() {
			return { card: 'generic', title: '撤销上一次计划改动', kind: 'other', rawInput: {} };
		},
		async execute(rawArgs, exec) {
			exec?.signal?.throwIfAborted?.();
			const args = rawArgs ?? {};
			const token = args.token;

			/* 不带参数 = 撤销刚才那一次。这是常规用法，因为模型看不到结构化返回值、
			   拿不到 undo_token；token 只是给"手里确实有"的调用方留的一条精确通道。 */
			if (token === undefined || token === null) {
				const recorded = store.readLastUndo();
				if (recorded === null) {
					throw new Error('nothing to undo: no planner_delete or planner_clear has been recorded yet');
				}
				store.undo({});
				return {
					restored: true,
					operations: recorded.ops.length,
					description: typeof recorded.description === 'string' ? recorded.description : ''
				};
			}

			if (typeof token !== 'object' || Array.isArray(token) === true || Array.isArray(token.ops) !== true) {
				throw new Error(
					'`token` must be the `undo_token` object returned by planner_delete or planner_clear, passed back unchanged ' +
						'(an object with an `ops` array). Omit `token` entirely to undo the most recent one.'
				);
			}
			store.undo({ ops: token.ops });
			return { restored: true, operations: token.ops.length };
		}
	};
}

/**
 * 建出插件要注册的全部模型工具。
 * @param store - `lib/store.js` 建出来的存储实例。
 * @returns 可直接交给 `ctx.tools.register()` 的定义数组（顺序即此处的顺序）。
 */
export function createPlannerTools(store) {
	return [readTool(store), writeTool(store), deleteTool(store), clearTool(store), undoTool(store)];
}
