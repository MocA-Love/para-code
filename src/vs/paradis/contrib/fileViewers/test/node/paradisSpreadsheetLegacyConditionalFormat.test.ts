/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { evaluateLegacyConditionalFormatting, parseConditionalFormatRef, type IParadisLegacyCfCellValue } from '../../node/spreadsheet/paradisSpreadsheetLegacyConditionalFormat.js';

/** argb だけを見る最小のリゾルバ。実サービスのテーマ解決には依存させない。 */
function resolveArgb(color: unknown): string | null {
	const argb = (color as { argb?: string } | undefined)?.argb;
	return argb ? `#${argb.slice(-6).toLowerCase()}` : null;
}

/** 1 列ぶんの数値セルを組み立てる。 */
function numericColumn(col: number, values: readonly number[]): IParadisLegacyCfCellValue[] {
	return values.map((num, index) => ({ row: index + 1, col, num, text: String(num) }));
}

const redFill = {
	fill: { pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
	font: { bold: true },
};

suite('ParadisSpreadsheetLegacyConditionalFormat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses single cells, ranges, and space separated multi ranges', () => {
		deepStrictEqual(parseConditionalFormatRef('B3'), [{ minR: 3, maxR: 3, minC: 2, maxC: 2 }]);
		deepStrictEqual(parseConditionalFormatRef('$A$1:$B$2'), [{ minR: 1, maxR: 2, minC: 1, maxC: 2 }]);
		deepStrictEqual(parseConditionalFormatRef('A1:B2 D4:E9'), [
			{ minR: 1, maxR: 2, minC: 1, maxC: 2 },
			{ minR: 4, maxR: 9, minC: 4, maxC: 5 },
		]);
		// 逆順の指定でも正規化され、AA 以降の複数文字列も解決できる。
		deepStrictEqual(parseConditionalFormatRef('C5:A1'), [{ minR: 1, maxR: 5, minC: 1, maxC: 3 }]);
		deepStrictEqual(parseConditionalFormatRef('AA1'), [{ minR: 1, maxR: 1, minC: 27, maxC: 27 }]);
		deepStrictEqual(parseConditionalFormatRef(undefined), []);
		deepStrictEqual(parseConditionalFormatRef('not-a-ref'), []);
	});

	test('applies cellIs rules only to matching cells inside the range', () => {
		const values = numericColumn(1, [10, 20, 30, 40, 50]);
		const styles = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [25], priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);

		deepStrictEqual([...styles.keys()].sort(), ['3,1', '4,1', '5,1']);
		deepStrictEqual(styles.get('3,1'), { backgroundColor: '#ff0000', fontWeight: 'bold' });
	});

	test('supports between, text, and string equality operators', () => {
		const values: IParadisLegacyCfCellValue[] = [
			{ row: 1, col: 1, num: 5, text: '5' },
			{ row: 2, col: 1, num: 15, text: '15' },
			{ row: 3, col: 1, text: '対象外' },
			{ row: 4, col: 1, text: '要確認です' },
		];

		const between = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A4', rules: [{ type: 'cellIs', operator: 'between', formulae: [10, 20], priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...between.keys()], ['2,1']);

		const contains = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A4', rules: [{ type: 'containsText', operator: 'containsText', text: '要確認', priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...contains.keys()], ['4,1']);

		// 数値化できない比較値は文字列の等価比較へ落ちる。
		const equalsText = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A4', rules: [{ type: 'cellIs', operator: 'equal', formulae: ['"対象外"'], priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...equalsText.keys()], ['3,1']);
	});

	test('interpolates two color scales across the range minimum and maximum', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A3',
				rules: [{
					type: 'colorScale',
					priority: 1,
					cfvo: [{ type: 'min' }, { type: 'max' }],
					color: [{ argb: 'FF000000' }, { argb: 'FFFFFFFF' }],
				}],
			}],
			numericColumn(1, [0, 50, 100]),
			resolveArgb,
		);

		deepStrictEqual(
			[styles.get('1,1'), styles.get('2,1'), styles.get('3,1')],
			[{ backgroundColor: '#000000' }, { backgroundColor: '#808080' }, { backgroundColor: '#ffffff' }],
		);
	});

	test('renders data bars as a bounded gradient and skips empty bars', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A3',
				rules: [{ type: 'dataBar', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF638EC6' } }],
			}],
			numericColumn(1, [0, 50, 100]),
			resolveArgb,
		);

		// 最小値のセルはバー長 0 なので塗らない。
		strictEqual(styles.has('1,1'), false);
		strictEqual(styles.get('2,1')?.backgroundImage?.includes('50%'), true);
		strictEqual(styles.get('3,1')?.backgroundImage?.includes('100%'), true);
	});

	test('ranks top10 and aboveAverage against the values inside the range', () => {
		const values = numericColumn(1, [1, 2, 3, 4, 100]);

		const top = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'top10', rank: 2, priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...top.keys()].sort(), ['4,1', '5,1']);

		const above = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'aboveAverage', aboveAverage: true, priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...above.keys()], ['5,1']);
	});

	test('lets the lower priority number win when rules overlap', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A1',
				rules: [
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 5, style: { fill: { fgColor: { argb: 'FF00FF00' } } } },
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, style: { fill: { fgColor: { argb: 'FFFF0000' } } } },
				],
			}],
			numericColumn(1, [10]),
			resolveArgb,
		);

		strictEqual(styles.get('1,1')?.backgroundColor, '#ff0000');
	});

	test('ignores rules that need a formula engine and leaves other cells untouched', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A2',
				rules: [
					{ type: 'expression', formulae: ['$A1>0'], priority: 1, style: redFill },
					{ type: 'iconSet', priority: 2, cfvo: [{ type: 'min' }, { type: 'max' }] },
				],
			}],
			numericColumn(1, [1, 2]),
			resolveArgb,
		);

		strictEqual(styles.size, 0);
	});

	test('returns nothing when there are no blocks or no values', () => {
		strictEqual(evaluateLegacyConditionalFormatting(undefined, numericColumn(1, [1]), resolveArgb).size, 0);
		strictEqual(evaluateLegacyConditionalFormatting([{ ref: 'A1', rules: [] }], [], resolveArgb).size, 0);
	});

	test('resolves percent and percentile thresholds against the range', () => {
		const values = numericColumn(1, [0, 1, 2, 3, 100]);
		// percentile 50 は中央値(2)、percent 50 は最小と最大の中点(50)。両者は一致しない。
		const percentile = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A5',
				rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }], color: [{ argb: 'FF000000' }, { argb: 'FFFFFFFF' }] }],
			}],
			values,
			resolveArgb,
		);
		strictEqual(percentile.get('3,1')?.backgroundColor, '#ffffff');

		const percent = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A5',
				rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'percent', value: 50 }], color: [{ argb: 'FF000000' }, { argb: 'FFFFFFFF' }] }],
			}],
			values,
			resolveArgb,
		);
		// 3 は中点 50 の手前なので、まだ白へ振り切らない。
		strictEqual(percent.get('3,1')?.backgroundColor !== '#ffffff', true);
	});

	test('interpolates three color scales through the midpoint stop', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A3',
				rules: [{
					type: 'colorScale',
					priority: 1,
					cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
					color: [{ argb: 'FF000000' }, { argb: 'FFFF0000' }, { argb: 'FFFFFFFF' }],
				}],
			}],
			numericColumn(1, [0, 50, 100]),
			resolveArgb,
		);

		deepStrictEqual(
			[styles.get('1,1'), styles.get('2,1'), styles.get('3,1')],
			[{ backgroundColor: '#000000' }, { backgroundColor: '#ff0000' }, { backgroundColor: '#ffffff' }],
		);
	});

	test('paints the first color when the range has no spread', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A3',
				rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FF112233' }, { argb: 'FFFFFFFF' }] }],
			}],
			numericColumn(1, [7, 7, 7]),
			resolveArgb,
		);

		deepStrictEqual([...new Set([...styles.values()].map(style => style.backgroundColor))], ['#112233']);
	});

	test('handles bottom and percent variants of top10 and clamps an out-of-range rank', () => {
		const values = numericColumn(1, [1, 2, 3, 4, 100]);

		const bottom = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'top10', rank: 2, bottom: true, priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...bottom.keys()].sort(), ['1,1', '2,1']);

		const percent = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'top10', rank: 40, percent: true, priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		deepStrictEqual([...percent.keys()].sort(), ['4,1', '5,1']);

		// rank が件数を超えても、静かに無効化せず全件に当てる。
		const oversized = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A5', rules: [{ type: 'top10', rank: 999, priority: 1, style: redFill }] }],
			values,
			resolveArgb,
		);
		strictEqual(oversized.size, 5);
	});

	test('treats a rule without a priority as the weakest one', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A1',
				rules: [
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { fill: { fgColor: { argb: 'FF00FF00' } } } },
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 3, style: { fill: { fgColor: { argb: 'FFFF0000' } } } },
				],
			}],
			numericColumn(1, [10]),
			resolveArgb,
		);

		strictEqual(styles.get('1,1')?.backgroundColor, '#ff0000');
	});

	test('stops at a matching stopIfTrue rule and keeps weaker rules from applying', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{
				ref: 'A1:A1',
				rules: [
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, stopIfTrue: true, style: { font: { bold: true } } },
					{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 2, style: { fill: { fgColor: { argb: 'FFFF0000' } } } },
				],
			}],
			numericColumn(1, [10]),
			resolveArgb,
		);

		deepStrictEqual(styles.get('1,1'), { fontWeight: 'bold' });
	});

	test('merges overlapping blocks without letting a weaker rule repaint a decided property', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[
				{ ref: 'A1:A2', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, style: { fill: { fgColor: { argb: 'FFFF0000' } }, font: { bold: true } } }] },
				{ ref: 'A2:A3', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 2, style: { font: { italic: true } } }] },
			],
			numericColumn(1, [1, 2, 3]),
			resolveArgb,
		);

		deepStrictEqual(styles.get('1,1'), { backgroundColor: '#ff0000', fontWeight: 'bold' });
		deepStrictEqual(styles.get('2,1'), { backgroundColor: '#ff0000', fontWeight: 'bold', fontStyle: 'italic' });
		deepStrictEqual(styles.get('3,1'), { fontStyle: 'italic' });
	});

	test('skips a rule whose colors cannot be resolved', () => {
		const styles = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A2', rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{}, {}] }] }],
			numericColumn(1, [1, 2]),
			resolveArgb,
		);

		strictEqual(styles.size, 0);
	});

	test('only walks cells that exist inside the declared range', () => {
		// 範囲は 1,000,000 行を指すが、実在するセルは 2 つだけ。走査は実セル数で収まる。
		const styles = evaluateLegacyConditionalFormatting(
			[{ ref: 'A1:A1000000', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, style: redFill }] }],
			numericColumn(1, [5, 6]),
			resolveArgb,
		);

		deepStrictEqual([...styles.keys()].sort(), ['1,1', '2,1']);
	});
});
