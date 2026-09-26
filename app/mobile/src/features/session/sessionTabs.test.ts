// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { SpaceTerminal } from '../../navigationTargets.js';
import { activeTabKey, buildSessionTabs, tabAfterClose } from './sessionTabs.js';

function terminal(terminalKey: string, extra: Partial<SpaceTerminal> = {}): SpaceTerminal {
	return { terminalKey, id: 1, windowId: 1, rendererGeneration: 1, title: terminalKey, ws: 'w1', ...extra };
}

describe('セッションのタブの並び', () => {
	test('ターミナルは PC から届いた順のまま、ブラウザは末尾に1つ', () => {
		const items = buildSessionTabs([terminal('b', { agent: true }), terminal('a')]);
		expect(items.map(item => item.key)).toEqual(['terminal:b', 'terminal:a', 'browser']);
		expect(items.map(item => item.kind === 'terminal' ? item.agent : undefined)).toEqual([true, false, undefined]);
	});

	test('ターミナルが無くてもブラウザのタブは出す', () => {
		expect(buildSessionTabs([]).map(item => item.key)).toEqual(['browser']);
	});

	test('名前が空のターミナルは「ターミナル」と呼ぶ', () => {
		expect(buildSessionTabs([terminal('a', { title: '  ' })])[0]?.title).toBe('ターミナル');
	});

	test('いま開いているタブの識別子はクエリの値と同じ形', () => {
		expect(activeTabKey({ status: 'terminal', terminal: terminal('k') })).toBe('terminal:k');
		expect(activeTabKey({ status: 'browser' })).toBe('browser');
		expect(activeTabKey({ status: 'loading' })).toBeUndefined();
		expect(activeTabKey({ status: 'missing' })).toBeUndefined();
	});
});

describe('タブを閉じたあとに開くタブ', () => {
	const items = buildSessionTabs([terminal('a'), terminal('b'), terminal('c')]);

	test('今のタブでなければ移らない', () => {
		expect(tabAfterClose(items, 'terminal:a', 'terminal:b')).toBeUndefined();
	});

	test('今のタブなら右隣、右端なら左隣', () => {
		expect(tabAfterClose(items, 'terminal:b', 'terminal:b')).toEqual({ kind: 'terminal', terminalKey: 'c' });
		expect(tabAfterClose(items, 'terminal:c', 'terminal:c')).toEqual({ kind: 'terminal', terminalKey: 'b' });
	});

	test('最後の1つを閉じたらブラウザへは移さない', () => {
		const single = buildSessionTabs([terminal('a')]);
		expect(tabAfterClose(single, 'terminal:a', 'terminal:a')).toBeUndefined();
	});
});
