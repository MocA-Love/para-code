/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisClaudeContextBreakdown, paradisParseClaudeContextBreakdown } from '../../common/paradisClaudeContextBreakdown.js';
import { ParadisClaudeContextStore } from '../../node/paradisClaudeContextStore.js';
import { ParadisClaudeModBridge, ParadisClaudeModEvent } from '../../node/paradisClaudeModBridge.js';

function breakdown(sessionId: string, at: number, totalTokens = 1_000): IParadisClaudeContextBreakdown {
	return paradisParseClaudeContextBreakdown({ totalTokens, window: 1_000_000, categories: [{ name: 'Messages', tokens: totalTokens, kind: 'used' }] }, sessionId, at)!;
}

function context(token: string, sessionId: string, at: number): ParadisClaudeModEvent {
	return { token, sessionId, at, type: 'context', breakdown: breakdown(sessionId, at) };
}

suite('ParadisClaudeContextStore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function files(initial?: string) {
		const state = { text: initial, writes: 0 };
		return { state, files: { read: async () => state.text, write: async (text: string) => { state.text = text; state.writes++; } } };
	}

	test('keeps the last breakdown of each conversation, knows which ones are live, and saves them', async () => {
		const disk = files();
		const store = disposables.add(new ParadisClaudeContextStore(disk.files, undefined, 60_000));
		let changes = 0;
		disposables.add(store.onDidChange(() => changes++));
		store.observe(context('pane-a', 's1', 10));
		store.observe(context('pane-a', 's1', 20));
		store.observe(context('pane-b', 's2', 30));
		// /clear: pane-a moved on to s3, s1 is no longer live but stays saved
		store.observe({ token: 'pane-a', sessionId: 's1', at: 40, type: 'bye' });
		store.observe(context('pane-a', 's3', 50));
		store.observe({ token: 'pane-b', sessionId: 's2', at: 60, type: 'alive-changed', alive: false });
		await store.flush();
		const saved = JSON.parse(disk.state.text!) as { version: number; sessions: IParadisClaudeContextBreakdown[] };
		assert.deepStrictEqual({
			live: (await store.liveBreakdowns()).map(entry => entry.sessionId),
			s1: (await store.breakdownOf('s1'))?.at,
			saved: { version: saved.version, sessions: saved.sessions.map(entry => [entry.sessionId, entry.at]) },
			changes,
			writes: disk.state.writes,
		}, {
			live: ['s3'],
			s1: 20,
			saved: { version: 1, sessions: [['s1', 20], ['s2', 30], ['s3', 50]] },
			changes: 6,
			writes: 1,
		});
	});

	test('reads what was saved, drops what it cannot trust, and keeps a newer breakdown taken before reading', async () => {
		const disk = files(JSON.stringify({ version: 1, sessions: [breakdown('old', 1), breakdown('s1', 2), { sessionId: '../bad', at: 3, totalTokens: 1, window: 1 }, { sessionId: 'nowindow', at: 4, totalTokens: 1 }] }));
		const store = disposables.add(new ParadisClaudeContextStore(disk.files, undefined, 60_000));
		store.observe(context('pane-a', 's1', 99));
		assert.deepStrictEqual({
			old: (await store.breakdownOf('old'))?.at,
			s1: (await store.breakdownOf('s1'))?.at,
			bad: await store.breakdownOf('../bad'),
			nowindow: await store.breakdownOf('nowindow'),
		}, { old: 1, s1: 99, bad: undefined, nowindow: undefined });
	});

	test('a broken file is left alone and the store starts empty', async () => {
		const errors: unknown[] = [];
		const store = disposables.add(new ParadisClaudeContextStore(files('{').files, error => errors.push(error), 60_000));
		assert.deepStrictEqual({ live: await store.liveBreakdowns(), errors: errors.length }, { live: [], errors: 1 });
	});

	test('the bridge passes a breakdown on only from a verified sender, cut to its limits', async () => {
		const bridge = disposables.add(new ParadisClaudeModBridge());
		const events: ParadisClaudeModEvent[] = [];
		disposables.add(bridge.onEvent(event => events.push(event)));
		const payload = {
			totalTokens: 2_000, window: 1_000_000, percent: 0.2,
			categories: [{ name: 'Messages', tokens: 2_000, kind: 'used' }],
			memoryFiles: Array.from({ length: 30 }, (_, index) => ({ name: `/m/${index}.md`, tokens: index })),
		};
		const signal = new AbortController();
		await bridge.handle('pane', 'event', { sessionId: 'unverified', events: [{ type: 'context', context: payload }] }, signal.signal, async () => false);
		await bridge.handle('pane', 'event', { sessionId: 'verified', events: [{ type: 'context', context: payload }] }, signal.signal, async () => true);
		const received = events.filter((event): event is Extract<ParadisClaudeModEvent, { type: 'context' }> => event.type === 'context');
		assert.deepStrictEqual(received.map(event => ({ session: event.sessionId, percent: event.breakdown.percent, files: event.breakdown.memoryFiles.length, first: event.breakdown.memoryFiles[0].name })), [
			{ session: 'verified', percent: 0, files: 20, first: '/m/29.md' },
		]);
	});
});
