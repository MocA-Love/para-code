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

	test('gives the saved box only to the notes set to show, and keeps hidden notes and thread copies as they are', () => {
		const notes = `<comments xmlns="${S}"><authors><author>Sample</author><author>tc={00000000-0000-0000-0000-0000000000A1}</author></authors><commentList>`
			+ ['B2', 'C5', 'E3', 'F7', 'H2'].map(ref => `<comment ref="${ref}" authorId="0"><text><t>${ref}</t></text></comment>`).join('')
			+ `<comment ref="G9" authorId="1"><text><t>[Threaded comment] copy</t></text></comment></commentList></comments>`;
		const thread = `<ThreadedComments xmlns="${TC}"><threadedComment ref="G9" dT="2026-09-30T10:12:00.00" personId="{00000000-0000-0000-0000-000000000001}" id="{00000000-0000-0000-0000-0000000000A1}"><text>Thread</text></threadedComment></ThreadedComments>`;
		const shape = (row: number, column: number, style: string, clientData: string, fill = '#ffffe1') =>
			`<v:shape id="_x0000_s${1025 + row}" type="#_x0000_t202" style='position:absolute;${style}' fillcolor="${fill}" o:insetmode="auto"><v:fill color2="${fill}"/><v:textbox><div style='text-align:left'></div></v:textbox>`
			+ `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>${clientData}<x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${column}</x:Column></x:ClientData></v:shape>`;
		const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">`
			+ `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>`
			// B2: shown by x:Visible, placed by x:Anchor, with its own fill.
			+ shape(1, 1, 'margin-left:80pt;margin-top:2pt;width:96pt;height:55.5pt;z-index:1;visibility:visible', '<x:Anchor>2, 15, 0, 10, 4, 20, 4, 6</x:Anchor><x:Visible/>', '#ccffcc [42]')
			// C5: hidden (Excel's default).
			+ shape(4, 2, 'margin-left:150pt;margin-top:40pt;width:108pt;height:59.25pt;z-index:2;visibility:hidden', '<x:Anchor>3, 15, 3, 2, 5, 31, 7, 16</x:Anchor>')
			// E3: x:Visible says False even though the style says visible.
			+ shape(2, 4, 'margin-left:300pt;width:108pt;height:59.25pt;visibility:visible', '<x:Anchor>5, 15, 1, 2, 7, 31, 5, 16</x:Anchor><x:Visible>False</x:Visible>')
			// F7: shown by the style only, with a broken anchor, so the style places it.
			+ shape(6, 5, 'margin-left:75pt;margin-top:15pt;width:1in;height:30pt;visibility:visible', '<x:Anchor>9, 0, 9, 0, 9, 0, 9, 0</x:Anchor>')
			// H2: shown, but neither the anchor nor the style says where.
			+ shape(1, 7, 'visibility:visible', '<x:Visible/>')
			// G9: the copy of a thread stays a thread.
			+ shape(8, 6, 'visibility:visible', '<x:Anchor>7, 15, 7, 2, 9, 31, 11, 16</x:Anchor><x:Visible/>')
			// An old file's unclosed line break must not hide the rest.
			+ '<v:shape id="_x0000_s2000" type="#_x0000_t201"><v:textbox><div>a<br>b</div></v:textbox><x:ClientData ObjectType="Button"><x:Anchor>0, 0, 0, 0, 1, 0, 1, 0</x:Anchor></x:ClientData></v:shape>'
			+ '</xml>';
		const px = (value: number) => value * 9525;
		const read = (vmlDrawingXml?: string) => readParadisSpreadsheetComments({ commentsXml: notes, threadedCommentsXml: thread, personsXml: persons, vmlDrawingXml }).map(comment => [comment.ref, comment.kind, comment.shown]);
		deepStrictEqual({ shown: read(vml), broken: read(vml.slice(0, -20)), none: read() }, {
			shown: [
				['B2', 'note', { from: { c: 2, co: px(15), r: 0, ro: px(10) }, to: { c: 4, co: px(20), r: 4, ro: px(6) }, fill: '#ccffcc' }],
				['H2', 'note', undefined],
				['E3', 'note', undefined],
				['C5', 'note', undefined],
				['F7', 'note', { from: { c: 0, co: px(100), r: 0, ro: px(20) }, ext: { cx: px(96), cy: px(40) }, fill: '#ffffe1' }],
				['G9', 'thread', undefined],
			],
			broken: [['B2', 'note', undefined], ['H2', 'note', undefined], ['E3', 'note', undefined], ['C5', 'note', undefined], ['F7', 'note', undefined], ['G9', 'thread', undefined]],
			none: [['B2', 'note', undefined], ['H2', 'note', undefined], ['E3', 'note', undefined], ['C5', 'note', undefined], ['F7', 'note', undefined], ['G9', 'thread', undefined]],
		});
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
