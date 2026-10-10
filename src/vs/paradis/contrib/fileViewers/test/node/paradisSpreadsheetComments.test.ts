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
import { PARADIS_SPREADSHEET_COMMENT_LIMITS, readParadisSpreadsheetComments, readParadisSpreadsheetSheetComments } from '../../node/spreadsheet/paradisSpreadsheetComments.js';

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

	test('clips long author names and dates, and stops at the workbook limits when one long name repeats', () => {
		const longName = 'N'.repeat(60_000);
		const longDate = `2026-09-30T10:12:00.00${'0'.repeat(1_000)}`;
		const people = `<personList xmlns="${TC}"><person displayName="${longName}" id="{00000000-0000-0000-0000-000000000009}" userId="nine" providerId="None"/></personList>`;
		const threads = `<ThreadedComments xmlns="${TC}"><threadedComment ref="A1" dT="${longDate}" personId="{00000000-0000-0000-0000-000000000009}" id="{00000000-0000-0000-0000-0000000000B1}"><text>x</text></threadedComment></ThreadedComments>`;
		const notes = (count: number) => `<comments xmlns="${S}"><authors><author>${longName}</author></authors><commentList>`
			+ Array.from({ length: count }, (_, index) => `<comment ref="A${index + 2}" authorId="0"><text><t>x</t></text></comment>`).join('') + '</commentList></comments>';
		const [thread] = readParadisSpreadsheetComments({ threadedCommentsXml: threads, personsXml: people });
		const budget = { comments: PARADIS_SPREADSHEET_COMMENT_LIMITS.commentsPerWorkbook, characters: PARADIS_SPREADSHEET_COMMENT_LIMITS.workbookCharacters };
		const first = readParadisSpreadsheetComments({ commentsXml: notes(10_000) }, budget);
		const second = readParadisSpreadsheetComments({ commentsXml: notes(10_000) }, budget);
		const perComment = PARADIS_SPREADSHEET_COMMENT_LIMITS.authorCharacters + 1;
		const expected = Math.floor(PARADIS_SPREADSHEET_COMMENT_LIMITS.workbookCharacters / perComment);
		deepStrictEqual({
			author: thread.entries[0].author.length,
			date: thread.entries[0].date?.length,
			noteAuthor: first[0].entries[0].author.length,
			kept: first.length + second.length,
			characters: first.concat(second).reduce((sum, comment) => sum + comment.entries[0].author.length + comment.entries[0].text.length, 0) <= PARADIS_SPREADSHEET_COMMENT_LIMITS.workbookCharacters,
		}, {
			author: PARADIS_SPREADSHEET_COMMENT_LIMITS.authorCharacters,
			date: PARADIS_SPREADSHEET_COMMENT_LIMITS.dateCharacters,
			noteAuthor: PARADIS_SPREADSHEET_COMMENT_LIMITS.authorCharacters,
			kept: expected,
			characters: true,
		});
	});

	test('keeps at most 32 mentions per post and drops ones that overlap the previous mention', () => {
		const post = (mentions: string) => `<ThreadedComments xmlns="${TC}"><threadedComment ref="A1" dT="2026-09-30T10:12:00.00" personId="{00000000-0000-0000-0000-000000000001}" id="{00000000-0000-0000-0000-0000000000C1}"><text>${'abcdefgh'.repeat(100)}</text><mentions>${mentions}</mentions></threadedComment></ThreadedComments>`;
		const mention = (start: number, length: number) => `<mention mentionpersonId="{00000000-0000-0000-0000-000000000002}" mentionId="{00000000-0000-0000-0000-0000000000F2}" startIndex="${start}" length="${length}"/>`;
		const read = (mentions: string) => readParadisSpreadsheetComments({ threadedCommentsXml: post(mentions), personsXml: persons })[0].entries[0].mentions;
		deepStrictEqual({
			sameRange: read(mention(0, 8).repeat(10_000)),
			overlapping: read(mention(4, 8) + mention(0, 8) + mention(10, 4)),
			many: read(Array.from({ length: 100 }, (_, index) => mention(index * 8, 4)).join(''))?.length,
		}, {
			sameRange: [{ start: 0, length: 8 }],
			overlapping: [{ start: 0, length: 8 }, { start: 10, length: 4 }],
			many: PARADIS_SPREADSHEET_COMMENT_LIMITS.mentionsPerEntry,
		});
	});

	test('counts the comments it leaves out once the workbook limits are used up', () => {
		const notes = (count: number) => `<comments xmlns="${S}"><authors><author>Sample</author></authors><commentList>`
			+ Array.from({ length: count }, (_, index) => `<comment ref="A${index + 1}" authorId="0"><text><t>x</t></text></comment>`).join('') + '</commentList></comments>';
		const budget = { comments: 2, characters: PARADIS_SPREADSHEET_COMMENT_LIMITS.workbookCharacters };
		const first = readParadisSpreadsheetSheetComments({ commentsXml: notes(3) }, budget);
		const second = readParadisSpreadsheetSheetComments({ commentsXml: notes(4) }, budget);
		deepStrictEqual([[first.comments.length, first.omitted], [second.comments.length, second.omitted]], [[2, 1], [0, 4]]);
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
