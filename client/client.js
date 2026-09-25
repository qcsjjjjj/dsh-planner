/**
 * dsh-planner 浏览器半边 —— 中间栏的第三个视图标签（`轨迹` 右边）。
 *
 * 经典脚本，不是 ESM：页面用 `window.__ModuleLoader__.load` 注册一个惰性 CJS 工厂，
 * `require` 只能取平台冻结的种子模块表。产品自带的 `对话`/`轨迹` 走的是同一个公开插槽
 * `conversation.view`，所以标签条的字号、间距、激活色与 2px 蓝色下划线全部白送，
 * 左右侧栏的推挤也不用管。
 *
 * 第①步：标签 + 骨架。第②步：日历卡片。第③步：计划列表 / 完成框 / 浮窗 / 躺平 / 持久化。
 * 第④步（本文件现状）：重复计划 —— 规则、截止日期、作用域询问、按天独立完成。
 *
 * 关于"用哪些产品原语"，这里是按**证据**决定的：
 *   - `Modal`          ：用。props 从第一方 `ui-agent-preset` 与第三方 `dsh-agent-teams`
 *                        的真实调用点读出：{open,onClose,title,closeLabel,description,footer}。
 *   - `Button`         ：不用。第一方在 Modal 的 footer 里用的就是朴素 `<button>`，
 *                        危险动作用 `data-danger`；那才是本产品的惯例。
 *   - `Input`          ：不用。没有任何第一方插件在用这个原语，表单字段各家都手写。
 *   - `Toast`          ：不用。其实现为 `$C({text,icon,anchor,holdMs,onDone})`，没有
 *                        action/children 槽位，装不下"撤销"按钮。撤销做成列表内的撤销条。
 * 颜色一律取主题 token，没有一处硬编码。
 */
window.__ModuleLoader__.load({
	id: 'dsh-planner',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const jsx = require('react/jsx-runtime');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const Modal = primitives.Modal;

		/* ──────────────────────────── 常量 ──────────────────────────── */

		const NS = 'planner';
		const VIEW_ID = 'planner';
		const API = '/dsh-planner';
		const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
		const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
		const ROWS = 6;
		const MAX_DOTS = 3;
		const TITLE_MAX = 60;
		const NO_COUNTS = {};
		const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
		const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

		/** 三档重要度：顺序、中文名与颜色 token。 */
		const IMPORTANCE = [
			{ id: 'high', label: '高', color: 'var(--dsw-alias-state-error-primary)' },
			{ id: 'medium', label: '中', color: 'var(--dsw-alias-state-warn-primary)' },
			{ id: 'low', label: '低', color: 'var(--dsw-alias-state-business-primary)' }
		];
		const IMPORTANCE_BY_ID = IMPORTANCE.reduce((map, item) => {
			map[item.id] = item;
			return map;
		}, {});

		/** 四种重复方式（含"不重复"）。顺序即界面顺序。 */
		const RECURRENCE_OPTIONS = [
			{ id: null, label: '不重复' },
			{ id: 'daily', label: '每天' },
			{ id: 'weekly', label: '每周' },
			{ id: 'weekdays', label: '工作日' }
		];
		const RECURRENCE_IDS = RECURRENCE_OPTIONS.map((item) => item.id);

		/** 撤销窗口（毫秒）。规格定的是 5 秒。 */
		const UNDO_MS = 5000;

		/**
		 * 开发期假数据开关：URL 带 `?plannerFixture` 时铺一层假的计划数，用于在没有真实
		 * 数据时验证密度圆点。不带该参数时完全走真数据路径。
		 */
		const FIXTURE = typeof location !== 'undefined' && /[?&]plannerFixture(?:[=&]|$)/.test(location.search);

		/* ──────────────────────────── 词典 ──────────────────────────── */

		const zh = {
			'view.planner': '计划',
			title: '计划看板',
			prevMonth: '上个月',
			nextMonth: '下个月',
			goToday: '回到今天',
			todayTag: '今天',
			planCount: '{n} 条计划',
			emptyDay: '这一天还没有计划。',
			newPlan: '新建',
			newDisabled: '不能为过去的日期新建计划',
			wipe: '一键躺平',
			wipeDisabled: '这一天没有计划可清空',
			edit: '编辑',
			remove: '删除',
			done: '标记完成',
			undone: '取消完成',
			loading: '正在读取…',
			loadFailed: '读取失败：{message}',
			pingFail: '宿主半边未连通，暂时无法读写计划',
			overlap: '与上一条时间重叠',
			recurringMark: '重复计划：{rule}',
			recurringMarkOverridden: '重复计划：{rule}（这一次已单独修改）',
			createTitle: '新建计划',
			editTitle: '编辑计划',
			fieldTitle: '标题',
			fieldContent: '内容',
			fieldStart: '开始',
			fieldEnd: '结束',
			fieldImportance: '重要度',
			fieldRecurrence: '重复',
			fieldUntil: '截止日期',
			untilHint: '留空表示永不结束',
			titlePlaceholder: '要做什么？',
			contentPlaceholder: '补充说明（可留空）',
			confirm: '确定',
			cancel: '取消',
			errTitleEmpty: '标题不能为空',
			errTitleLong: '标题不能超过 {n} 个字',
			errEndBeforeStart: '结束时间必须晚于开始时间',
			errTimeFormat: '时间格式无效',
			errRecurrence: '重复方式无效',
			errUntilBeforeAnchor: '截止日期不能早于系列开始的那一天',
			singleOnlyNote: '单次计划不能改成重复；如需重复请删除后重新创建',
			hostOutdated: '宿主半边尚未重启，重复计划暂不可用；请重启 dsh web 后再试',
			oneOfSeriesNote: '属于重复系列（{rule}）；这里的修改只影响这一天',
			seriesNote: '属于重复系列（{rule}）；重复方式与截止日期对整系列生效',
			scopeTitle: '这是重复计划',
			scopeEditBody: '「{title}」属于一个重复系列。要只改这一次，还是改整个系列？',
			scopeDeleteBody: '「{title}」属于一个重复系列。要只跳过这一次，还是删除整个系列？',
			scopeOne: '仅此一次',
			scopeSeries: '整个系列',
			wipeTitle: '一键躺平',
			wipeBody: '将删除 {date} 的 {n} 条计划。',
			wipeBodyRecurring: '其中 {m} 条属于重复计划，仅跳过该日、系列保留。',
			wipeConfirm: '清空这一天',
			undoRemoved: '已删除「{title}」',
			undoSeriesRemoved: '已删除整个系列「{title}」',
			undoWiped: '已清空 {n} 条计划',
			undoAction: '撤销',
			saving: '保存中…'
		};
		const en = {
			'view.planner': 'Planner',
			title: 'Planner',
			prevMonth: 'Previous month',
			nextMonth: 'Next month',
			goToday: 'Today',
			todayTag: 'Today',
			planCount: '{n} plans',
			emptyDay: 'Nothing planned for this day yet.',
			newPlan: 'New',
			newDisabled: 'Cannot create plans in the past',
			wipe: 'Clear day',
			wipeDisabled: 'Nothing to clear on this day',
			edit: 'Edit',
			remove: 'Delete',
			done: 'Mark done',
			undone: 'Mark not done',
			loading: 'Loading…',
			loadFailed: 'Load failed: {message}',
			pingFail: 'The host half is unreachable, so plans cannot be read or written',
			overlap: 'Overlaps the previous plan',
			recurringMark: 'Repeats: {rule}',
			recurringMarkOverridden: 'Repeats: {rule} (this occurrence was edited)',
			createTitle: 'New plan',
			editTitle: 'Edit plan',
			fieldTitle: 'Title',
			fieldContent: 'Details',
			fieldStart: 'Start',
			fieldEnd: 'End',
			fieldImportance: 'Priority',
			fieldRecurrence: 'Repeats',
			fieldUntil: 'Until',
			untilHint: 'Leave empty to repeat forever',
			titlePlaceholder: 'What needs doing?',
			contentPlaceholder: 'Optional details',
			confirm: 'Save',
			cancel: 'Cancel',
			errTitleEmpty: 'Title cannot be empty',
			errTitleLong: 'Title cannot exceed {n} characters',
			errEndBeforeStart: 'End time must be after the start time',
			errTimeFormat: 'Invalid time format',
			errRecurrence: 'Invalid repeat rule',
			errUntilBeforeAnchor: 'The end date cannot precede the series start',
			singleOnlyNote: 'A one-off plan cannot become recurring; delete and recreate it instead',
			hostOutdated: 'The host half has not been restarted yet, so repeating plans are unavailable; restart dsh web',
			oneOfSeriesNote: 'Part of a repeating series ({rule}); changes here affect this day only',
			seriesNote: 'Part of a repeating series ({rule}); the rule and end date apply to the whole series',
			scopeTitle: 'This is a repeating plan',
			scopeEditBody: '“{title}” belongs to a repeating series. Edit just this occurrence, or the whole series?',
			scopeDeleteBody: '“{title}” belongs to a repeating series. Skip just this occurrence, or delete the whole series?',
			scopeOne: 'This occurrence',
			scopeSeries: 'Whole series',
			wipeTitle: 'Clear day',
			wipeBody: 'This deletes {n} plans on {date}.',
			wipeBodyRecurring: '{m} of them belong to repeating series and are only skipped for this day.',
			wipeConfirm: 'Clear this day',
			undoRemoved: 'Deleted “{title}”',
			undoSeriesRemoved: 'Deleted the whole series “{title}”',
			undoWiped: 'Cleared {n} plans',
			undoAction: 'Undo',
			saving: 'Saving…'
		};

		/* ──────────────────────────── 纯日期工具 ──────────────────────────── */

		const pad2 = (value) => String(value).padStart(2, '0');

		/** `YYYY-MM-DD` 键。始终本地日期，绝不存 UTC 时间戳。 */
		function dateKey(year, month, day) {
			return `${year}-${pad2(month + 1)}-${pad2(day)}`;
		}

		function todayKey() {
			const now = new Date();
			return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
		}

		function daysInMonth(year, month) {
			return new Date(year, month + 1, 0).getDate();
		}

		/** JS 的 0=周日 映射成 0=周一。 */
		function mondayOffset(jsWeekday) {
			return (jsWeekday + 6) % 7;
		}

		function shiftMonthOf(year, month, delta) {
			const moved = new Date(year, month + delta, 1);
			return { year: moved.getFullYear(), month: moved.getMonth() };
		}

		/** 星期几：0=周日 … 6=周六。 */
		function weekdayOf(date) {
			const [year, month, day] = date.split('-').map(Number);
			return new Date(year, month - 1, day).getDay();
		}

		/** 固定 6×7 格，首尾用相邻月份补齐（靠 Date 的越界归一化，无需特判）。 */
		function buildCells(year, month) {
			const lead = mondayOffset(new Date(year, month, 1).getDay());
			const cells = [];
			for (let index = 0; index < ROWS * 7; index += 1) {
				const date = new Date(year, month, index - lead + 1);
				const column = index % 7;
				cells.push({
					key: dateKey(date.getFullYear(), date.getMonth(), date.getDate()),
					day: date.getDate(),
					inMonth: date.getFullYear() === year && date.getMonth() === month,
					isWeekend: column >= 5
				});
			}
			return cells;
		}

		/** 某月整个 6×7 网格覆盖的日期区间——正好是 `state` 接口要拉的区间。 */
		function rangeOfMonth(year, month) {
			const cells = buildCells(year, month);
			return { from: cells[0].key, to: cells[cells.length - 1].key };
		}

		/* ──────────────────────────── 纯业务工具 ──────────────────────────── */

		/** 按开始时间排序；同时到达的按创建时间。 */
		function sortPlans(plans) {
			return [...plans].sort((left, right) => {
				const byTime = String(left.start).localeCompare(String(right.start));
				if (byTime !== 0) return byTime;
				return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
			});
		}

		/**
		 * 找出与前一条时间重叠的计划 id（Q25：不拦截，只给轻微标识）。
		 * 只与**相邻**的前一条比较——列表已按开始时间排序，与更早的重叠必然也与相邻的重叠。
		 */
		function overlapIds(plans) {
			const marked = new Set();
			for (let index = 1; index < plans.length; index += 1) {
				if (plans[index].start < plans[index - 1].end) marked.add(plans[index].id);
			}
			return marked;
		}

		/** 用中文说清楚一条重复规则，用于卡片提示与系列说明。 */
		function recurrenceText(recurrence, anchor) {
			if (recurrence === 'daily') return '每天';
			if (recurrence === 'weekdays') return '每个工作日';
			if (recurrence === 'weekly') return '每周' + WEEKDAY_NAMES[weekdayOf(anchor)];
			return '不重复';
		}

		/**
		 * 浮窗里"重复"那一行右侧的统一说明：`从 <锚点日期> 起，<规则>`。
		 *
		 * 三档规则**都**受锚点约束（锚点之前的那几天不发生），而且只有"每周"必须知道参照的
		 * 星期几。只给"每周"显示提示会让人以为三档规则有性质差别；统一显示锚点日期，
		 * 三档的信息量才一致。
		 *
		 * 注：与日历表头（`2026 年 9 月`）、星期表头（`一二三四五六日`）一样，这里是硬编码
		 * 中文——面板尚未做完整本地化。只把这句走词典会造出 "Starting …, 每周三" 这种半中半英，
		 * 所以宁可保持与日历一致。本地化是独立的一件事，需要连表头和星期名一起做。
		 *
		 * @returns 提示文本；`recurrence` 为 null（不重复）时返回 `undefined`，即不显示。
		 */
		function recurrenceHint(recurrence, anchor) {
			if (recurrence === null || recurrence === undefined) return undefined;
			return '从 ' + anchor + ' 起，' + recurrenceText(recurrence, anchor);
		}

		/**
		 * 规则与锚点日期冲突时的提醒。目前只有一种：选了「工作日」却把锚点放在周末——
		 * 按规则那天本来就不该有这条计划。界面若不说明，用户会以为"创建成功却什么都没出现"
		 * 是保存失败。
		 * @returns 提醒文本；无冲突时返回 `undefined`。
		 */
		function recurrenceWarning(recurrence, anchor) {
			if (recurrence !== 'weekdays') return undefined;
			const weekday = weekdayOf(anchor);
			if (weekday !== 0 && weekday !== 6) return undefined;
			return '这一天是周末，「工作日」规则不含周末——计划将从下一个工作日开始，当天不会出现。';
		}

		/**
		 * 表单校验。与宿主 `lib/store.js` 的 `validatePlan` 同规则，但只用于即时反馈
		 * （把"确定"置灰并说明原因）；宿主的校验才是权威的。
		 * @returns 错误码数组，空数组表示通过。
		 */
		function validateDraft(draft, options = {}) {
			const errors = [];
			const title = typeof draft.title === 'string' ? draft.title.trim() : '';
			if (title === '') errors.push('errTitleEmpty');
			else if (title.length > TITLE_MAX) errors.push('errTitleLong');
			if (!TIME_RE.test(String(draft.start)) || !TIME_RE.test(String(draft.end))) errors.push('errTimeFormat');
			else if (String(draft.end) <= String(draft.start)) errors.push('errEndBeforeStart');

			const recurrence = draft.recurrence ?? null;
			if (RECURRENCE_IDS.indexOf(recurrence) < 0) errors.push('errRecurrence');
			if (recurrence !== null) {
				const until = typeof draft.until === 'string' ? draft.until.trim() : '';
				if (until !== '' && DATE_RE.test(until) && options.anchor !== undefined && until < options.anchor) {
					errors.push('errUntilBeforeAnchor');
				}
			}
			return errors;
		}

		/** 把 `{n}` / `{title}` 之类的占位符填掉。 */
		function fill(template, values) {
			let text = String(template);
			for (const key of Object.keys(values)) text = text.split(`{${key}}`).join(String(values[key]));
			return text;
		}

		/* ──────────────────────────── 网络 ──────────────────────────── */

		/** 统一的请求：把宿主的 `{ok:false,message}` 变成带 code 的 Error。 */
		async function request(path, options) {
			const response = await fetch(path, options);
			let body = null;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			if (!response.ok || body === null || body.ok !== true) {
				const error = new Error(body?.message ?? `HTTP ${response.status}`);
				error.code = body?.error ?? 'http';
				throw error;
			}
			return body;
		}

		const jsonPost = (path, payload) =>
			request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				cache: 'no-store'
			});

		const api = {
			state: (from, to) => request(`${API}/state?from=${from}&to=${to}`, { cache: 'no-store' }),
			save: (date, plan, scope) => jsonPost(`${API}/save`, { date, plan, scope }),
			remove: (date, id, scope) => jsonPost(`${API}/delete`, { date, id, scope }),
			toggle: (date, id, done) => jsonPost(`${API}/toggle`, { date, id, done }),
			wipe: (date) => jsonPost(`${API}/wipe`, { date }),
			undo: (ops) => jsonPost(`${API}/undo`, { ops })
		};

		/* ──────────────────────────── 小组件 ──────────────────────────── */

		/** 悬停时才显底色的小按钮（图标或胶囊）。 */
		function HoverButton({ label, onClick, children, wide, tone, disabled }) {
			const [hover, setHover] = React.useState(false);
			const isOff = disabled === true;
			const color =
				tone === 'danger'
					? 'var(--dsw-alias-state-error-primary)'
					: tone === 'primary'
						? 'var(--dsw-alias-state-business-primary)'
						: 'var(--dsw-alias-label-secondary)';
			return jsx.jsx('button', {
				type: 'button',
				title: label,
				'aria-label': label,
				disabled: isOff,
				onClick,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					appearance: 'none',
					border: 'none',
					background: hover && !isOff ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
					color,
					cursor: isOff ? 'not-allowed' : 'pointer',
					opacity: isOff ? 0.4 : 1,
					borderRadius: 6,
					height: wide === true ? 28 : 26,
					minWidth: wide === true ? undefined : 26,
					padding: wide === true ? '0 12px' : 0,
					fontSize: wide === true ? 12 : 16,
					lineHeight: wide === true ? '28px' : '26px',
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					gap: 4,
					transition: 'background 120ms ease'
				},
				children
			});
		}

		/** 密度圆点；没有计划时也占位，保证格子高度不变。 */
		function DensityDots({ count, onAccent }) {
			if (count <= 0) return jsx.jsx('span', { style: { display: 'block', height: 4 } });
			const dots = [];
			for (let index = 0; index < Math.min(count, MAX_DOTS); index += 1) {
				dots.push(
					jsx.jsx(
						'span',
						{
							style: {
								width: 3,
								height: 3,
								borderRadius: '50%',
								background: onAccent
									? 'var(--dsw-alias-label-primary-foreground)'
									: 'var(--dsw-alias-state-business-primary)',
								opacity: onAccent ? 0.85 : 0.7
							}
						},
						index
					)
				);
			}
			return jsx.jsxs('span', { style: { display: 'inline-flex', gap: 2, height: 4, alignItems: 'center' }, children: dots });
		}

		/** 日期格子。today 的圆点在数字**上方**，密度圆点在**下方**：靠位置区分状态。 */
		function DayCell({ cell, selected, today, count, onSelect, t }) {
			const [hover, setHover] = React.useState(false);
			const isToday = cell.key === today;
			const isSelected = cell.key === selected;

			let background = 'transparent';
			if (isSelected) background = 'var(--dsw-alias-state-business-primary)';
			else if (hover) background = 'var(--dsw-alias-interactive-bg-hover)';

			let numberColor = 'var(--dsw-alias-label-primary)';
			if (isSelected) numberColor = 'var(--dsw-alias-label-primary-foreground)';
			else if (!cell.inMonth) numberColor = 'var(--dsw-alias-label-tertiary)';
			else if (cell.isWeekend) numberColor = 'var(--dsw-alias-label-secondary)';

			const aboveDotColor = isToday
				? isSelected
					? 'var(--dsw-alias-label-primary-foreground)'
					: 'var(--dsw-alias-state-business-primary)'
				: 'transparent';

			return jsx.jsxs('button', {
				type: 'button',
				onClick: () => onSelect(cell.key),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				'aria-label': isToday ? cell.key + ' ' + t('todayTag') : cell.key,
				'aria-pressed': isSelected,
				style: {
					appearance: 'none',
					border: 'none',
					padding: 0,
					background,
					borderRadius: 8,
					height: 46,
					cursor: 'pointer',
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					gap: 2,
					transition: 'background 120ms ease'
				},
				children: [
					jsx.jsx('span', { style: { width: 4, height: 4, borderRadius: '50%', background: aboveDotColor } }),
					jsx.jsx('span', {
						style: {
							fontSize: 13,
							lineHeight: '16px',
							fontWeight: isSelected || isToday ? 600 : 400,
							color: numberColor
						},
						children: cell.day
					}),
					jsx.jsx(DensityDots, { count, onAccent: isSelected })
				]
			});
		}

		/** 日历卡片：头部 + 星期表头 + 6×7 网格。 */
		function CalendarCard({ year, month, selected, today, counts, onSelect, onShiftMonth, onGoToday, t }) {
			const rows = React.useMemo(() => {
				const cells = buildCells(year, month);
				const grouped = [];
				for (let index = 0; index < cells.length; index += 7) grouped.push(cells.slice(index, index + 7));
				return grouped;
			}, [year, month]);

			return jsx.jsxs('section', {
				style: {
					background: 'var(--dsw-alias-bg-layer-1)',
					border: '1px solid var(--dsw-alias-border-l3)',
					borderRadius: 12,
					padding: '12px 14px 14px'
				},
				children: [
					jsx.jsxs('header', {
						style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
						children: [
							jsx.jsx('span', {
								style: {
									fontSize: 14,
									fontWeight: 600,
									color: 'var(--dsw-alias-label-primary)',
									flex: '0 0 auto',
									fontVariantNumeric: 'tabular-nums'
								},
								children: year + ' 年 ' + (month + 1) + ' 月'
							}),
							jsx.jsx('span', { style: { flex: '1 1 auto' } }),
							jsx.jsx(HoverButton, { label: t('goToday'), onClick: onGoToday, wide: true, children: t('goToday') }),
							jsx.jsx(HoverButton, { label: t('prevMonth'), onClick: () => onShiftMonth(-1), children: '‹' }),
							jsx.jsx(HoverButton, { label: t('nextMonth'), onClick: () => onShiftMonth(1), children: '›' })
						]
					}),
					jsx.jsx('div', {
						style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2, marginBottom: 4 },
						children: WEEKDAYS.map((name) =>
							jsx.jsx(
								'div',
								{
									style: { textAlign: 'center', fontSize: 11, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
								},
								name
							)
						)
					}),
					jsx.jsxs('div', {
						style: { display: 'flex', flexDirection: 'column', gap: 2 },
						children: rows.map((row, rowIndex) =>
							jsx.jsx(
								'div',
								{
									style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2 },
									children: row.map((cell) =>
										jsx.jsx(DayCell, { cell, selected, today, count: counts[cell.key] ?? 0, onSelect, t }, cell.key)
									)
								},
								'row-' + rowIndex
							)
						)
					})
				]
			});
		}

		/** 方形完成框。用字符画勾，避免为一个对勾引入图标依赖。 */
		function DoneBox({ done, label, onToggle }) {
			const [hover, setHover] = React.useState(false);
			return jsx.jsx('button', {
				type: 'button',
				role: 'checkbox',
				'aria-checked': done,
				'aria-label': label,
				title: label,
				onClick: onToggle,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					appearance: 'none',
					flex: '0 0 auto',
					width: 16,
					height: 16,
					marginTop: 2,
					padding: 0,
					borderRadius: 4,
					cursor: 'pointer',
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					fontSize: 11,
					lineHeight: 1,
					color: 'var(--dsw-alias-label-primary-foreground)',
					background: done
						? 'var(--dsw-alias-state-business-primary)'
						: hover
							? 'var(--dsw-alias-interactive-bg-hover)'
							: 'transparent',
					border: done
						? '1px solid var(--dsw-alias-state-business-primary)'
						: '1px solid var(--dsw-alias-border-l4)',
					transition: 'background 120ms ease'
				},
				children: done ? '✓' : null
			});
		}

		/** 一张计划卡片。 */
		function PlanCard({ plan, overlaps, onToggle, onEdit, onRemove, t }) {
			const tone = IMPORTANCE_BY_ID[plan.importance] ?? IMPORTANCE_BY_ID.medium;
			const timeText = plan.start + ' – ' + plan.end;
			const rule = plan.isRecurring ? recurrenceText(plan.recurrence, plan.seriesAnchor ?? plan.date) : '';
			const recurringTitle = fill(plan.overridden ? t('recurringMarkOverridden') : t('recurringMark'), { rule });

			return jsx.jsxs('article', {
				style: {
					background: 'var(--dsw-alias-bg-layer-1)',
					border: '1px solid var(--dsw-alias-border-l3)',
					borderLeft: '4px solid ' + tone.color,
					borderRadius: 10,
					padding: '10px 12px',
					display: 'flex',
					gap: 10,
					alignItems: 'flex-start',
					opacity: plan.done ? 0.6 : 1
				},
				children: [
					jsx.jsx(DoneBox, { done: plan.done === true, label: plan.done === true ? t('undone') : t('done'), onToggle }),
					jsx.jsxs('div', {
						style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
						children: [
							jsx.jsxs('div', {
								style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
								children: [
									plan.isRecurring
										? jsx.jsx('span', {
												title: recurringTitle,
												'aria-label': recurringTitle,
												style: {
													fontSize: 12,
													lineHeight: '18px',
													color: plan.overridden
														? 'var(--dsw-alias-state-warn-primary)'
														: 'var(--dsw-alias-state-business-primary)'
												},
												children: '↻'
											})
										: null,
									jsx.jsx('span', {
										style: {
											fontSize: 13,
											fontWeight: 600,
											lineHeight: '18px',
											color: 'var(--dsw-alias-label-primary)',
											textDecoration: plan.done ? 'line-through' : 'none',
											wordBreak: 'break-word'
										},
										children: plan.title
									}),
									jsx.jsx('span', {
										style: {
											fontSize: 11,
											lineHeight: '18px',
											fontVariantNumeric: 'tabular-nums',
											color: 'var(--dsw-alias-label-tertiary)'
										},
										children: timeText
									}),
									jsx.jsx('span', {
										style: {
											fontSize: 10,
											lineHeight: '16px',
											padding: '0 5px',
											borderRadius: 4,
											color: tone.color,
											border: '1px solid ' + tone.color
										},
										children: tone.label
									}),
									overlaps
										? jsx.jsx('span', {
												title: t('overlap'),
												'aria-label': t('overlap'),
												style: { fontSize: 11, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary)' },
												children: '⚠'
											})
										: null
								]
							}),
							plan.content.trim() === ''
								? null
								: jsx.jsx('div', {
										style: {
											fontSize: 12,
											lineHeight: '18px',
											color: 'var(--dsw-alias-label-secondary)',
											whiteSpace: 'pre-wrap',
											wordBreak: 'break-word'
										},
										children: plan.content
									})
						]
					}),
					jsx.jsxs('div', {
						style: { flex: '0 0 auto', display: 'flex', gap: 2, alignItems: 'center' },
						children: [
							jsx.jsx(HoverButton, { label: t('edit'), onClick: onEdit, children: '✎' }),
							jsx.jsx(HoverButton, { label: t('remove'), onClick: onRemove, tone: 'danger', children: '✕' })
						]
					})
				]
			});
		}

		/** 一个带标签（与可选提示）的表单行。 */
		function Field({ label, children, hint }) {
			return jsx.jsxs('div', {
				style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 0', minWidth: 0 },
				children: [
					jsx.jsxs('span', {
						style: { display: 'flex', gap: 8, alignItems: 'baseline' },
						children: [
							jsx.jsx('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }, children: label }),
							hint === undefined
								? null
								: jsx.jsx('span', {
										style: { fontSize: 10, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', opacity: 0.8 },
										children: hint
									})
						]
					}),
					children
				]
			});
		}

		/** 统一样式的文本 / 多行输入。 */
		function TextInput({ value, onChange, placeholder, multiline, autoFocus, invalid }) {
			const [focused, setFocused] = React.useState(false);
			return jsx.jsx(multiline === true ? 'textarea' : 'input', {
				type: multiline === true ? undefined : 'text',
				rows: multiline === true ? 3 : undefined,
				value,
				placeholder,
				autoFocus,
				onChange: (event) => onChange(event.target.value),
				onFocus: () => setFocused(true),
				onBlur: () => setFocused(false),
				style: {
					width: '100%',
					boxSizing: 'border-box',
					background: 'var(--dsw-alias-bg-base)',
					color: 'var(--dsw-alias-label-primary)',
					border:
						'1px solid ' +
						(invalid
							? 'var(--dsw-alias-state-error-primary)'
							: focused
								? 'var(--dsw-alias-state-business-primary)'
								: 'var(--dsw-alias-border-l3)'),
					borderRadius: 8,
					padding: '6px 8px',
					fontSize: 13,
					lineHeight: '18px',
					fontFamily: 'inherit',
					outline: 'none',
					resize: multiline === true ? 'vertical' : undefined
				}
			});
		}

		/** 原生 `type="time"` / `type="date"` 输入。规格明确选了原生控件：零依赖。 */
		function NativeInput({ type, value, onChange, invalid }) {
			const [focused, setFocused] = React.useState(false);
			return jsx.jsx('input', {
				type,
				value,
				onChange: (event) => onChange(event.target.value),
				onFocus: () => setFocused(true),
				onBlur: () => setFocused(false),
				style: {
					width: '100%',
					boxSizing: 'border-box',
					background: 'var(--dsw-alias-bg-base)',
					color: 'var(--dsw-alias-label-primary)',
					border:
						'1px solid ' +
						(invalid
							? 'var(--dsw-alias-state-error-primary)'
							: focused
								? 'var(--dsw-alias-state-business-primary)'
								: 'var(--dsw-alias-border-l3)'),
					borderRadius: 8,
					padding: '5px 8px',
					fontSize: 13,
					lineHeight: '18px',
					fontFamily: 'inherit',
					outline: 'none'
				}
			});
		}

		/** 通用分段选择器（重要度与重复方式共用）。 */
		function Segmented({ options, value, onChange, colorOf }) {
			return jsx.jsx('div', {
				style: { display: 'flex', gap: 4 },
				children: options.map((option) => {
					const active = option.id === value;
					const color = colorOf === undefined ? 'var(--dsw-alias-state-business-primary)' : colorOf(option);
					return jsx.jsx(
						'button',
						{
							type: 'button',
							'aria-pressed': active,
							onClick: () => onChange(option.id),
							style: {
								appearance: 'none',
								flex: '1 1 0',
								cursor: 'pointer',
								borderRadius: 8,
								padding: '5px 0',
								fontSize: 12,
								lineHeight: '18px',
								fontFamily: 'inherit',
								whiteSpace: 'nowrap',
								color: active ? 'var(--dsw-alias-label-primary-foreground)' : color,
								background: active ? color : 'transparent',
								border: '1px solid ' + (active ? color : 'var(--dsw-alias-border-l3)'),
								transition: 'background 120ms ease'
							}
						},
						String(option.id)
					);
				})
			});
		}

		/**
		 * 新建 / 编辑浮窗。新建与编辑、仅此一次与整个系列，都是同一个组件：
		 * 靠 `initial` / `scope` / `anchor` 区分。
		 */
		function PlanEditor({ open, initial, scope, seriesBase, date, anchor, recurrenceReady, onCancel, onSubmit, t }) {
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [serverError, setServerError] = React.useState(null);

			const isCreate = initial === null || initial === undefined;
			const isSeriesScope = scope === 'series';
			const isRecurringOccurrence = !isCreate && initial.isRecurring === true;
			/** 重复方式只在"新建"或"编辑整个系列"时可改；并且要求宿主半边已经能处理它。
			    两重限制都是为了避免界面把用户带进一个必然失败或**静默失效**的操作：
			    - 旧的宿主会丢掉 recurrence 字段，新建的"每天"会变成不重复；
			    - 单次记录住在日期文件里，改成重复同样会静默失效。 */
			const canChangeRecurrence = (isCreate || isSeriesScope) && recurrenceReady === true;

			/* 每次打开都按来源重置，避免上一次编辑的内容漏进下一次。
			   注意"整个系列"必须用 seriesBase（系列自身的值），不能用当天的覆盖值，
			   否则会把某一天的临时改动悄悄写成整个系列的新定义。 */
			React.useEffect(() => {
				if (!open) return;
				if (isCreate) {
					setDraft({ title: '', content: '', start: '09:00', end: '10:00', importance: 'medium', recurrence: null, until: '' });
				} else if (isSeriesScope) {
					setDraft({
						title: seriesBase.title,
						content: seriesBase.content,
						start: seriesBase.start,
						end: seriesBase.end,
						importance: seriesBase.importance,
						recurrence: seriesBase.recurrence,
						until: seriesBase.until ?? ''
					});
				} else {
					setDraft({
						title: initial.title,
						content: initial.content,
						start: initial.start,
						end: initial.end,
						importance: initial.importance,
						recurrence: initial.recurrence ?? null,
						until: initial.until ?? ''
					});
				}
				setBusy(false);
				setServerError(null);
			}, [open, initial, scope, seriesBase, isCreate, isSeriesScope]);

			if (draft === null) return null;

			const errors = validateDraft(draft, { anchor });
			const patch = (values) => setDraft((current) => Object.assign({}, current, values));
			const recurrence = draft.recurrence ?? null;
			const warning = recurrenceWarning(recurrence, anchor);

			const submit = async () => {
				if (errors.length > 0 || busy) return;
				setBusy(true);
				setServerError(null);
				try {
					await onSubmit(draft);
				} catch (error) {
					setServerError(error.message);
					setBusy(false);
				}
			};

			const errorText = errors
				.map((code) => (code === 'errTitleLong' ? fill(t('errTitleLong'), { n: TITLE_MAX }) : t(code)))
				.join('；');

			return jsx.jsx(Modal, {
				open,
				onClose: busy ? () => {} : onCancel,
				title: isCreate ? t('createTitle') : t('editTitle'),
				closeLabel: t('cancel'),
				description: date,
				children: jsx.jsxs('div', {
					style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 340 },
					children: [
						jsx.jsx(Field, {
							label: t('fieldTitle'),
							children: jsx.jsx(TextInput, {
								value: draft.title,
								onChange: (value) => patch({ title: value }),
								placeholder: t('titlePlaceholder'),
								autoFocus: true,
								invalid: errors.indexOf('errTitleEmpty') >= 0 || errors.indexOf('errTitleLong') >= 0
							})
						}),
						jsx.jsx(Field, {
							label: t('fieldContent'),
							children: jsx.jsx(TextInput, {
								value: draft.content,
								onChange: (value) => patch({ content: value }),
								placeholder: t('contentPlaceholder'),
								multiline: true
							})
						}),
						jsx.jsxs('div', {
							style: { display: 'flex', gap: 10 },
							children: [
								jsx.jsx(Field, {
									label: t('fieldStart'),
									children: jsx.jsx(NativeInput, {
										type: 'time',
										value: draft.start,
										onChange: (value) => patch({ start: value }),
										invalid: errors.indexOf('errTimeFormat') >= 0
									})
								}),
								jsx.jsx(Field, {
									label: t('fieldEnd'),
									children: jsx.jsx(NativeInput, {
										type: 'time',
										value: draft.end,
										onChange: (value) => patch({ end: value }),
										invalid: errors.indexOf('errEndBeforeStart') >= 0 || errors.indexOf('errTimeFormat') >= 0
									})
								})
							]
						}),
						jsx.jsx(Field, {
							label: t('fieldImportance'),
							children: jsx.jsx(Segmented, {
								options: IMPORTANCE,
								value: draft.importance,
								onChange: (value) => patch({ importance: value }),
								colorOf: (option) => option.color
							})
						}),
						canChangeRecurrence
							? jsx.jsx(Field, {
									label: t('fieldRecurrence'),
									hint: recurrenceHint(recurrence, anchor),
									children: jsx.jsx(Segmented, {
										options: RECURRENCE_OPTIONS,
										value: recurrence,
										onChange: (value) => patch({ recurrence: value, until: value === null ? '' : draft.until })
									})
								})
							: null,
						/* 只有选了非"不重复"时才展开截止日期一行（Q20）。 */
						canChangeRecurrence && recurrence !== null
							? jsx.jsx(Field, {
									label: t('fieldUntil'),
									hint: t('untilHint'),
									children: jsx.jsx(NativeInput, {
										type: 'date',
										value: draft.until,
										onChange: (value) => patch({ until: value }),
										invalid: errors.indexOf('errUntilBeforeAnchor') >= 0
									})
								})
							: null,
						/* 规则与锚点冲突（周末的「工作日」）时提前说清楚，免得用户以为没保存成功。 */
						warning === undefined
							? null
							: jsx.jsx('p', {
									style: { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-warn-primary)' },
									children: warning
								}),
						!canChangeRecurrence && isRecurringOccurrence
							? jsx.jsx('p', {
									style: { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
									children: fill(t('oneOfSeriesNote'), {
										rule: recurrenceText(recurrence, initial.seriesAnchor ?? initial.date)
									})
								})
							: null,
						recurrenceReady !== true
							? jsx.jsx('p', {
									style: { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary)' },
									children: t('hostOutdated')
								})
							: null,
						recurrenceReady === true && !canChangeRecurrence && !isRecurringOccurrence
							? jsx.jsx('p', {
									style: { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
									children: t('singleOnlyNote')
								})
							: null,
						isSeriesScope
							? jsx.jsx('p', {
									style: { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
									children: fill(t('seriesNote'), {
										rule: recurrenceText(recurrence === null ? 'daily' : recurrence, seriesBase.anchor)
									})
								})
							: null,
						errors.length > 0 || serverError !== null
							? jsx.jsx('p', {
									style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
									children: serverError !== null ? serverError : errorText
								})
							: null
					]
				}),
				footer: jsx.jsxs('span', {
					style: { display: 'inline-flex', gap: 8, alignItems: 'center' },
					children: [
						busy ? jsx.jsx('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }, children: t('saving') }) : null,
						jsx.jsx(HoverButton, { label: t('cancel'), onClick: busy ? () => {} : onCancel, wide: true, children: t('cancel') }),
						jsx.jsx(HoverButton, {
							label: t('confirm'),
							onClick: submit,
							wide: true,
							tone: 'primary',
							disabled: errors.length > 0 || busy,
							children: t('confirm')
						})
					]
				})
			});
		}

		/**
		 * 重复计划的作用域询问（Q17）。默认动作是"仅此一次"，放在最右（主位），
		 * 破坏性大的"整个系列"用危险色放在左边——按快时手不会先落在它上面。
		 */
		function ScopePrompt({ open, action, plan, onCancel, onChoose, t }) {
			if (plan === null || plan === undefined) return null;
			const rule = recurrenceText(plan.recurrence, plan.seriesAnchor ?? plan.date);
			return jsx.jsx(Modal, {
				open,
				onClose: onCancel,
				title: t('scopeTitle'),
				closeLabel: t('cancel'),
				description:
					fill(action === 'delete' ? t('scopeDeleteBody') : t('scopeEditBody'), { title: plan.title }) + '（' + rule + '）',
				footer: jsx.jsxs('span', {
					style: { display: 'inline-flex', gap: 8 },
					children: [
						jsx.jsx(HoverButton, { label: t('cancel'), onClick: onCancel, wide: true, children: t('cancel') }),
						jsx.jsx(HoverButton, {
							label: t('scopeSeries'),
							onClick: () => onChoose('series'),
							wide: true,
							tone: 'danger',
							children: t('scopeSeries')
						}),
						jsx.jsx(HoverButton, {
							label: t('scopeOne'),
							onClick: () => onChoose('one'),
							wide: true,
							tone: 'primary',
							children: t('scopeOne')
						})
					]
				})
			});
		}

		/** 一键躺平的二次确认。写明条数；有重复计划时额外说明"仅跳过该日"（Q18）。 */
		function WipeConfirm({ open, date, plans, busy, onCancel, onConfirm, t }) {
			const total = plans.length;
			const recurring = plans.filter((plan) => plan.isRecurring === true).length;
			return jsx.jsx(Modal, {
				open,
				onClose: busy ? () => {} : onCancel,
				title: t('wipeTitle'),
				closeLabel: t('cancel'),
				description:
					fill(t('wipeBody'), { date, n: total }) +
					(recurring > 0 ? ' ' + fill(t('wipeBodyRecurring'), { m: recurring }) : ''),
				footer: jsx.jsxs('span', {
					style: { display: 'inline-flex', gap: 8 },
					children: [
						jsx.jsx(HoverButton, { label: t('cancel'), onClick: busy ? () => {} : onCancel, wide: true, children: t('cancel') }),
						jsx.jsx(HoverButton, {
							label: t('wipeConfirm'),
							onClick: onConfirm,
							wide: true,
							tone: 'danger',
							disabled: busy,
							children: t('wipeConfirm')
						})
					]
				})
			});
		}

		/* ──────────────────────────── 主视图 ──────────────────────────── */

		function PlannerView(props) {
			const t = props.t;

			const [today, setToday] = React.useState(todayKey);
			const [selected, setSelected] = React.useState(todayKey);
			const [view, setView] = React.useState(() => {
				const now = new Date();
				return { year: now.getFullYear(), month: now.getMonth() };
			});
			const [days, setDays] = React.useState({});
			const [status, setStatus] = React.useState('loading');
			const [loadError, setLoadError] = React.useState(null);
			const [editing, setEditing] = React.useState(null);
			const [scopePrompt, setScopePrompt] = React.useState(null);
			const [wiping, setWiping] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [undo, setUndo] = React.useState(null);
			const [ping, setPing] = React.useState({ state: 'pending' });
			/* 宿主半边自报的步骤号。第④步的客户端要靠它判断对面是否已经支持重复计划——
			   旧宿主的 store 会丢掉 recurrence 字段，新建的"每天"会静默变成不重复。 */
			const [hostStep, setHostStep] = React.useState(null);

			const todayRef = React.useRef(today);
			const undoSeq = React.useRef(0);

			/** 把"今天"推进到新值；仅当此前正选中旧今天时才跟着移动选中日。 */
			const adoptToday = React.useCallback((next) => {
				if (!DATE_RE.test(next)) return;
				const previous = todayRef.current;
				if (next === previous) return;
				todayRef.current = next;
				setSelected((current) => (current === previous ? next : current));
				setToday(next);
			}, []);

			React.useEffect(() => {
				let alive = true;
				fetch(`${API}/ping`, { cache: 'no-store' })
					.then((response) => response.json())
					.then((body) => {
						if (!alive) return;
						setPing({ state: 'ok', text: JSON.stringify(body) });
						if (typeof body?.step === 'number') setHostStep(body.step);
					})
					.catch((error) => {
						if (alive) setPing({ state: 'fail', text: String(error) });
					});
				return () => {
					alive = false;
				};
			}, []);

			/* 跨零点：每 60 秒比对本地日期字符串（不用算到午夜的定时器——后者在休眠唤醒
			   与夏令时下会漂移）。 */
			React.useEffect(() => {
				const timer = setInterval(() => adoptToday(todayKey()), 60000);
				return () => clearInterval(timer);
			}, [adoptToday]);

			const range = React.useMemo(() => rangeOfMonth(view.year, view.month), [view.year, view.month]);

			const refresh = React.useCallback(async () => {
				setStatus('loading');
				try {
					const data = await api.state(range.from, range.to);
					setDays(data.days ?? {});
					setLoadError(null);
					setStatus('ready');
					/* 宿主与本机对"今天"的判断可能因时钟差异而不一致；以宿主为准，
					   免得界面以为能新建、却被宿主用 409 拒掉。 */
					if (typeof data.today === 'string') adoptToday(data.today);
				} catch (error) {
					setLoadError(error.message);
					setStatus('error');
				}
			}, [range.from, range.to, adoptToday]);

			React.useEffect(() => {
				refresh();
			}, [refresh]);

			React.useEffect(() => {
				if (undo === null) return;
				const timer = setTimeout(() => setUndo(null), UNDO_MS);
				return () => clearTimeout(timer);
			}, [undo]);

			const planCounts = React.useMemo(() => {
				if (FIXTURE) {
					const fixture = {};
					const total = daysInMonth(view.year, view.month);
					for (let day = 1; day <= total; day += 1) {
						const amount = (day * 7) % 4;
						if (amount > 0) fixture[dateKey(view.year, view.month, day)] = amount;
					}
					return fixture;
				}
				const counts = {};
				for (const key of Object.keys(days)) counts[key] = days[key].length;
				return counts;
			}, [days, view.year, view.month]);

			const dayPlans = React.useMemo(() => sortPlans(days[selected] ?? []), [days, selected]);
			const overlaps = React.useMemo(() => overlapIds(dayPlans), [dayPlans]);

			const shiftMonth = React.useCallback((delta) => {
				setView((current) => shiftMonthOf(current.year, current.month, delta));
			}, []);

			const goToday = React.useCallback(() => {
				const key = todayKey();
				const parts = key.split('-');
				todayRef.current = key;
				setToday(key);
				setSelected(key);
				setView({ year: Number(parts[0]), month: Number(parts[1]) - 1 });
			}, []);

			/* 点到相邻月份的日子时顺带把月份切过去，否则选中态会跑到看不见的地方。 */
			const selectDate = React.useCallback((key) => {
				const parts = key.split('-');
				const year = Number(parts[0]);
				const month = Number(parts[1]) - 1;
				setSelected(key);
				setView((current) => (current.year === year && current.month === month ? current : { year, month }));
			}, []);

			/** 统一处理忙碌标记与刷新的包装。 */
			const run = React.useCallback(
				async (action) => {
					setBusy(true);
					try {
						await action();
						await refresh();
						return true;
					} finally {
						setBusy(false);
					}
				},
				[refresh]
			);

			const remember = React.useCallback((text, ops) => {
				if (!Array.isArray(ops) || ops.length === 0) return;
				undoSeq.current += 1;
				setUndo({ seq: undoSeq.current, text, ops });
			}, []);

			const isPast = selected < today;

			const submitPlan = React.useCallback(
				async (draft) => {
					const target = editing?.plan ?? null;
					const scope = editing?.scope ?? 'one';
					const until = draft.until === '' || draft.until === undefined ? null : draft.until;
					let payload;
					if (target === null) payload = { ...draft, until };
					else if (scope === 'series') payload = { id: target.id, ...draft, until };
					else payload = { id: target.id, ...draft, until: null };
					await run(() => api.save(selected, payload, scope));
					setEditing(null);
				},
				[editing, run, selected]
			);

			const requestEdit = React.useCallback((plan) => {
				if (plan.isRecurring === true) {
					setScopePrompt({ action: 'edit', plan });
					return;
				}
				setEditing({ plan, scope: 'one' });
			}, []);

			/** 单次计划不询问作用域，直接删（Q24：不弹确认框，靠撤销兜底）。 */
			const removeSingle = React.useCallback(
				(plan) => {
					void run(async () => {
						const result = await api.remove(selected, plan.id, 'one');
						if (result.removed !== null && result.removed !== undefined) {
							remember(fill(t('undoRemoved'), { title: result.removed.title }), result.undo);
						}
					});
				},
				[run, selected, remember, t]
			);

			const requestRemove = React.useCallback(
				(plan) => {
					if (plan.isRecurring === true) {
						setScopePrompt({ action: 'delete', plan });
						return;
					}
					removeSingle(plan);
				},
				[removeSingle]
			);

			const chooseScope = React.useCallback(
				async (scope) => {
					const pending = scopePrompt;
					setScopePrompt(null);
					if (pending === null) return;
					if (pending.action === 'edit') {
						setEditing({ plan: pending.plan, scope: scope === 'series' ? 'series' : 'one' });
						return;
					}
					await run(async () => {
						const result = await api.remove(selected, pending.plan.id, scope);
						if (result.removed === null || result.removed === undefined) return;
						remember(
							scope === 'series'
								? fill(t('undoSeriesRemoved'), { title: pending.plan.title })
								: fill(t('undoRemoved'), { title: pending.plan.title }),
							result.undo
						);
					});
				},
				[scopePrompt, run, selected, remember, t]
			);

			const togglePlan = React.useCallback(
				async (plan) => {
					await run(() => api.toggle(selected, plan.id, plan.done !== true));
				},
				[run, selected]
			);

			const confirmWipe = React.useCallback(async () => {
				await run(async () => {
					const result = await api.wipe(selected);
					setWiping(false);
					if (result.count > 0) remember(fill(t('undoWiped'), { n: result.count }), result.undo);
				});
			}, [run, selected, remember, t]);

			const applyUndo = React.useCallback(async () => {
				if (undo === null) return;
				const pending = undo;
				setUndo(null);
				await run(() => api.undo(pending.ops));
			}, [undo, run]);

			const editingSeries = editing !== null && editing.plan !== null && editing.plan !== undefined && editing.plan.seriesBase !== undefined;

			return jsx.jsxs('div', {
				style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
				children: [
					jsx.jsx('div', {
						style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '20px 24px 24px', boxSizing: 'border-box' },
						children: jsx.jsxs('div', {
							style: { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
							children: [
								jsx.jsx('h2', {
									style: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
									children: t('title')
								}),
								jsx.jsx(CalendarCard, {
									year: view.year,
									month: view.month,
									selected,
									today,
									counts: planCounts,
									onSelect: selectDate,
									onShiftMonth: shiftMonth,
									onGoToday: goToday,
									t
								}),
								jsx.jsxs('section', {
									style: {
										background: 'var(--dsw-alias-bg-layer-1)',
										border: '1px solid var(--dsw-alias-border-l3)',
										borderRadius: 12,
										padding: '12px 14px'
									},
									children: [
										jsx.jsxs('header', {
											style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
											children: [
												jsx.jsx('span', {
													style: {
														fontSize: 14,
														fontWeight: 600,
														color: 'var(--dsw-alias-label-primary)',
														fontVariantNumeric: 'tabular-nums'
													},
													children: selected
												}),
												selected === today
													? jsx.jsx('span', {
															style: {
																fontSize: 11,
																padding: '1px 6px',
																borderRadius: 4,
																color: 'var(--dsw-alias-state-business-primary)',
																background: 'var(--dsw-alias-interactive-bg-hover)'
															},
															children: t('todayTag')
														})
													: null,
												jsx.jsx('span', {
													style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
													children: fill(t('planCount'), { n: dayPlans.length })
												}),
												jsx.jsx('span', { style: { flex: '1 1 auto' } }),
												status === 'loading'
													? jsx.jsx('span', {
															style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
															children: t('loading')
														})
													: null
											]
										}),
										status === 'error' && loadError !== null
											? jsx.jsx('p', {
													style: {
														margin: '0 0 10px',
														fontSize: 12,
														lineHeight: '18px',
														color: 'var(--dsw-alias-state-error-primary)'
													},
													children: fill(t('loadFailed'), { message: loadError })
												})
											: null,
										dayPlans.length === 0
											? jsx.jsx('p', {
													style: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
													children: t('emptyDay')
												})
											: jsx.jsx('div', {
													style: { display: 'flex', flexDirection: 'column', gap: 8 },
													children: dayPlans.map((plan) =>
														jsx.jsx(
															PlanCard,
															{
																plan,
																overlaps: overlaps.has(plan.id),
																onToggle: () => togglePlan(plan),
																onEdit: () => requestEdit(plan),
																onRemove: () => requestRemove(plan),
																t
															},
															plan.id
														)
													)
												})
									]
								}),
								/* 宿主连通性提示：**健康时完全不出现**。
								   开发期这里曾把 ping 返回的原始 JSON 直接印在面板底部（含 Windows
								   路径与工具名，约 200 字符、等宽字体）——调试有用，但正常状态下它显示的
								   一切都没有信息量，糊在计划面板下方很难看。现在只在宿主不可达时出现
								   一行红字，那才是用户真正需要知道的一件事。 */
								ping.state === 'fail'
									? jsx.jsx('p', {
											style: {
												margin: 0,
												fontSize: 12,
												lineHeight: '18px',
												color: 'var(--dsw-alias-state-error-primary)'
											},
											children: t('pingFail') + (ping.text === undefined ? '' : '：' + ping.text)
										})
									: null
							]
						})
					}),
					jsx.jsxs('footer', {
						style: {
							flex: '0 0 auto',
							borderTop: '1px solid var(--dsw-alias-border-l3)',
							padding: '10px 24px',
							display: 'flex',
							alignItems: 'center',
							gap: 10,
							flexWrap: 'wrap'
						},
						children: [
							undo === null
								? null
								: jsx.jsxs('span', {
										style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '18px' },
										children: [
											jsx.jsx('span', { style: { color: 'var(--dsw-alias-label-secondary)' }, children: undo.text }),
											jsx.jsx(HoverButton, {
												label: t('undoAction'),
												onClick: applyUndo,
												tone: 'primary',
												wide: true,
												children: t('undoAction')
											})
										]
									}),
							jsx.jsx('span', { style: { flex: '1 1 auto' } }),
							jsx.jsx(HoverButton, {
								label: isPast ? t('newDisabled') : t('newPlan'),
								disabled: isPast,
								onClick: () => setEditing({ plan: null, scope: 'one' }),
								wide: true,
								tone: 'primary',
								children: t('newPlan')
							}),
							jsx.jsx(HoverButton, {
								label: dayPlans.length === 0 ? t('wipeDisabled') : t('wipe'),
								disabled: dayPlans.length === 0,
								onClick: () => setWiping(true),
								wide: true,
								tone: 'danger',
								children: t('wipe')
							})
						]
					}),
					jsx.jsx(PlanEditor, {
						open: editing !== null,
						initial: editing === null ? null : editing.plan,
						scope: editing === null ? 'one' : editing.scope,
						seriesBase: editingSeries ? editing.plan.seriesBase : null,
						date: selected,
						anchor: editing !== null && editing.scope === 'series' && editingSeries ? editing.plan.seriesBase.anchor : selected,
						/* null（探测还没回来或失败）时按乐观处理；只有明确小于 4 才判定为旧宿主。 */
						recurrenceReady: hostStep === null ? true : hostStep >= 4,
						onCancel: () => setEditing(null),
						onSubmit: submitPlan,
						t
					}),
					jsx.jsx(ScopePrompt, {
						open: scopePrompt !== null,
						action: scopePrompt === null ? 'edit' : scopePrompt.action,
						plan: scopePrompt === null ? null : scopePrompt.plan,
						onCancel: () => setScopePrompt(null),
						onChoose: chooseScope,
						t
					}),
					jsx.jsx(WipeConfirm, {
						open: wiping,
						date: selected,
						plans: dayPlans,
						busy,
						onCancel: () => setWiping(false),
						onConfirm: confirmWipe,
						t
					})
				]
			});
		}

		/* ──────────────────────────── 插件入口 ──────────────────────────── */

		/** 需要的 cordis 服务：插槽注册表与词典。 */
		const inject = ['slots', 'locale'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-planner: dictionaries');
			ctx.effect(
				() =>
					ctx.slots.inject('conversation.view', () =>
						ctx.slots.register(
							{
								name: 'conversation.view',
								id: VIEW_ID,
								order: 20,
								locale: NS,
								label: () => t('view.planner')
							},
							PlannerView
						)
					),
				'dsh-planner: view tab'
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * 只读的内部引用，供 `.dev/` 下的离线测试断言纯逻辑。全是无副作用的纯函数，
		 * 渲染路径碰不到它们。
		 */
		exports.__internals = {
			zh,
			en,
			dateKey,
			todayKey,
			daysInMonth,
			mondayOffset,
			shiftMonthOf,
			weekdayOf,
			buildCells,
			rangeOfMonth,
			sortPlans,
			overlapIds,
			recurrenceText,
			recurrenceHint,
			recurrenceWarning,
			validateDraft,
			fill,
			IMPORTANCE,
			RECURRENCE_OPTIONS,
			TITLE_MAX
		};
		return module.exports;
	}
});
