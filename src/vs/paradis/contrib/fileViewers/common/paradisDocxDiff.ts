/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)差分の比較アルゴリズム本体。DOM にも docx-preview にも依存しない純 TS なので
// ユニットテストできる（test/common/paradisDocxDiff.test.ts）。
//
// 3段構えで対応付ける:
//   1. ブロック整列 … `vs/base` の LcsDiff で、指紋(docxBlockKey)が完全一致する段落を「不変」として固定する
//   2. 変更領域の再マッチング … 1で「両側に中身がある」と判定された区間だけ、類似度による
//      順序保存アライメント(DP)を掛ける。ここが Excel 差分の「行は位置ペアリングのみ」という
//      既知の弱点を繰り返さないための肝で、段落が1つ挿入されただけで以降が全部ズレるのを防ぐ。
//   3. 移動検出 … 1・2で対応が付かなかった削除/追加のうち、正規化テキストが完全一致し、かつ
//      両側で一意なものを「移動」として結び直す。
//
// 段落内は LcsDiff による文字差分 + 不変部分の書式比較。
//
// なぜ `vs/editor` の MyersDiffAlgorithm ではなく `vs/base` の LcsDiff なのか:
// MyersDiffAlgorithm の ISequence は `getElement(i): number` しか持たず、要素の同一性を
// **ハッシュの数値比較だけ**で判定する。段落キーのハッシュが衝突すると「別の段落が同じ段落」と
// 誤判定され、以降の対応付けが丸ごと壊れる。LcsDiff は getElements() が string[] を返すと
// ハッシュ一致後に**実文字列を再比較**するので、この誤マッチが起きない。
//
// なぜ Excel 差分の computeCharDiff を流用しないのか:
// あれは (n+1)×(m+1) の Uint32Array を実体で確保する O(n·m) メモリ実装で、セル(数十文字)だから
// 成立している。2,000字の段落同士だと1段落あたり十数MBを確保して破綻する。LcsDiff は
// 分割統治 + 履歴配列なので同じ結果をはるかに安いメモリで得られる。

import { IDiffChange, ISequence, LcsDiff, StringDiffSequence } from '../../../../base/common/diff/diff.js';
import {
	IParadisDocxAnnotation,
	IParadisDocxBlock,
	IParadisDocxChange,
	IParadisDocxDiffResult,
	IParadisDocxFiller,
	IParadisDocxFormatChange,
	IParadisDocxOutline,
	IParadisDocxRun,
	IParadisDocxSegment,
	PARADIS_DOCX_ALIGN_CELL_BUDGET,
	PARADIS_DOCX_EXCERPT_LIMIT,
	PARADIS_DOCX_FILLER_TEXT_LIMIT,
	PARADIS_DOCX_LIST_KEY,
	PARADIS_DOCX_MAX_CHAR_DIFF_LENGTH,
	PARADIS_DOCX_MOVE_MIN_LENGTH,
	PARADIS_DOCX_PARAGRAPH_STYLE_KEY,
	PARADIS_DOCX_SIMILARITY_THRESHOLD,
	ParadisDocxChangeStatus,
	ParadisDocxDegradeReason,
	ParadisDocxSegmentType,
	ParadisDocxSide,
	docxBlockKey,
	normalizeDocxText,
} from './paradisDocx.js';

// The semantic Story/package diff is the forward path. Keep this legacy module as the stable
// import surface while the existing outline renderer continues to consume buildDocxDiff below.
export {
	compareWordSemantics,
	diffParadisWordSemantics,
	type ParadisWordPackageFact,
	type ParadisWordSemanticDiffOptions,
	type ParadisWordSemanticDiffPage,
	type ParadisWordSemanticSnapshot,
} from './word/paradisWordSemanticDiff.js';
export {
	alignParadisWordDocuments,
	diffParadisWordGraphemes,
	type ParadisWordDocumentAlignment,
	type ParadisWordTreeAlignOptions,
} from './word/paradisWordTreeAlign.js';

/** 対応付けの結果1件。 */
interface IAlignOp {
	/** 'matched' は「同じ段落」とみなしたペア。中身が違えば後段で modified になる。 */
	readonly kind: 'matched' | 'removed' | 'added';
	readonly o?: number;
	readonly m?: number;
}

/** ブロック指紋の並び。LcsDiff に食わせる。 */
class DocxBlockSequence implements ISequence {

	constructor(private readonly _keys: readonly string[]) { }

	getElements(): string[] {
		// string[] を返すとハッシュ一致後に実文字列で再検証されるため、衝突による誤マッチが起きない。
		return this._keys as string[];
	}
}

// ── 類似度 ──────────────────────────────────────────────────────────────
//
// 変更領域内の対応付けは p×q ペアぶんの類似度を必要とするので、精度と費用を切り替える。
//
//   小さい領域 + 短い段落 … LCS 比（正確）
//   それ以外            … 文字バイグラムの Dice 係数（1ペア O(n+m) の近似）
//
// バイグラムだけにしないのは、短い段落で精度が足りないため。「第1章」→「第2章」は
// バイグラムが1つも共有されず類似度 0 になり、見出しの小さな修正が「削除+追加」に化ける。
// LCS 比なら 0.67 で正しく「変更」として結ばれる。
//
// 逆に、LCS 比だけにもできない。1セルあたり O(n·m) なので、長い段落 × 多数のセルで
// 現実的な時間に収まらなくなる。**どちらの経路も常に使える状態にしておくこと**（片方しか
// 用意しないと、条件から外れた組み合わせで類似度が 0 に落ち、対応付けが丸ごと壊れる）。

/** LCS 比を正確に測る対象とする、正規化テキストの最大長。 */
const EXACT_SIMILARITY_MAX_LENGTH = 40;
/** LCS 比を使う変更領域の最大セル数（原文数 × 新文数）。 */
const EXACT_SIMILARITY_CELL_BUDGET = 4_000;
/**
 * 類似度の計算に使う正規化テキストの最大長。これを超える段落は先頭だけを見る。
 * 打ち切っても害が無いのは、類似度は「対応付けるかどうか」の判定にしか使わず、
 * 実際の差分は対応付けたあとに全文で取り直すため。上限が無いと、長い段落が多数ある
 * 変更領域で Dice の1セルあたりの費用が青天井になり、数秒〜数十秒固まる。
 */
const SIMILARITY_TEXT_LIMIT = 2_000;

/** 2文字列の最長共通部分列の長さ。2行だけ持つ DP なのでメモリは O(min(n, m))。 */
function lcsLength(a: string, b: string): number {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) {
		return 0;
	}
	let previous = new Uint16Array(m + 1);
	let current = new Uint16Array(m + 1);
	for (let i = 1; i <= n; i++) {
		const head = a[i - 1];
		for (let j = 1; j <= m; j++) {
			current[j] = head === b[j - 1]
				? previous[j - 1] + 1
				: Math.max(previous[j], current[j - 1]);
		}
		const swap = previous;
		previous = current;
		current = swap;
		current.fill(0);
	}
	return previous[m];
}

/** 類似度の計算のために段落1つぶんを前処理したもの。バイグラムは常に用意しておく。 */
interface ISimilarityText {
	/** 上限で切り詰めた正規化テキスト。 */
	readonly text: string;
	readonly grams: Map<string, number>;
	/** バイグラムの総数（= text.length - 1）。セルごとに数え直さないよう持っておく。 */
	readonly total: number;
}

function buildSimilarityText(raw: string): ISimilarityText {
	const text = raw.length > SIMILARITY_TEXT_LIMIT ? raw.substring(0, SIMILARITY_TEXT_LIMIT) : raw;
	const grams = new Map<string, number>();
	for (let i = 0; i + 1 < text.length; i++) {
		const gram = text.substring(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return { text, grams, total: Math.max(0, text.length - 1) };
}

/** バイグラムの Dice 係数。0(全く違う)〜1(同一)。 */
function diceSimilarity(a: ISimilarityText, b: ISimilarityText): number {
	if (a.total === 0 || b.total === 0) {
		return a.text === b.text ? 1 : 0;
	}
	let shared = 0;
	// 小さい方を回すと走査量が減る。
	const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
	for (const [gram, count] of small) {
		const other = large.get(gram);
		if (other !== undefined) {
			shared += Math.min(count, other);
		}
	}
	return (2 * shared) / (a.total + b.total);
}

/**
 * 2つの正規化テキストの類似度。短くて領域も小さければ LCS 比で正確に、
 * それ以外はバイグラムの Dice 係数で近似する。**どの入力でも必ずどちらかが使われる**。
 */
function textSimilarity(a: ISimilarityText, b: ISimilarityText, exact: boolean): number {
	if (a.text === b.text) {
		return 1;
	}
	if (a.text.length === 0 || b.text.length === 0) {
		return 0;
	}
	if (exact && a.text.length <= EXACT_SIMILARITY_MAX_LENGTH && b.text.length <= EXACT_SIMILARITY_MAX_LENGTH) {
		return (2 * lcsLength(a.text, b.text)) / (a.text.length + b.text.length);
	}
	return diceSimilarity(a, b);
}

// ── 単語境界へのスナップ ────────────────────────────────────────────────

/**
 * ラテン文字・数字だけを「単語の一部」とみなす。
 * CJK を含めないのは、日本語では1文字単位の差分の方が読みやすく、単語へ広げると
 * 文全体が変更扱いになってしまうため。
 */
function isWordChar(ch: string | undefined): boolean {
	if (!ch) {
		return false;
	}
	const code = ch.charCodeAt(0);
	if (code >= 0x30 && code <= 0x39) { return true; }
	if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) { return true; }
	// ラテン補助・拡張A/B（アクセント付き文字）
	if (code >= 0x00c0 && code <= 0x024f) { return true; }
	return false;
}

/**
 * UTF-16 のサロゲート上位かどうか。
 * LcsDiff は文字列を**コードユニット単位**で比べるため、変更の境界がサロゲートペアの
 * 内側に落ちることがある。そのまま run を切ると絵文字や SIP 漢字（𠮟 等）が
 * 片割れだけの不正な文字列になり、実際に文字化けして表示される。
 */
function isHighSurrogate(ch: string | undefined): boolean {
	if (!ch) {
		return false;
	}
	const code = ch.charCodeAt(0);
	return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 文字単位の差分を単語境界まで広げる。"colour"→"color" が「単語まるごとの置き換え」に見えるようにする。
 *
 * 変更と変更の間（不変部分）は左右で必ず同一なので、左へ k 文字広げるときは両側とも同じ k だけ
 * 広げれば「不変部分の長さは左右で等しい」という不変条件が保たれる。
 * 空白だけの変更（"foo bar"→"foo  bar"）で両隣の単語まで巻き込まないよう、
 * **変更内容そのものの端が単語文字である側だけ**広げる。
 */
function snapToWordBoundaries(changes: readonly IDiffChange[], original: string, modified: string): IDiffChange[] {
	if (changes.length === 0) {
		return [];
	}
	const snapped: IDiffChange[] = [];
	for (let i = 0; i < changes.length; i++) {
		const change = changes[i];
		const originalEnd = change.originalStart + change.originalLength;
		const modifiedEnd = change.modifiedStart + change.modifiedLength;

		const previous = snapped[snapped.length - 1];
		const previousOriginalEnd = previous ? previous.originalStart + previous.originalLength : 0;
		const previousModifiedEnd = previous ? previous.modifiedStart + previous.modifiedLength : 0;
		const roomBefore = Math.min(change.originalStart - previousOriginalEnd, change.modifiedStart - previousModifiedEnd);

		const next = changes[i + 1];
		const roomAfter = Math.min(
			(next ? next.originalStart : original.length) - originalEnd,
			(next ? next.modifiedStart : modified.length) - modifiedEnd
		);

		const startsWithWord = isWordChar(original[change.originalStart]) || isWordChar(modified[change.modifiedStart]);
		const endsWithWord = isWordChar(original[originalEnd - 1]) || isWordChar(modified[modifiedEnd - 1]);

		let left = 0;
		if (startsWithWord) {
			while (left < roomBefore && isWordChar(original[change.originalStart - left - 1])) {
				left++;
			}
		}
		let right = 0;
		if (endsWithWord) {
			while (right < roomAfter && isWordChar(original[originalEnd + right])) {
				right++;
			}
		}

		// サロゲートペアの内側で切らない。境界の直前が上位サロゲートなら、その1つ手前まで戻す。
		// 変更と変更の間は左右で同じ文字列なので、両側に同じだけ足せば整合は保たれる。
		while (left < roomBefore && isHighSurrogate(original[change.originalStart - left - 1])) {
			left++;
		}
		while (right < roomAfter && isHighSurrogate(original[originalEnd + right - 1])) {
			right++;
		}

		const expanded: IDiffChange = {
			originalStart: change.originalStart - left,
			originalLength: change.originalLength + left + right,
			modifiedStart: change.modifiedStart - left,
			modifiedLength: change.modifiedLength + left + right,
		};

		// 広げた結果、直前の変更と接したら1つに畳む。
		if (previous && expanded.originalStart <= previousOriginalEnd && expanded.modifiedStart <= previousModifiedEnd) {
			const originalTail = Math.max(previousOriginalEnd, expanded.originalStart + expanded.originalLength);
			const modifiedTail = Math.max(previousModifiedEnd, expanded.modifiedStart + expanded.modifiedLength);
			snapped[snapped.length - 1] = {
				originalStart: previous.originalStart,
				originalLength: originalTail - previous.originalStart,
				modifiedStart: previous.modifiedStart,
				modifiedLength: modifiedTail - previous.modifiedStart,
			};
			continue;
		}
		snapped.push(expanded);
	}
	return snapped;
}

// ── run とオフセットの対応 ──────────────────────────────────────────────

/** runs の各先頭が block.text の何文字目から始まるか（末尾に全体長を1つ足した番兵つき）。 */
function runOffsets(runs: readonly IParadisDocxRun[]): number[] {
	const starts: number[] = new Array(runs.length + 1);
	let offset = 0;
	for (let i = 0; i < runs.length; i++) {
		starts[i] = offset;
		offset += runs[i].text.length;
	}
	starts[runs.length] = offset;
	return starts;
}

/** offset を含む run の添字。run が無い場合は 0 を返す（呼び出し側で undefined を許容すること）。 */
function runIndexAt(starts: readonly number[], runCount: number, offset: number): number {
	if (runCount === 0) {
		return 0;
	}
	let lo = 0;
	let hi = runCount - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

/**
 * block.text 上の範囲 `[start, end)` を run 単位のセグメントに割る。
 * テキストを持たない run（画像など）は途中で切らず、run 全体に印を付ける。
 */
function rangeToSegments(
	runs: readonly IParadisDocxRun[],
	starts: readonly number[],
	start: number,
	end: number,
	type: ParadisDocxSegmentType,
	format?: readonly IParadisDocxFormatChange[]
): IParadisDocxSegment[] {
	const segments: IParadisDocxSegment[] = [];
	if (end <= start || runs.length === 0) {
		return segments;
	}
	let i = runIndexAt(starts, runs.length, start);
	while (i < runs.length && starts[i] < end) {
		if (starts[i + 1] > start) {
			const run = runs[i];
			const whole = run.special !== undefined;
			const from = whole ? 0 : Math.max(0, start - starts[i]);
			const to = whole ? run.text.length : Math.min(run.text.length, end - starts[i]);
			if (to > from) {
				segments.push(format ? { run: i, start: from, end: to, type, format } : { run: i, start: from, end: to, type });
			}
		}
		i++;
	}
	return segments;
}

// ── 書式の比較 ──────────────────────────────────────────────────────────

/** 正規化キー(`k=v;k=v`)を辞書に戻す。 */
function parseFormatKey(key: string): Map<string, string> {
	const map = new Map<string, string>();
	if (!key) {
		return map;
	}
	for (const part of key.split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0) {
			map.set(part.substring(0, eq), part.substring(eq + 1));
		}
	}
	return map;
}

/** 2つの書式キーの差。同じなら空配列。 */
function compareFormatKeys(originalKey: string, modifiedKey: string): IParadisDocxFormatChange[] {
	if (originalKey === modifiedKey) {
		return [];
	}
	const original = parseFormatKey(originalKey);
	const modified = parseFormatKey(modifiedKey);
	const properties = new Set<string>([...original.keys(), ...modified.keys()]);
	const changes: IParadisDocxFormatChange[] = [];
	for (const property of [...properties].sort()) {
		const before = original.get(property);
		const after = modified.get(property);
		if (before !== after) {
			changes.push({ property, original: before, modified: after });
		}
	}
	return changes;
}

// ── 段落ペアの詳細比較 ──────────────────────────────────────────────────

interface IPairComparison {
	readonly status: ParadisDocxChangeStatus | undefined;
	readonly originalSegments: IParadisDocxSegment[];
	readonly modifiedSegments: IParadisDocxSegment[];
	readonly blockFormat: IParadisDocxFormatChange[];
	readonly degraded?: ParadisDocxDegradeReason;
}

const NO_CHANGE: IPairComparison = { status: undefined, originalSegments: [], modifiedSegments: [], blockFormat: [] };

/**
 * 段落自身の書式キー。CSS 由来の `fmt` に加えて、段落スタイル名とリスト種別も同じ土俵で比べる。
 * これらは docxBlockKey（対応付けの指紋）にも入っているので、ここで比べないと
 * 「対応は付いたのに変更として出てこない」段落ができてしまう。
 */
function blockFormatKeyOf(block: IParadisDocxBlock): string {
	const parts: string[] = [];
	if (block.fmt) {
		parts.push(block.fmt);
	}
	if (block.styleName) {
		parts.push(`${PARADIS_DOCX_PARAGRAPH_STYLE_KEY}=${block.styleName}`);
	}
	if (block.listKey) {
		parts.push(`${PARADIS_DOCX_LIST_KEY}=${block.listKey}`);
	}
	return parts.join(';');
}

/** 段落が含む図・画像の並び。差し替えの検出に使う。 */
function objectsKeyOf(block: IParadisDocxBlock): string {
	return block.objects?.length ? block.objects.join(',') : '';
}

/** 2つの段落の run 列が「テキストも書式も完全に同じ」か。よくある不変段落を早く弾くための判定。 */
function runsAreIdentical(original: readonly IParadisDocxRun[], modified: readonly IParadisDocxRun[]): boolean {
	if (original.length !== modified.length) {
		return false;
	}
	for (let i = 0; i < original.length; i++) {
		if (original[i].fmt !== modified[i].fmt || original[i].text !== modified[i].text) {
			return false;
		}
	}
	return true;
}

/**
 * 対応が付いた段落ペアを詳しく比べる。
 * テキストが同じでも書式だけ違えば 'formatChanged'、どちらも同じなら status は undefined。
 */
function comparePair(original: IParadisDocxBlock, modified: IParadisDocxBlock): IPairComparison {
	const blockFormat = compareFormatKeys(blockFormatKeyOf(original), blockFormatKeyOf(modified));
	// 図・画像は本文では U+FFFC 1文字にしか見えないので、文字差分では差し替えを検出できない。
	// 中身の同一性は objects の並びで別に比べる。
	const objectsChanged = objectsKeyOf(original) !== objectsKeyOf(modified);
	if (blockFormat.length === 0 && !objectsChanged && runsAreIdentical(original.runs, modified.runs)) {
		return NO_CHANGE;
	}

	const originalText = original.text;
	const modifiedText = modified.text;
	const originalStarts = runOffsets(original.runs);
	const modifiedStarts = runOffsets(modified.runs);
	const originalSegments: IParadisDocxSegment[] = [];
	const modifiedSegments: IParadisDocxSegment[] = [];
	let degraded: ParadisDocxDegradeReason | undefined;
	let textChanged = false;
	let formatChanged = blockFormat.length > 0;

	/**
	 * 左右で内容が一致する区間 `original[originalFrom, +length)` ⇔ `modified[modifiedFrom, +length)` を
	 * 1文字ずつ見て、書式が違う極大区間に印を付ける。文字が同じ位置同士を比べられるのは
	 * この区間だけなので、書式差分は必ずここで取る。
	 */
	const pushFormatSegments = (originalFrom: number, modifiedFrom: number, length: number): void => {
		const formatAt = (runs: readonly IParadisDocxRun[], starts: readonly number[], offset: number): string => {
			const run = runs[runIndexAt(starts, runs.length, offset)];
			return run ? run.fmt : '';
		};
		let i = 0;
		while (i < length) {
			const originalKey = formatAt(original.runs, originalStarts, originalFrom + i);
			const modifiedKey = formatAt(modified.runs, modifiedStarts, modifiedFrom + i);
			if (originalKey === modifiedKey) {
				i++;
				continue;
			}
			// 同じ書式ペアが続く限り伸ばす。
			let j = i + 1;
			while (j < length
				&& formatAt(original.runs, originalStarts, originalFrom + j) === originalKey
				&& formatAt(modified.runs, modifiedStarts, modifiedFrom + j) === modifiedKey) {
				j++;
			}
			const format = compareFormatKeys(originalKey, modifiedKey);
			if (format.length > 0) {
				formatChanged = true;
				originalSegments.push(...rangeToSegments(original.runs, originalStarts, originalFrom + i, originalFrom + j, 'format', format));
				modifiedSegments.push(...rangeToSegments(modified.runs, modifiedStarts, modifiedFrom + i, modifiedFrom + j, 'format', format));
			}
			i = j;
		}
	};

	/** 文字差分を諦めて、段落まるごとの置き換えとして扱う。 */
	const replaceWholeBlock = (): void => {
		textChanged = true;
		degraded = 'chars';
		originalSegments.push(...rangeToSegments(original.runs, originalStarts, 0, originalText.length, 'removed'));
		modifiedSegments.push(...rangeToSegments(modified.runs, modifiedStarts, 0, modifiedText.length, 'added'));
	};

	if (originalText === modifiedText) {
		// 文字は同一。全体が「不変の対応区間」なので、そのまま書式だけ比べる。
		pushFormatSegments(0, 0, originalText.length);
	} else if (originalText.length > PARADIS_DOCX_MAX_CHAR_DIFF_LENGTH || modifiedText.length > PARADIS_DOCX_MAX_CHAR_DIFF_LENGTH) {
		replaceWholeBlock();
	} else {
		const result = new LcsDiff(new StringDiffSequence(originalText), new StringDiffSequence(modifiedText)).ComputeDiff(true);
		if (result.quitEarly) {
			replaceWholeBlock();
		} else {
			const changes = snapToWordBoundaries(result.changes, originalText, modifiedText);
			let originalPos = 0;
			let modifiedPos = 0;
			for (const change of changes) {
				const unchanged = change.originalStart - originalPos;
				if (unchanged > 0) {
					pushFormatSegments(originalPos, modifiedPos, unchanged);
				}
				if (change.originalLength > 0) {
					textChanged = true;
					originalSegments.push(...rangeToSegments(original.runs, originalStarts, change.originalStart, change.originalStart + change.originalLength, 'removed'));
				}
				if (change.modifiedLength > 0) {
					textChanged = true;
					modifiedSegments.push(...rangeToSegments(modified.runs, modifiedStarts, change.modifiedStart, change.modifiedStart + change.modifiedLength, 'added'));
				}
				originalPos = change.originalStart + change.originalLength;
				modifiedPos = change.modifiedStart + change.modifiedLength;
			}
			const tail = originalText.length - originalPos;
			if (tail > 0) {
				pushFormatSegments(originalPos, modifiedPos, tail);
			}
		}
	}

	if (objectsChanged) {
		// 図が差し替わった場合、文字は同じままなので run 単位で印を付ける。
		textChanged = true;
		markObjectRuns(original.runs, originalStarts, originalSegments, 'removed');
		markObjectRuns(modified.runs, modifiedStarts, modifiedSegments, 'added');
	}

	const status: ParadisDocxChangeStatus | undefined = textChanged
		? 'modified'
		: (formatChanged ? 'formatChanged' : undefined);

	return { status, originalSegments, modifiedSegments, blockFormat, degraded };
}

/** 図・画像だけの run すべてに印を付ける（既に同じ印が付いている場合は足さない）。 */
function markObjectRuns(
	runs: readonly IParadisDocxRun[],
	starts: readonly number[],
	segments: IParadisDocxSegment[],
	type: ParadisDocxSegmentType
): void {
	for (let i = 0; i < runs.length; i++) {
		if (runs[i].special !== 'object') {
			continue;
		}
		if (segments.some(segment => segment.run === i && segment.type === type)) {
			continue;
		}
		segments.push(...rangeToSegments(runs, starts, starts[i], starts[i + 1], type));
	}
}

// ── 変更領域の再マッチング ──────────────────────────────────────────────

/**
 * LcsDiff が「両側に中身がある」とした区間を、類似度による順序保存アライメントで対応付ける。
 * 位置ペアリングだけだと段落が1つ挿入されただけで以降が全部ズレて「全部変更」に見えるため、
 * ここで内容の似ている段落同士を結ぶ。
 */
function alignRegion(
	originals: readonly IParadisDocxBlock[],
	modifieds: readonly IParadisDocxBlock[],
	originalStart: number,
	originalLength: number,
	modifiedStart: number,
	modifiedLength: number,
	degradeSink: Set<ParadisDocxDegradeReason>
): IAlignOp[] {
	const ops: IAlignOp[] = [];
	if (originalLength === 0 && modifiedLength === 0) {
		return ops;
	}
	if (originalLength === 0) {
		for (let j = 0; j < modifiedLength; j++) {
			ops.push({ kind: 'added', m: modifiedStart + j });
		}
		return ops;
	}
	if (modifiedLength === 0) {
		for (let i = 0; i < originalLength; i++) {
			ops.push({ kind: 'removed', o: originalStart + i });
		}
		return ops;
	}

	// 領域が小さいうちは LCS 比で正確に測る。大きくなったらバイグラムの近似に落とす。
	// どちらに転んでもバイグラムは用意しておくこと（長い段落は exact でも近似側を通るため）。
	const exact = originalLength * modifiedLength <= EXACT_SIMILARITY_CELL_BUDGET;

	const originalTexts: ISimilarityText[] = [];
	for (let i = 0; i < originalLength; i++) {
		originalTexts.push(buildSimilarityText(normalizeDocxText(originals[originalStart + i].text)));
	}
	const modifiedTexts: ISimilarityText[] = [];
	for (let j = 0; j < modifiedLength; j++) {
		modifiedTexts.push(buildSimilarityText(normalizeDocxText(modifieds[modifiedStart + j].text)));
	}

	const similarity = (i: number, j: number): number => {
		// 表の中と本文を跨いで対応付けない（深さが違えば別物）。
		if (originals[originalStart + i].depth !== modifieds[modifiedStart + j].depth) {
			return 0;
		}
		return textSimilarity(originalTexts[i], modifiedTexts[j], exact);
	};

	if (originalLength * modifiedLength > PARADIS_DOCX_ALIGN_CELL_BUDGET) {
		// DP を諦めて位置ペアリングに落とす。ただし似ていないものは無理に結ばない。
		degradeSink.add('align');
		const paired = Math.min(originalLength, modifiedLength);
		for (let k = 0; k < paired; k++) {
			if (similarity(k, k) >= PARADIS_DOCX_SIMILARITY_THRESHOLD) {
				ops.push({ kind: 'matched', o: originalStart + k, m: modifiedStart + k });
			} else {
				ops.push({ kind: 'removed', o: originalStart + k });
				ops.push({ kind: 'added', m: modifiedStart + k });
			}
		}
		for (let i = paired; i < originalLength; i++) {
			ops.push({ kind: 'removed', o: originalStart + i });
		}
		for (let j = paired; j < modifiedLength; j++) {
			ops.push({ kind: 'added', m: modifiedStart + j });
		}
		return ops;
	}

	// 順序を保つ最大スコアのアライメント（Needleman-Wunsch 型）。
	// 一致は類似度(>0)を加点、飛ばしは加点なし。閾値未満の対応は禁止する。
	const width = modifiedLength + 1;
	const score = new Float64Array((originalLength + 1) * width);
	// 1=一致, 2=旧を飛ばす, 3=新を飛ばす
	const trace = new Uint8Array((originalLength + 1) * width);
	for (let i = 1; i <= originalLength; i++) {
		for (let j = 1; j <= modifiedLength; j++) {
			const sim = similarity(i - 1, j - 1);
			// 閾値未満の対応は禁止。番兵は -Infinity にしておく（-1 だと「スコアは常に 0 以上」
			// という前提に寄りかかることになり、閾値を 0 にした瞬間に禁止が効かなくなる）。
			const matchScore = sim >= PARADIS_DOCX_SIMILARITY_THRESHOLD
				? score[(i - 1) * width + (j - 1)] + sim
				: Number.NEGATIVE_INFINITY;
			const skipOriginal = score[(i - 1) * width + j];
			const skipModified = score[i * width + (j - 1)];
			let best = skipOriginal;
			let direction = 2;
			// 同点なら「新を飛ばす」を採る。逆順に辿る traceback ではこれが、
			// 文書順で「削除 → 追加」（統一 diff と同じ並び）になる。
			if (skipModified >= best) {
				best = skipModified;
				direction = 3;
			}
			if (matchScore >= best) {
				best = matchScore;
				direction = 1;
			}
			score[i * width + j] = best;
			trace[i * width + j] = direction;
		}
	}

	const reversed: IAlignOp[] = [];
	let i = originalLength;
	let j = modifiedLength;
	while (i > 0 && j > 0) {
		switch (trace[i * width + j]) {
			case 1:
				reversed.push({ kind: 'matched', o: originalStart + i - 1, m: modifiedStart + j - 1 });
				i--;
				j--;
				break;
			case 3:
				reversed.push({ kind: 'added', m: modifiedStart + j - 1 });
				j--;
				break;
			default:
				reversed.push({ kind: 'removed', o: originalStart + i - 1 });
				i--;
				break;
		}
	}
	while (i > 0) {
		reversed.push({ kind: 'removed', o: originalStart + i - 1 });
		i--;
	}
	while (j > 0) {
		reversed.push({ kind: 'added', m: modifiedStart + j - 1 });
		j--;
	}
	reversed.reverse();
	ops.push(...reversed);
	return ops;
}

// ── 移動検出 ────────────────────────────────────────────────────────────

/**
 * 対応が付かなかった削除/追加のうち「同じ内容が別の場所へ動いただけ」のものを結び直す。
 *
 * 短い段落（「はい」等）が偶然一致して移動扱いになるのを防ぐため、
 * **正規化テキストが両側の未対応集合の中で一意**であることを条件にする。長さの下限も併用する。
 */
function detectMoves(ops: readonly IAlignOp[], originals: readonly IParadisDocxBlock[], modifieds: readonly IParadisDocxBlock[]): Map<number, number> {
	const removedByText = new Map<string, number[]>();
	const addedByText = new Map<string, number[]>();
	const record = (map: Map<string, number[]>, text: string, index: number): void => {
		if (text.length < PARADIS_DOCX_MOVE_MIN_LENGTH) {
			return;
		}
		const list = map.get(text);
		if (list) {
			list.push(index);
		} else {
			map.set(text, [index]);
		}
	};
	for (const op of ops) {
		if (op.kind === 'removed' && op.o !== undefined) {
			record(removedByText, normalizeDocxText(originals[op.o].text), op.o);
		} else if (op.kind === 'added' && op.m !== undefined) {
			record(addedByText, normalizeDocxText(modifieds[op.m].text), op.m);
		}
	}
	const moves = new Map<number, number>();
	for (const [text, removed] of removedByText) {
		const added = addedByText.get(text);
		if (removed.length === 1 && added?.length === 1) {
			moves.set(removed[0], added[0]);
		}
	}
	return moves;
}

// ── 本体 ────────────────────────────────────────────────────────────────

function excerpt(text: string): string {
	const normalized = normalizeDocxText(text);
	return normalized.length <= PARADIS_DOCX_EXCERPT_LIMIT ? normalized : `${normalized.substring(0, PARADIS_DOCX_EXCERPT_LIMIT)}...`;
}

function fillerText(text: string): string {
	const normalized = normalizeDocxText(text);
	return normalized.length <= PARADIS_DOCX_FILLER_TEXT_LIMIT ? normalized : `${normalized.substring(0, PARADIS_DOCX_FILLER_TEXT_LIMIT)}...`;
}

/**
 * 2つの文書概要を突き合わせ、注釈・ゴースト・変更一覧を返す。
 * 副作用なし・入力を変更しないので、そのままユニットテストできる。
 */
export function buildDocxDiff(original: IParadisDocxOutline, modified: IParadisDocxOutline): IParadisDocxDiffResult {
	const originals = original.blocks;
	const modifieds = modified.blocks;
	const degradeSink = new Set<ParadisDocxDegradeReason>();
	if (original.truncated || modified.truncated) {
		degradeSink.add('blocks');
	}

	// 第1段: 指紋の完全一致で「不変」の骨組みを固める。
	const lcsResult = new LcsDiff(
		new DocxBlockSequence(originals.map(docxBlockKey)),
		new DocxBlockSequence(modifieds.map(docxBlockKey))
	).ComputeDiff(true);
	if (lcsResult.quitEarly) {
		degradeSink.add('align');
	}

	const ops: IAlignOp[] = [];
	let o = 0;
	let m = 0;
	for (const change of lcsResult.changes) {
		while (o < change.originalStart) {
			ops.push({ kind: 'matched', o, m });
			o++;
			m++;
		}
		// 第2段: 変更領域だけ類似度で対応付け直す。
		ops.push(...alignRegion(originals, modifieds, change.originalStart, change.originalLength, change.modifiedStart, change.modifiedLength, degradeSink));
		o = change.originalStart + change.originalLength;
		m = change.modifiedStart + change.modifiedLength;
	}
	while (o < originals.length && m < modifieds.length) {
		ops.push({ kind: 'matched', o, m });
		o++;
		m++;
	}
	while (o < originals.length) {
		ops.push({ kind: 'removed', o });
		o++;
	}
	while (m < modifieds.length) {
		ops.push({ kind: 'added', m });
		m++;
	}

	// 第3段: 残った削除/追加から移動を拾う。
	const moves = detectMoves(ops, originals, modifieds);
	const movesReverse = new Map<number, number>();
	for (const [originalIndex, modifiedIndex] of moves) {
		movesReverse.set(modifiedIndex, originalIndex);
	}

	const annotations: IParadisDocxAnnotation[] = [];
	const fillers: IParadisDocxFiller[] = [];
	// 変更は文書内の並び順（= ops の並び）で Prev/Next したいので、採番とは別に順序を持たせる。
	const pending: { readonly order: number; readonly change: IParadisDocxChange }[] = [];
	// 移動は旧側と新側で別々の op として現れるため、先に現れた方で採番して共有する。
	const moveChangeIds = new Map<number, number>();
	let nextChangeId = 1;
	let lastOriginalIndex = -1;
	let lastModifiedIndex = -1;

	/** 表の中の段落にはゴーストを作らない（対応するセルが相手側に無いと表の構造を壊すため）。 */
	const pushFiller = (side: ParadisDocxSide, afterIndex: number, block: IParadisDocxBlock, kind: IParadisDocxFiller['kind'], changeId: number): void => {
		if (block.depth !== 0) {
			return;
		}
		fillers.push({ side, afterIndex, text: fillerText(block.text), kind, changeId });
	};

	/** 移動1件の変更 id。旧側・新側どちらから呼ばれても同じ id を返し、変更一覧には1度だけ積む。 */
	const moveChangeId = (originalOp: number, modifiedOp: number, order: number): number => {
		const existing = moveChangeIds.get(originalOp);
		if (existing !== undefined) {
			return existing;
		}
		const id = nextChangeId++;
		moveChangeIds.set(originalOp, id);
		pending.push({
			order,
			change: {
				id,
				status: 'moved',
				originalIndex: originals[originalOp].index,
				modifiedIndex: modifieds[modifiedOp].index,
				excerpt: excerpt(originals[originalOp].text),
			},
		});
		return id;
	};

	for (let opIndex = 0; opIndex < ops.length; opIndex++) {
		const op = ops[opIndex];

		if (op.kind === 'matched' && op.o !== undefined && op.m !== undefined) {
			const originalBlock = originals[op.o];
			const modifiedBlock = modifieds[op.m];
			const comparison = comparePair(originalBlock, modifiedBlock);
			if (comparison.degraded) {
				degradeSink.add(comparison.degraded);
			}
			if (comparison.status) {
				const changeId = nextChangeId++;
				pending.push({
					order: opIndex,
					change: {
						id: changeId,
						status: comparison.status,
						originalIndex: originalBlock.index,
						modifiedIndex: modifiedBlock.index,
						excerpt: excerpt(modifiedBlock.text || originalBlock.text),
					},
				});
				annotations.push({
					side: 'original',
					index: originalBlock.index,
					status: comparison.status,
					changeId,
					segments: comparison.originalSegments.length ? comparison.originalSegments : undefined,
					blockFormat: comparison.blockFormat.length ? comparison.blockFormat : undefined,
				});
				annotations.push({
					side: 'modified',
					index: modifiedBlock.index,
					status: comparison.status,
					changeId,
					segments: comparison.modifiedSegments.length ? comparison.modifiedSegments : undefined,
					blockFormat: comparison.blockFormat.length ? comparison.blockFormat : undefined,
				});
			}
			lastOriginalIndex = originalBlock.index;
			lastModifiedIndex = modifiedBlock.index;
			continue;
		}

		if (op.kind === 'removed' && op.o !== undefined) {
			const block = originals[op.o];
			const movedTo = moves.get(op.o);
			if (movedTo !== undefined) {
				const changeId = moveChangeId(op.o, movedTo, opIndex);
				annotations.push({ side: 'original', index: block.index, status: 'moved', changeId });
				pushFiller('modified', lastModifiedIndex, block, 'moved', changeId);
			} else {
				const changeId = nextChangeId++;
				pending.push({ order: opIndex, change: { id: changeId, status: 'removed', originalIndex: block.index, excerpt: excerpt(block.text) } });
				annotations.push({ side: 'original', index: block.index, status: 'removed', changeId });
				// 旧側にしかない段落の分だけ、新側へゴーストを差し込んで縦位置を保つ。
				pushFiller('modified', lastModifiedIndex, block, 'removed', changeId);
			}
			lastOriginalIndex = block.index;
			continue;
		}

		if (op.kind === 'added' && op.m !== undefined) {
			const block = modifieds[op.m];
			const movedFrom = movesReverse.get(op.m);
			if (movedFrom !== undefined) {
				const changeId = moveChangeId(movedFrom, op.m, opIndex);
				annotations.push({ side: 'modified', index: block.index, status: 'moved', changeId });
				pushFiller('original', lastOriginalIndex, block, 'moved', changeId);
			} else {
				const changeId = nextChangeId++;
				pending.push({ order: opIndex, change: { id: changeId, status: 'added', modifiedIndex: block.index, excerpt: excerpt(block.text) } });
				annotations.push({ side: 'modified', index: block.index, status: 'added', changeId });
				pushFiller('original', lastOriginalIndex, block, 'added', changeId);
			}
			lastModifiedIndex = block.index;
			continue;
		}
	}

	pending.sort((a, b) => a.order - b.order || a.change.id - b.change.id);

	return {
		changes: pending.map(entry => entry.change),
		annotations,
		fillers,
		degraded: degradeSink.size ? [...degradeSink] : undefined,
	};
}
