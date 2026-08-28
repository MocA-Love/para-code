/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisDirectoryWalkLedger } from '../../common/paradisDirectoryWalkLedger.js';

suite('ParadisDirectoryWalkLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ttlMs = 5 * 60_000;

	test('denies a marked key inside the TTL and admits it at exact expiry', () => {
		let now = 1_000;
		const ledger = new ParadisDirectoryWalkLedger(ttlMs, 128, () => now);

		ledger.mark('workspace');
		now += ttlMs - 1;
		assert.strictEqual(ledger.mayRun('workspace'), false);
		assert.strictEqual(ledger.size, 1);

		now++;
		assert.strictEqual(ledger.mayRun('workspace'), true);
		assert.strictEqual(ledger.size, 0);
	});

	test('prunes expired entries before marking a new key', () => {
		let now = 0;
		const ledger = new ParadisDirectoryWalkLedger(ttlMs, 128, () => now);

		ledger.mark('expired');
		now = ttlMs;
		ledger.mark('current');

		assert.strictEqual(ledger.size, 1);
		assert.strictEqual(ledger.mayRun('expired'), true);
		assert.strictEqual(ledger.mayRun('current'), false);
	});

	test('refreshes an existing key as the newest entry before eviction', () => {
		let now = 0;
		const ledger = new ParadisDirectoryWalkLedger(ttlMs, 2, () => now);

		ledger.mark('first');
		now++;
		ledger.mark('second');
		now++;
		ledger.mark('first');
		now++;
		ledger.mark('third');

		assert.deepStrictEqual({
			size: ledger.size,
			first: ledger.mayRun('first'),
			second: ledger.mayRun('second'),
			third: ledger.mayRun('third'),
		}, {
			size: 2,
			first: false,
			second: true,
			third: false,
		});
	});

	test('evicts only the oldest entry when 129 live keys are marked', () => {
		const ledger = new ParadisDirectoryWalkLedger(ttlMs, 128, () => 0);

		for (let index = 0; index < 129; index++) {
			ledger.mark(`cwd-${index}`);
		}

		assert.deepStrictEqual({
			size: ledger.size,
			oldest: ledger.mayRun('cwd-0'),
			secondOldest: ledger.mayRun('cwd-1'),
			newest: ledger.mayRun('cwd-128'),
		}, {
			size: 128,
			oldest: true,
			secondOldest: false,
			newest: false,
		});
	});
});
