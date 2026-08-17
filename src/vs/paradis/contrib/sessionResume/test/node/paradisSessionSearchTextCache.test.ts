/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSessionSearchTextCache } from '../../node/paradisSessionSearchTextCache.js';

suite('ParadisSessionSearchTextCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('touches a hit so the least recently used entry is evicted', () => {
		const cache = new ParadisSessionSearchTextCache(8);
		cache.set('a', 1, 'aa');
		cache.set('b', 1, 'bb');

		assert.strictEqual(cache.get('a', 1), 'aa');
		cache.set('c', 1, 'cc');

		assert.deepStrictEqual({ a: cache.get('a', 1), b: cache.get('b', 1), c: cache.get('c', 1), size: cache.size, bytes: cache.bytes }, {
			a: 'aa', b: undefined, c: 'cc', size: 2, bytes: 8,
		});
	});

	test('accounts for replacement and revision-specific values exactly', () => {
		const cache = new ParadisSessionSearchTextCache(20);
		cache.set('session', 1, 'four');
		cache.set('session', 1, 'two');
		cache.set('session', 2, 'new');

		assert.deepStrictEqual({ old: cache.get('session', 1), current: cache.get('session', 2), size: cache.size, bytes: cache.bytes }, {
			old: undefined, current: 'new', size: 1, bytes: 6,
		});
	});

	test('accepts a value at the exact byte boundary', () => {
		const cache = new ParadisSessionSearchTextCache(6);
		cache.set('boundary', 1, 'abc');

		assert.deepStrictEqual({ value: cache.get('boundary', 1), size: cache.size, bytes: cache.bytes }, {
			value: 'abc', size: 1, bytes: 6,
		});
	});

	test('uses UTF-16 conservative byte cost for Unicode text', () => {
		const cache = new ParadisSessionSearchTextCache(4);
		cache.set('unicode', 1, '😀');

		assert.deepStrictEqual({ value: cache.get('unicode', 1), size: cache.size, bytes: cache.bytes }, {
			value: '😀', size: 1, bytes: 4,
		});
	});

	test('deletes a catalog entry idempotently', () => {
		const cache = new ParadisSessionSearchTextCache(8);
		cache.set('delete-me', 1, 'abc');
		cache.delete('delete-me');
		cache.delete('delete-me');

		assert.deepStrictEqual({ value: cache.get('delete-me', 1), size: cache.size, bytes: cache.bytes }, {
			value: undefined, size: 0, bytes: 0,
		});
	});

	test('does not retain a value larger than the byte budget', () => {
		const cache = new ParadisSessionSearchTextCache(4);
		cache.set('oversize', 1, 'abc');

		assert.deepStrictEqual({ value: cache.get('oversize', 1), size: cache.size, bytes: cache.bytes }, {
			value: undefined, size: 0, bytes: 0,
		});
	});
});
