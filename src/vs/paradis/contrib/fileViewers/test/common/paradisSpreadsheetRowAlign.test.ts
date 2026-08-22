/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCellData, IParadisRowData } from '../../common/paradisSpreadsheet.js';
import { computeLcsRowPairs, rowFingerprint } from '../../common/paradisSpreadsheetRowAlign.js';

function row(values: readonly string[], excelRow = 1): IParadisRowData {
	const cells: IParadisCellData[] = values.map(value => ({ value, style: {} }));
	return { excelRow, height: 20, cells };
}

suite('paradisSpreadsheetRowAlign', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('rowFingerprint', () => {
		test('joins cell display values', () => {
			strictEqual(rowFingerprint(row(['a', 'b'])), 'a\u001Fb\u001F');
		});

		test('ignores styles so style-only changes still pair as modified', () => {
			const styled: IParadisRowData = { excelRow: 1, height: 20, cells: [{ value: 'a', style: { color: '#FF0000' } }] };
			strictEqual(rowFingerprint(styled), rowFingerprint(row(['a'])));
		});

		test('caps the fingerprint length', () => {
			ok(rowFingerprint(row(['x'.repeat(5000)])).length <= 2000);
		});
	});

	suite('computeLcsRowPairs', () => {
		test('pairs identical sequences in order', () => {
			deepStrictEqual(computeLcsRowPairs(['a', 'b', 'c'], ['a', 'b', 'c']), [
				{ o: 0, m: 0 }, { o: 1, m: 1 }, { o: 2, m: 2 },
			]);
		});

		test('skips a row inserted at the top', () => {
			deepStrictEqual(computeLcsRowPairs(['a', 'b'], ['x', 'a', 'b']), [
				{ o: 0, m: 1 }, { o: 1, m: 2 },
			]);
		});

		test('skips a row inserted in the middle', () => {
			deepStrictEqual(computeLcsRowPairs(['a', 'c'], ['a', 'b', 'c']), [
				{ o: 0, m: 0 }, { o: 1, m: 2 },
			]);
		});

		test('pairs around a deleted row', () => {
			deepStrictEqual(computeLcsRowPairs(['a', 'b', 'c'], ['a', 'c']), [
				{ o: 0, m: 0 }, { o: 2, m: 1 },
			]);
		});

		test('returns no pairs for disjoint sequences', () => {
			deepStrictEqual(computeLcsRowPairs(['a'], ['z']), []);
			deepStrictEqual(computeLcsRowPairs([], ['a']), []);
			deepStrictEqual(computeLcsRowPairs(['a'], []), []);
		});

		test('gives up when the DP table would exceed the budget', () => {
			const big = Array.from({ length: 2001 }, (_, i) => `row-${i}`);
			strictEqual(computeLcsRowPairs(big, [...big, 'extra']), undefined);
		});
	});
});
