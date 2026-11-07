/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisClaudeContextBreakdown, paradisAggregateClaudeContextPeriod, paradisParseClaudeContextBreakdown, paradisShortenContextBreakdownPaths } from '../../common/paradisClaudeContextBreakdown.js';
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
			live: ['s1', 's2', 's3'].filter(sessionId => store.isLive(sessionId)),
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

	test('keeps the largest breakdown of each conversation (before /compact) and saves it only when it differs from the last', async () => {
		const disk = files();
		const store = disposables.add(new ParadisClaudeContextStore(disk.files, undefined, 60_000));
		store.observe(context('pane-a', 's1', 10, 300_000));
		store.observe(context('pane-a', 's1', 20, 40_000));
		store.observe(context('pane-a', 's2', 30, 5_000));
		store.observe(context('pane-a', 's2', 40, 9_000));
		store.observe(context('pane-b', 's3', 99, 1_000));
		await store.flush();
		const saved = JSON.parse(disk.state.text!) as { sessions: (IParadisClaudeContextBreakdown & { peak?: IParadisClaudeContextBreakdown })[] };
		const period = await store.peaksBetween(10, 50);
		assert.deepStrictEqual({
			saved: saved.sessions.map(entry => [entry.sessionId, entry.totalTokens, entry.peak?.totalTokens]),
			period: { peaks: period.peaks.map(peak => [peak.sessionId, peak.totalTokens]), since: period.since },
		}, {
			saved: [['s1', 40_000, 300_000], ['s2', 9_000, undefined], ['s3', 1_000, undefined]],
			period: { peaks: [['s1', 300_000], ['s2', 9_000]], since: 20 },
		});
	});

	test('reads a saved peak, takes the last breakdown as the peak for older saves, and keeps a saved peak over a smaller fresh one', async () => {
		const mine = owner('pane-a');
		const disk = files(JSON.stringify({
			version: 1, sessions: [
				{ owner: mine, ...breakdown('old', 1, 2_000) },
				{ owner: mine, ...breakdown('s1', 2, 1_000), peak: breakdown('s1', 1, 500_000) },
			]
		}));
		const store = disposables.add(new ParadisClaudeContextStore(disk.files, undefined, 60_000));
		store.observe(context('pane-a', 's1', 3, 7_000));
		const period = await store.peaksBetween(0, 10);
		assert.deepStrictEqual(period.peaks.map(peak => [peak.sessionId, peak.totalTokens]).sort(), [['old', 2_000], ['s1', 500_000]]);
	});

	test('the period sums each conversation once: averages and largest per category, what every conversation carries, and how many conversations read each item', () => {
		const peak = (sessionId: string, messages: number, memory: readonly { name: string; tokens: number }[], mcp: readonly { name: string; tokens: number; count: number }[]) => paradisParseClaudeContextBreakdown({
			totalTokens: messages + 10_000 + memory.reduce((sum, row) => sum + row.tokens, 0), window: 1_000_000,
			categories: [
				{ name: 'Messages', tokens: messages, kind: 'used' },
				{ name: 'System prompt', tokens: 10_000, kind: 'used' },
				{ name: 'Memory files', tokens: memory.reduce((sum, row) => sum + row.tokens, 0), kind: 'used' },
				{ name: 'MCP tools (deferred)', tokens: 50_000, kind: 'deferred' },
				{ name: 'Free space', tokens: 1_000_000 - messages, kind: 'free' },
			],
			memoryFiles: memory, mcpServers: mcp,
		}, sessionId, 1)!;
		const result = paradisAggregateClaudeContextPeriod([
			peak('a', 100_000, [{ name: '~/.claude/CLAUDE.md', tokens: 4_000 }], [{ name: 'browser', tokens: 12_000, count: 40 }]),
			peak('b', 300_000, [{ name: '~/.claude/CLAUDE.md', tokens: 4_000 }, { name: '~/repo/CLAUDE.md', tokens: 20_000 }], []),
		], 7);
		assert.deepStrictEqual({
			head: [result.conversations, result.averageTokens, result.averagePercent, result.maxPercent, result.window, result.fixedAverage, result.since],
			categories: result.categories.map(category => [category.name, category.kind, category.average, category.max, category.share.toFixed(1)]),
			memory: result.memoryFiles.map(item => [item.name, item.conversations, item.average]),
			mcp: result.mcpServers.map(item => [item.name, item.conversations, item.average, item.count]),
		}, {
			head: [2, 224_000, 22, 33, 1_000_000, 24_000, 7],
			categories: [
				['Messages', 'used', 200_000, 300_000, '20.0'],
				['Memory files', 'used', 14_000, 24_000, '1.4'],
				['System prompt', 'used', 10_000, 10_000, '1.0'],
				['Free space', 'free', 800_000, 900_000, '80.0'],
				['MCP tools (deferred)', 'deferred', 50_000, 50_000, '5.0'],
			],
			memory: [['~/.claude/CLAUDE.md', 2, 4_000], ['~/repo/CLAUDE.md', 1, 20_000]],
			mcp: [['browser', 1, 12_000, 40]],
		});
	});

	test('at the end of the process it reads and writes synchronously, keeping what was saved', () => {
		const mine = owner('pane-a');
		const state: { text: string | undefined } = { text: JSON.stringify({ version: 1, sessions: [{ owner: mine, ...breakdown('old', 1) }] }) };
		const store = disposables.add(new ParadisClaudeContextStore({
			read: async () => state.text,
			write: async text => { state.text = text; },
			readSync: () => state.text,
			writeSync: text => { state.text = text; },
		}, undefined, 60_000));
		store.observe(context('pane-a', 'new', 2));
		store.flushSync();
		const saved = JSON.parse(state.text!) as { sessions: IParadisClaudeContextBreakdown[] };
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
		assert.deepStrictEqual({ s1: await store.breakdownOf('s1'), errors: errors.length }, { s1: undefined, errors: 1 });
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
