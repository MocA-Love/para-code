// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
// fflate はアプリの依存に無いので、zip はプロトコルのテスト用の関数で作る
import { zipForTest } from '../../../../protocol/src/zipFixtures.js';
import { MAX_RAW_LINES, decodeXmlText, diffLines, officeRawDiff, paragraphRawRows } from './officeRawDiff.js';

const bytesOf = (text: string) => new TextEncoder().encode(text);

function workbook(sheets: Record<string, string>, shared: readonly string[]): Uint8Array {
	const names = Object.keys(sheets);
	const files: Record<string, string> = {
		'xl/workbook.xml': (`<workbook><sheets>${names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`),
		'xl/_rels/workbook.xml.rels': (`<Relationships>${names.map((_, index) => `<Relationship Id="rId${index + 1}" Type="x" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`),
		'xl/sharedStrings.xml': (`<sst>${shared.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`),
	};
	names.forEach((name, index) => {
		files[`xl/worksheets/sheet${index + 1}.xml`] = (`<worksheet><sheetData>${sheets[name]}</sheetData></worksheet>`);
	});
	return zipForTest(files);
}

function documentOf(paragraphs: readonly string[]): Uint8Array {
	const body = paragraphs.map(text => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
	return zipForTest({ 'word/document.xml': `<w:document><w:body>${body}<w:p/></w:body></w:document>` });
}

describe('officeRawDiff', () => {
	it('lists changed, added and removed cells per sheet with formulas and shared strings', () => {
		const before = workbook({
			Sheet1: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B3"><v>100</v></c><c r="C1"><v>1</v></c></row>',
			Old: '<row r="1"><c r="A1"><v>1</v></c></row>',
		}, ['名前']);
		const after = workbook({
			Sheet1: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B3"><f>SUM(A1:A2)</f><v>120</v></c><c r="A2" t="inlineStr"><is><t>a&amp;b</t></is></c></row>',
		}, ['名前']);
		const result = officeRawDiff('spreadsheet', { before, after });
		expect(result.kind === 'rows' ? result.rows.map(row => `${row.kind} ${row.text}`) : result).toEqual([
			'hunk Sheet1',
			'del C1: 1',
			'add A2: a&b',
			'del B3: 100',
			'add B3: 120 (=SUM(A1:A2))',
			'hunk Old（削除したシート）',
			'del A1: 1',
		]);
	});

	it('compares Word paragraphs as added and removed lines with three paragraphs of context', () => {
		const before = documentOf(['1', '2', '3', '4', '5', '6', 'old', '8']);
		const after = documentOf(['1', '2', '3', '4', '5', '6', 'new', '8', '9']);
		const result = officeRawDiff('docx', { before, after });
		expect(result.kind === 'rows' ? result.rows.map(row => `${row.kind}${row.oldNo ?? ''}/${row.newNo ?? ''} ${row.text}`) : result).toEqual([
			'hunk/ 段落 4',
			'ctx4/4 4', 'ctx5/5 5', 'ctx6/6 6',
			'del7/ old', 'add/7 new',
			'ctx8/8 8',
			'add/9 9',
		]);
	});

	it('treats a missing side as empty and a broken file as unreadable', () => {
		const added = officeRawDiff('docx', { before: undefined, after: documentOf(['a']) });
		expect([
			added.kind === 'rows' ? added.rows.map(row => row.kind) : added.kind,
			officeRawDiff('spreadsheet', { before: bytesOf('not a zip'), after: undefined }).kind,
		]).toEqual([['hunk', 'add'], 'unreadable']);
	});

	it('marks capped when the paragraphs exceed the limit, and too-large zips', () => {
		const many = documentOf(Array.from({ length: MAX_RAW_LINES + 1 }, (_, index) => `p${index}`));
		const result = officeRawDiff('docx', { before: many, after: many });
		const small = officeRawDiff('docx', { before: undefined, after: documentOf(['a']) });
		const bomb = zipForTest({ 'word/document.xml': new Uint8Array(64 * 1024 * 1024 + 1) });
		expect([
			result.kind === 'rows' ? [result.capped, result.rows.length] : result.kind,
			small.kind === 'rows' ? small.capped : small.kind,
			officeRawDiff('docx', { before: bomb, after: undefined }).kind,
		]).toEqual([[true, 0], false, 'tooLarge']);
	});

	it('decodes XML entities and diffs lines by LCS', () => {
		expect([
			decodeXmlText('&lt;a&gt; &#65;&#x42; &quot;'),
			diffLines(['a', 'b', 'c'], ['a', 'x', 'c']).map(op => op.kind),
			paragraphRawRows(['same'], ['same']),
		]).toEqual(['<a> AB "', ['ctx', 'del', 'add', 'ctx'], []]);
	});
});
