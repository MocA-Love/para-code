// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { SHORTCUTS, availableShortcuts, shortcutById, stepIndex, stepKey, type ShortcutContext } from './shortcuts.js';

const NOTHING: ShortcutContext = {
	tabCount: undefined,
	send: false,
	list: false,
	launch: false,
	sidebar: false,
	escape: false,
	inSettings: false,
	inNotifications: false,
	terminalArrows: false,
	find: false,
};

const ids = (context: ShortcutContext) => availableShortcuts(context).map(def => def.id);

describe('terminal arrows', () => {
	test('矢印はライブ入力にフォーカスがある間だけ PC のターミナルへ回す', () => {
		const arrows = ['terminal.up', 'terminal.down', 'terminal.left', 'terminal.right'];
		expect([
			ids(NOTHING).filter(id => arrows.includes(id)),
			ids({ ...NOTHING, terminalArrows: true }).filter(id => arrows.includes(id)),
			shortcutById('terminal.left')?.action,
		]).toEqual([[], arrows, { kind: 'terminalArrow', key: 'left' }]);
	});
});

describe('find in file', () => {
	test('⌘F・⌘G・⇧⌘G はファイルのビューアが前面にあるときだけ', () => {
		const find = ['find', 'find.next', 'find.prev'];
		expect([
			ids(NOTHING).filter(id => find.includes(id)),
			ids({ ...NOTHING, find: true }).filter(id => find.includes(id)),
			find.map(id => shortcutById(id)?.action),
		]).toEqual([[], find, [{ kind: 'find' }, { kind: 'stepFind', delta: 1 }, { kind: 'stepFind', delta: -1 }]]);
	});
});

describe('SHORTCUTS', () => {
	test('入力欄より先に効かせるのは、入力欄の標準の動きとぶつかるものだけ（Esc は変換の取り消しを奪わない）', () => {
		expect(SHORTCUTS.filter(def => def.overridesTextInput === true).map(def => def.id)).toEqual(['tab.prev', 'tab.next', 'send', 'agent.prev', 'agent.next', 'terminal.up', 'terminal.down', 'terminal.left', 'terminal.right']);
	});

	test('同じキーの組み合わせを2つに割り当てない', () => {
		const combos = SHORTCUTS.map(def => `${[...def.modifiers].sort().join('+')}:${def.input}`);
		expect(new Set(combos).size).toBe(combos.length);
	});

	test('ID が重ならず、どれも ID から引ける', () => {
		expect(new Set(SHORTCUTS.map(def => def.id)).size).toBe(SHORTCUTS.length);
		for (const def of SHORTCUTS) {
			expect(shortcutById(def.id)).toBe(def);
		}
		expect(shortcutById('unknown')).toBeUndefined();
	});

	test('⌘ を長押ししたときの一覧に出す名前がすべてにある', () => {
		expect(SHORTCUTS.every(def => def.title.length > 0)).toBe(true);
	});

	test('⌘1〜⌘9 は 1〜9 番目のタブ', () => {
		expect(['tab.1', 'tab.9'].map(id => shortcutById(id)?.action)).toEqual([
			{ kind: 'selectTab', index: 0 },
			{ kind: 'selectTab', index: 8 },
		]);
	});
});

describe('availableShortcuts', () => {
	test('どこにも受け口が無ければ、設定と通知だけ', () => {
		expect(ids(NOTHING)).toEqual(['settings', 'notifications']);
	});

	test('設定・通知の画面ではその画面を重ねない', () => {
		expect(ids({ ...NOTHING, inSettings: true })).toEqual(['notifications']);
		expect(ids({ ...NOTHING, inNotifications: true })).toEqual(['settings']);
	});

	test('セッションではタブの数までの ⌘数字と、タブが2つ以上なら前後の移動', () => {
		const three = ids({ ...NOTHING, tabCount: 3 });
		expect(three.filter(id => id.startsWith('tab.'))).toEqual(['tab.1', 'tab.2', 'tab.3', 'tab.prev', 'tab.next']);
		expect(three).toEqual(expect.arrayContaining(['quick', 'panel.scm', 'panel.files', 'panel.note']));
		const one = ids({ ...NOTHING, tabCount: 1 });
		expect(one).not.toContain('tab.next');
	});

	test('タブが10以上でも ⌘9 まで', () => {
		expect(ids({ ...NOTHING, tabCount: 12 }).filter(id => /^tab\.\d$/.test(id))).toHaveLength(9);
	});

	test('Esc は閉じるものがあるときだけ取る（ターミナルの Esc を奪わない）', () => {
		expect(ids({ ...NOTHING, tabCount: 2 })).not.toContain('escape');
		expect(ids({ ...NOTHING, tabCount: 2, escape: true })).toContain('escape');
	});

	test('一覧・起動・左の列・送信はそれぞれの受け口があるときだけ', () => {
		expect(ids({ ...NOTHING, list: true })).toEqual(expect.arrayContaining(['agent.prev', 'agent.next']));
		expect(ids({ ...NOTHING, launch: true })).toContain('launch');
		expect(ids({ ...NOTHING, sidebar: true })).toContain('sidebar');
		expect(ids({ ...NOTHING, send: true })).toContain('send');
		expect(ids(NOTHING)).not.toEqual(expect.arrayContaining(['agent.next', 'launch', 'sidebar', 'send']));
	});
});

describe('stepIndex', () => {
	test('端では反対の端へ回る', () => {
		expect(stepIndex(2, 3, 1)).toBe(0);
		expect(stepIndex(0, 3, -1)).toBe(2);
		expect(stepIndex(1, 3, 1)).toBe(2);
	});

	test('今の位置が無ければ、次は先頭・前は末尾', () => {
		expect(stepIndex(-1, 4, 1)).toBe(0);
		expect(stepIndex(-1, 4, -1)).toBe(3);
		expect(stepIndex(9, 4, 1)).toBe(0);
	});

	test('空なら -1', () => {
		expect(stepIndex(0, 0, 1)).toBe(-1);
	});
});

describe('stepKey', () => {
	test('今のものの前後を返す', () => {
		expect(stepKey(['a', 'b', 'c'], 'b', 1)).toBe('c');
		expect(stepKey(['a', 'b', 'c'], 'a', -1)).toBe('c');
	});

	test('今のものが一覧に無ければ先頭（前なら末尾）', () => {
		expect(stepKey(['a', 'b'], 'x', 1)).toBe('a');
		expect(stepKey(['a', 'b'], undefined, -1)).toBe('b');
	});

	test('空なら undefined', () => {
		expect(stepKey([], 'a', 1)).toBeUndefined();
	});
});
