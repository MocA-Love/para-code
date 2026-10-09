/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import ExcelJS from 'exceljs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpreadsheetService } from '../../node/paradisSpreadsheetService.js';
import { readParadisSpreadsheetComments } from '../../node/spreadsheet/paradisSpreadsheetComments.js';

// Invented minimal parts. None of them comes from a real file.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const TC = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';

const persons = `<personList xmlns="${TC}"><person displayName="Sample One" id="{00000000-0000-0000-0000-000000000001}" userId="one" providerId="None"/><person displayName="Sample Two" id="{00000000-0000-0000-0000-000000000002}" userId="two" providerId="None"/></personList>`;
const threaded = `<ThreadedComments xmlns="${TC}">`
	+ `<threadedComment ref="C2" dT="2026-09-30T10:12:00.00" personId="{00000000-0000-0000-0000-000000000001}" id="{00000000-0000-0000-0000-0000000000A1}"><text>Please check @Sample Two</text><mentions><mention mentionpersonId="{00000000-0000-0000-0000-000000000002}" mentionId="{00000000-0000-0000-0000-0000000000F1}" startIndex="13" length="11"/></mentions></threadedComment>`
	+ `<threadedComment ref="C2" dT="2026-09-30T10:40:00.00" personId="{00000000-0000-0000-0000-000000000002}" id="{00000000-0000-0000-0000-0000000000A2}" parentId="{00000000-0000-0000-0000-0000000000A1}"><text>Confirmed</text></threadedComment>`
	+ `<threadedComment ref="B3" dT="2026-09-28T17:05:00.00" personId="{00000000-0000-0000-0000-000000000002}" id="{00000000-0000-0000-0000-0000000000A3}" done="1"><text>Fixed</text></threadedComment>`
	+ `</ThreadedComments>`;
const legacy = `<comments xmlns="${S}"><authors><author>tc={00000000-0000-0000-0000-0000000000A1}</author><author>Sample Note</author></authors><commentList>`
	+ `<comment ref="C2" authorId="0"><text><t>[Threaded comment] copy</t></text></comment>`
	+ `<comment ref="A1" authorId="1"><text><r><rPr><b/></rPr><t>Sample Note:</t></r><r><t xml:space="preserve">\nnote body</t></r></text></comment>`
	+ `</commentList></comments>`;

suite('ParadisSpreadsheetComments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads threads with replies, mentions, and resolution, and notes except the thread copies', () => {
		deepStrictEqual(readParadisSpreadsheetComments({ commentsXml: legacy, threadedCommentsXml: threaded, personsXml: persons }), [
			{ ref: 'A1', row: 0, column: 0, kind: 'note', entries: [{ author: 'Sample Note', text: 'Sample Note:\nnote body' }] },
			{
				ref: 'C2', row: 1, column: 2, kind: 'thread', entries: [
					{ author: 'Sample One', date: '2026-09-30T10:12:00.00', text: 'Please check @Sample Two', mentions: [{ start: 13, length: 11 }] },
					{ author: 'Sample Two', date: '2026-09-30T10:40:00.00', text: 'Confirmed' },
				],
			},
			{ ref: 'B3', row: 2, column: 1, kind: 'thread', resolved: true, entries: [{ author: 'Sample Two', date: '2026-09-28T17:05:00.00', text: 'Fixed' }] },
		]);
	});

	test('ignores parts it cannot read', () => {
		deepStrictEqual(readParadisSpreadsheetComments({ commentsXml: '<comments', threadedCommentsXml: '' }), []);
	});

	test('attaches notes written by exceljs to the sheet they belong to', async () => {
		const book = new ExcelJS.Workbook();
		book.addWorksheet('First').getCell('A1').value = 'x';
		const second = book.addWorksheet('Second');
		second.getCell('B2').value = 'y';
		second.getCell('B2').note = 'a note';
		const bytes = await book.xlsx.writeBuffer();
		const result = await new ParadisSpreadsheetService().parseWorkbook(Buffer.from(bytes).toString('base64'));
		deepStrictEqual(result.sheets.map(sheet => [sheet.name, sheet.comments?.map(comment => [comment.ref, comment.kind, comment.entries[0].text])]), [
			['First', undefined],
			['Second', [['B2', 'note', 'a note']]],
		]);
	});
});
