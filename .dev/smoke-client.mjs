/**
 * 浏览器半边的离线测试（不属于插件交付物，放在 .dev/ 下）。
 *
 * 做法：用假的 `window.__ModuleLoader__` 捕获注册，再用最小的 `require` 桩执行工厂，
 * 取出 `exports.__internals` 里的纯日期函数做断言。测的是**真实的产出代码**，
 * 不是复制出来的副本。
 *
 * 重点盯的是日历数学——周一起始、相邻月份补齐、闰年、跨年翻页。这些地方错一天
 * 是看不出来的，只有不变量能抓。
 */
import { readFileSync } from 'node:fs';

/* 从本文件位置推导，别写死本机路径——否则别人 clone 下来跑不了。 */
const SRC = new URL('../client/client.js', import.meta.url);

const failures = [];
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!ok) failures.push(label);
};

/* ── 1. 捕获注册 ──────────────────────────────────────────────────────────── */
const registrations = new Map();
const fakeWindow = {
	__ModuleLoader__: { load: (registration) => registrations.set(registration.id, registration) }
};

new Function('window', readFileSync(SRC, 'utf8'))(fakeWindow);

check('注册了且只注册了 dsh-planner', registrations.size === 1 && registrations.has('dsh-planner'), `-> ${[...registrations.keys()].join(',')}`);

const registration = registrations.get('dsh-planner');
check('注册的 id 与文件名一致（HMR 靠它定位）', registration.id === 'dsh-planner');

/* ── 2. 用最小桩执行工厂 ──────────────────────────────────────────────────── */
const fakeRequire = (spec) => {
	if (spec === 'react') return { useState() {}, useRef() {}, useEffect() {}, useMemo() {}, useCallback() {} };
	if (spec === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: {} };
	if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: function Modal() {} };
	throw new Error('未预期的 require: ' + spec);
};

const mod = registration.factory(fakeRequire);
check('工厂返回带 apply 的模块', typeof mod.apply === 'function');
check('inject 含 slots 与 locale', Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'), `-> ${JSON.stringify(mod.inject)}`);

const I = mod.__internals;
check('导出了测试所需的内部纯函数', I !== undefined && typeof I.buildCells === 'function');

/* ── 3. 日期键 ────────────────────────────────────────────────────────────── */
check('dateKey 补零', I.dateKey(2026, 0, 5) === '2026-01-05', `-> ${I.dateKey(2026, 0, 5)}`);
check('dateKey 两位数月份', I.dateKey(2026, 11, 31) === '2026-12-31', `-> ${I.dateKey(2026, 11, 31)}`);
check('todayKey 形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(I.todayKey()), `-> ${I.todayKey()}`);
check('todayKey 与本地日期一致', I.todayKey() === I.dateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));

/* ── 4. 周一起始的偏移 ────────────────────────────────────────────────────── */
check('周一 -> 0', I.mondayOffset(1) === 0);
check('周二 -> 1', I.mondayOffset(2) === 1);
check('周六 -> 5', I.mondayOffset(6) === 5);
check('周日 -> 6（关键：JS 的 0 必须映射到末尾）', I.mondayOffset(0) === 6, `-> ${I.mondayOffset(0)}`);

/* ── 5. 天数（含闰年） ────────────────────────────────────────────────────── */
check('2024-02 是闰月 29 天', I.daysInMonth(2024, 1) === 29, `-> ${I.daysInMonth(2024, 1)}`);
check('2026-02 是 28 天', I.daysInMonth(2026, 1) === 28, `-> ${I.daysInMonth(2026, 1)}`);
check('2000-02 是闰月（百年闰） 29 天', I.daysInMonth(2000, 1) === 29, `-> ${I.daysInMonth(2000, 1)}`);
check('1900-02 不是闰月（百年非闰） 28 天', I.daysInMonth(1900, 1) === 28, `-> ${I.daysInMonth(1900, 1)}`);
check('2026-09 是 30 天', I.daysInMonth(2026, 8) === 30);

/* ── 6. 月份平移（跨年） ──────────────────────────────────────────────────── */
const dec = I.shiftMonthOf(2026, 11, 1);
check('12 月 +1 -> 次年 1 月', dec.year === 2027 && dec.month === 0, `-> ${JSON.stringify(dec)}`);
const jan = I.shiftMonthOf(2026, 0, -1);
check('1 月 -1 -> 上年 12 月', jan.year === 2025 && jan.month === 11, `-> ${JSON.stringify(jan)}`);
const back = I.shiftMonthOf(2026, 5, 12);
check('+12 个月 -> 同月次年', back.year === 2027 && back.month === 5, `-> ${JSON.stringify(back)}`);

/* ── 7. 格子网格的结构不变量 ──────────────────────────────────────────────── */
/** 把 `YYYY-MM-DD` 加一天，用 UTC 做纯算术，避免本地时区干扰。 */
function plusOneDay(key) {
	const [y, m, d] = key.split('-').map(Number);
	const next = new Date(Date.UTC(y, m - 1, d + 1));
	return I.dateKey(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
}

/** 逐个检查一个月的网格；返回该月通过的不变量条数。 */
function verifyMonth(year, month, label) {
	const cells = I.buildCells(year, month);
	let ok = true;

	ok &&= cells.length === 42;
	ok &&= cells.every((cell, index) => index === 0 || cell.key === plusOneDay(cells[index - 1].key));

	const inMonth = cells.filter((cell) => cell.inMonth);
	ok &&= inMonth.length === I.daysInMonth(year, month);
	ok &&= inMonth[0].day === 1;
	ok &&= inMonth[inMonth.length - 1].day === I.daysInMonth(year, month);

	/* 每行 7 个，且第一格必须是周一、第七格必须是周日。 */
	for (let row = 0; row < 6; row += 1) {
		const slice = cells.slice(row * 7, row * 7 + 7);
		ok &&= slice.length === 7;
		const firstWeekday = new Date(slice[0].key + 'T00:00:00').getDay();
		const lastWeekday = new Date(slice[6].key + 'T00:00:00').getDay();
		ok &&= firstWeekday === 1 && lastWeekday === 0;
	}

	/* 同一格里不能出现重复日期。 */
	ok &&= new Set(cells.map((cell) => cell.key)).size === 42;

	/* 1 号必须落在 Monday 偏移算出来的那个位置上。 */
	const lead = I.mondayOffset(new Date(year, month, 1).getDay());
	ok &&= cells[lead].key === I.dateKey(year, month, 1);

	check(`${label} 网格不变量（42 格 / 连续 / 周一起始 / 1 号位置 / 无重复）`, ok);
	return ok;
}

/* 覆盖：普通月、闰月、年初、年末、以及一个 1 号恰好是周一的月份。 */
verifyMonth(2026, 8, '2026-09');
verifyMonth(2024, 1, '2024-02(闰)');
verifyMonth(2026, 0, '2026-01');
verifyMonth(2026, 11, '2026-12(跨年)');
verifyMonth(2023, 4, '2023-05');

/* 一段连续月份全扫一遍，抓偶发的边界问题。 */
let swept = 0;
let sweepOk = true;
for (let month = 0; month < 12; month += 1) {
	const cells = I.buildCells(2026, month);
	sweepOk &&= cells.length === 42;
	sweepOk &&= cells.every((cell, index) => index === 0 || cell.key === plusOneDay(cells[index - 1].key));
	sweepOk &&= cells.filter((c) => c.inMonth).length === I.daysInMonth(2026, month);
	swept += 1;
}
check(`2026 全年 12 个月逐一扫描（${swept} 个月）`, sweepOk);

/* 跨年月份里相邻月份的年份必须算对（12 月的尾随格子属于次年 1 月）。 */
const decCells = I.buildCells(2026, 11);
const trailing = decCells[decCells.length - 1];
check('2026-12 的最后一格落在 2027-01', trailing.key.startsWith('2027-01'), `-> ${trailing.key}`);

const janCells = I.buildCells(2026, 0);
const leading = janCells[0];
check('2026-01 的第一格落在 2025-12', leading.key.startsWith('2025-12'), `-> ${leading.key}`);
check('前导格 inMonth 为假', leading.inMonth === false);
check('周末标记落在第 6/7 列', janCells[5].isWeekend === true && janCells[6].isWeekend === true && janCells[4].isWeekend === false);

/* ── 11. 第③步新增的纯业务逻辑 ──────────────────────────────────────────── */

/* 区间：某月网格覆盖的 42 天，正好是 state 接口要拉的区间。 */
const sept = I.rangeOfMonth(2026, 8);
check('rangeOfMonth 起点是网格第一格', sept.from === '2026-08-31', `-> ${sept.from}`);
check('rangeOfMonth 终点是网格最后一格', sept.to === '2026-10-11', `-> ${sept.to}`);
let spanDays = 0;
for (let cursor = sept.from; cursor <= sept.to; cursor = plusOneDay(cursor)) spanDays += 1;
check('区间恰好覆盖 42 天', spanDays === 42, `-> ${spanDays}`);
check('区间包含该月 1 号', sept.from < '2026-09-01' && sept.to > '2026-09-30');
const feb = I.rangeOfMonth(2026, 1);
check('闰年与非闰年的区间都能算', feb.from < '2026-02-01' && feb.to > '2026-02-28');
check('区间被去重后仍是 42 天（无重叠格）', new Set(I.buildCells(2026, 8).map((c) => c.key)).size === 42);

/* 排序：先按开始时间，再按创建时间。 */
const shuffled = [
	{ id: 'c', start: '12:00', end: '13:00', createdAt: '2026-01-03' },
	{ id: 'a', start: '07:00', end: '08:00', createdAt: '2026-01-01' },
	{ id: 'b', start: '07:00', end: '07:30', createdAt: '2026-01-02' },
	{ id: 'd', start: '15:00', end: '16:00', createdAt: '2026-01-04' }
];
const ordered = I.sortPlans(shuffled);
check('sortPlans 按开始时间升序', ordered.map((p) => p.start).join(',') === '07:00,07:00,12:00,15:00', `-> ${ordered.map((p) => p.start).join(',')}`);
check('同一开始时间按创建时间定序', ordered[0].id === 'a' && ordered[1].id === 'b', `-> ${ordered[0].id},${ordered[1].id}`);
check('sortPlans 不修改入参', shuffled[0].id === 'c' && shuffled.length === 4);

/* 重叠判定（Q25：不拦截，只标识）。 */
const forOverlap = [
	{ id: 'p1', start: '09:00', end: '10:00' },
	{ id: 'p2', start: '09:30', end: '10:30' },
	{ id: 'p3', start: '11:00', end: '12:00' },
	{ id: 'p4', start: '11:30', end: '12:30' }
];
const overlapped = I.overlapIds(forOverlap);
check('重叠的后续条目被标出', overlapped.has('p2') && overlapped.has('p4'), `-> ${[...overlapped].join(',')}`);
check('不重叠的条目不被标出', !overlapped.has('p1') && !overlapped.has('p3'));
check('首条永远不会被标为重叠', !overlapped.has('p1'));
check('首尾相接不算重叠', I.overlapIds([{ id: 'x', start: '09:00', end: '10:00' }, { id: 'y', start: '10:00', end: '11:00' }]).size === 0);
check('空列表与单条列表不报错', I.overlapIds([]).size === 0 && I.overlapIds([forOverlap[0]]).size === 0);

/* 表单校验：与宿主同规则，用于把"确定"置灰。 */
check('合法草稿无错误', I.validateDraft({ title: '写周报', start: '09:00', end: '10:00' }).length === 0);
check('空标题报错', I.validateDraft({ title: '   ', start: '09:00', end: '10:00' }).indexOf('errTitleEmpty') >= 0);
check('超长标题报错', I.validateDraft({ title: 'x'.repeat(I.TITLE_MAX + 1), start: '09:00', end: '10:00' }).indexOf('errTitleLong') >= 0);
check('结束早于开始报错', I.validateDraft({ title: 'a', start: '10:00', end: '09:00' }).indexOf('errEndBeforeStart') >= 0);
check('结束等于开始报错', I.validateDraft({ title: 'a', start: '10:00', end: '10:00' }).indexOf('errEndBeforeStart') >= 0);
check('时间格式非法报错', I.validateDraft({ title: 'a', start: '9:00', end: '10:00' }).indexOf('errTimeFormat') >= 0);
const multiError = I.validateDraft({ title: '', start: '25:00', end: 'zz' });
check(
	'校验一次能报出多个错',
	multiError.length === 2 && multiError.indexOf('errTitleEmpty') >= 0 && multiError.indexOf('errTimeFormat') >= 0,
	`-> ${multiError.join(',')}`
);
check('两个时间都非法时只报一次 errTimeFormat（不重复提示）', I.validateDraft({ title: 'a', start: '25:00', end: 'zz' }).length === 1);

/* 占位符填充。 */
check('fill 替换单个占位符', I.fill('{n} 条计划', { n: 3 }) === '3 条计划');
check('fill 替换多个不同占位符', I.fill('删除 {n} 条（{m} 条重复）', { n: 5, m: 2 }) === '删除 5 条（2 条重复）');
check('fill 替换重复出现的占位符', I.fill('{n}/{n}', { n: 7 }) === '7/7');
check('fill 无占位符时原样返回', I.fill('原样', { n: 1 }) === '原样');

/* 三档重要度。 */
check('重要度正好三档', I.IMPORTANCE.length === 3);
check('重要度 id 是 high/medium/low', I.IMPORTANCE.map((i) => i.id).join(',') === 'high,medium,low');
check('三档颜色互不相同', new Set(I.IMPORTANCE.map((i) => i.color)).size === 3);
check('三档颜色都是主题 token（未硬编码色值）', I.IMPORTANCE.every((i) => i.color.indexOf('var(--dsw-') === 0));
check('三档都有中文标签', I.IMPORTANCE.every((i) => typeof i.label === 'string' && i.label.length === 1));

/* ── 12. 第④步新增：重复规则 ─────────────────────────────────────────────── */

check('重复选项正好四档（含不重复）', I.RECURRENCE_OPTIONS.length === 4);
check(
	'重复选项 id 序列正确',
	I.RECURRENCE_OPTIONS.map((o) => String(o.id)).join(',') === 'null,daily,weekly,weekdays',
	`-> ${I.RECURRENCE_OPTIONS.map((o) => String(o.id)).join(',')}`
);
check('四个选项都有中文标签', I.RECURRENCE_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length >= 2));
check('第一档就是不重复（界面顺序：不重复在最左）', I.RECURRENCE_OPTIONS[0].id === null);

check('weekdayOf 已暴露且正确（2026-09-24 是周四）', I.weekdayOf('2026-09-24') === 4, `-> ${I.weekdayOf('2026-09-24')}`);

check('recurrenceText 不重复', I.recurrenceText(null, '2026-09-24') === '不重复');
check('recurrenceText 每天', I.recurrenceText('daily', '2026-09-24') === '每天');
check('recurrenceText 工作日', I.recurrenceText('weekdays', '2026-09-24') === '每个工作日');
check('recurrenceText 每周带上开始那天的星期', I.recurrenceText('weekly', '2026-09-23') === '每周三', `-> ${I.recurrenceText('weekly', '2026-09-23')}`);
check('recurrenceText 每周（周日也要对）', I.recurrenceText('weekly', '2026-09-27') === '每周日', `-> ${I.recurrenceText('weekly', '2026-09-27')}`);

/* 浮窗里那一行统一说明：三档都要显示锚点日期，而不是只给"每周"显示。 */
check('每天的提示含锚点日期', I.recurrenceHint('daily', '2026-09-25') === '从 2026-09-25 起，每天', `-> ${I.recurrenceHint('daily', '2026-09-25')}`);
check('每周的提示含锚点日期与参照星期几', I.recurrenceHint('weekly', '2026-09-23') === '从 2026-09-23 起，每周三', `-> ${I.recurrenceHint('weekly', '2026-09-23')}`);
check('工作日的提示含锚点日期', I.recurrenceHint('weekdays', '2026-09-25') === '从 2026-09-25 起，每个工作日', `-> ${I.recurrenceHint('weekdays', '2026-09-25')}`);
check('不重复时没有提示', I.recurrenceHint(null, '2026-09-25') === undefined);
check('undefined 也没有提示（缺字段时不炸）', I.recurrenceHint(undefined, '2026-09-25') === undefined);
check(
	'三档提示的信息量一致（都写出锚点日期）',
	['daily', 'weekly', 'weekdays'].every((rule) => I.recurrenceHint(rule, '2026-09-25').indexOf('2026-09-25') > 0)
);
check(
	'三档提示互不相同（不会把规则说混）',
	new Set(['daily', 'weekly', 'weekdays'].map((rule) => I.recurrenceHint(rule, '2026-09-25'))).size === 3
);

/* 规则与锚点冲突的提醒：只有"工作日 + 周末锚点"这一种。 */
check('工作日锚在周六 -> 有提醒', typeof I.recurrenceWarning('weekdays', '2026-09-26') === 'string', `-> ${I.recurrenceWarning('weekdays', '2026-09-26')}`);
check('工作日锚在周日 -> 有提醒', typeof I.recurrenceWarning('weekdays', '2026-09-27') === 'string');
check('工作日锚在工作日 -> 无提醒', I.recurrenceWarning('weekdays', '2026-09-25') === undefined);
check('每天任何时候都无提醒', I.recurrenceWarning('daily', '2026-09-26') === undefined);
check('每周任何时候都无提醒（它的锚点就是它自己）', I.recurrenceWarning('weekly', '2026-09-26') === undefined);
check('不重复无提醒', I.recurrenceWarning(null, '2026-09-26') === undefined);
check('提醒文字说明了「当天不会出现」', String(I.recurrenceWarning('weekdays', '2026-09-26')).includes('当天不会出现'));

check(
	'选了重复但截止日早于锚点 -> 报 errUntilBeforeAnchor',
	I.validateDraft(
		{ title: 'a', start: '09:00', end: '10:00', recurrence: 'daily', until: '2026-09-01' },
		{ anchor: '2026-09-24' }
	).indexOf('errUntilBeforeAnchor') >= 0
);
check(
	'截止日等于锚点（只有一天）-> 通过',
	I.validateDraft({ title: 'a', start: '09:00', end: '10:00', recurrence: 'daily', until: '2026-09-24' }, { anchor: '2026-09-24' }).length === 0
);
check(
	'选了重复但截止日留空 -> 通过（永不结束）',
	I.validateDraft({ title: 'a', start: '09:00', end: '10:00', recurrence: 'daily', until: '' }, { anchor: '2026-09-24' }).length === 0
);
check(
	'不重复时截止日不参与校验',
	I.validateDraft({ title: 'a', start: '09:00', end: '10:00', recurrence: null, until: '2020-01-01' }, { anchor: '2026-09-24' }).length === 0
);
check('非法重复方式 -> 报 errRecurrence', I.validateDraft({ title: 'a', start: '09:00', end: '10:00', recurrence: 'yearly' }).indexOf('errRecurrence') >= 0);
check(
	'没有锚点时不会误报截止日',
	I.validateDraft({ title: 'a', start: '09:00', end: '10:00', recurrence: 'daily', until: '2020-01-01' }).length === 0
);
check(
	'重复的合法草稿无错误',
	I.validateDraft({ title: '周会', start: '14:00', end: '15:00', recurrence: 'weekly', until: '2026-12-31' }, { anchor: '2026-09-24' }).length === 0
);
check(
	'重复草稿里的时间/标题问题仍会被抓到',
	I.validateDraft({ title: '', start: '10:00', end: '09:00', recurrence: 'daily', until: '' }, { anchor: '2026-09-24' }).length === 2
);

/* ── 13. 词典完整性 ───────────────────────────────────────────────────────
   这一条是补上一个真缺陷后加的：我把渲染改成 `t('pingFail')`，而那个键在第③步重写词典时
   已经被删掉了——界面会显示字面的 "pingFail"。这里静态扫描所有字面量键，逐个核对两张词典。 */
const clientSource = readFileSync(SRC, 'utf8');
const literalKeys = [...new Set([...clientSource.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]))];
check(`扫到了 UI 里的字面量词典键（${literalKeys.length} 个）`, literalKeys.length > 20, `-> ${literalKeys.length}`);
const missingZh = literalKeys.filter((key) => I.zh[key] === undefined);
check('每个字面量键都在中文词典里', missingZh.length === 0, missingZh.length > 0 ? `缺失：${missingZh.join(', ')}` : '');
const missingEn = literalKeys.filter((key) => I.en[key] === undefined);
check('每个字面量键也都在英文词典里', missingEn.length === 0, missingEn.length > 0 ? `缺失：${missingEn.join(', ')}` : '');
/* 错误码是动态传进去的（`t(code)`），静态扫不到，单独列出核对。 */
for (const code of ['errTitleEmpty', 'errTitleLong', 'errTimeFormat', 'errEndBeforeStart', 'errRecurrence', 'errUntilBeforeAnchor']) {
	check(`  动态错误码词典存在 ${code}`, I.zh[code] !== undefined && I.en[code] !== undefined);
}
check('中文与英文词典的键集完全一致', (() => Object.keys(I.zh).sort().join(',') === Object.keys(I.en).sort().join(','))());
check('词典里没有空文案', Object.values(I.zh).every((value) => typeof value === 'string' && value.trim() !== ''));

/* ── 收尾 ─────────────────────────────────────────────────────────────────── */
console.log('');
if (failures.length === 0) {
	console.log('SMOKE OK — 浏览器半边的日期逻辑可以信任。');
} else {
	console.log(`SMOKE FAILED — ${failures.length} 项失败：`);
	for (const item of failures) console.log('  - ' + item);
	process.exitCode = 1;
}
