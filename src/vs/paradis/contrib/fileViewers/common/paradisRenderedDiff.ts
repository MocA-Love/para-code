/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// .md・.html の「プレビュー差分」（描いた見た目どうしの差分）の突き合わせ。DOM も marked の拡張も使わない純関数で、
// 単体の差分エディタ（Markdown・HTML）とモバイルへ送る差分の HTML を作る側の両方から使う。
//
// 2 段で比べる:
// 1. 並びの突き合わせ（`alignParadisRenderedItems`）。文書の一番上のブロック（Markdown のトークン、HTML の要素）や、
//    リストの項目・表の行とセルを、種類と鍵の並びとして受け取る。鍵の等しいものを本家の LCS で対応させ、
//    対応の取れなかった隙間の中だけで「種類が同じで文字が近い」ものを「変更」の組にする（Word の差分の
//    paradisWordTreeAlign と同じ考え方）。返すのは表示の順に並んだ行で、左右の高さ合わせ・1 列の表示・↑↓ の件数を
//    どれもここから作れる。
// 2. 文字の差分（`diffParadisRenderedText`）。「変更」の組の中身を、語（日本語は Intl.Segmenter）か行の単位で比べ、
//    元の文字列の中の位置付きの区間を返す。印は呼び出し側が消毒の後の DOM に付ける（HTML の文字列は返さない）。
//
// どちらも計算量に上限があり、超えたら細かく比べずに「削除＋追加」や「全体を置き換え」に落とす（結果は粗くなるが、
// 間違った対応は出さない）。文書が大きすぎるときにプレビュー差分そのものをやめる判定もここに置く
// （`isParadisRenderedDiffTooLarge`）。

import { CancellationError } from '../../../../base/common/errors.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { safeIntl } from '../../../../base/common/date.js';
import type { ISequence } from '../../../../base/common/diff/diff.js';
import type * as marked from '../../../../base/common/marked/marked.js';
import { paradisLcsPairs } from './paradisSpreadsheetRowAlign.js';

/** 突き合わせる 1 件（ブロック・項目・行・セル）。 */
export interface IParadisRenderedDiffItem {
	/** 種類（Markdown のトークンの種類、HTML のタグ名など）。種類の違うものは「変更」の組にしない。 */
	readonly kind: string;
	/** 同じものかを決める鍵。鍵が等しければ変わっていない。 */
	readonly key: string;
	/** 近さを測る文字（省略すると `key`）。描いた後の文字を渡すと、記法だけの違いに引きずられない。 */
	readonly text?: string;
}

/** 突き合わせの 1 行の種類。 */
export type ParadisRenderedDiffRowKind = 'equal' | 'changed' | 'added' | 'removed';

/**
 * 突き合わせの 1 行。`original`・`modified` は渡した並びの添字。`equal`・`changed` は両方、`removed` は
 * `original` だけ、`added` は `modified` だけを持つ。行は表示の順（両側の添字はどちらも昇順）に並ぶ。
 */
export interface IParadisRenderedDiffRow {
	readonly kind: ParadisRenderedDiffRowKind;
	readonly original?: number;
	readonly modified?: number;
}

export interface IParadisRenderedDiffAlignOptions {
	readonly token?: CancellationToken;
	/**
	 * 1 つの隙間の中で近さを測る組の数（隙間の両側の件数の積）の上限。超えた隙間は組を作らず、削除と追加にする。
	 * 既定は {@link PARADIS_RENDERED_DIFF_LIMITS}。
	 */
	readonly maxCandidatePairs?: number;
	/** 「変更」の組にする近さ（0〜1）の下限。既定は 0.5。 */
	readonly minSimilarity?: number;
}

/** 文字の差分の 1 区間。位置は元の文字列（UTF-16 の位置）の中の範囲。 */
export interface IParadisRenderedTextSegment {
	readonly kind: 'equal' | 'removed' | 'added';
	readonly text: string;
	readonly originalStart: number;
	readonly originalLength: number;
	readonly modifiedStart: number;
	readonly modifiedLength: number;
}

/** 文字の差分の単位。`word` は語（空白と記号も 1 区間）、`line` は行（改行を行の末尾に含める）。 */
export type ParadisRenderedTextGranularity = 'word' | 'line';

export interface IParadisRenderedTextDiffOptions {
	readonly token?: CancellationToken;
	/** 片側の単位（語・行）の数の上限。超えたら細かく比べず、全体を削除＋追加にする。既定は {@link PARADIS_RENDERED_DIFF_LIMITS}。 */
	readonly maxUnits?: number;
}

/** プレビュー差分の上限。 */
export const PARADIS_RENDERED_DIFF_LIMITS = Object.freeze({
	/** 片側の文書の文字数。超えたらプレビュー差分を出さず、テキスト差分のままにする。 */
	maxDocumentLength: 1_000_000,
	/** 片側の一番上のブロックの数。超えたらプレビュー差分を出さない。 */
	maxBlocks: 5_000,
	/** 1 つの隙間で近さを測る組の数。 */
	maxCandidatePairs: 2_500,
	/** 文字の差分の片側の単位の数。 */
	maxUnits: 20_000,
	/** 近さを測るときに見る先頭の文字数。 */
	similarityPrefixLength: 4_000,
});

/** プレビュー差分を出すには大きすぎるか（片側でも上限を超えたら `true`）。ブロックの数は分かっていれば渡す。 */
export function isParadisRenderedDiffTooLarge(original: { readonly length: number; readonly blocks?: number }, modified: { readonly length: number; readonly blocks?: number }): boolean {
	const over = (side: { readonly length: number; readonly blocks?: number }) => side.length > PARADIS_RENDERED_DIFF_LIMITS.maxDocumentLength
		|| (side.blocks ?? 0) > PARADIS_RENDERED_DIFF_LIMITS.maxBlocks;
	return over(original) || over(modified);
}

/** 文字列の並び（LcsDiff はハッシュが一致した後に文字列そのものも比べる）。 */
class ParadisRenderedStringSequence implements ISequence {
	constructor(private readonly _items: readonly string[]) { }
	getElements(): string[] {
		return this._items as string[];
	}
}

function lcsPairs(original: readonly string[], modified: readonly string[], token: CancellationToken | undefined) {
	return paradisLcsPairs(new ParadisRenderedStringSequence(original), new ParadisRenderedStringSequence(modified), original.length, modified.length, token ? () => {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
	} : undefined);
}

/**
 * 2 つの並びを突き合わせ、表示の順の行を返す。鍵の等しいものは `equal`、対応の取れなかった隙間の中で種類が同じで
 * 文字の近いものは `changed`、残りは `removed`・`added`。隙間の中では、削除・追加は対応する組より前に並ぶ。
 * 取り消されたら `CancellationError` を投げる。
 */
export function alignParadisRenderedItems(original: readonly IParadisRenderedDiffItem[], modified: readonly IParadisRenderedDiffItem[], options: IParadisRenderedDiffAlignOptions = {}): readonly IParadisRenderedDiffRow[] {
	// 種類も鍵に含める（同じ文字の段落と見出しは別のもの）。
	const pairs = lcsPairs(original.map(itemKey), modified.map(itemKey), options.token);
	const rows: IParadisRenderedDiffRow[] = [];
	let o = 0;
	let m = 0;
	for (const pair of [...pairs, { o: original.length, m: modified.length }]) {
		if (pair.o > o || pair.m > m) {
			appendGap(rows, original, modified, o, pair.o, m, pair.m, options);
		}
		if (pair.o < original.length) {
			rows.push({ kind: 'equal', original: pair.o, modified: pair.m });
		}
		o = pair.o + 1;
		m = pair.m + 1;
	}
	return rows;
}

function itemKey(item: IParadisRenderedDiffItem): string {
	return `${item.kind}\u0000${item.key}`;
}

/** 隙間（original の [oStart, oEnd)・modified の [mStart, mEnd)）の行を足す。 */
function appendGap(
	rows: IParadisRenderedDiffRow[], original: readonly IParadisRenderedDiffItem[], modified: readonly IParadisRenderedDiffItem[],
	oStart: number, oEnd: number, mStart: number, mEnd: number, options: IParadisRenderedDiffAlignOptions,
): void {
	const matches = matchGap(original, modified, oStart, oEnd, mStart, mEnd, options);
	let o = oStart;
	let m = mStart;
	for (const match of [...matches, { o: oEnd, m: mEnd }]) {
		while (o < match.o) {
			rows.push({ kind: 'removed', original: o++ });
		}
		while (m < match.m) {
			rows.push({ kind: 'added', modified: m++ });
		}
		if (match.o < oEnd) {
			rows.push({ kind: 'changed', original: match.o, modified: match.m });
		}
		o = match.o + 1;
		m = match.m + 1;
	}
}

/**
 * 隙間の中で「変更」の組を選ぶ。組は交差させない（左右に並べたとき順が入れ替わらない）。近さの合計が最大に
 * なる組を、隙間の大きさの積に比例する時間で求める。両側に 1 件ずつしかないときは、種類が同じなら近さを問わず組にする。
 */
function matchGap(
	original: readonly IParadisRenderedDiffItem[], modified: readonly IParadisRenderedDiffItem[],
	oStart: number, oEnd: number, mStart: number, mEnd: number, options: IParadisRenderedDiffAlignOptions,
): readonly { readonly o: number; readonly m: number }[] {
	const n = oEnd - oStart;
	const k = mEnd - mStart;
	if (n === 0 || k === 0) {
		return [];
	}
	if (n === 1 && k === 1) {
		return original[oStart].kind === modified[mStart].kind ? [{ o: oStart, m: mStart }] : [];
	}
	if (n * k > (options.maxCandidatePairs ?? PARADIS_RENDERED_DIFF_LIMITS.maxCandidatePairs)) {
		return [];
	}
	const minSimilarity = options.minSimilarity ?? 0.5;
	const originalGrams = original.slice(oStart, oEnd).map(item => bigrams(item.text ?? item.key));
	const modifiedGrams = modified.slice(mStart, mEnd).map(item => bigrams(item.text ?? item.key));
	// score[i][j]: original の先頭 i 件と modified の先頭 j 件で作れる組の近さの合計の最大。
	const score: Float64Array[] = [];
	const take: Uint8Array[] = [];
	for (let i = 0; i <= n; i++) {
		score.push(new Float64Array(k + 1));
		take.push(new Uint8Array(k + 1));
	}
	for (let i = 1; i <= n; i++) {
		if (options.token?.isCancellationRequested) {
			throw new CancellationError();
		}
		for (let j = 1; j <= k; j++) {
			let best = score[i - 1][j];
			let choice = 1; // original の i 件目を組にしない
			if (score[i][j - 1] > best) {
				best = score[i][j - 1];
				choice = 2; // modified の j 件目を組にしない
			}
			if (original[oStart + i - 1].kind === modified[mStart + j - 1].kind) {
				const similarity = diceSimilarity(originalGrams[i - 1], modifiedGrams[j - 1]);
				if (similarity >= minSimilarity && score[i - 1][j - 1] + similarity > best) {
					best = score[i - 1][j - 1] + similarity;
					choice = 3; // 組にする
				}
			}
			score[i][j] = best;
			take[i][j] = choice;
		}
	}
	const matches: { o: number; m: number }[] = [];
	for (let i = n, j = k; i > 0 && j > 0;) {
		const choice = take[i][j];
		if (choice === 3) {
			matches.push({ o: oStart + i - 1, m: mStart + j - 1 });
			i--;
			j--;
		} else if (choice === 1) {
			i--;
		} else {
			j--;
		}
	}
	return matches.reverse();
}

/** 文字の 2 文字ずつの組の数（空白の並びは 1 つにまとめる）。先頭の一定の文字数だけを見る。 */
function bigrams(value: string): Map<string, number> {
	const text = value.slice(0, PARADIS_RENDERED_DIFF_LIMITS.similarityPrefixLength).replace(/\s+/g, ' ').trim();
	const grams = new Map<string, number>();
	if (text.length === 1) {
		grams.set(text, 1);
	}
	for (let i = 0; i + 1 < text.length; i++) {
		const gram = text.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return grams;
}

/** Dice 係数（共通の組の数 × 2 ÷ 両方の組の数の和）。両方とも空なら 1。 */
function diceSimilarity(a: Map<string, number>, b: Map<string, number>): number {
	let total = 0;
	let common = 0;
	for (const count of a.values()) {
		total += count;
	}
	for (const [gram, count] of b) {
		total += count;
		common += Math.min(count, a.get(gram) ?? 0);
	}
	return total === 0 ? 1 : 2 * common / total;
}

const wordSegmenter = safeIntl.Segmenter(undefined, { granularity: 'word' });

/** 語（Intl.Segmenter の区切り。空白・記号も 1 区間）か行に分ける。つなげると元の文字列に戻る。 */
function splitUnits(value: string, granularity: ParadisRenderedTextGranularity): string[] {
	if (value.length === 0) {
		return [];
	}
	if (granularity === 'line') {
		return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	}
	const units: string[] = [];
	for (const { segment } of wordSegmenter.value.segment(value)) {
		units.push(segment);
	}
	return units;
}

/**
 * 2 つの文字列を語か行の単位で比べ、区間を前から順に返す。隣り合う同じ種類の区間はまとめる（削除は追加より前）。
 * 片側の単位の数が上限を超えたら、細かく比べずに全体を削除＋追加にする。取り消されたら `CancellationError` を投げる。
 */
export function diffParadisRenderedText(original: string, modified: string, granularity: ParadisRenderedTextGranularity = 'word', options: IParadisRenderedTextDiffOptions = {}): readonly IParadisRenderedTextSegment[] {
	if (original === modified) {
		return original.length === 0 ? [] : [{ kind: 'equal', text: original, originalStart: 0, originalLength: original.length, modifiedStart: 0, modifiedLength: modified.length }];
	}
	const originalUnits = splitUnits(original, granularity);
	const modifiedUnits = splitUnits(modified, granularity);
	const maxUnits = options.maxUnits ?? PARADIS_RENDERED_DIFF_LIMITS.maxUnits;
	const segments: IParadisRenderedTextSegment[] = [];
	const push = (kind: IParadisRenderedTextSegment['kind'], originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number) => {
		const text = kind === 'added' ? modified.slice(modifiedStart, modifiedEnd) : original.slice(originalStart, originalEnd);
		if (text.length === 0) {
			return;
		}
		const last = segments[segments.length - 1];
		if (last && last.kind === kind) {
			segments[segments.length - 1] = {
				kind, text: last.text + text,
				originalStart: last.originalStart, originalLength: originalEnd - last.originalStart,
				modifiedStart: last.modifiedStart, modifiedLength: modifiedEnd - last.modifiedStart,
			};
			return;
		}
		segments.push({ kind, text, originalStart, originalLength: originalEnd - originalStart, modifiedStart, modifiedLength: modifiedEnd - modifiedStart });
	};
	if (originalUnits.length > maxUnits || modifiedUnits.length > maxUnits) {
		push('removed', 0, original.length, 0, 0);
		push('added', original.length, original.length, 0, modified.length);
		return segments;
	}
	const originalOffsets = offsets(originalUnits);
	const modifiedOffsets = offsets(modifiedUnits);
	const pairs = lcsPairs(originalUnits, modifiedUnits, options.token);
	let o = 0;
	let m = 0;
	for (const pair of [...pairs, { o: originalUnits.length, m: modifiedUnits.length }]) {
		const oAt = originalOffsets[o];
		const mAt = modifiedOffsets[m];
		push('removed', oAt, originalOffsets[pair.o], mAt, mAt);
		push('added', originalOffsets[pair.o], originalOffsets[pair.o], mAt, modifiedOffsets[pair.m]);
		if (pair.o < originalUnits.length) {
			push('equal', originalOffsets[pair.o], originalOffsets[pair.o + 1], modifiedOffsets[pair.m], modifiedOffsets[pair.m + 1]);
		}
		o = pair.o + 1;
		m = pair.m + 1;
	}
	return segments;
}

/** 各単位の始まりの位置（末尾に全体の長さを足す）。 */
function offsets(units: readonly string[]): number[] {
	const result = [0];
	for (const unit of units) {
		result.push(result[result.length - 1] + unit.length);
	}
	return result;
}

/** Markdown の一番上のブロック 1 件（{@link paradisMarkdownRenderedDiffItems} の結果）。 */
export interface IParadisMarkdownRenderedDiffItem extends IParadisRenderedDiffItem {
	/** marked の lexer が返した並びの中の位置（描くときにトークンを引く）。 */
	readonly tokenIndex: number;
}

/**
 * marked の lexer の結果の一番上のトークンを、突き合わせの並びにする。空行（`space`）は捨て、鍵は書いたままの文字
 * （`raw`）の前後の空白を落としたもの。種類はトークンの種類で、` ```mermaid ` のコードだけ `mermaid` にする（図は
 * 図どうしで比べる）。
 *
 * 参照リンクの定義（`[a]: https://…`）は lexer がトークンにせず `links` に集めるので、定義だけを書き換えると
 * 使う側の段落の `raw` は変わらない。段落が使っている定義の行き先を鍵に足して、その段落を「変更」にする。
 */
export function paradisMarkdownRenderedDiffItems(tokens: readonly marked.Token[], links?: marked.Links): readonly IParadisMarkdownRenderedDiffItem[] {
	const items: IParadisMarkdownRenderedDiffItem[] = [];
	tokens.forEach((token, tokenIndex) => {
		if (token.type === 'space') {
			return;
		}
		const raw = token.raw.trim();
		const kind = token.type === 'code' && (token as marked.Tokens.Code).lang?.trim().toLowerCase() === 'mermaid' ? 'mermaid' : token.type;
		items.push({ kind, key: raw + referencedLinks(raw, links), tokenIndex });
	});
	return items;
}

/** `raw` が使っていそうな参照リンクの定義（ラベル → 行き先・題）を、鍵に足す形で返す。 */
function referencedLinks(raw: string, links: marked.Links | undefined): string {
	if (!links || !raw.includes('[')) {
		return '';
	}
	const used = new Set<string>();
	for (const match of raw.matchAll(/\[([^\[\]]+)\]/g)) {
		// marked と同じ正規化（空白の並びを 1 つに、小文字に）。
		const label = match[1].replace(/\s+/g, ' ').toLowerCase();
		const link = Object.prototype.hasOwnProperty.call(links, label) ? links[label] : undefined;
		if (link) {
			used.add(`\u0000${label}=${link.href ?? ''} ${link.title ?? ''}`);
		}
	}
	return [...used].sort().join('');
}
