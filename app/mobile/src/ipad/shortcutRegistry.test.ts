// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { afterEach, describe, expect, test } from 'vitest';
import { topSlot, useShortcutRegistry, type SlotHandlers } from './shortcutRegistry.js';

function escapeHandler(calls: string[], name: string): { current: SlotHandlers['escape'] } {
	return { current: { escape: () => calls.push(name) } };
}

afterEach(() => {
	useShortcutRegistry.setState({ slots: { session: [], send: [], list: [], launch: [], sidebar: [], escape: [], terminalArrows: [] } });
});

describe('shortcutRegistry', () => {
	test('重なったら後から置いたものに届き、それが外れると1つ前に戻る', () => {
		const calls: string[] = [];
		const { add, remove } = useShortcutRegistry.getState();
		add('escape', { token: 1, ref: escapeHandler(calls, 'sheet'), meta: 0 });
		add('escape', { token: 2, ref: escapeHandler(calls, 'dock'), meta: 0 });
		topSlot('escape')?.escape();
		remove('escape', 2);
		topSlot('escape')?.escape();
		remove('escape', 1);
		expect({ calls, empty: topSlot('escape') }).toEqual({ calls: ['dock', 'sheet'], empty: undefined });
	});

	test('meta（タブの数）は指定した受け口だけを書き換え、並びは変えない', () => {
		const { add, setMeta } = useShortcutRegistry.getState();
		const handler = { tabCount: 0, selectTab: () => {}, stepTab: () => {}, openQuick: () => {}, openPanel: () => {} };
		add('session', { token: 1, ref: { current: handler }, meta: 0 });
		add('session', { token: 2, ref: { current: handler }, meta: 0 });
		setMeta('session', 1, 3);
		setMeta('session', 2, 5);
		setMeta('session', 9, 7);
		expect(useShortcutRegistry.getState().slots.session.map(({ token, meta }) => ({ token, meta }))).toEqual([
			{ token: 1, meta: 3 },
			{ token: 2, meta: 5 },
		]);
	});
});
