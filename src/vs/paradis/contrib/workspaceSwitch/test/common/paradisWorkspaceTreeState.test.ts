/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApplyDesiredOrder, paradisLoadCollapsedRepositoryIds, paradisParseCollapsedRepositoryIds, paradisRemoveStaleCollapsedRepositoryIds, paradisReorderByDrop, paradisSerializeCollapsedRepositoryIds, paradisSetRepositoryCollapsed, paradisSwapAdjacent } from '../../common/paradisWorkspaceTreeState.js';

suite('ParadisWorkspaceTreeState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a strict unique repository id array', () => {
		assert.deepStrictEqual(paradisParseCollapsedRepositoryIds(undefined), new Set());
		assert.deepStrictEqual(paradisParseCollapsedRepositoryIds('["repo-b","repo-a","repo-b"]'), new Set(['repo-b', 'repo-a']));
	});

	test('treats malformed storage as empty', () => {
		for (const raw of ['{', '{}', '[1]', '[""]', JSON.stringify([`x${'y'.repeat(512)}`])]) {
			assert.deepStrictEqual(paradisParseCollapsedRepositoryIds(raw), new Set(), raw);
		}
	});

	test('bounds the number of stored ids', () => {
		const ids = Array.from({ length: 1025 }, (_, index) => `repo-${index}`);
		assert.deepStrictEqual(paradisParseCollapsedRepositoryIds(JSON.stringify(ids)), new Set());
	});

	test('rejects an oversized raw value before parsing', () => {
		assert.deepStrictEqual(paradisParseCollapsedRepositoryIds(`["${'x'.repeat(600_000)}"]`), new Set());
	});

	test('recovers when workspace storage read throws', () => {
		let errors = 0;
		assert.deepStrictEqual(paradisLoadCollapsedRepositoryIds(() => { throw new Error('storage unavailable'); }, () => errors++), new Set());
		assert.strictEqual(errors, 1);
	});

	test('does not surface a diagnostic failure while recovering from storage read failure', () => {
		assert.doesNotThrow(() => paradisLoadCollapsedRepositoryIds(
			() => { throw new Error('storage unavailable'); },
			() => { throw new Error('logger unavailable'); }
		));
	});

	test('serializes deterministically', () => {
		assert.strictEqual(paradisSerializeCollapsedRepositoryIds(new Set(['repo-b', 'repo-a'])), '["repo-a","repo-b"]');
	});

	test('refuses snapshots that its reader would reject', () => {
		assert.strictEqual(paradisSerializeCollapsedRepositoryIds(new Set(Array.from({ length: 1025 }, (_, index) => `repo-${index}`))), undefined);
		assert.strictEqual(paradisSerializeCollapsedRepositoryIds(new Set([`repo-${'x'.repeat(512)}`])), undefined);
		const maximumLengthIds = new Set(Array.from({ length: 1024 }, (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(507)}`));
		const serialized = paradisSerializeCollapsedRepositoryIds(maximumLengthIds);
		assert.ok(serialized !== undefined);
		assert.deepStrictEqual(paradisParseCollapsedRepositoryIds(serialized), maximumLengthIds);
	});

	test('tracks repository collapse changes idempotently', () => {
		const ids = new Set<string>();
		assert.strictEqual(paradisSetRepositoryCollapsed(ids, 'repo-a', true), true);
		assert.strictEqual(paradisSetRepositoryCollapsed(ids, 'repo-a', true), false);
		assert.strictEqual(paradisSetRepositoryCollapsed(ids, 'repo-a', false), true);
		assert.strictEqual(paradisSetRepositoryCollapsed(ids, 'repo-a', false), false);
	});

	test('removes only collapsed ids for deleted repositories', () => {
		const ids = new Set(['repo-a', 'repo-deleted']);
		assert.strictEqual(paradisRemoveStaleCollapsedRepositoryIds(ids, new Set(['repo-a', 'repo-b'])), true);
		assert.deepStrictEqual(ids, new Set(['repo-a']));
		assert.strictEqual(paradisRemoveStaleCollapsedRepositoryIds(ids, new Set(['repo-a'])), false);
	});

	test('swaps adjacent items and refuses out-of-range moves', () => {
		assert.deepStrictEqual(paradisSwapAdjacent(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
		assert.deepStrictEqual(paradisSwapAdjacent(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
		assert.strictEqual(paradisSwapAdjacent(['a', 'b', 'c'], 0, -1), null);
		assert.strictEqual(paradisSwapAdjacent(['a', 'b', 'c'], 2, 1), null);
		assert.strictEqual(paradisSwapAdjacent(['a', 'b', 'c'], -1, 1), null);
	});

	test('reorders by drop before/after with source-index correction', () => {
		assert.deepStrictEqual(paradisReorderByDrop(['a', 'b', 'c', 'd'], 'a', 'c', false), ['b', 'a', 'c', 'd']);
		assert.deepStrictEqual(paradisReorderByDrop(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd']);
		assert.deepStrictEqual(paradisReorderByDrop(['a', 'b', 'c', 'd'], 'd', 'b', false), ['a', 'd', 'b', 'c']);
		// 同一要素・未知ID・移動しても順序が変わらないケースは null
		assert.strictEqual(paradisReorderByDrop(['a', 'b', 'c'], 'a', 'a', false), null);
		assert.strictEqual(paradisReorderByDrop(['a', 'b', 'c'], 'a', 'b', false), null);
		assert.strictEqual(paradisReorderByDrop(['a', 'b', 'c'], 'x', 'b', false), null);
	});

	test('applies a desired order and keeps unlisted items in their relative order', () => {
		assert.deepStrictEqual(paradisApplyDesiredOrder(['a', 'b', 'c'], id => id, ['c', 'a', 'b']), ['c', 'a', 'b']);
		assert.deepStrictEqual(paradisApplyDesiredOrder(['a', 'b', 'c', 'd'], id => id, ['c', 'a']), ['c', 'a', 'b', 'd']);
		assert.strictEqual(paradisApplyDesiredOrder(['a', 'b', 'c'], id => id, ['a', 'b', 'c']), null);
		assert.strictEqual(paradisApplyDesiredOrder(['a', 'b', 'c'], id => id, ['x', 'y']), null);
	});
});
