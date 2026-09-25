/**
 * 用**真实的** buildCells 渲染文本版日历，供肉眼看屏幕时逐格对照。
 * 不是复制逻辑——同样走 `.dev/smoke-client.mjs` 那套提取 exports.__internals 的办法。
 */
import { readFileSync } from 'node:fs';

/* 从本文件位置推导，别写死本机路径。 */
const SRC = new URL('../client/client.js', import.meta.url);
const registrations = new Map();
const fakeWindow = { __ModuleLoader__: { load: (r) => registrations.set(r.id, r) } };
new Function('window', readFileSync(SRC, 'utf8'))(fakeWindow);

const fakeRequire = (spec) =>
	spec === 'react'
		? { useState() {}, useRef() {}, useEffect() {}, useMemo() {}, useCallback() {} }
		: { jsx() {}, jsxs() {}, Fragment: {} };

const I = registrations.get('dsh-planner').factory(fakeRequire).__internals;

const today = I.todayKey();
const [ty, tm] = today.split('-').map(Number);

/** 与客户端的 fixture 计数规则完全一致：(day * 7) % 4。 */
function fixtureCount(year, month, day) {
	return (day * 7) % 4;
}

function render(year, month, selected, withFixture) {
	const cells = I.buildCells(year, month);
	const head = '一   二   三   四   五   六   日';
	const lines = [`${year} 年 ${month + 1} 月        已选 ${selected}${selected === today ? ' [今天]' : ''}`];
	lines.push(head);
	for (let row = 0; row < 6; row += 1) {
		const slice = cells.slice(row * 7, row * 7 + 7);
		const cellsText = slice.map((cell) => {
			let text = String(cell.day).padStart(2, ' ');
			if (cell.day < 10) text = ' ' + cell.day;
			else text = String(cell.day);
			/* 标记：* = 今天的小圆点，[] = 选中态实心填充，·~= 密度圆点数量 */
			const flags = [];
			if (cell.key === today) flags.push('*');
			if (cell.key === selected) flags.push('[S]');
			if (withFixture) {
				const n = cell.inMonth ? fixtureCount(year, month, cell.day) : 0;
				if (n > 0) flags.push('+' + Math.min(n, 3));
			}
			const flag = flags.join('');
			const body = flag.length > 0 ? `${text}${flag}` : text;
			return body.padEnd(9, ' ');
		});
		lines.push(cellsText.join(' ').replace(/\s+$/, ''));
	}
	return lines.join('\n');
}

console.log('=== 无 fixture（默认状态，密度圆点应当为空）===');
console.log(render(ty, tm - 1, today, false));
console.log('');
console.log('=== 带 ?plannerFixture（密度圆点出现）===');
console.log(render(ty, tm - 1, today, true));
console.log('');
console.log('=== 翻到 2026 年 2 月（验证：非闰月 + 1 号落位）===');
console.log(render(2026, 1, '2026-02-15', false));
console.log('');
console.log('图例：  * = 今天（数字上方的小圆点）   [S] = 选中（实心填充）   +n = 密度圆点个数(上限 3)');
