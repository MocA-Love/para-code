/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectParadisCsvDelimiter,
	estimateParadisCsvColumnWidth,
	formatParadisCsvAsTsv,
	isParadisCsvNumeric,
	ParadisCsvIndexer,
	parseParadisCsvRecord,
	searchParadisCsv,
	sortParadisCsvRows,
	type ParadisCsvDelimiter,
	type ParadisCsvDocument,
	type ParadisCsvIndexOptions,
} from '../../common/csv/paradisCsv.js';

function index(text: string, delimiter: ParadisCsvDelimiter = ',', options?: ParadisCsvIndexOptions, budget = 1_000_000): ParadisCsvDocument {
	const indexer = new ParadisCsvIndexer(text, delimiter, options);
	while (!indexer.step(budget)) {
		// keep stepping
	}
	return indexer.finish();
}

function records(document: ParadisCsvDocument): string[][] {
	const result: string[][] = [];
	for (let record = 0; record < document.recordCount; record++) {
		result.push([...document.getRecord(record)]);
	}
	return result;
}

const immediate = () => Promise.resolve();

suite('ParadisCsv', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses RFC 4180 records with quotes, escaped quotes, embedded newlines and a BOM', () => {
		const text = '﻿id,name,note\r\n1,"Acme, Inc.","say ""hi"""\r\n2,Blue,"line 1\nline 2"\r\n3,,\r\n';
		const document = index(text);
		deepStrictEqual({ records: records(document), columns: document.columnCount, flags: document.flags }, {
			records: [
				['id', 'name', 'note'],
				['1', 'Acme, Inc.', 'say "hi"'],
				['2', 'Blue', 'line 1\nline 2'],
				['3', '', ''],
			],
			columns: 3,
			flags: { truncatedRecords: false, truncatedColumns: false },
		});
	});

	test('produces the same index regardless of how the work is chunked', () => {
		const text = 'a,b\n"x\n""y""",2\r\n3,"4"\r5,6';
		deepStrictEqual(records(index(text, ',', undefined, 1)), records(index(text)));
		deepStrictEqual(records(index(text)), [['a', 'b'], ['x\n"y"', '2'], ['3', '4'], ['5', '6']]);
	});

	test('keeps a quoted empty final record, ignores a trailing newline and counts ragged rows', () => {
		deepStrictEqual(records(index('a\n""')), [['a'], ['']]);
		const ragged = index('a,b\n1,2,3,4\n5\n');
		deepStrictEqual({ records: records(ragged), columns: ragged.columnCount }, { records: [['a', 'b'], ['1', '2', '3', '4'], ['5']], columns: 4 });
		strictEqual(index('').recordCount, 0);
		strictEqual(index('﻿').recordCount, 0);
	});

	test('reads malformed quoting leniently instead of failing', () => {
		deepStrictEqual(parseParadisCsvRecord('"ab"cd,e', 0, 8, ','), ['abcd', 'e']);
		deepStrictEqual(parseParadisCsvRecord('x"y,"z', 0, 6, ','), ['x"y', 'z']);
	});

	test('stops at the record limit and drops a record cut off by the byte limit', () => {
		const limited = index('h\n1\n2\n3\n4\n', ',', { maxRecords: 3 });
		deepStrictEqual({ records: records(limited), truncated: limited.flags.truncatedRecords }, { records: [['h'], ['1'], ['2']], truncated: true });
		const cut = index('h,v\n1,a\n2,"unfinished', ',', { contentTruncated: true });
		deepStrictEqual({ records: records(cut), truncated: cut.flags.truncatedRecords }, { records: [['h', 'v'], ['1', 'a']], truncated: true });
		const wide = index('a,b,c,d\n1,2,3,4', ',', { maxColumns: 2 });
		deepStrictEqual({ records: records(wide), columns: wide.columnCount, truncatedColumns: wide.flags.truncatedColumns }, { records: [['a', 'b'], ['1', '2']], columns: 2, truncatedColumns: true });
	});

	test('detects comma, tab and semicolon delimiters', () => {
		deepStrictEqual([
			detectParadisCsvDelimiter('a,b,c\n1,2,3\n'),
			detectParadisCsvDelimiter('a\tb\tc\n1\t2,5\t3\n'),
			detectParadisCsvDelimiter('name;price\nfoo;1,5\nbar;2,25\n'),
			detectParadisCsvDelimiter('"a;b",c\n"1;2",3\n'),
			detectParadisCsvDelimiter('﻿\n\nsingle\ncolumn\n'),
		], [',', '\t', ';', ',', ',']);
	});

	test('sorts numbers numerically, text after numbers and blanks last in both directions', async () => {
		const document = index('k,v\na,10\nb,9\nc,\nd,x\ne,"1,000"\nf,9\n');
		const ascending = await sortParadisCsvRows(document, 1, 'asc', immediate, CancellationToken.None);
		const descending = await sortParadisCsvRows(document, 1, 'desc', immediate, CancellationToken.None);
		const keys = (order: Uint32Array) => Array.from(order, row => document.getField(row + 1, 0)).join('');
		deepStrictEqual([keys(ascending), keys(descending)], ['bfaedc', 'deabfc']);
	});

	test('searches in display order, respects case and caps the result count', async () => {
		const document = index('Name,City\nalice,Tokyo\nBob,tokyo\ncarol,Osaka\n');
		const order = await sortParadisCsvRows(document, 0, 'desc', immediate, CancellationToken.None);
		const insensitive = await searchParadisCsv(document, order, 'tokyo', false, immediate, CancellationToken.None);
		const sensitive = await searchParadisCsv(document, undefined, 'Tokyo', true, immediate, CancellationToken.None);
		const capped = await searchParadisCsv(document, undefined, 'o', false, immediate, CancellationToken.None, 2);
		deepStrictEqual({
			insensitive: insensitive.matches.map(match => [match.row, match.column, match.offset]),
			sensitive: sensitive.matches.map(match => [match.row, match.column]),
			capped: [capped.matches.length, capped.capped],
		}, {
			// Descending by name: carol, alice, Bob -> Tokyo is on display rows 2 and 3.
			insensitive: [[2, 1, 0], [3, 1, 0]],
			sensitive: [[1, 1]],
			capped: [2, true],
		});
	});

	test('formats selections as Excel-compatible TSV and classifies numbers', () => {
		strictEqual(formatParadisCsvAsTsv([['a', 'b\tc'], ['say "hi"', 'x\ny']]), 'a\t"b\tc"\n"say ""hi"""\t"x\ny"');
		deepStrictEqual(['12', '-3.5', '1,234', '1e3', 'abc', '', '12a', '.'].map(isParadisCsvNumeric), [true, true, true, true, false, false, false, false]);
		deepStrictEqual([estimateParadisCsvColumnWidth(['id']), estimateParadisCsvColumnWidth(['東京都']), estimateParadisCsvColumnWidth(['x'.repeat(500)])], [48, 60, 320]);
	});
});
