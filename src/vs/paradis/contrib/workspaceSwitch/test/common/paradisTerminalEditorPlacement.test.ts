/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisTerminalEditorPlacement, paradisOrderTerminalEditorPlacements, paradisParseTerminalEditorPlacements, paradisSerializeTerminalEditorPlacements, paradisUpdateTerminalEditorPlacements } from '../../common/paradisTerminalEditorPlacement.js';

function placement(groupId: number, index: number, active = false): IParadisTerminalEditorPlacement {
	return { groupId, index, active, pinned: true, sticky: false };
}

function toPlain(scopes: ReadonlyMap<string, ReadonlyMap<string, IParadisTerminalEditorPlacement>>): [string, [string, IParadisTerminalEditorPlacement][]][] {
	return [...scopes].map(([stateKey, placements]) => [stateKey, [...placements]]);
}

suite('paradisTerminalEditorPlacement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips the placements of each space', () => {
		const scopes = new Map([
			['space:a', new Map([['nonce-a1', placement(3, 1, true)], ['nonce-a2', placement(4, 0)]])],
			['space:b', new Map([['nonce-b1', placement(7, 2)]])],
		]);
		assert.deepStrictEqual(toPlain(paradisParseTerminalEditorPlacements(paradisSerializeTerminalEditorPlacements(scopes))), toPlain(scopes));
	});

	test('replaces one space and keeps the spaces another window wrote', () => {
		const shared = paradisSerializeTerminalEditorPlacements(new Map([
			['space:a', new Map([['nonce-old', placement(1, 0)]])],
			['space:b', new Map([['nonce-b1', placement(7, 2)]])],
		]));
		const updated = paradisUpdateTerminalEditorPlacements(shared, 'space:a', new Map([['nonce-new', placement(2, 3)]]));
		assert.deepStrictEqual(toPlain(paradisParseTerminalEditorPlacements(updated)), [
			['space:a', [['nonce-new', placement(2, 3)]]],
			['space:b', [['nonce-b1', placement(7, 2)]]],
		]);
	});

	test('forgets a space when it has nothing left to place', () => {
		const shared = paradisSerializeTerminalEditorPlacements(new Map([
			['space:a', new Map([['nonce-a1', placement(1, 0)]])],
			['space:b', new Map([['nonce-b1', placement(7, 2)]])],
		]));
		assert.deepStrictEqual([
			toPlain(paradisParseTerminalEditorPlacements(paradisUpdateTerminalEditorPlacements(shared, 'space:a', undefined))),
			toPlain(paradisParseTerminalEditorPlacements(paradisUpdateTerminalEditorPlacements(shared, 'space:b', new Map()))),
		], [
			[['space:b', [['nonce-b1', placement(7, 2)]]]],
			[['space:a', [['nonce-a1', placement(1, 0)]]]],
		]);
	});

	test('reads a malformed ledger as empty', () => {
		const entry = { nonce: 'nonce-a1', ...placement(1, 0) };
		const malformed = [
			'not json',
			JSON.stringify({ version: 2, scopes: [] }),
			JSON.stringify({ version: 1, scopes: [{ stateKey: 'space:a', placements: [{ ...entry, groupId: -1 }] }] }),
			JSON.stringify({ version: 1, scopes: [{ stateKey: 'space:a', placements: [{ ...entry, nonce: '' }] }] }),
			JSON.stringify({ version: 1, scopes: [{ stateKey: 'space:a', placements: [entry, entry] }] }),
			JSON.stringify({ version: 1, scopes: [{ stateKey: 'space:a', placements: [] }, { stateKey: 'space:a', placements: [] }] }),
		];
		assert.deepStrictEqual(malformed.map(raw => paradisParseTerminalEditorPlacements(raw).size), [0, 0, 0, 0, 0, 0]);
	});

	test('reopens each group from its leftmost saved position so the original order comes back', () => {
		const ordered = paradisOrderTerminalEditorPlacements([
			{ name: 'right-third', placement: placement(5, 2) },
			{ name: 'left-second', placement: placement(4, 1) },
			{ name: 'right-first', placement: placement(5, 0, true) },
			{ name: 'left-first', placement: placement(4, 0) },
		]);
		assert.deepStrictEqual(ordered.map(item => item.name), ['left-first', 'left-second', 'right-first', 'right-third']);
	});
});
