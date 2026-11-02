/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { asFiniteNumber, asRecord, isRecord } from '../../common/paradisGuards.js';

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
});
