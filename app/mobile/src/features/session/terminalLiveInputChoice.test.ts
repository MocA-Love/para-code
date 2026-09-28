// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>();
vi.mock('../../platform.js', () => ({
	secureKeyStore: {
		getItem: async (key: string) => stored.get(key) ?? null,
		setItem: async (key: string, value: string) => { stored.set(key, value); },
	},
}));

import { liveInputEnabled, parseLiveInputChoices, useTerminalLiveInputChoices, withLiveInputChoice } from './terminalLiveInputChoice.js';

describe('live input choice', () => {
	it('is on by default and remembers only what the user switched', () => {
		const choices = withLiveInputChoice(withLiveInputChoice({}, 'pc\u0000a', false), 'pc\u0000b', true);
		expect([liveInputEnabled(choices, 'pc\u0000a'), liveInputEnabled(choices, 'pc\u0000b'), liveInputEnabled(choices, 'pc\u0000new')]).toEqual([false, true, true]);
	});

	it('keeps the most recent choices up to the limit', () => {
		let choices = {};
		for (const key of ['a', 'b', 'c']) {
			choices = withLiveInputChoice(choices, key, false, 2);
		}
		choices = withLiveInputChoice(choices, 'b', true, 2);
		expect(choices).toEqual({ c: false, b: true });
	});

	it('drops malformed stored values', () => {
		expect([
			parseLiveInputChoices(null),
			parseLiveInputChoices('not json'),
			parseLiveInputChoices('[true]'),
			parseLiveInputChoices('{"a":false,"b":"yes","c":true}'),
		]).toEqual([{}, {}, {}, { a: false, c: true }]);
	});

	it('restores a saved choice and lets a switch made before loading win', async () => {
		stored.set('terminalLiveInputChoices', JSON.stringify({ saved: false, both: false }));
		const store = useTerminalLiveInputChoices.getState();
		store.choose('both', true);
		store.load();
		await new Promise(resolve => setTimeout(resolve, 0));
		store.choose('later', false);
		const { choices } = useTerminalLiveInputChoices.getState();
		expect([liveInputEnabled(choices, 'saved'), liveInputEnabled(choices, 'both'), liveInputEnabled(choices, 'later'), liveInputEnabled(choices, 'other')]).toEqual([false, true, false, true]);
		// 読み込む前の切り替えで、保存されていた他のターミナルの選択を消さない
		expect(JSON.parse(stored.get('terminalLiveInputChoices')!)).toEqual({ saved: false, both: true, later: false });
	});
});
