/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentLiveEntry, ParadisAgentLiveStatus } from '../../../agentLiveWindow/common/paradisAgentLiveWindow.js';
import {
	IParadisPaletteRecent,
	paradisCyclePaletteKind,
	paradisFormatCrossJumpAgo,
	paradisGroupPaletteSpaces,
	paradisPaletteActionsToShow,
	paradisPaletteMatches,
	paradisPaletteRecentsToShow,
	paradisParsePalettePrefix,
	paradisParsePaletteRecents,
	paradisPrunePaletteRecents,
	PARADIS_PALETTE_PIN_LIMIT,
	paradisRecordPaletteRecent,
	paradisShouldOfferCrossJumpCreate,
	paradisShouldReturnToCrossJump,
	paradisSortCrossJumpAgents,
	paradisSplitPaletteRecents,
	paradisTogglePalettePin,
} from '../../common/paradisCrossJump.js';

function entry(token: string, status: ParadisAgentLiveStatus, since: number): IParadisAgentLiveEntry {
	return { token, instanceId: 1, stateKey: undefined, spaceName: 's', spaceColor: undefined, detail: '', title: token, status, since, lastOutputAt: 0 };
}

suite('paradisCrossJump', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('agents are ordered by attention first, then by the newest status change', () => {
		const sorted = paradisSortCrossJumpAgents([
			entry('idle', 'idle', 50),
			entry('review-old', 'review', 10),
			entry('working', 'working', 5),
			entry('review-new', 'review', 30),
			entry('question', 'question', 1),
			entry('permission', 'permission', 2),
			entry('unknown', 'later' as ParadisAgentLiveStatus, 99),
		]);
		assert.deepStrictEqual(sorted.map(e => e.token), ['permission', 'question', 'working', 'review-new', 'review-old', 'idle', 'unknown']);
	});

	test('elapsed time and the create row', () => {
		assert.deepStrictEqual({
			ago: [0, 59_000, 60_000, 59 * 60_000, 2 * 3600_000, 50 * 3600_000].map(paradisFormatCrossJumpAgo),
			create: [
				paradisShouldOfferCrossJumpCreate('', ['a']),
				paradisShouldOfferCrossJumpCreate('  ', ['a']),
				paradisShouldOfferCrossJumpCreate('Login', ['sample-login']),
				paradisShouldOfferCrossJumpCreate('login-v2', ['sample-login']),
			],
		}, {
			ago: ['今', '今', '1 分前', '59 分前', '2 時間前', '2 日前'],
			create: [false, false, false, true],
		});
	});

	test('kinds cycle with Tab and Shift+Tab, wrapping at both ends', () => {
		assert.deepStrictEqual({
			next: (['all', 'agent', 'editor', 'space', 'command'] as const).map(kind => paradisCyclePaletteKind(kind, 1)),
			previous: (['all', 'agent', 'editor', 'space', 'command'] as const).map(kind => paradisCyclePaletteKind(kind, -1)),
		}, {
			next: ['agent', 'editor', 'space', 'command', 'all'],
			previous: ['command', 'all', 'agent', 'editor', 'space'],
		});
	});

	test('prefixes pick a kind only with a space after the letter; > and ? switch the palette', () => {
		assert.deepStrictEqual(['a codex', 'T paradis', 's ', '>reload', '?', 'abc', 'a', 'x foo', ' a foo'].map(paradisParsePalettePrefix), [
			{ kind: 'agent', rest: 'codex' },
			{ kind: 'editor', rest: 'paradis' },
			{ kind: 'space', rest: '' },
			{ kind: 'command', rest: 'reload' },
			{ kind: 'help', rest: '' },
			{ kind: undefined, rest: 'abc' },
			{ kind: undefined, rest: 'a' },
			{ kind: undefined, rest: 'x foo' },
			{ kind: undefined, rest: ' a foo' },
		]);
	});

	test('matching follows the quick pick list (label or description, icons ignored)', () => {
		assert.deepStrictEqual([
			paradisPaletteMatches('', '$(repo) Paracode', undefined),
			paradisPaletteMatches('para', '$(repo) Paracode', undefined),
			paradisPaletteMatches('repo', '$(repo) Paracode', undefined),
			paradisPaletteMatches('f15', 'codex', 'fix/security-f15-ssrf'),
			paradisPaletteMatches('zzz', 'codex', 'fix/security-f15-ssrf'),
		], [true, true, false, true, false]);
	});

	test('spaces are grouped by repository in the given order', () => {
		const groups = paradisGroupPaletteSpaces([
			{ repositoryId: 'r1', name: 'r1' },
			{ repositoryId: 'r2', name: 'r2' },
			{ repositoryId: 'r1', name: 'r1-wt' },
		]);
		assert.deepStrictEqual(groups.map(group => [group.repositoryId, group.items.map(item => item.name)]), [['r1', ['r1', 'r1-wt']], ['r2', ['r2']]]);
	});

	test('recent jumps keep pins, move to the top and show pins plus the newest up to four', () => {
		let list: IParadisPaletteRecent[] = paradisParsePaletteRecents('not json');
		list = paradisRecordPaletteRecent(list, 'space', 's1', 1);
		list = paradisRecordPaletteRecent(list, 'agent', 'a1', 2);
		list = paradisTogglePalettePin(list, 'space', 's1', 3);
		list = paradisRecordPaletteRecent(list, 'editor', 'e1', 4);
		list = paradisRecordPaletteRecent(list, 'editor', 'e2', 5);
		list = paradisRecordPaletteRecent(list, 'editor', 'e3', 6);
		list = paradisRecordPaletteRecent(list, 'space', 's1', 7);
		const roundTrip = paradisParsePaletteRecents(JSON.stringify(list));
		assert.deepStrictEqual({
			stored: roundTrip.map(entry => `${entry.kind}:${entry.key}${entry.pinned ? '*' : ''}`),
			shown: paradisPaletteRecentsToShow(roundTrip, entry => entry.key !== 'e2').map(entry => entry.key),
			unpinned: paradisTogglePalettePin(roundTrip, 'space', 's1', 8).find(entry => entry.key === 's1')?.pinned,
		}, {
			stored: ['space:s1*', 'editor:e3', 'editor:e2', 'editor:e1', 'agent:a1'],
			shown: ['s1', 'e3', 'e1', 'a1'],
			unpinned: undefined,
		});
	});

	test('actions: three when the input is empty, matching ones (up to five) when typing', () => {
		const actions = ['新しいスペース', 'ターミナルを開く', 'Claude Code を起動', 'Codex を起動', 'エージェント一覧のウィンドウを開く'].map(label => ({ label }));
		assert.deepStrictEqual({
			empty: paradisPaletteActionsToShow(actions, '').map(action => action.label),
			launch: paradisPaletteActionsToShow(actions, '起動').map(action => action.label),
		}, {
			empty: ['新しいスペース', 'ターミナルを開く', 'Claude Code を起動'],
			launch: ['Claude Code を起動', 'Codex を起動'],
		});
	});

	test('pins are capped (oldest pin dropped) and gone targets are pruned even when pinned', () => {
		let list: IParadisPaletteRecent[] = [];
		for (let i = 0; i < PARADIS_PALETTE_PIN_LIMIT + 2; i++) {
			list = paradisTogglePalettePin(list, 'editor', `e${i}`, i);
		}
		list = paradisTogglePalettePin(list, 'agent', 'gone', 100);
		const pruned = paradisPrunePaletteRecents(list, entry => entry.kind === 'agent' && entry.key === 'gone');
		assert.deepStrictEqual({
			pins: list.filter(entry => entry.pinned).length,
			oldestKept: list.some(entry => entry.key === 'e0' || entry.key === 'e1' || entry.key === 'e2'),
			pruned: pruned.some(entry => entry.key === 'gone'),
			prunedCount: pruned.length,
		}, {
			pins: PARADIS_PALETTE_PIN_LIMIT,
			oldestKept: false,
			pruned: false,
			prunedCount: PARADIS_PALETTE_PIN_LIMIT - 1,
		});
	});

	test('the shared (profile) records move to the window only for the targets this window knows', () => {
		const shared: IParadisPaletteRecent[] = [
			{ kind: 'space', key: 'here', at: 3, pinned: true },
			{ kind: 'space', key: 'other-window', at: 2, pinned: true },
			{ kind: 'agent', key: 'here-agent', at: 1 },
		];
		const known = new Set(['here', 'here-agent']);
		const { moved, rest } = paradisSplitPaletteRecents(shared, entry => known.has(entry.key));
		assert.deepStrictEqual({ moved: moved.map(entry => entry.key), rest: rest.map(entry => entry.key) }, { moved: ['here', 'here-agent'], rest: ['other-window'] });
	});
	test('deleting the prefix of a quick access picker returns to the cross jump, other replacements do not', () => {
		const files = 'inFilesPicker';
		const prefixed = new Set(['inCommandsPicker', 'inQuickOpenHelp']);
		const check = (previous: { contextKey: string | undefined; value: string } | undefined, next: { contextKey: string | undefined; value: string }) => paradisShouldReturnToCrossJump(previous, next, files, prefixed);
		assert.deepStrictEqual({
			commandsToFiles: check({ contextKey: 'inCommandsPicker', value: 'term' }, { contextKey: files, value: 'term' }),
			commandsToFilesEmpty: check({ contextKey: 'inCommandsPicker', value: '' }, { contextKey: files, value: '' }),
			helpToFiles: check({ contextKey: 'inQuickOpenHelp', value: '' }, { contextKey: files, value: '' }),
			crossJumpToFiles: check({ contextKey: 'paradisInCrossJump', value: 'term' }, { contextKey: files, value: 'term' }),
			noPrevious: check(undefined, { contextKey: files, value: '' }),
			plainPicker: check({ contextKey: undefined, value: '' }, { contextKey: files, value: '' }),
			filesToFiles: check({ contextKey: files, value: '' }, { contextKey: files, value: '' }),
			nextNotFiles: check({ contextKey: 'inCommandsPicker', value: '?' }, { contextKey: 'inQuickOpenHelp', value: '?' }),
			valueDiffers: check({ contextKey: 'inCommandsPicker', value: '>term' }, { contextKey: files, value: 'other' }),
		}, {
			commandsToFiles: true,
			commandsToFilesEmpty: true,
			helpToFiles: true,
			crossJumpToFiles: false,
			noPrevious: false,
			plainPicker: false,
			filesToFiles: false,
			nextNotFiles: false,
			valueDiffers: false,
		});
	});
});
