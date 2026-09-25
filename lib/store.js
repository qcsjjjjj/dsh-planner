/**
 * dsh-planner 的持久化层。
 *
 * 为什么是手写的 node:fs 而不是 `ctx.storageDomain`：
 *
 * 插件是 `link:` 安装的，Node 按 realpath 解析，于是它只能 import **内置模块**——
 * 实测从 真实路径 与 profile 符号链接路径 各跑一次，`@deepseek-ai/dsh-storage-domain`
 * 都是 ERR_MODULE_NOT_FOUND（该包只存在于 npx 安装锚点里）。
 *
 * 虽然 `ctx.storageDomain` 本身不需要 import 就能拿到（服务挂在 ctx 上），而
 * `domainTable(schema)` 的实现也确实只是 `{ valueSchema: schema }`、设施全文只调用
 * `safeParse(null)` 与 `parse(...)`——也就是说可以手搓一个鸭子类型的 schema 糊过去。
 * 但那样一来，"设施只会调这三个方法"就成了一个**只会在重启之后才被证伪**的推断。
 * 手写 node:fs 则是可证明的：内置模块永远能解析，且本 profile 里已有的
 * `dsh-balance-tracker` 用的正是同一套手法。
 *
 * ── 磁盘布局 ────────────────────────────────────────────────────────────────
 *
 *   <root>/plans/<YYYY-MM-DD>.json   单次计划（recurrence 为 null 的那些）
 *   <root>/series.json               重复系列的定义
 *
 * 为什么分两类文件：重复系列的"某一次发生"散落在许多日期上，而**系列定义本身不属于
 * 任何一个日期**。把它塞进某个日期文件，躺平（Q18 要求只跳过该日、系列保留）就必须
 * 小心翼翼绕开它；放进独立文件后，躺平的可达范围天然不含系列定义，这条规则由结构保证。
 *
 * 第③步已有的数据全是单次计划，第④步只是新增一个文件，因此**不需要迁移**。
 *
 * 本模块不依赖任何 DSH 运行时，只依赖 node:fs / node:path / node:os / node:crypto，
 * 因此可以在普通 node 进程里用临时目录完整测到（见 .dev/smoke-store.mjs）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 落盘格式版本。 */
export const FORMAT_VERSION = 2;
/** 三档重要度。 */
export const IMPORTANCE = ['high', 'medium', 'low'];
/** 三种重复方式；`null` 表示不重复。 */
export const RECURRENCE = ['daily', 'weekly', 'weekdays'];
/** 标题长度上限。 */
export const TITLE_MAX = 60;
/** 内容长度上限（纯文本）。 */
export const CONTENT_MAX = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 存储层错误：带一个机器可读的 code，供路由翻译成 HTTP 状态码。 */
export class StoreError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'StoreError';
		this.code = code;
	}
}

/**
 * 存储根目录：`$DSH_HOME/storages/planner`，`DSH_HOME` 缺省时退回 `~/.dsh`。
 * 与产品自己挂载 storage-json 后端时用的 `dshHomePath('storages')` 同一处，
 * 但落在 `planner/` 子目录下，不与任何已注册的 storage unit 抢名字。
 */
export function storageRoot(env = process.env) {
	const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
	const home = configured !== '' ? configured : path.join(os.homedir(), '.dsh');
	return path.join(home, 'storages', 'planner');
}

/** 今天的本地日期键（与浏览器半边同一规则：本地日期，绝不是 UTC 时间戳）。 */
export function todayKey(now = new Date()) {
	const pad = (value) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 星期几：0=周日 … 6=周六（与 `Date#getDay` 一致，按**本地**日期算）。 */
export function weekdayOf(date) {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(year, month - 1, day).getDay();
}

/** `YYYY-MM-DD` 加若干天（纯 UTC 算术，不受本地时区影响）。 */
export function addDays(date, days) {
	const [year, month, day] = date.split('-').map(Number);
	const moved = new Date(Date.UTC(year, month - 1, day + days));
	const pad = (value) => String(value).padStart(2, '0');
	return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

function assertDate(value, label = '日期') {
	if (typeof value !== 'string' || !DATE_RE.test(value)) {
		throw new StoreError('invalid-date', `${label}必须是 YYYY-MM-DD，收到 ${JSON.stringify(value)}`);
	}
	return value;
}

function byStart(left, right) {
	const timeOrder = String(left.start).localeCompare(String(right.start));
	if (timeOrder !== 0) return timeOrder;
	return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
}

/** 一条记录是否具备可用的最小形状；坏记录不参与渲染，但也不会让整份文件失效。 */
function isStorablePlan(value) {
	if (value === null || typeof value !== 'object') return false;
	if (typeof value.id !== 'string' || value.id === '') return false;
	if (typeof value.title !== 'string') return false;
	if (!TIME_RE.test(String(value.start))) return false;
	if (!TIME_RE.test(String(value.end))) return false;
	return IMPORTANCE.includes(value.importance);
}

/** 把一条计划补全成规范形状（缺失字段取默认值）。 */
function normalizePlan(input) {
	const source = input !== null && typeof input === 'object' ? input : {};
	const recurrence = source.recurrence === undefined ? null : source.recurrence;
	return {
		id: typeof source.id === 'string' && source.id !== '' ? source.id : randomUUID(),
		title: typeof source.title === 'string' ? source.title.trim() : '',
		content: typeof source.content === 'string' ? source.content : '',
		start: typeof source.start === 'string' ? source.start : '',
		end: typeof source.end === 'string' ? source.end : '',
		importance: IMPORTANCE.includes(source.importance) ? source.importance : 'medium',
		done: source.done === true,
		recurrence: RECURRENCE.includes(recurrence) ? recurrence : null,
		until: typeof source.until === 'string' && DATE_RE.test(source.until) ? source.until : null
	};
}

/**
 * 校验一条计划草稿。返回**全部**错误而不是遇到第一个就停。
 * @param plan - 规范化后的计划。
 * @param options.anchor - 系列的锚点日期，用于判断截止日期是否合法。
 * @returns 错误说明数组；空数组表示通过。
 */
export function validatePlan(plan, options = {}) {
	const errors = [];
	if (plan.title === '') errors.push('标题不能为空');
	if (plan.title.length > TITLE_MAX) errors.push(`标题不能超过 ${TITLE_MAX} 个字`);
	if (plan.content.length > CONTENT_MAX) errors.push(`内容不能超过 ${CONTENT_MAX} 个字`);
	if (!TIME_RE.test(plan.start)) errors.push('开始时间格式无效（应为 HH:mm）');
	if (!TIME_RE.test(plan.end)) errors.push('结束时间格式无效（应为 HH:mm）');
	if (TIME_RE.test(plan.start) && TIME_RE.test(plan.end) && plan.end <= plan.start) {
		errors.push('结束时间必须晚于开始时间');
	}
	if (!IMPORTANCE.includes(plan.importance)) errors.push('重要度只能是 high / medium / low');
	if (plan.recurrence !== null && !RECURRENCE.includes(plan.recurrence)) {
		errors.push('重复方式只能是 daily / weekly / weekdays');
	}
	if (plan.recurrence === null && plan.until !== null) {
		errors.push('不重复的计划不应带截止日期');
	}
	if (plan.until !== null && options.anchor !== undefined && plan.until < options.anchor) {
		errors.push('截止日期不能早于系列开始的那一天');
	}
	return errors;
}

/**
 * 建一个存储实例。所有写操作都是"临时文件 + fsync + 同卷改名"。
 * @param options - `root` 可覆盖存储根目录（测试用）。
 */
export function createPlanStore(options = {}) {
	const root = options.root ?? storageRoot();
	const plansDir = path.join(root, 'plans');
	const seriesFile = path.join(root, 'series.json');
	/** 最后一次破坏性操作的撤销记录。让"撤销刚才那次"不需要调用方持有 token。 */
	const undoFile = path.join(root, 'undo.json');

	const fileFor = (date) => path.join(plansDir, `${date}.json`);

	function ensureDir() {
		fs.mkdirSync(plansDir, { recursive: true });
	}

	/** 原子写：临时文件 → fsync → 同卷改名。传 null 表示删文件。 */
	function atomicWrite(target, text) {
		if (text === null) {
			try {
				fs.unlinkSync(target);
			} catch (error) {
				if (error?.code !== 'ENOENT') throw new StoreError('write-failed', `删除 ${target} 失败：${error.message}`);
			}
			return;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
		const fd = fs.openSync(tmp, 'w');
		try {
			fs.writeFileSync(fd, text, 'utf8');
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, target);
	}

	/** 解析不了的文件改名留档，再按空处理——不静默丢数据，也不让一次坏掉拖垮全部。 */
	function quarantine(target) {
		try {
			fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
		} catch {
			/* 留档都失败时也只能算了，总比抛出去让整个日历打不开好。 */
		}
	}

	/* ── 单次计划（按日期分文件） ─────────────────────────────────────────── */

	function readOneOffs(date) {
		assertDate(date);
		let raw;
		try {
			raw = fs.readFileSync(fileFor(date), 'utf8');
		} catch (error) {
			if (error?.code === 'ENOENT') return [];
			throw new StoreError('read-failed', `读取 ${date} 失败：${error.message}`);
		}
		try {
			const parsed = JSON.parse(raw);
			const list = Array.isArray(parsed?.plans) ? parsed.plans : [];
			return list.filter(isStorablePlan);
		} catch {
			quarantine(fileFor(date));
			throw new StoreError('read-failed', `${date} 的数据文件已损坏并被留档，本次按空处理`);
		}
	}

	function writeOneOffs(date, plans) {
		assertDate(date);
		if (plans.length === 0) {
			atomicWrite(fileFor(date), null);
			return;
		}
		const sorted = [...plans].sort(byStart);
		atomicWrite(
			fileFor(date),
			JSON.stringify({ version: FORMAT_VERSION, date, plans: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n'
		);
	}

	/* ── 重复系列（独立文件） ─────────────────────────────────────────────── */

	function readSeries() {
		let raw;
		try {
			raw = fs.readFileSync(seriesFile, 'utf8');
		} catch (error) {
			if (error?.code === 'ENOENT') return [];
			throw new StoreError('read-failed', `读取重复系列失败：${error.message}`);
		}
		try {
			const parsed = JSON.parse(raw);
			const list = Array.isArray(parsed?.series) ? parsed.series : [];
			return list.filter(
				(entry) =>
					entry !== null &&
					typeof entry === 'object' &&
					typeof entry.id === 'string' &&
					entry.id !== '' &&
					DATE_RE.test(String(entry.anchor)) &&
					RECURRENCE.includes(entry.recurrence) &&
					isStorablePlan({ id: entry.id, title: entry.title, start: entry.start, end: entry.end, importance: entry.importance })
			);
		} catch {
			quarantine(seriesFile);
			throw new StoreError('read-failed', '重复系列文件已损坏并被留档，本次按空处理');
		}
	}

	function writeSeries(list) {
		if (list.length === 0) {
			atomicWrite(seriesFile, null);
			return;
		}
		const sorted = [...list].sort(
			(left, right) => left.anchor.localeCompare(right.anchor) || left.id.localeCompare(right.id)
		);
		atomicWrite(
			seriesFile,
			JSON.stringify({ version: FORMAT_VERSION, series: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n'
		);
	}

	/**
	 * 记下"最后一次破坏性操作"，供不带参数的撤销使用。
	 *
	 * 为什么需要它：模型工具看到的只有 `output.render` 产出的**文本**，看不到结构化的返回值，
	 * 所以调用方拿不到 `undo_token`。与其把上千字的 JSON 塞进 render 让模型照抄（不可靠），
	 * 不如把它落盘——"撤销刚才那次删除"本来也更贴近用户的说法。
	 */
	function rememberUndo(ops, description) {
		if (!Array.isArray(ops) || ops.length === 0) return;
		atomicWrite(
			undoFile,
			JSON.stringify({ version: FORMAT_VERSION, at: new Date().toISOString(), description, ops }, null, 2) + '\n'
		);
	}

	/** 读回最后一次破坏性操作；没有或读不动就回 null。 */
	function readLastUndo() {
		try {
			const parsed = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
			if (parsed === null || typeof parsed !== 'object') return null;
			if (!Array.isArray(parsed.ops) || parsed.ops.length === 0) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	/** 取某个系列在某天的例外记录（没有就是空对象）。 */
	function exceptionOf(series, date) {		const table = series.exceptions !== null && typeof series.exceptions === 'object' ? series.exceptions : {};
		const entry = table[date];
		return entry !== null && typeof entry === 'object' ? entry : {};
	}

	/** 写回某个系列的例外表。 */
	function withException(series, date, patch) {
		const exceptions = { ...(series.exceptions ?? {}) };
		exceptions[date] = { ...exceptionOf(series, date), ...patch };
		return { ...series, exceptions, updatedAt: new Date().toISOString() };
	}

	/**
	 * 判断一个系列是否在某天发生，并把那一次展开成一条可渲染的计划。
	 * @returns 展开后的计划，或 `null` 表示这天不发生。
	 */
	/** 这个系列在某天是否**发生**（不含"被 skip 掉"以外的任何渲染细节）。 */
	function seriesOccurs(series, date) {
		if (date < series.anchor) return false;
		if (series.until !== null && series.until !== undefined && date > series.until) return false;
		if (exceptionOf(series, date).skip === true) return false;
		if (series.recurrence === 'weekly') return weekdayOf(date) === weekdayOf(series.anchor);
		if (series.recurrence === 'weekdays') {
			const weekday = weekdayOf(date);
			return weekday !== 0 && weekday !== 6;
		}
		return true; /* 'daily'：锚点之后无额外条件 */
	}

	/** 把系列摊平成一条计划（**不判断**当天是否发生）。 */
	function seriesShape(series, date) {
		const exception = exceptionOf(series, date);
		const override = exception.override !== null && typeof exception.override === 'object' ? exception.override : {};
		return {
			id: series.id,
			title: typeof override.title === 'string' ? override.title : series.title,
			content: typeof override.content === 'string' ? override.content : series.content,
			start: typeof override.start === 'string' ? override.start : series.start,
			end: typeof override.end === 'string' ? override.end : series.end,
			importance: IMPORTANCE.includes(override.importance) ? override.importance : series.importance,
			done: exception.done === true,
			date,
			isRecurring: true,
			seriesAnchor: series.anchor,
			recurrence: series.recurrence,
			until: series.until ?? null,
			overridden: Object.keys(override).length > 0,
			/* 系列自身的值（未叠加当天覆盖）。界面要编辑"整个系列"时必须用这一份，
			   否则会把当天临时改的值悄悄写成整个系列的新定义。 */
			seriesBase: {
				title: series.title,
				content: series.content,
				start: series.start,
				end: series.end,
				importance: series.importance,
				recurrence: series.recurrence,
				until: series.until ?? null,
				anchor: series.anchor
			},
			skipped: exception.skip === true,
			createdAt: series.createdAt,
			updatedAt: series.updatedAt
		};
	}

	/** 某天发生就展开，不发生就 null。 */
	function expandSeries(series, date) {
		return seriesOccurs(series, date) ? seriesShape(series, date) : null;
	}

	/**
	 * 写入一个系列之后该回什么。
	 *
	 * 关键点：**锚点当天不一定发生**。最典型的是"工作日"规则锚在周六——那天本来就不该有
	 * 这条计划。此时若回 `plan: null`，两个调用方都会出事：
	 *   - 界面刚"创建成功"却什么都不出现，用户以为失败；
	 *   - 模型工具的 `render` 会对 null 取字段，直接崩成一条看不懂的报错。
	 * 所以这里永远回一份**系列形状**的计划，并额外说明锚点当天是否发生、首次发生在哪天。
	 * @returns `{ plan, occursOnAnchor, firstDate }`（`firstDate` 为 null 表示系列永不发生，
	 *   例如 `until` 早于第一个合法工作日）。
	 */
	function seriesOutcome(series, date) {
		const occurrence = expandSeries(series, date);
		if (occurrence !== null) return { plan: occurrence, occursOnAnchor: true, firstDate: date };

		let firstDate = null;
		let cursor = date;
		/* 最长需要走一周（weekdays 从周六到下一个周一；until 可能提前截断）。 */
		for (let step = 0; step < 8; step += 1) {
			cursor = addDays(cursor, 1);
			if (series.until !== null && series.until !== undefined && cursor > series.until) break;
			if (seriesOccurs(series, cursor)) {
				firstDate = cursor;
				break;
			}
		}
		return { plan: seriesShape(series, date), occursOnAnchor: false, firstDate };
	}

	/* ── 读取（单次 + 展开后的重复，合并后排序） ─────────────────────────── */

	/** 把某一天的单次计划与所有系列的展开合并、排序。 */
	function composeDay(date, series) {
		const plans = readOneOffs(date).map((plan) => ({ ...plan, date, isRecurring: false, recurrence: null, until: null }));
		for (const entry of series) {
			const occurrence = expandSeries(entry, date);
			if (occurrence !== null) plans.push(occurrence);
		}
		return plans.sort(byStart);
	}

	/** 单日读取：**严格**——这一天读坏了就如实报错，不静默变成"没有计划"。 */
	function readDay(date) {
		assertDate(date);
		return composeDay(date, readSeries());
	}

	/** 区间读取：**宽容**——某一天的文件坏了就跳过那一天，其余照常渲染。 */
	function readRange(from, to) {
		assertDate(from, 'from');
		assertDate(to, 'to');
		if (from > to) throw new StoreError('invalid-range', 'from 不能晚于 to');
		ensureDir();
		const series = readSeries();

		/* 候选日期 = 区间内有文件的那些天 ∪ 每个系列在区间内可能发生的那些天。 */
		const dates = new Set();
		for (const name of fs.readdirSync(plansDir)) {
			if (!name.endsWith('.json')) continue;
			const date = name.slice(0, -'.json'.length);
			if (!DATE_RE.test(date)) continue;
			if (date >= from && date <= to) dates.add(date);
		}
		for (const entry of series) {
			if (entry.anchor > to) continue;
			const start = entry.anchor > from ? entry.anchor : from;
			for (let cursor = start; cursor <= to; cursor = addDays(cursor, 1)) dates.add(cursor);
		}

		const days = {};
		for (const date of dates) {
			let plans;
			try {
				plans = composeDay(date, series);
			} catch {
				plans = []; // 单日损坏不影响整个区间
			}
			if (plans.length > 0) days[date] = plans;
		}
		return days;
	}

	/* ── 写入 ─────────────────────────────────────────────────────────────── */

	/**
	 * 新增或更新。
	 * @param input.scope - `'one'`（仅这一次，写成例外覆盖）或 `'series'`（整个系列）。
	 *   只在目标是一条重复计划时有意义；单次计划忽略它。
	 * @param input.allowPastCreate - 允许为**过去日期新建**。默认关闭：界面上的"新建"按钮
	 *   禁用过去日期是为了防手滑。但模型工具需要它——用户明确说"把昨天的会补记一下"是完全
	 *   合理的请求，而工具无法判断指令是否明确，所以改由工具的**描述**约束使用时机，并由
	 *   工具**如实回传**（写明这是为哪个过去日期创建的），让用户在对话里看得见。
	 *   注意：这**只影响新建**，更新已存在的计划本来就不受过去日期限制。
	 */
	function save(input) {
		const date = assertDate(input?.date);
		const draft = normalizePlan(input?.plan);
		const scope = input?.scope === 'series' ? 'series' : 'one';
		const allowPastCreate = input?.allowPastCreate === true;
		const seriesList = readSeries();
		const seriesIndex = seriesList.findIndex((entry) => entry.id === draft.id);

		if (seriesIndex >= 0) {
			const existing = seriesList[seriesIndex];

			if (scope === 'series') {
				if (draft.recurrence === null) {
					throw new StoreError(
						'invalid',
						'重复计划必须保留一种重复方式。要停止重复请设置截止日期，或删除整个系列'
					);
				}
				const errors = validatePlan(draft, { anchor: existing.anchor });
				if (errors.length > 0) throw new StoreError('invalid', errors.join('；'));
				seriesList[seriesIndex] = {
					...existing,
					title: draft.title,
					content: draft.content,
					start: draft.start,
					end: draft.end,
					importance: draft.importance,
					recurrence: draft.recurrence,
					until: draft.until,
					updatedAt: new Date().toISOString()
				};
				writeSeries(seriesList);
				const updated = seriesOutcome(seriesList[seriesIndex], date);
				return { ...updated, created: false, scope };
			}

			/* 仅这一次：只写例外覆盖，系列定义不动（Q17）。
			   覆盖值同样要过校验，否则会造出一个界面上撤不掉的坏格子。 */
			const errors = validatePlan(
				{ ...draft, recurrence: existing.recurrence, until: existing.until },
				{ anchor: existing.anchor }
			);
			if (errors.length > 0) throw new StoreError('invalid', errors.join('；'));
			seriesList[seriesIndex] = withException(existing, date, {
				override: {
					title: draft.title,
					content: draft.content,
					start: draft.start,
					end: draft.end,
					importance: draft.importance
				}
			});
			writeSeries(seriesList);
			const overridden = seriesOutcome(seriesList[seriesIndex], date);
			return { ...overridden, created: false, scope };
		}

		const current = readOneOffs(date);
		const index = current.findIndex((item) => item.id === draft.id);
		const now = new Date().toISOString();

		if (index >= 0) {
			/* 单次计划**不能**就地改成重复计划：那份记录住在日期文件里，而重复系列的展开
			   只认 series.json。若默默接受，计划会带着 recurrence 字段躺在那儿永不重复——
			   一个界面上看不出来的静默失效。宁可明确拒绝。 */
			if (draft.recurrence !== null) {
				throw new StoreError('invalid', '单次计划不能改成重复计划；请删除后重新创建为重复计划');
			}
			const errors = validatePlan(draft, { anchor: date });
			if (errors.length > 0) throw new StoreError('invalid', errors.join('；'));
			current[index] = { ...current[index], ...draft, createdAt: current[index].createdAt ?? now, updatedAt: now };
			writeOneOffs(date, current);
			return { plan: { ...current[index], date, isRecurring: false }, created: false, scope };
		}

		/* 新建：过去日期默认不允许（Q23=c）。编辑走的是上面两条分支，不受影响；
		   模型工具显式传 allowPastCreate 时才放行。 */
		if (date < todayKey() && !allowPastCreate) {
			throw new StoreError('past-date', '不能为过去的日期新建计划');
		}
		const errors = validatePlan(draft, { anchor: date });
		if (errors.length > 0) throw new StoreError('invalid', errors.join('；'));

		if (draft.recurrence !== null) {
			const series = {
				id: draft.id,
				title: draft.title,
				content: draft.content,
				start: draft.start,
				end: draft.end,
				importance: draft.importance,
				anchor: date,
				recurrence: draft.recurrence,
				until: draft.until,
				exceptions: {},
				createdAt: now,
				updatedAt: now
			};
			writeSeries([...seriesList, series]);
			const created = seriesOutcome(series, date);
			return { ...created, created: true, scope: 'series' };
		}

		const created = { ...draft, createdAt: now, updatedAt: now };
		current.push(created);
		writeOneOffs(date, current);
		return { plan: { ...created, date, isRecurring: false }, created: true, scope };
	}

	/**
	 * 删除。
	 * @param input.scope - `'one'`：重复计划只跳过这一天（Q18/Q17 默认）；`'series'`：整个系列一起删。
	 * @returns `{ removed, undo }`；`removed` 为 null 表示没找到。
	 */
	function remove(input) {
		const date = assertDate(input?.date);
		const id = typeof input?.id === 'string' ? input.id : '';
		const scope = input?.scope === 'series' ? 'series' : 'one';

		const seriesList = readSeries();
		const seriesIndex = seriesList.findIndex((entry) => entry.id === id);

		if (seriesIndex >= 0) {
			const series = seriesList[seriesIndex];
			const occurrence = expandSeries(series, date);
			if (occurrence === null && scope === 'one') {
				/* 这天本来就没发生，别写一条毫无意义的 skip 例外。 */
				return { removed: null, undo: [] };
			}
			if (scope === 'series') {
				writeSeries(seriesList.filter((entry) => entry.id !== id));
				const ops = [{ op: 'putSeries', series }];
				rememberUndo(ops, `删除整个系列「${series.title}」`);
				return { removed: occurrence, undo: ops };
			}
			seriesList[seriesIndex] = withException(series, date, { skip: true });
			writeSeries(seriesList);
			const ops = [{ op: 'unskip', seriesId: id, date }];
			rememberUndo(ops, `跳过「${series.title}」在 ${date} 的这一次`);
			return { removed: occurrence, undo: ops };
		}

		const current = readOneOffs(date);
		const index = current.findIndex((item) => item.id === id);
		if (index < 0) return { removed: null, undo: [] };
		const [removed] = current.splice(index, 1);
		writeOneOffs(date, current);
		const ops = [{ op: 'putPlan', date, plan: removed }];
		rememberUndo(ops, `删除「${removed.title}」（${date}）`);
		return { removed: { ...removed, date, isRecurring: false }, undo: ops };
	}

	/** 勾选/取消完成。重复计划**按天独立**（Q19）：写进那天的例外，不动同系列的其它天。 */
	function setDone(input) {
		const date = assertDate(input?.date);
		const id = typeof input?.id === 'string' ? input.id : '';
		const done = input?.done === true;

		const seriesList = readSeries();
		const seriesIndex = seriesList.findIndex((entry) => entry.id === id);
		if (seriesIndex >= 0) {
			const series = seriesList[seriesIndex];
			/* 那天本来就不发生（例如周末的工作日系列）就别写例外的空盒子——与 remove 的守卫对称。 */
			if (!seriesOccurs(series, date)) return seriesShape(series, date);
			seriesList[seriesIndex] = withException(series, date, { done });
			writeSeries(seriesList);
			return seriesShape(seriesList[seriesIndex], date);
		}

		const current = readOneOffs(date);
		const index = current.findIndex((item) => item.id === id);
		if (index < 0) throw new StoreError('not-found', `找不到计划 ${id}`);
		current[index] = { ...current[index], done, updatedAt: new Date().toISOString() };
		writeOneOffs(date, current);
		return { ...current[index], date, isRecurring: false };
	}

	/**
	 * 一键躺平：清空某一天。
	 * 单次计划被真正删除；重复计划只写一条 skip 例外——**系列定义在本函数里完全不可达**
	 * （它住在另一个文件里），所以"躺平不会误删系列"（Q18）由结构保证，不是靠小心。
	 * @returns `{ removed, undo, count }`。
	 */
	function wipe(input) {
		const date = assertDate(input?.date);
		const removed = readDay(date);
		const undo = [];

		for (const plan of readOneOffs(date)) undo.push({ op: 'putPlan', date, plan });
		writeOneOffs(date, []);

		const seriesList = readSeries();
		let dirty = false;
		seriesList.forEach((series, index) => {
			if (expandSeries(series, date) === null) return;
			seriesList[index] = withException(series, date, { skip: true });
			undo.push({ op: 'unskip', seriesId: series.id, date });
			dirty = true;
		});
		if (dirty) writeSeries(seriesList);

		rememberUndo(undo, `清空 ${date} 的 ${removed.length} 条计划`);
		return { removed, undo, count: removed.length };
	}

	/**
	 * 撤销：把 `remove` / `wipe` 回传的操作列表做回去。
	 * 刻意**不**走 save 的"过去日期不许新建"规则——撤销一次对过去日期的删除必须能成功，
	 * 否则"删除 + 5 秒撤销"在过去日期上就是假承诺。
	 */
	/**
	 * 撤销：把 `remove` / `wipe` 的操作做回去。
	 * 刻意**不**走 save 的"过去日期不许新建"规则——撤销一次对过去日期的删除必须能成功，
	 * 否则"删除 + 5 秒撤销"在过去日期上就是假承诺。
	 *
	 * 两种调用方式：
	 *   - 显式给 `ops`（界面用：它把删除时拿到的操作留在内存里）；
	 *   - **不给 `ops`**，撤销"最后一次删除/清空"（模型工具用）。后者是必需的：模型看到的
	 *     只有 `output.render` 产出的文本，**看不到结构化的返回值**，所以它拿不到那个
	 *     `undo_token`——除非把上千字的 JSON 塞进 render 让它照抄，那是不可靠的。
	 * 撤销成功后清掉落盘的那一份（每个 token 只用一次）。
	 */
	function undo(input) {
		const explicit = Array.isArray(input?.ops) ? input.ops : null;
		const stored = explicit === null ? readLastUndo() : null;
		const ops = explicit ?? (stored === null ? [] : stored.ops);
		const seriesList = readSeries();
		let dirty = false;

		for (const op of ops) {
			if (op === null || typeof op !== 'object') continue;
			if (op.op === 'putPlan') {
				const date = assertDate(op.date);
				if (!isStorablePlan(op.plan)) continue;
				const current = readOneOffs(date);
				if (current.some((item) => item.id === op.plan.id)) continue;
				current.push(op.plan);
				writeOneOffs(date, current);
			} else if (op.op === 'unskip') {
				const index = seriesList.findIndex((entry) => entry.id === op.seriesId);
				if (index < 0) continue;
				const entry = { ...exceptionOf(seriesList[index], op.date) };
				delete entry.skip;
				const exceptions = { ...(seriesList[index].exceptions ?? {}) };
				if (Object.keys(entry).length === 0) delete exceptions[op.date];
				else exceptions[op.date] = entry;
				seriesList[index] = { ...seriesList[index], exceptions, updatedAt: new Date().toISOString() };
				dirty = true;
			} else if (op.op === 'putSeries') {
				if (seriesList.some((entry) => entry.id === op.series.id)) continue;
				seriesList.push(op.series);
				dirty = true;
			}
		}
		if (dirty) writeSeries(seriesList);
		if (ops.length > 0) atomicWrite(undoFile, null);
		return { ok: true, applied: ops.length, source: explicit === null ? (stored === null ? 'none' : 'recorded') : 'explicit' };
	}

	return {
		root,
		plansDir,
		seriesFile,
		undoFile,
		fileFor,
		readDay,
		readRange,
		readSeries,
		readLastUndo,
		expandSeries,
		seriesOccurs,
		seriesShape,
		save,
		remove,
		setDone,
		wipe,
		undo
	};
}
