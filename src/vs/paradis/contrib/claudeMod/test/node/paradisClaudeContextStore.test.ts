/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisClaudeContextBreakdown, paradisParseClaudeContextBreakdown, paradisShortenContextBreakdownPaths } from '../../common/paradisClaudeContextBreakdown.js';
import { ParadisClaudeContextStore } from '../../node/paradisClaudeContextStore.js';
import { ParadisClaudeModBridge, ParadisClaudeModEvent } from '../../node/paradisClaudeModBridge.js';

function breakdown(sessionId: string, at: number, totalTokens: number = 1_000): IParadisClaudeContextBreakdown {
	return paradisParseClaudeContextBreakdown({ totalTokens, window: 1_000_000, categories: [{ name: 'Messages', tokens: totalTokens, kind: 'used' }] }, sessionId, at)!;
}

function context(token: string, sessionId: string, at: number, totalTokens?: number): ParadisClaudeModEvent {
	return { token, sessionId, at, type: 'context', breakdown: breakdown(sessionId, at, totalTokens) };
}

function owner(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
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
		const saved = JSON.parse(disk.state.text!) as { version: number; sessions: (IParadisClaudeContextBreakdown & { owner: string })[] };
		assert.deepStrictEqual({
			live: (await store.liveBreakdowns()).map(entry => entry.sessionId),
			s1: (await store.breakdownOf('s1'))?.at,
			saved: { version: saved.version, sessions: saved.sessions.map(entry => [entry.owner, entry.sessionId, entry.at]) },
			tokenWritten: disk.state.text!.includes('pane-a'),
			changes,
			writes: disk.state.writes,
		}, {
			live: ['s3'],
			s1: 20,
			saved: { version: 1, sessions: [[owner('pane-a'), 's1', 20], [owner('pane-b'), 's2', 30], [owner('pane-a'), 's3', 50]] },
			tokenWritten: false,
			changes: 6,
			writes: 1,
		});
	});

	test('reads what was saved, drops what it cannot trust, and keeps a newer breakdown taken before reading', async () => {
		const mine = owner('pane-a');
		const disk = files(JSON.stringify({ version: 1, sessions: [{ owner: mine, ...breakdown('old', 1) }, { owner: mine, ...breakdown('s1', 2) }, { owner: mine, sessionId: '../bad', at: 3, totalTokens: 1, window: 1 }, { owner: mine, sessionId: 'nowindow', at: 4, totalTokens: 1 }, { ...breakdown('noowner', 5) }] }));
		const store = disposables.add(new ParadisClaudeContextStore(disk.files, undefined, 60_000));
		store.observe(context('pane-a', 's1', 99));
		assert.deepStrictEqual({
			old: (await store.breakdownOf('old'))?.at,
			s1: (await store.breakdownOf('s1'))?.at,
			bad: await store.breakdownOf('../bad'),
			nowindow: await store.breakdownOf('nowindow'),
			noowner: await store.breakdownOf('noowner'),
		}, { old: 1, s1: 99, bad: undefined, nowindow: undefined, noowner: undefined });
	});

	test('another pane naming the same conversation does not overwrite or answer for the first pane', async () => {
		const store = disposables.add(new ParadisClaudeContextStore(files().files, undefined, 60_000));
		store.observe(context('pane-a', 's1', 10, 1_000));
		store.observe(context('pane-b', 's1', 20, 9_000));
		assert.deepStrictEqual({
			paneA: (await store.breakdownOf('s1', 'pane-a'))?.totalTokens,
			paneB: (await store.breakdownOf('s1', 'pane-b'))?.totalTokens,
			paneC: await store.breakdownOf('s1', 'pane-c'),
			newest: (await store.breakdownOf('s1'))?.totalTokens,
		}, { paneA: 1_000, paneB: 9_000, paneC: undefined, newest: 9_000 });
	});

	test('a store disposed before it read its file keeps what was saved', async () => {
		const mine = owner('pane-a');
		const disk = files(JSON.stringify({ version: 1, sessions: [{ owner: mine, ...breakdown('old', 1) }] }));
		const store = new ParadisClaudeContextStore(disk.files, undefined, 60_000);
		store.observe(context('pane-a', 'new', 2));
		store.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
		await new Promise(resolve => setTimeout(resolve, 0));
		const saved = JSON.parse(disk.state.text!) as { sessions: IParadisClaudeContextBreakdown[] };
		assert.deepStrictEqual(saved.sessions.map(entry => entry.sessionId), ['old', 'new']);
	});

	test('paths sent to the phone show the home as ~', () => {
		const shortened = paradisShortenContextBreakdownPaths({
			...breakdown('s1', 1), cwd: '/Users/example/repo',
			memoryFiles: [{ name: '/Users/example/.claude/CLAUDE.md', tokens: 1 }, { name: '/home/remote/repo/CLAUDE.md', tokens: 1 }, { name: '/etc/claude-code/CLAUDE.md', tokens: 1 }],
		}, '/Users/example/');
		assert.deepStrictEqual({ cwd: shortened.cwd, files: shortened.memoryFiles.map(row => row.name) }, {
			cwd: '~/repo',
			files: ['~/.claude/CLAUDE.md', '~/repo/CLAUDE.md', '/etc/claude-code/CLAUDE.md'],
		});
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
