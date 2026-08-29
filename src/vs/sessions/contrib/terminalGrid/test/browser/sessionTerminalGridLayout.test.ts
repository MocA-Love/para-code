/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ISerializedGrid, ISerializedNode, Orientation } from '../../../../../base/browser/ui/grid/grid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionTerminalGridIdentity, sessionCollectGridLayoutTerminals, sessionMergeGridLayoutEntries, sessionParseGridLayoutStorage, sessionPruneGridLayout, sessionRekeyOwnedGridLayoutEntries, sessionResolveGridLayoutTerminalId, sessionResolveGridLayoutTerminalNonce, sessionSerializeGridLayoutStorage } from '../../browser/sessionTerminalGridLayout.js';

function leaf(terminal: SessionTerminalGridIdentity, size = 100): ISerializedNode {
	return { type: 'leaf', data: { terminal }, size };
}

function branch(data: ISerializedNode[], size = 200): ISerializedNode {
	return { type: 'branch', data, size };
}

function grid(root: ISerializedNode, orientation = Orientation.VERTICAL): ISerializedGrid {
	return { root, orientation, width: 800, height: 400 };
}

/** The 2x2 layout: a vertical root means two rows, each split into two columns. */
function quadLayout(): ISerializedGrid {
	return grid(branch([branch([leaf(1), leaf(2)]), branch([leaf(3), leaf(4)])]));
}

suite('sessionTerminalGridLayout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('collects every terminal of a layout in traversal order', () => {
		assert.deepStrictEqual(sessionCollectGridLayoutTerminals(quadLayout()), [1, 2, 3, 4]);
	});

	test('pruning a missing pane collapses its branch into the surviving leaf', () => {
		assert.deepStrictEqual(
			sessionPruneGridLayout(quadLayout(), new Set([1, 3, 4])),
			grid(branch([{ ...leaf(1), size: 200 }, branch([leaf(3), leaf(4)])])),
		);
	});

	test('a branch left with a single child branch is flattened into its parent', () => {
		// Dropping terminal 9 leaves the inner branch with one child, which is laid out along the
		// grandparent's axis and must therefore be lifted, not substituted.
		const layout = grid(branch([branch([branch([leaf(1), leaf(2)]), leaf(9)]), leaf(3)]));

		assert.deepStrictEqual(
			sessionPruneGridLayout(layout, new Set([1, 2, 3])),
			grid(branch([leaf(1), leaf(2), leaf(3)])),
		);
	});

	test('pruning down to one branch lifts it into the root and flips the orientation', () => {
		assert.deepStrictEqual(
			sessionPruneGridLayout(quadLayout(), new Set([3, 4])),
			{ ...quadLayout(), root: branch([leaf(3), leaf(4)]), orientation: Orientation.HORIZONTAL },
		);
	});

	test('pruning everything away yields nothing to restore', () => {
		assert.strictEqual(sessionPruneGridLayout(quadLayout(), new Set([7])), undefined);
	});

	test('storage round-trips a valid snapshot', () => {
		const entries = [{ terminals: [1, 2, 3, 4], layout: quadLayout() }];
		const raw = sessionSerializeGridLayoutStorage(entries);

		assert.deepStrictEqual(raw && sessionParseGridLayoutStorage(raw), entries);
	});

	test('storage round-trips a nonce-keyed v2 snapshot', () => {
		const layout = grid(branch([leaf('nonce-a'), leaf('nonce-b')]));
		const entries = [{ version: 2 as const, terminals: ['nonce-a', 'nonce-b'], layout }];
		const raw = sessionSerializeGridLayoutStorage(entries);

		assert.deepStrictEqual(raw && sessionParseGridLayoutStorage(raw), entries);
	});

	test('malformed entries are skipped without taking the rest of the snapshot down', () => {
		const usable = { terminals: [8, 9], layout: grid(branch([leaf(8), leaf(9)])) };
		const raw = JSON.stringify([
			// `GridView.deserialize` hard-requires a branch root.
			{ terminals: [1, 2], layout: { ...quadLayout(), root: leaf(1) } },
			{ terminals: [1, 2], layout: { ...quadLayout(), width: 0 } },
			{ terminals: [1, 2], layout: grid(branch([leaf(1), { type: 'leaf', data: {}, size: 10 }])) },
			// An arrangement needs at least two panes, and the ids have to be unique.
			{ terminals: [5], layout: quadLayout() },
			{ terminals: [1, 1], layout: grid(branch([leaf(1), leaf(1)])) },
			// The terminal list has to describe exactly the tree it comes with.
			{ terminals: [1, 2], layout: quadLayout() },
			usable,
		]);

		assert.deepStrictEqual(sessionParseGridLayoutStorage(raw), [usable]);
	});

	test('storage that is not a list of entries yields nothing', () => {
		assert.deepStrictEqual(
			['not json', '{}'].map(raw => sessionParseGridLayoutStorage(raw)),
			[undefined, undefined],
		);
	});

	test('re-keying moves an unclaimed entry onto this session ids', () => {
		const entry = { terminals: [1, 2], layout: grid(branch([leaf(1), leaf(2)])) };

		assert.deepStrictEqual(
			sessionRekeyOwnedGridLayoutEntries([entry], [{ restored: 1, current: 31 }, { restored: 2, current: 32 }]),
			[{ terminals: [31, 32], layout: grid(branch([leaf(31), leaf(32)])) }],
		);
	});

	test('re-keying drops what it cannot account for rather than mixing generations', () => {
		// Nothing live explains this entry, so it is not this window's to rewrite.
		const unrelated = { terminals: [1, 2], layout: grid(branch([leaf(1), leaf(2)])) };
		// Only two of the three panes came back; the third has to leave the arrangement.
		const partial = { terminals: [3, 4, 5], layout: grid(branch([leaf(3), branch([leaf(4), leaf(5)])])) };
		// One pane left is no arrangement at all.
		const single = { terminals: [6, 7], layout: grid(branch([leaf(6), leaf(7)])) };

		assert.deepStrictEqual(
			sessionRekeyOwnedGridLayoutEntries(
				[unrelated, partial, single],
				// Two live terminals claim id 1, so it proves nothing about that id.
				[{ restored: 1, current: 31 }, { restored: 1, current: 32 }, { restored: 3, current: 33 }, { restored: 4, current: 34 }, { restored: 6, current: 36 }],
			),
			[{ terminals: [33, 34], layout: grid(branch([leaf(33), { ...leaf(34), size: 200 }])) }],
		);
	});

	test('merging keeps another window layouts and drops this window older copies', () => {
		const foreign = { terminals: [10, 11], layout: grid(branch([leaf(10), leaf(11)])) };
		// The same group as `owned`, stored under the ids of the session that wrote it.
		const previousGeneration = { terminals: [1, 2], layout: grid(branch([leaf(1), leaf(2)])) };
		const owned = { terminals: [31, 32], layout: grid(branch([leaf(31), leaf(32)])) };

		assert.deepStrictEqual(
			sessionMergeGridLayoutEntries([owned], [previousGeneration, foreign], new Set([1, 2, 31, 32])),
			[owned, foreign],
		);
	});

	test('only restored terminals resolve, by the id of the generation that persisted the layout', () => {
		const resolved = [
			// Revived after an app restart: the pty host handed out a fresh id.
			sessionResolveGridLayoutTerminalId({ shellLaunchConfig: { attachPersistentProcess: { id: 20, paradisRevivedFromPersistentProcessId: 5 } } }),
			// Window reload: the process kept its id.
			sessionResolveGridLayoutTerminalId({ shellLaunchConfig: { attachPersistentProcess: { id: 7 } } }),
			// Created in this session: its id comes from the restarted counter and would collide with
			// an unrelated terminal of the previous session.
			sessionResolveGridLayoutTerminalId({ shellLaunchConfig: {} }),
			// Taken back from a daemon that outlived the app: a fresh id, and nothing records what its
			// id was before, so placing it by that id would be the same collision.
			sessionResolveGridLayoutTerminalId({ shellLaunchConfig: { attachPersistentProcess: { id: 9, paradisAdopted: true } } }),
		];

		assert.deepStrictEqual(resolved, [5, 7, undefined, undefined]);
	});

	test('an adopted terminal keeps a stable nonce identity for v2 layouts', () => {
		assert.strictEqual(sessionResolveGridLayoutTerminalNonce({
			shellIntegrationNonce: 'nonce-adopted',
			shellLaunchConfig: { attachPersistentProcess: { id: 9, paradisAdopted: true } },
		}), 'nonce-adopted');
	});
});
