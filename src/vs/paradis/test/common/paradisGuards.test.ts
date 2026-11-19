/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { asFiniteNumber, asRecord, isExactPlainArray, isExactPlainRecord, isPlainRecord, isRecord } from '../../common/paradisGuards.js';

suite('paradisGuards', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts plain objects and finite numbers only', () => {
		const values: readonly unknown[] = [{ a: 1 }, [], null, undefined, 'x', 1, Number.NaN, Number.POSITIVE_INFINITY];
		assert.deepStrictEqual({
			isRecord: values.map(isRecord),
			asRecord: values.map(asRecord),
			asFiniteNumber: values.map(asFiniteNumber),
		}, {
			isRecord: [true, false, false, false, false, false, false, false],
			asRecord: [{ a: 1 }, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
			asFiniteNumber: [undefined, undefined, undefined, undefined, undefined, 1, undefined, undefined],
		});
	});

	test('accepts only plain records and arrays whose own keys are exactly the expected data properties', () => {
		const withGetter = Object.defineProperty({}, 'a', { enumerable: true, get: () => 1 });
		const hidden = Object.defineProperty({}, 'a', { enumerable: false, value: 1 });
		const sparse = [1, 2];
		delete sparse[0];
		const records: readonly unknown[] = [{ a: 1 }, Object.assign(Object.create(null), { a: 1 }), new Map(), new Date(0), [], null, 'x', { a: 1, b: 2 }, { a: 1, [Symbol.iterator]: 2 }, withGetter, hidden, {}];
		const arrays: readonly unknown[] = [[], [1, 'x'], sparse, Object.assign([1], { extra: true }), new (class extends Array { })(), Object.defineProperty([0], '0', { enumerable: true, get: () => 1 }), { length: 0 }, 'ab'];
		assert.deepStrictEqual({
			isPlainRecord: records.map(isPlainRecord),
			isExactPlainRecord: records.map(value => isExactPlainRecord(value, ['a'])),
			isExactPlainArray: arrays.map(isExactPlainArray),
		}, {
			isPlainRecord: [true, true, false, false, false, false, false, true, true, true, true, true],
			isExactPlainRecord: [true, true, false, false, false, false, false, false, false, false, false, false],
			isExactPlainArray: [true, true, false, false, false, false, false, false],
		});
	});
});
