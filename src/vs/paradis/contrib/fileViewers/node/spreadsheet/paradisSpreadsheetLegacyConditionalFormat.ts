/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

/**
 * ExcelJS が読み取った条件付き書式(worksheet.conditionalFormattings)を評価し、
 * セルへ焼き込む CSS を返す。描画側(buildSheetTableDom)は IParadisCellStyle を
 * そのまま CSS として適用するため、ここで CSS を組み立てておけば描画側は無改造で済む。
 *
 * 数式(expression)ルールは式エンジンが要るためこの層では扱わない。実務で多い
 * cellIs / colorScale / dataBar / top10 / aboveAverage / containsText を対象にする。
 */

/** 評価対象セルの実値(数値・文字列)。行・列は Excel の 1 始まり。 */
export interface IParadisLegacyCfCellValue {
	readonly row: number;
	readonly col: number;
	readonly num?: number;
	readonly text: string;
}

/** ExcelJS の色(argb など)を CSS 色へ解決するコールバック。 */
export type ParadisLegacyCfColorResolver = (color: unknown) => string | null;

interface ICfRange {
	readonly minR: number;
	readonly maxR: number;
	readonly minC: number;
	readonly maxC: number;
}

interface ICfRule {
	readonly type?: string;
	readonly priority?: number;
	readonly operator?: string;
	readonly text?: string;
	readonly formulae?: readonly unknown[];
	readonly style?: unknown;
	readonly cfvo?: readonly { readonly type?: string; readonly value?: unknown }[];
	/** colorScale は色の配列、dataBar は単色。ExcelJS が同じ名前で両方を返す。 */
	readonly color?: readonly unknown[] | unknown;
	readonly rank?: number;
	readonly percent?: boolean;
	readonly bottom?: boolean;
	readonly aboveAverage?: boolean;
	readonly gradient?: boolean;
	readonly showValue?: boolean;
	/** 真のとき、このルールが一致したら優先度の低いルールを評価しない。 */
	readonly stopIfTrue?: boolean;
}

/** ExcelJS の worksheet.conditionalFormattings 1 件分。 */
export interface IParadisLegacyCfBlock {
	readonly ref?: string;
	readonly rules?: readonly ICfRule[];
}

/** 上限: 1 シートあたりに評価する条件付き書式セル数。巨大シートで描画が止まらないようにする。 */
const MAX_CF_CELLS = 200_000;

function columnLettersToIndex(letters: string): number {
	let index = 0;
	for (let i = 0; i < letters.length; i++) {
		index = index * 26 + (letters.charCodeAt(i) - 64);
	}
	return index;
}

/** "A1:D10" や "A1" 、空白区切りの複数範囲("A1:B2 D4:E9")を範囲配列へ。 */
export function parseConditionalFormatRef(ref: string | undefined): ICfRange[] {
	if (!ref) {
		return [];
	}
	const ranges: ICfRange[] = [];
	for (const part of ref.split(/\s+/)) {
		if (!part) {
			continue;
		}
		const cells = part.split(':');
		const first = /^\$?([A-Z]+)\$?(\d+)$/i.exec(cells[0]?.trim() ?? '');
		if (!first) {
			continue;
		}
		const firstCol = columnLettersToIndex(first[1].toUpperCase());
		const firstRow = Number(first[2]);
		if (cells.length === 1) {
			ranges.push({ minR: firstRow, maxR: firstRow, minC: firstCol, maxC: firstCol });
			continue;
		}
		const second = /^\$?([A-Z]+)\$?(\d+)$/i.exec(cells[1]?.trim() ?? '');
		if (!second) {
			continue;
		}
		const secondCol = columnLettersToIndex(second[1].toUpperCase());
		const secondRow = Number(second[2]);
		ranges.push({
			minR: Math.min(firstRow, secondRow),
			maxR: Math.max(firstRow, secondRow),
			minC: Math.min(firstCol, secondCol),
			maxC: Math.max(firstCol, secondCol),
		});
	}
	return ranges;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim().replace(/^"|"$/g, '');
		if (trimmed === '') {
			return undefined;
		}
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim().replace(/^"|"$/g, '');
	}
	if (typeof value === 'number') {
		return String(value);
	}
	return undefined;
}

/** cellIs / containsText 系の判定。真なら rule.style を適用する。 */
function matchesPredicateRule(rule: ICfRule, cell: IParadisLegacyCfCellValue): boolean {
	const formulae = rule.formulae ?? [];
	switch (rule.type) {
		case 'cellIs': {
			const operator = rule.operator ?? 'equal';
			const first = toNumber(formulae[0]);
			const second = toNumber(formulae[1]);
			// 数値比較ができない場合は文字列比較へ落とす(equal/notEqual のみ意味を持つ)。
			if (first === undefined) {
				const expected = toText(formulae[0]);
				if (expected === undefined) {
					return false;
				}
				if (operator === 'equal') {
					return cell.text === expected;
				}
				if (operator === 'notEqual') {
					return cell.text !== expected;
				}
				return false;
			}
			if (cell.num === undefined) {
				return false;
			}
			switch (operator) {
				case 'equal': return cell.num === first;
				case 'notEqual': return cell.num !== first;
				case 'greaterThan': return cell.num > first;
				case 'lessThan': return cell.num < first;
				case 'greaterThanOrEqual': return cell.num >= first;
				case 'lessThanOrEqual': return cell.num <= first;
				case 'between': return second !== undefined && cell.num >= Math.min(first, second) && cell.num <= Math.max(first, second);
				case 'notBetween': return second !== undefined && (cell.num < Math.min(first, second) || cell.num > Math.max(first, second));
				default: return false;
			}
		}
		case 'containsText': {
			const needle = rule.text ?? toText(formulae[0]);
			if (needle === undefined || needle === '') {
				return false;
			}
			const haystack = cell.text;
			switch (rule.operator ?? 'containsText') {
				case 'containsText': return haystack.includes(needle);
				case 'notContains': return !haystack.includes(needle);
				case 'beginsWith': return haystack.startsWith(needle);
				case 'endsWith': return haystack.endsWith(needle);
				default: return false;
			}
		}
		default:
			return false;
	}
}

interface ICfStats {
	readonly min: number;
	readonly max: number;
	readonly sum: number;
	readonly count: number;
	/** 降順に並べた数値。top10 の閾値算出に使う。 */
	readonly sortedDesc: readonly number[];
	/** 昇順に並べた数値。percentile の補間に使う(セルごとに作り直さない)。 */
	readonly sortedAsc: readonly number[];
}

function collectStats(cells: readonly IParadisLegacyCfCellValue[]): ICfStats {
	const numbers: number[] = [];
	let sum = 0;
	for (const cell of cells) {
		if (cell.num === undefined) {
			continue;
		}
		numbers.push(cell.num);
		sum += cell.num;
	}
	numbers.sort((a, b) => b - a);
	return {
		min: numbers.length ? numbers[numbers.length - 1] : 0,
		max: numbers.length ? numbers[0] : 0,
		sum,
		count: numbers.length,
		sortedDesc: numbers,
		sortedAsc: [...numbers].reverse(),
	};
}

/** cfvo(閾値定義)を実数へ。min/max/percent/percentile/num に対応する。 */
function resolveCfvo(entry: { readonly type?: string; readonly value?: unknown } | undefined, stats: ICfStats, fallback: number): number {
	if (!entry) {
		return fallback;
	}
	switch (entry.type) {
		case 'min':
		case 'autoMin':
			return stats.min;
		case 'max':
		case 'autoMax':
			return stats.max;
		case 'percent': {
			const percent = toNumber(entry.value) ?? 0;
			return stats.min + (stats.max - stats.min) * (percent / 100);
		}
		case 'percentile': {
			const percent = toNumber(entry.value) ?? 0;
			if (stats.sortedAsc.length === 0) {
				return fallback;
			}
			const ascending = stats.sortedAsc;
			const position = (ascending.length - 1) * (percent / 100);
			const lower = Math.floor(position);
			const upper = Math.ceil(position);
			if (lower === upper) {
				return ascending[lower];
			}
			return ascending[lower] + (ascending[upper] - ascending[lower]) * (position - lower);
		}
		case 'num':
			return toNumber(entry.value) ?? fallback;
		default:
			return toNumber(entry.value) ?? fallback;
	}
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) {
		return undefined;
	}
	const value = parseInt(match[1], 16);
	return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function mixColors(from: string, to: string, ratio: number): string | undefined {
	const a = parseHexColor(from);
	const b = parseHexColor(to);
	if (!a || !b) {
		return undefined;
	}
	const clamped = Math.max(0, Math.min(1, ratio));
	const channel = (x: number, y: number) => Math.round(x + (y - x) * clamped);
	const hex = (n: number) => n.toString(16).padStart(2, '0');
	return `#${hex(channel(a.r, b.r))}${hex(channel(a.g, b.g))}${hex(channel(a.b, b.b))}`;
}

/** ExcelJS のルール style(fill/font) を CSS へ。 */
function ruleStyleToCss(style: unknown, resolveColor: ParadisLegacyCfColorResolver): Record<string, string> {
	const css: Record<string, string> = {};
	if (!style || typeof style !== 'object') {
		return css;
	}
	const typed = style as {
		readonly fill?: { readonly fgColor?: unknown; readonly bgColor?: unknown; readonly pattern?: string };
		readonly font?: { readonly color?: unknown; readonly bold?: boolean; readonly italic?: boolean; readonly strike?: boolean; readonly underline?: unknown };
	};
	if (typed.fill) {
		// solid 塗りは fgColor が実際の背景色(ECMA-376)。
		const background = resolveColor(typed.fill.fgColor) ?? resolveColor(typed.fill.bgColor);
		if (background) {
			css.backgroundColor = background;
		}
	}
	if (typed.font) {
		const color = resolveColor(typed.font.color);
		if (color) {
			css.color = color;
		}
		if (typed.font.bold) {
			css.fontWeight = 'bold';
		}
		if (typed.font.italic) {
			css.fontStyle = 'italic';
		}
		const decorations: string[] = [];
		if (typed.font.strike) {
			decorations.push('line-through');
		}
		if (typed.font.underline) {
			decorations.push('underline');
		}
		if (decorations.length) {
			css.textDecoration = decorations.join(' ');
		}
	}
	return css;
}
/** ルールごとに1回だけ閾値・色を解いておき、セル評価では算術だけを行う。 */
type CompiledRule = (cell: IParadisLegacyCfCellValue) => Record<string, string> | undefined;

/** 2色/3色スケール。境界値と色はルール単位で確定するので、ここで解いて閉じ込める。 */
function compileColorScale(rule: ICfRule, stats: ICfStats, resolveColor: ParadisLegacyCfColorResolver): CompiledRule | undefined {
	const colors = (Array.isArray(rule.color) ? rule.color : []).map(color => resolveColor(color)).filter((color): color is string => !!color);
	if (colors.length < 2) {
		return undefined;
	}
	const cfvo = rule.cfvo ?? [];
	const low = resolveCfvo(cfvo[0], stats, stats.min);
	const high = resolveCfvo(cfvo[cfvo.length - 1], stats, stats.max);
	const span = high - low;
	if (!(span > 0)) {
		// 範囲に幅が無い(全部同値)ときは Excel も先頭色で塗る。
		return cell => cell.num === undefined ? undefined : { backgroundColor: colors[0] };
	}
	if (colors.length === 2) {
		return cell => {
			if (cell.num === undefined) {
				return undefined;
			}
			const mixed = mixColors(colors[0], colors[1], (cell.num - low) / span);
			return mixed ? { backgroundColor: mixed } : undefined;
		};
	}
	const mid = resolveCfvo(cfvo[1], stats, (low + high) / 2);
	const midRatio = Math.max(0, Math.min(1, (mid - low) / span));
	return cell => {
		if (cell.num === undefined) {
			return undefined;
		}
		const ratio = (cell.num - low) / span;
		const mixed = ratio <= midRatio
			? mixColors(colors[0], colors[1], midRatio > 0 ? ratio / midRatio : 0)
			: mixColors(colors[1], colors[2], midRatio < 1 ? (ratio - midRatio) / (1 - midRatio) : 1);
		return mixed ? { backgroundColor: mixed } : undefined;
	};
}

/** データバーは CSS グラデーションで表す。バー長 0 のセルは塗らない。 */
function compileDataBar(rule: ICfRule, stats: ICfStats, resolveColor: ParadisLegacyCfColorResolver): CompiledRule {
	const color = resolveColor(rule.color) ?? '#638ec6';
	const cfvo = rule.cfvo ?? [];
	const low = resolveCfvo(cfvo[0], stats, stats.min);
	const high = resolveCfvo(cfvo[cfvo.length - 1], stats, stats.max);
	const span = high - low;
	return cell => {
		if (cell.num === undefined) {
			return undefined;
		}
		const ratio = span > 0 ? Math.max(0, Math.min(1, (cell.num - low) / span)) : (cell.num > 0 ? 1 : 0);
		const percent = Math.round(ratio * 100);
		if (percent <= 0) {
			return undefined;
		}
		// セル背景をバーとして描く。文字は上に残るので値も読める。
		return {
			backgroundImage: `linear-gradient(to right, ${color} 0%, ${color} ${percent}%, transparent ${percent}%, transparent 100%)`,
			backgroundRepeat: 'no-repeat',
		};
	};
}

/** 上位/下位ルール。順位の閾値はルール単位で1回だけ求める。 */
function compileTop10(rule: ICfRule, stats: ICfStats, style: Record<string, string>): CompiledRule | undefined {
	if (stats.sortedDesc.length === 0 || Object.keys(style).length === 0) {
		return undefined;
	}
	const rank = Math.max(1, rule.rank ?? 10);
	const requested = rule.percent ? Math.floor(stats.sortedDesc.length * rank / 100) : rank;
	// 件数は必ず 1..件数 に収める(rank が範囲外でも黙って無効化させない)。
	const count = Math.max(1, Math.min(requested, stats.sortedDesc.length));
	const threshold = rule.bottom ? stats.sortedDesc[stats.sortedDesc.length - count] : stats.sortedDesc[count - 1];
	return cell => {
		if (cell.num === undefined) {
			return undefined;
		}
		// 同順位を取りこぼさないよう、境界値との比較で判定する。
		const hit = rule.bottom ? cell.num <= threshold : cell.num >= threshold;
		return hit ? style : undefined;
	};
}

function compileAboveAverage(rule: ICfRule, stats: ICfStats, style: Record<string, string>): CompiledRule | undefined {
	if (stats.count === 0 || Object.keys(style).length === 0) {
		return undefined;
	}
	const average = stats.sum / stats.count;
	return cell => {
		if (cell.num === undefined) {
			return undefined;
		}
		const hit = rule.aboveAverage === false ? cell.num < average : cell.num > average;
		return hit ? style : undefined;
	};
}

function compilePredicate(rule: ICfRule, style: Record<string, string>): CompiledRule | undefined {
	if (Object.keys(style).length === 0) {
		return undefined;
	}
	return cell => matchesPredicateRule(rule, cell) ? style : undefined;
}

/** ルールを1回だけ解いて評価関数にする。扱えないルールは undefined を返す。 */
function compileRule(rule: ICfRule, stats: ICfStats, resolveColor: ParadisLegacyCfColorResolver): CompiledRule | undefined {
	switch (rule.type) {
		case 'colorScale':
			return compileColorScale(rule, stats, resolveColor);
		case 'dataBar':
			return compileDataBar(rule, stats, resolveColor);
		case 'expression':
		case 'iconSet':
		case 'timePeriod':
			// 数式エンジン/アイコン画像が要るためこの層では扱わない。
			return undefined;
		case 'top10':
			return compileTop10(rule, stats, ruleStyleToCss(rule.style, resolveColor));
		case 'aboveAverage':
			return compileAboveAverage(rule, stats, ruleStyleToCss(rule.style, resolveColor));
		default:
			return compilePredicate(rule, ruleStyleToCss(rule.style, resolveColor));
	}
}

/** 優先度は小さいほど強い。未指定は最も弱いものとして扱う(既定値 0 だと最強になってしまう)。 */
function rulePriority(rule: ICfRule): number {
	return typeof rule.priority === 'number' ? rule.priority : Number.MAX_SAFE_INTEGER;
}

/**
 * シート内の全条件付き書式を評価し、"row,col" → 適用 CSS のマップを返す。
 * 優先度の強い順に見て、先に決まった CSS プロパティを弱いルールで上書きしない(Excel と同じ)。
 * stopIfTrue が付いたルールが一致したら、それより弱いルールは評価しない。
 */
export function evaluateLegacyConditionalFormatting(
	blocks: readonly IParadisLegacyCfBlock[] | undefined,
	values: readonly IParadisLegacyCfCellValue[],
	resolveColor: ParadisLegacyCfColorResolver,
): Map<string, Record<string, string>> {
	const result = new Map<string, Record<string, string>>();
	if (!blocks?.length || values.length === 0) {
		return result;
	}
	// 範囲判定のたびに全セルを舐めないよう、先に "row,col" で引けるようにしておく。
	const byPosition = new Map<string, IParadisLegacyCfCellValue>();
	for (const value of values) {
		byPosition.set(`${value.row},${value.col}`, value);
	}
	let budget = MAX_CF_CELLS;

	for (const block of blocks) {
		const ranges = parseConditionalFormatRef(block.ref);
		if (ranges.length === 0 || !block.rules?.length) {
			continue;
		}
		// 範囲に属するセルだけを集め、統計もルールの閾値もこの単位で1回だけ解く。
		const scoped: IParadisLegacyCfCellValue[] = [];
		const seen = new Set<string>();
		for (const range of ranges) {
			for (let row = range.minR; row <= range.maxR; row++) {
				for (let col = range.minC; col <= range.maxC; col++) {
					const key = `${row},${col}`;
					if (seen.has(key)) {
						continue;
					}
					seen.add(key);
					const value = byPosition.get(key);
					if (value) {
						scoped.push(value);
					}
				}
			}
		}
		if (scoped.length === 0) {
			continue;
		}
		const stats = collectStats(scoped);
		const compiled = [...block.rules]
			.sort((a, b) => rulePriority(a) - rulePriority(b))
			.map(rule => ({ stopIfTrue: rule.stopIfTrue === true, evaluate: compileRule(rule, stats, resolveColor) }))
			.filter((entry): entry is { stopIfTrue: boolean; evaluate: CompiledRule } => !!entry.evaluate);
		if (compiled.length === 0) {
			continue;
		}

		for (const cell of scoped) {
			if (budget <= 0) {
				return result;
			}
			budget--;
			const key = `${cell.row},${cell.col}`;
			let merged: Record<string, string> | undefined;
			for (const { stopIfTrue, evaluate } of compiled) {
				const css = evaluate(cell);
				if (!css) {
					continue;
				}
				merged ??= {};
				// 強いルールが先に来るので、既に決まったプロパティは上書きしない。
				for (const [property, value] of Object.entries(css)) {
					merged[property] ??= value;
				}
				if (stopIfTrue) {
					break;
				}
			}
			if (merged) {
				result.set(key, { ...(result.get(key) ?? {}), ...merged });
			}
		}
	}
	return result;
}
