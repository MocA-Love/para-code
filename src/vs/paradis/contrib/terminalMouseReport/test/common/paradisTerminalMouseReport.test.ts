/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDropNonFiniteMouseReports } from '../../common/paradisTerminalMouseReport.js';

suite('ParadisTerminalMouseReport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops broken mouse reports and keeps everything else', () => {
		const cases: [string, string][] = [
			// 座標 NaN の SGR 報告 (今回の不具合)
			['nan release', '\x1b[<0;NaN;NaNm'],
			['nan press', '\x1b[<0;NaN;NaNM'],
			['nan x only', '\x1b[<32;NaN;5M'],
			['nan y only', '\x1b[<32;5;NaNM'],
			['infinity', '\x1b[<0;Infinity;-InfinityM'],
			['negative infinity x', '\x1b[<0;-Infinity;3m'],
			['empty coords', '\x1b[<0;;m'],
			// X10 形式: String.fromCharCode(NaN + 32) は NUL
			['x10 nan', '\x1b[M \x00\x00'],
			['x10 nan y', '\x1b[M !\x00'],
			// 正しい報告と通常の入力は落とさない
			['valid sgr', '\x1b[<0;12;34m'],
			['valid sgr pixels', '\x1b[<35;640;480M'],
			['valid x10', '\x1b[M !!'],
			['plain text', 'hello aN;NaNm'],
			['arrow key', '\x1b[A'],
			// 1 回の onData に混ざって来たら報告だけを抜く
			['mixed', 'ab\x1b[<0;12;34Mc\x1b[<0;NaN;NaNmd\x1b[<0;12;34m'],
			['two broken', '\x1b[<0;NaN;NaNM\x1b[<0;NaN;NaNm'],
			// ブラケットペーストの中身は触らない
			['paste', '\x1b[200~x\x1b[<0;NaN;NaNmy\x1b[201~\x1b[<0;NaN;NaNm'],
			['unterminated paste', '\x1b[200~\x1b[<0;NaN;NaNm'],
		];
		assert.deepStrictEqual(
			cases.map(([name, input]) => [name, paradisDropNonFiniteMouseReports(input)]),
			[
				['nan release', { data: '', droppedReports: 1 }],
				['nan press', { data: '', droppedReports: 1 }],
				['nan x only', { data: '', droppedReports: 1 }],
				['nan y only', { data: '', droppedReports: 1 }],
				['infinity', { data: '', droppedReports: 1 }],
				['negative infinity x', { data: '', droppedReports: 1 }],
				['empty coords', { data: '', droppedReports: 1 }],
				['x10 nan', { data: '', droppedReports: 1 }],
				['x10 nan y', { data: '', droppedReports: 1 }],
				['valid sgr', { data: '\x1b[<0;12;34m', droppedReports: 0 }],
				['valid sgr pixels', { data: '\x1b[<35;640;480M', droppedReports: 0 }],
				['valid x10', { data: '\x1b[M !!', droppedReports: 0 }],
				['plain text', { data: 'hello aN;NaNm', droppedReports: 0 }],
				['arrow key', { data: '\x1b[A', droppedReports: 0 }],
				['mixed', { data: 'ab\x1b[<0;12;34Mcd\x1b[<0;12;34m', droppedReports: 1 }],
				['two broken', { data: '', droppedReports: 2 }],
				['paste', { data: '\x1b[200~x\x1b[<0;NaN;NaNmy\x1b[201~', droppedReports: 1 }],
				['unterminated paste', { data: '\x1b[200~\x1b[<0;NaN;NaNm', droppedReports: 0 }],
			]
		);
	});
});
