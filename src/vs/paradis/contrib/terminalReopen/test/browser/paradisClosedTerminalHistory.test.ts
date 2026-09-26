/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GroupDirection } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IParadisClosedTerminal, ParadisClosedEntry, PARADIS_CLOSED_TERMINAL_LIMIT, ParadisClosedTerminalHistory, paradisPlanReopen } from '../../browser/paradisClosedTerminalHistory.js';

/** 同期処理の区切り（upstream の閉じたエディタ履歴と同じく microtask で1まとまりを閉じる）を手で進める。 */
function manualBatches(): { history: ParadisClosedTerminalHistory; endTurn(): void } {
	let pending: (() => void)[] = [];
	const history = new ParadisClosedTerminalHistory(callback => pending.push(callback));
	return {
		history,
		endTurn: () => {
			const callbacks = pending;
			pending = [];
			callbacks.forEach(callback => callback());
		},
	};
}

function terminal(cwd: string, neighbor?: IParadisClosedTerminal['neighbor']): IParadisClosedTerminal {
	return { cwd, groupId: 1, index: 0, neighbor };
}

function describe(entries: ParadisClosedEntry[]): string[] {
	return entries.map(entry => entry.kind === 'terminal' ? `terminal:${entry.terminal.cwd}` : 'editor');
}

suite('ParadisClosedTerminalHistory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reopens in closing order, keeping terminals and editors interleaved', () => {
		const { history, endTurn } = manualBatches();
		history.recordEditor('space');
		endTurn();
		history.recordTerminal('space', terminal('/a', { groupId: 2, direction: GroupDirection.RIGHT }));
		endTurn();
		history.recordEditor('space');
		endTurn();

		assert.deepStrictEqual([
			describe(history.takeLastBatch('space')),
			history.takeLastBatch('space'),
			describe(history.takeLastBatch('space')),
			describe(history.takeLastBatch('space')),
		], [
			['editor'],
			[{ kind: 'terminal', terminal: terminal('/a', { groupId: 2, direction: GroupDirection.RIGHT }), batch: 2 }],
			['editor'],
			[],
		]);
	});

	test('reopens everything closed in the same turn together', () => {
		const { history, endTurn } = manualBatches();
		history.recordTerminal('space', terminal('/before'));
		endTurn();
		// 「すべて閉じる」: ファイル2つとターミナル2つが同じ同期処理の中で閉じる
		history.recordEditor('space');
		history.recordTerminal('space', terminal('/a'));
		history.recordEditor('space');
		history.recordTerminal('space', terminal('/b'));
		endTurn();

		assert.deepStrictEqual([
			describe(history.takeLastBatch('space')),
			describe(history.takeLastBatch('space')),
		], [
			['editor', 'terminal:/a', 'editor', 'terminal:/b'],
			['terminal:/before'],
		]);
	});

	test('does not repeat the editor mark for editors closed together', () => {
		const { history } = manualBatches();
		history.recordEditor('space');
		history.recordEditor('space');
		history.recordEditor('space');
		assert.deepStrictEqual(describe(history.takeLastBatch('space')), ['editor']);
	});

	test('keeps a separate history per space, capped, and drops it with the space', () => {
		const { history, endTurn } = manualBatches();
		for (let i = 0; i < PARADIS_CLOSED_TERMINAL_LIMIT + 3; i++) {
			history.recordTerminal('a', terminal(`/a${i}`));
			endTurn();
		}
		history.recordTerminal('b', terminal('/b'));
		endTurn();
		history.recordTerminal('gone', terminal('/gone'));
		endTurn();
		history.clearScope('gone');

		const drainedA: string[] = [];
		for (let batch = history.takeLastBatch('a'); batch.length; batch = history.takeLastBatch('a')) {
			drainedA.push(...describe(batch));
		}
		assert.deepStrictEqual({
			a: drainedA,
			b: describe(history.takeLastBatch('b')),
			gone: describe(history.takeLastBatch('gone')),
		}, {
			a: Array.from({ length: PARADIS_CLOSED_TERMINAL_LIMIT }, (_, i) => `terminal:/a${PARADIS_CLOSED_TERMINAL_LIMIT + 2 - i}`),
			b: ['terminal:/b'],
			gone: [],
		});
	});

	test('delegates editors to the upstream history once per batch and skips batches it no longer has', () => {
		const editor: ParadisClosedEntry = { kind: 'editor', batch: 1 };
		const closed: ParadisClosedEntry = { kind: 'terminal', terminal: terminal('/a'), batch: 1 };
		assert.deepStrictEqual({
			terminalOnly: paradisPlanReopen([closed], false),
			mixed: paradisPlanReopen([editor, closed], true),
			editorOnly: paradisPlanReopen([editor], true),
			editorOnlyButUpstreamEmpty: paradisPlanReopen([editor], false),
		}, {
			terminalOnly: { reopenEditors: false, terminals: [terminal('/a')] },
			mixed: { reopenEditors: true, terminals: [terminal('/a')] },
			editorOnly: { reopenEditors: true, terminals: [] },
			editorOnlyButUpstreamEmpty: undefined,
		});
	});
});
