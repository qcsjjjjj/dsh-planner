/**
 * 持久化层的离线测试（不属于插件交付物，放在 .dev/ 下）。
 *
 * `lib/store.js` 只依赖 node 内置模块，所以可以在普通 node 进程里用临时目录
 * 完整驱动它——不需要 DSH、不需要重启、不需要浏览器。
 *
 * 第④步的新增重点：重复规则的展开、截止日期、按天独立的完成状态、
 * 「仅此一次 / 整个系列」的作用域、以及躺平不会误删系列（Q18，靠结构保证）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createPlanStore,
	validatePlan,
	todayKey,
	weekdayOf,
	addDays,
	storageRoot,
	StoreError,
	TITLE_MAX
} from '../lib/store.js';

const failures = [];
const check = (label, ok, extra = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!ok) failures.push(label);
};
const throws = (label, fn, code, messagePart) => {
	try {
		fn();
		check(label, false, '-> 没有抛错');
	} catch (error) {
		const okCode = error instanceof StoreError && (code === undefined || error.code === code);
		const okMsg = messagePart === undefined || String(error.message).includes(messagePart);
		check(label, okCode && okMsg, `-> ${error.code ?? error.name}: ${error.message}`);
	}
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-planner-store-'));
const store = createPlanStore({ root: sandbox });
console.log('沙箱:', sandbox);

const TODAY = todayKey();
const PAST = addDays(TODAY, -3);
const FUTURE = addDays(TODAY, 5);
/** 今天之后的第一个周三（用于"每周"规则）。 */
const nextWednesday = (() => {
	let cursor = addDays(TODAY, 1);
	while (weekdayOf(cursor) !== 3) cursor = addDays(cursor, 1);
	return cursor;
})();

/* ══════════════════════ 1. 基础：路径、空状态、日期工具 ══════════════════════ */
check('缺省存储根指向 $DSH_HOME/storages/planner', storageRoot({ DSH_HOME: 'X:/h' }).endsWith(path.join('storages', 'planner')));
check('DSH_HOME 为空串时退回 ~/.dsh', storageRoot({ DSH_HOME: '   ' }).includes(path.join('.dsh', 'storages', 'planner')));
check('todayKey 形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(TODAY), `-> ${TODAY}`);
check('addDays 跨月正确', addDays('2026-01-31', 1) === '2026-02-01', `-> ${addDays('2026-01-31', 1)}`);
check('addDays 跨年正确', addDays('2026-12-31', 1) === '2027-01-01', `-> ${addDays('2026-12-31', 1)}`);
check('addDays 负数跨年正确', addDays('2026-01-01', -1) === '2025-12-31', `-> ${addDays('2026-01-01', -1)}`);
check('weekdayOf 周日=0', weekdayOf('2026-09-27') === 0, `-> ${weekdayOf('2026-09-27')}`);
check('weekdayOf 周六=6', weekdayOf('2026-09-26') === 6, `-> ${weekdayOf('2026-09-26')}`);
check('不存在的日期读出来是空数组', Array.isArray(store.readDay(FUTURE)) && store.readDay(FUTURE).length === 0);
check('区间读取为空对象', Object.keys(store.readRange(PAST, FUTURE)).length === 0);

/* ══════════════════════ 2. 单次计划：新建 / 校验 / 排序 ══════════════════════ */
const created = store.save({
	date: TODAY,
	plan: { title: '  写周报  ', content: '第 40 周', start: '09:00', end: '10:30', importance: 'high' }
});
check('新建返回 created:true', created.created === true);
check('标题被 trim', created.plan.title === '写周报');
check('回传带 date 与 isRecurring:false', created.plan.date === TODAY && created.plan.isRecurring === false);
check('落盘文件存在', fs.existsSync(store.fileFor(TODAY)));
check('没有残留临时文件', fs.readdirSync(store.plansDir).every((n) => !n.includes('.tmp-')));

check('validatePlan 对合法计划无意见', validatePlan({ ...created.plan, recurrence: null, until: null }).length === 0);
throws('空标题被拒', () => store.save({ date: TODAY, plan: { title: '   ', start: '09:00', end: '10:00' } }), 'invalid', '标题不能为空');
throws('超长标题被拒', () => store.save({ date: TODAY, plan: { title: 'x'.repeat(TITLE_MAX + 1), start: '09:00', end: '10:00' } }), 'invalid');
throws('结束早于开始被拒', () => store.save({ date: TODAY, plan: { title: 'a', start: '10:00', end: '09:00' } }), 'invalid', '结束时间必须晚于开始时间');
throws('时间格式非法被拒', () => store.save({ date: TODAY, plan: { title: 'a', start: '9:00', end: '10:00' } }), 'invalid');
throws('非法日期被拒', () => store.save({ date: '2026/09/24', plan: { title: 'a', start: '09:00', end: '10:00' } }), 'invalid-date');

const defaulted = store.save({ date: FUTURE, plan: { title: '没写重要度', start: '08:00', end: '08:30' } });
check('缺省重要度落到 medium', defaulted.plan.importance === 'medium');

check('单次计划不能就地改成重复计划（否则会静默失效）', (() => {
	try {
		store.save({
			date: FUTURE,
			plan: { id: defaulted.plan.id, title: '改重复', start: '08:00', end: '08:30', recurrence: 'daily' }
		});
		return false;
	} catch (error) {
		return error.code === 'invalid' && error.message.includes('重新创建');
	}
})());

/* ══════════════════════ 3. 过去日期边界（Q23=c） ══════════════════════ */
throws('过去日期不能新建', () => store.save({ date: PAST, plan: { title: '补记', start: '09:00', end: '10:00' } }), 'past-date');
store.undo({
	ops: [
		{
			op: 'putPlan',
			date: PAST,
			plan: {
				id: 'legacy-1',
				title: '当年建的会',
				content: '',
				start: '14:00',
				end: '15:00',
				importance: 'low',
				done: false,
				createdAt: '2026-01-01T00:00:00.000Z'
			}
		}
	]
});
check('undo 能把计划注入到过去日期', store.readDay(PAST).length === 1);
const pastUpdate = store.save({
	date: PAST,
	plan: { id: 'legacy-1', title: '改了标题', content: '', start: '14:00', end: '15:30', importance: 'medium' }
});
check('过去日期**可以编辑**已存在的计划', pastUpdate.created === false && pastUpdate.plan.title === '改了标题');
check('编辑保留了 createdAt', pastUpdate.plan.createdAt === '2026-01-01T00:00:00.000Z');

/* ══════════════════════ 4. 排序 ══════════════════════ */
store.save({ date: FUTURE, plan: { title: '下午', start: '15:00', end: '16:00' } });
store.save({ date: FUTURE, plan: { title: '早上', start: '07:00', end: '08:00' } });
store.save({ date: FUTURE, plan: { title: '中午', start: '12:00', end: '13:00' } });
check(
	'按开始时间升序',
	store.readDay(FUTURE).map((p) => p.start).join(',') === '07:00,08:00,12:00,15:00',
	`-> ${store.readDay(FUTURE).map((p) => p.start).join(',')}`
);

/* ══════════════════════ 5. 完成 / 删除 / 撤销 ══════════════════════ */
const morning = store.readDay(FUTURE).find((p) => p.title === '早上');
check('勾选完成后为 true', store.setDone({ date: FUTURE, id: morning.id, done: true }).done === true);
check('取消完成写回 false', store.setDone({ date: FUTURE, id: morning.id, done: false }).done === false);
throws('勾选不存在的计划报 not-found', () => store.setDone({ date: FUTURE, id: 'nope', done: true }), 'not-found');

const beforeDelete = store.readDay(FUTURE).length;
const deleteResult = store.remove({ date: FUTURE, id: morning.id });
check(
	'删除返回被删的那条与一条撤销操作',
	deleteResult.removed?.id === morning.id && deleteResult.undo.length === 1 && deleteResult.undo[0].op === 'putPlan'
);
check('删除后数量 -1', store.readDay(FUTURE).length === beforeDelete - 1);
check('删除不存在的返回 null 与空撤销列表', store.remove({ date: FUTURE, id: 'nope' }).removed === null);
store.undo({ ops: deleteResult.undo });
check('撤销后计划回到原位', store.readDay(FUTURE).some((p) => p.id === morning.id));
check('撤销后仍保持排序', store.readDay(FUTURE).map((p) => p.start).join(',') === '07:00,08:00,12:00,15:00');
store.undo({ ops: deleteResult.undo });
check('重复撤销不会产生重复条目', store.readDay(FUTURE).filter((p) => p.id === morning.id).length === 1);

const pastRemove = store.remove({ date: PAST, id: 'legacy-1' });
store.undo({ ops: pastRemove.undo });
check('过去日期的删除可撤销（撤销绕过 past-date 规则）', store.readDay(PAST).length === 1);

/* ══════════════════════ 6. 重复计划：四种规则 ══════════════════════ */
const dailyAnchor = addDays(TODAY, 1);
const daily = store.save({
	date: dailyAnchor,
	plan: { title: '每日站会', start: '09:00', end: '09:15', importance: 'medium', recurrence: 'daily' }
});
check('带重复的计划落到 series.json', fs.existsSync(store.seriesFile));
check('新建重复计划返回 scope:series', daily.scope === 'series' && daily.created === true);
check('锚点当天就发生', store.readDay(dailyAnchor).some((p) => p.id === daily.plan.id && p.isRecurring === true));
check('锚点之前不发生', !store.readDay(addDays(dailyAnchor, -1)).some((p) => p.id === daily.plan.id));
check('锚点之后第 5 天发生', store.readDay(addDays(dailyAnchor, 5)).some((p) => p.id === daily.plan.id));
check('系列定义没有混进日期文件', (() => {
	try {
		return !JSON.parse(fs.readFileSync(store.fileFor(dailyAnchor), 'utf8')).plans.some((p) => p.id === daily.plan.id);
	} catch {
		return true; /* 该日没有日期文件，更说明系列没混进去 */
	}
})());

/* 每周：锚在一个周三 */
const weekly = store.save({
	date: nextWednesday,
	plan: { title: '周会', start: '14:00', end: '15:00', importance: 'high', recurrence: 'weekly' }
});
check('每周：锚点当天发生', store.readDay(nextWednesday).some((p) => p.id === weekly.plan.id));
check('每周：次日（周四）不发生', !store.readDay(addDays(nextWednesday, 1)).some((p) => p.id === weekly.plan.id));
check('每周：下周三发生', store.readDay(addDays(nextWednesday, 7)).some((p) => p.id === weekly.plan.id));
check('每周：下周四不发生', !store.readDay(addDays(nextWednesday, 8)).some((p) => p.id === weekly.plan.id));
check('每周：隔两周的周三也发生', store.readDay(addDays(nextWednesday, 14)).some((p) => p.id === weekly.plan.id));

/* 工作日：锚点必须落在一个**工作日**上，否则系列在锚点当天就不发生——那属于另一条
   单独的测试（见后面的"周末锚点"一节）。这里曾经写死 addDays(TODAY,1)，结果日期一跨到
   周五就静默变成周六，把这条测试弄成了假的失败。 */
const nextWeekday = (() => {
	let cursor = addDays(TODAY, 1);
	while (weekdayOf(cursor) === 0 || weekdayOf(cursor) === 6) cursor = addDays(cursor, 1);
	return cursor;
})();
const workday = store.save({
	date: nextWeekday,
	plan: { title: '例行巡检', start: '10:00', end: '10:30', importance: 'low', recurrence: 'weekdays' }
});
check('工作日系列锚点当天就发生', store.readDay(nextWeekday).some((p) => p.id === workday.plan.id));
check('工作日系列回传 occursOnAnchor:true', workday.occursOnAnchor === true);
const weekdaysHit = [];
for (let offset = 0; offset <= 14; offset += 1) {
	const key = addDays(TODAY, offset);
	if (store.readDay(key).some((p) => p.id === workday.plan.id)) weekdaysHit.push(weekdayOf(key));
}
check('工作日重复只落在周一至周五', weekdaysHit.every((w) => w >= 1 && w <= 5), `-> ${weekdaysHit.join(',')}`);
check('工作日重复在两周窗口内命中若干天', weekdaysHit.length >= 8, `-> ${weekdaysHit.length}`);

/* ── 周末锚点的"工作日"系列：锚点当天不发生，但**绝不能回 null** ──
   这是真踩到的缺陷：save 曾把 expandSeries 的 null 直接回出去，于是界面"创建成功却什么都
   不出现"，而模型工具拿它渲染会直接崩。 */
const weekendAnchor = (() => {
	let cursor = addDays(TODAY, 1);
	while (weekdayOf(cursor) !== 0 && weekdayOf(cursor) !== 6) cursor = addDays(cursor, 1);
	return cursor;
})();
const weekendSeries = store.save({
	date: weekendAnchor,
	plan: { title: '周末建的巡检', start: '10:00', end: '10:30', importance: 'low', recurrence: 'weekdays' }
});
check('周末锚点：save 不回 null', weekendSeries.plan !== null && typeof weekendSeries.plan === 'object');
check('周末锚点：occursOnAnchor 为 false', weekendSeries.occursOnAnchor === false);
check('周末锚点：锚点当天确实没有它', !store.readDay(weekendAnchor).some((p) => p.id === weekendSeries.plan.id));
check(
	'周末锚点：回传的是系列形状（字段齐全）',
	weekendSeries.plan.isRecurring === true &&
		weekendSeries.plan.recurrence === 'weekdays' &&
		weekendSeries.plan.seriesAnchor === weekendAnchor &&
		weekendSeries.plan.start === '10:00'
);
check(
	'周末锚点：firstDate 指向下一个工作日',
	weekendSeries.firstDate !== null && weekdayOf(weekendSeries.firstDate) >= 1 && weekdayOf(weekendSeries.firstDate) <= 5,
	`-> ${weekendSeries.firstDate}`
);
check('周末锚点：firstDate 当天确实有它', store.readDay(weekendSeries.firstDate).some((p) => p.id === weekendSeries.plan.id));
check('周末锚点：setDone 对不发生的那天也不回 null', store.setDone({ date: weekendAnchor, id: weekendSeries.plan.id, done: true }) !== null);
check('周末锚点：setDone 没有为不发生的那天留下无意义的例外', (() => {
	const entry = JSON.parse(fs.readFileSync(store.seriesFile, 'utf8')).series.find((s) => s.id === weekendSeries.plan.id);
	return (entry.exceptions ?? {})[weekendAnchor] === undefined;
})());

/* until 早于第一个合法工作日 → 系列永不发生，firstDate 必须是 null 而不是瞎猜一个日期。 */
const neverSeries = store.save({
	date: weekendAnchor,
	plan: { title: '永不发生', start: '10:00', end: '10:30', recurrence: 'weekdays', until: weekendAnchor }
});
check('永不发生的系列：save 仍不回 null', neverSeries.plan !== null);
check('永不发生的系列：occursOnAnchor 为 false', neverSeries.occursOnAnchor === false);
check('永不发生的系列：firstDate 为 null', neverSeries.firstDate === null, `-> ${neverSeries.firstDate}`);

/* 截止日期 */
const untilDate = addDays(TODAY, 3);
const bounded = store.save({
	date: addDays(TODAY, 1),
	plan: { title: '限时每日', start: '11:00', end: '11:30', importance: 'low', recurrence: 'daily', until: untilDate }
});
check('截止日当天仍发生', store.readDay(untilDate).some((p) => p.id === bounded.plan.id));
check('截止日次日不发生', !store.readDay(addDays(untilDate, 1)).some((p) => p.id === bounded.plan.id));
throws(
	'截止日期早于锚点被拒',
	() =>
		store.save({
			date: addDays(TODAY, 3),
			plan: { title: 'x', start: '09:00', end: '10:00', recurrence: 'daily', until: addDays(TODAY, 1) }
		}),
	'invalid',
	'截止日期'
);

/* 未识别的重复方式被规范化成"不重复"（与重要度同一策略：给默认值而不是报错） */
const bogus = store.save({ date: FUTURE, plan: { title: '怪重复', start: '09:00', end: '10:00', recurrence: 'yearly' } });
check('未识别的重复方式被规范化成 null', bogus.plan.recurrence === null && bogus.scope === 'one');
check('不重复却带截止日期被拒', (() => {
	try {
		store.save({ date: FUTURE, plan: { title: 'x', start: '09:00', end: '10:00', recurrence: null, until: FUTURE } });
		return false;
	} catch (error) {
		return error.code === 'invalid' && error.message.includes('不应带截止日期');
	}
})());

/* ══════════════════════ 7. 「仅此一次 / 整个系列」（Q17） ══════════════════════ */
const anchor = addDays(TODAY, 1);
const series = store.save({
	date: anchor,
	plan: { title: '原名', content: '', start: '09:00', end: '10:00', importance: 'medium', recurrence: 'daily' }
});
const seriesId = series.plan.id;
const otherDay = addDays(anchor, 2);

const oneEdit = store.save({
	date: otherDay,
	scope: 'one',
	plan: { id: seriesId, title: '只改这次', content: '临时', start: '09:30', end: '10:30', importance: 'high', recurrence: 'daily' }
});
check('仅此一次编辑返回 scope:one', oneEdit.scope === 'one');
check('被改的那天用覆盖值', store.readDay(otherDay).find((p) => p.id === seriesId).title === '只改这次');
check('被改的那天带 overridden 标记', store.readDay(otherDay).find((p) => p.id === seriesId).overridden === true);
check('同系列的其它天不受影响', store.readDay(addDays(anchor, 3)).find((p) => p.id === seriesId).title === '原名');
check('锚点当天也不受影响', store.readDay(anchor).find((p) => p.id === seriesId).title === '原名');

store.save({
	date: anchor,
	scope: 'series',
	plan: { id: seriesId, title: '全系列改名', content: '', start: '08:00', end: '08:45', importance: 'low', recurrence: 'daily' }
});
check('整个系列改名后锚点跟着变', store.readDay(anchor).find((p) => p.id === seriesId).title === '全系列改名');
check('整个系列改名后其它天跟着变', store.readDay(addDays(anchor, 3)).find((p) => p.id === seriesId).title === '全系列改名');
check(
	'整个系列改名后，此前"仅此一次"的那天仍保留覆盖值',
	store.readDay(otherDay).find((p) => p.id === seriesId).title === '只改这次'
);
check('展开的实例带回未叠加覆盖的 seriesBase（编辑整个系列时要用它）', (() => {
	const occurrence = store.readDay(otherDay).find((p) => p.id === seriesId);
	return (
		occurrence.title === '只改这次' &&
		occurrence.seriesBase.title === '全系列改名' &&
		occurrence.seriesBase.recurrence === 'daily' &&
		occurrence.seriesBase.anchor === anchor
	);
})());
throws(
	'把系列改成不重复被明确拒绝（附可执行建议）',
	() => store.save({ date: anchor, scope: 'series', plan: { id: seriesId, title: 'x', start: '09:00', end: '10:00', recurrence: null } }),
	'invalid',
	'截止日期'
);

/* ══════════════════════ 8. 按天独立的完成状态（Q19） ══════════════════════ */
store.setDone({ date: anchor, id: seriesId, done: true });
check('勾选系列的某一天后，那天是完成', store.readDay(anchor).find((p) => p.id === seriesId).done === true);
check('同系列的次日**不受影响**（按天独立）', store.readDay(addDays(anchor, 1)).find((p) => p.id === seriesId).done === false);
store.setDone({ date: anchor, id: seriesId, done: false });
check('取消完成后那天不再是完成', store.readDay(anchor).find((p) => p.id === seriesId).done === false);

/* ══════════════════════ 9. 删除作用域与跳过 ══════════════════════ */
const dayA = addDays(anchor, 1);
const skipResult = store.remove({ date: dayA, id: seriesId, scope: 'one' });
check('仅跳过该日：那天消失了', !store.readDay(dayA).some((p) => p.id === seriesId));
check('仅跳过该日：系列文件仍在', fs.existsSync(store.seriesFile));
check('仅跳过该日：次日照常发生', store.readDay(addDays(anchor, 2)).some((p) => p.id === seriesId));
check('仅跳过该日：撤销操作是 unskip', skipResult.undo[0].op === 'unskip');
store.undo({ ops: skipResult.undo });
check('撤销跳过：那天回来了', store.readDay(dayA).some((p) => p.id === seriesId));

check('对不发生的那天做"仅跳过"不会留下无意义的例外', (() => {
	const read = () => JSON.stringify(JSON.parse(fs.readFileSync(store.seriesFile, 'utf8')).series.find((s) => s.id === seriesId).exceptions ?? {});
	const before = read();
	const result = store.remove({ date: addDays(anchor, -1), id: seriesId, scope: 'one' });
	return result.removed === null && before === read();
})());

const seriesDelete = store.remove({ date: anchor, id: seriesId, scope: 'series' });
check('删除整个系列：那一天没了', !store.readDay(anchor).some((p) => p.id === seriesId));
check('删除整个系列：别的天也没了', !store.readDay(addDays(anchor, 1)).some((p) => p.id === seriesId));
check('删除整个系列：撤销操作是 putSeries', seriesDelete.undo[0].op === 'putSeries');
store.undo({ ops: seriesDelete.undo });
check(
	'撤销删除整个系列：各天的发生都回来了',
	store.readDay(anchor).some((p) => p.id === seriesId) && store.readDay(addDays(anchor, 1)).some((p) => p.id === seriesId)
);

/* ══════════════════════ 10. 躺平与重复计划（Q18） ══════════════════════ */
const wipeDay = addDays(TODAY, 2);
store.save({ date: wipeDay, plan: { title: '那天的一次性事', start: '16:00', end: '17:00' } });
const seriesBefore = readSeriesCount();
const wipeResult = store.wipe({ date: wipeDay });
check('躺平返回条数', wipeResult.count === wipeResult.removed.length && wipeResult.count >= 2, `-> ${wipeResult.count}`);
check('躺平后该日为空', store.readDay(wipeDay).length === 0);
check('躺平**没有**删掉任何系列定义（Q18 由结构保证）', readSeriesCount() === seriesBefore, `-> ${readSeriesCount()} vs ${seriesBefore}`);
check('躺平让重复计划当天变成"跳过"，但系列次日照常发生', (() => {
	/* 用"每天"那个系列来验证——"工作日"系列在周末本来就不发生，拿它测会得出错误结论。 */
	const skippedToday = !store.readDay(wipeDay).some((p) => p.id === daily.plan.id);
	const aliveTomorrow = store.readDay(addDays(wipeDay, 1)).some((p) => p.id === daily.plan.id);
	const stillDefined = seriesExists(daily.plan.id);
	return stillDefined && skippedToday && aliveTomorrow;
})());
check('躺平的撤销列表同时含单次计划与跳过两类操作', wipeResult.undo.some((op) => op.op === 'putPlan') && wipeResult.undo.some((op) => op.op === 'unskip'));
store.undo({ ops: wipeResult.undo });
check('躺平可整体撤销（单次计划回来了）', store.readDay(wipeDay).some((p) => p.title === '那天的一次性事'));
check('躺平可整体撤销（被跳过的重复计划也回来了）', store.readDay(wipeDay).length === wipeResult.count, `-> ${store.readDay(wipeDay).length}`);

const anchorWipe = store.wipe({ date: anchor });
check('在锚点当天躺平：当天清空', !store.readDay(anchor).some((p) => p.id === seriesId));
check('在锚点当天躺平：系列仍存在于 series.json', seriesExists(seriesId));
check('在锚点当天躺平：次日仍照常发生', store.readDay(addDays(anchor, 1)).some((p) => p.id === seriesId));
store.undo({ ops: anchorWipe.undo });
check('在锚点当天躺平的撤销能恢复当天', store.readDay(anchor).some((p) => p.id === seriesId));

/* ══════════════════════ 11. 区间读取 ══════════════════════ */
const spanFrom = addDays(TODAY, 1);
const spanTo = addDays(TODAY, 21);
const range = store.readRange(spanFrom, spanTo);
check('区间里能读到未来的日子', Object.keys(range).length > 0);
check('区间不含范围外的日子', !Object.keys(range).some((d) => d < spanFrom || d > spanTo));
check('区间内的重复发生被展开出来（当天没有日期文件的也算）', (() => {
	const withSeries = Object.keys(range).filter((d) => range[d].some((p) => p.isRecurring === true));
	return withSeries.length >= 5;
})());
check('from 晚于 to 被拒', (() => {
	try {
		store.readRange(spanTo, spanFrom);
		return false;
	} catch (error) {
		return error.code === 'invalid-range';
	}
})());
check('跨月区间可读', typeof store.readRange('2026-01-25', '2026-02-05') === 'object');
check('区间内单次与重复可以同一天共存', (() => {
	const target = addDays(dailyAnchor, 1);
	store.save({ date: target, plan: { title: '同日的单次事', start: '18:00', end: '19:00' } });
	const day = store.readDay(target);
	return day.some((p) => p.isRecurring === true) && day.some((p) => p.isRecurring === false);
})());

/* ══════════════════════ 12. 损坏文件留档 ══════════════════════ */
fs.writeFileSync(store.fileFor(TODAY), '{ 这不是 JSON', 'utf8');
let readThrew = null;
try {
	store.readDay(TODAY);
} catch (error) {
	readThrew = error;
}
check('损坏文件读取时抛 read-failed', readThrew?.code === 'read-failed', `-> ${readThrew?.code}`);
check('损坏文件被改名留档（数据没丢）', fs.readdirSync(store.plansDir).some((n) => n.includes('.corrupt-')));
check('留档后第二次读取按空处理', store.readDay(TODAY).length === 0);

const goodSeries = fs.readFileSync(store.seriesFile, 'utf8');
fs.writeFileSync(store.seriesFile, 'not json at all', 'utf8');
let seriesThrew = null;
try {
	store.readDay(FUTURE);
} catch (error) {
	seriesThrew = error;
}
check('series.json 损坏时抛 read-failed', seriesThrew?.code === 'read-failed', `-> ${seriesThrew?.code}`);
check('series.json 损坏后被留档', fs.readdirSync(sandbox).some((n) => n.includes('series.json.corrupt-')));
fs.writeFileSync(store.seriesFile, goodSeries, 'utf8');
check('恢复 series.json 后重复计划照常展开', store.readDay(anchor).some((p) => p.id === seriesId));

/* ══════════════════════ 13. 最后一次破坏性操作的落盘记录 ══════════════════════ */
/* 这一份是给"不带参数的撤销"用的。为什么必须落盘：模型工具看到的只有 render 文本，
   看不到结构化返回值，所以拿不到 undo_token——撤销只能靠"刚才那一次"的记录完成。 */
check('初始时没有撤销记录', store.readLastUndo() === null);
const recordTarget = store.save({ date: FUTURE, plan: { title: '待记录', start: '19:00', end: '20:00' } });
store.remove({ date: FUTURE, id: recordTarget.plan.id });
const recorded = store.readLastUndo();
check('删除后落盘了撤销记录', recorded !== null && Array.isArray(recorded.ops) && recorded.ops.length === 1);
check('记录里带可读描述', typeof recorded.description === 'string' && recorded.description.includes('待记录'), `-> ${recorded.description}`);
check('落盘文件在磁盘上', fs.existsSync(store.undoFile));
check('不带 ops 调用 undo 会走记录分支', store.undo({}).source === 'recorded');
check('撤销后计划回来了', store.readDay(FUTURE).some((p) => p.id === recordTarget.plan.id));
check('撤销后记录被清掉（不会重复回放）', store.readLastUndo() === null);
check('没有记录时 undo 不报错，只是什么都没做', store.undo({}).source === 'none');
check('显式给 ops 时走 explicit 分支', (() => {
	const target = store.save({ date: FUTURE, plan: { title: '显式撤销', start: '19:30', end: '20:30' } });
	const removed = store.remove({ date: FUTURE, id: target.plan.id });
	store.save({ date: FUTURE, plan: { title: '其它写入不覆盖记录', start: '21:00', end: '22:00' } });
	const result = store.undo({ ops: removed.undo });
	return result.source === 'explicit' && store.readDay(FUTURE).some((p) => p.id === target.plan.id);
})());
check('躺平也会落盘撤销记录', (() => {
	store.wipe({ date: FUTURE });
	const snapshot = store.readLastUndo();
	return snapshot !== null && snapshot.ops.length > 0 && String(snapshot.description).includes('清空');
})());

/* ══════════════════════ 收尾 ══════════════════════ */
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failures.length === 0) {
	console.log('SMOKE OK — 持久化层（含重复计划）可以信任。');
} else {
	console.log(`SMOKE FAILED — ${failures.length} 项失败：`);
	for (const item of failures) console.log('  - ' + item);
	process.exitCode = 1;
}

/** 数一下 series.json 里有多少个系列；文件不存在算 0。 */
function readSeriesCount() {
	try {
		return JSON.parse(fs.readFileSync(store.seriesFile, 'utf8')).series.length;
	} catch {
		return 0;
	}
}

/** 某个系列是否还在 series.json 里。 */
function seriesExists(id) {
	try {
		return JSON.parse(fs.readFileSync(store.seriesFile, 'utf8')).series.some((entry) => entry.id === id);
	} catch {
		return false;
	}
}
