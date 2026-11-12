/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSheetData } from '../../../fileViewers/common/paradisSpreadsheet.js';
import { paradisMobileSheetCertainlyTooLarge, paradisMobileStyleRule } from '../../electron-browser/paradisMobileSpreadsheetHtml.js';

suite('ParadisMobileSpreadsheetHtml', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function sheet(rows: number, columns: number, hidden = false): Pick<IParadisSheetData, 'rows'> {
		const cells = Array.from({ length: columns }, () => ({ value: '', style: {}, ...(hidden ? { hidden: true } : {}) }));
		return { rows: Array.from({ length: rows }, (_, index) => ({ excelRow: index + 1, height: 20, cells })) } as Pick<IParadisSheetData, 'rows'>;
	}

	test('refuses before building a sheet whose cells cannot fit the mobile limit, and counts only the cells it draws', () => {
		assert.deepStrictEqual({
			wide: paradisMobileSheetCertainlyTooLarge(sheet(2000, 400)),
			fits: paradisMobileSheetCertainlyTooLarge(sheet(2000, 300)),
			hidden: paradisMobileSheetCertainlyTooLarge(sheet(2000, 400, true)),
		}, { wide: true, fits: false, hidden: false });
	});

	test('keeps a font name from the file inside the shared style element', () => {
		assert.deepStrictEqual(
			paradisMobileStyleRule('pmx-0', 'font-family: "</style><script>alert(1)</script>", sans-serif; color: red'),
			'.pmx-0 { font-family: "\\3C /style>\\3C script>alert(1)\\3C /script>", sans-serif !important; color: red !important; }',
		);
	});
});
