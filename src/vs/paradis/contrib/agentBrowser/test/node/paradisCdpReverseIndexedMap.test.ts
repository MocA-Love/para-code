/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisReverseIndexedMap } from '../../node/paradisCdpReverseIndexedMap.js';

suite('ParadisCdpReverseIndexedMap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keysOf gives the keys of a value in the order a scan of a plain Map would find them, through sets, moves, deletes and clears', () => {
		const indexed = new ParadisReverseIndexedMap<string, string | undefined>();
		const plain = new Map<string, string | undefined>();
		const values = ['p0', 'p1', 'p2', undefined];
		// A fixed pseudo-random sequence of operations (a small LCG, so the test is the same every run)
		let seed = 7;
		const next = (bound: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % bound;
		};
		const mismatches: string[] = [];
		for (let step = 0; step < 2000; step++) {
			const key = `k${next(40)}`;
			const operation = next(10);
			if (operation < 6) {
				const value = values[next(values.length)];
				indexed.set(key, value);
				plain.set(key, value);
			} else if (operation < 9) {
				indexed.delete(key);
				plain.delete(key);
			} else if (next(20) === 0) {
				indexed.clear();
				plain.clear();
			}
			for (const value of values) {
				const expected = [...plain].filter(([, candidate]) => candidate === value).map(([candidate]) => candidate);
				const actual = indexed.keysOf(value);
				if (expected.join() !== actual.join() || indexed.hasValue(value) !== (expected.length > 0)) {
					mismatches.push(`step ${step} value ${value}`);
				}
			}
			if ([...indexed].join() !== [...plain].join() || indexed.size !== plain.size) {
				mismatches.push(`step ${step} entries`);
			}
		}
		assert.deepStrictEqual(mismatches.slice(0, 5), []);
	});
});
