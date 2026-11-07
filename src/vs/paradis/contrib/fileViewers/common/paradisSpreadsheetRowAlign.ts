/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel 差分の行アライメント。行の「表示値フィンガープリント」に対して最長共通部分列(LCS)を求め、
// 挿入/削除された行を独立した差分行として切り出すための純関数群。
// 依存を持たない(common 層)。diff 本体(electron-browser)から使い、単体テストは node で走る。

import { LcsDiff, StringDiffSequence, type IContinueProcessingPredicate, type ISequence } from '../../../../base/common/diff/diff.js';
import { IParadisRowData } from './paradisSpreadsheet.js';

/**
 * LCS を求める行数の組((行数+1)×(行数+1))の上限。超過時は呼び出し側がインデックス対比へフォールバックする。
 * ビューアが表示する上限(2,000 行。node/paradisSpreadsheetService.ts の MAX_ROWS)同士も対応を取れるようにする
 * (以前の 4,000,000 では 2,000 行同士が必ず超え、途中に行を足しただけで以降がすべて変更扱いになった)。
 */
const MAX_LCS_CELLS = (2_000 + 1) * (2_000 + 1);

/** フィンガープリントの打ち切り前の最大長。極端に長い行でメモリ・比較コストが爆発しないよう打ち切る。 */
const FINGERPRINT_MAX_LENGTH = 2000;

/**
 * 32bit FNV-1a。暗号強度は不要——先頭 {@link FINGERPRINT_MAX_LENGTH} 文字が同じで
 * それ以降だけ違う行を区別できれば十分。
 */
function fnv1aHex(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 行のフィンガープリント=全セル表示値の連結。
 * 値だけを見るのは意図的: 値が同じ行は書式だけ変わっていても「対応行」としてペアリングし、
 * セル比較で modified を付ける方が差分として読みやすい。
 */
export function rowFingerprint(row: IParadisRowData): string {
	let out = '';
	for (const cell of row.cells) {
		out += cell.value;
		out += '\u001F';
	}
	if (out.length <= FINGERPRINT_MAX_LENGTH) {
		return out;
	}
	// 打ち切った分だけ全体のハッシュを足す。先頭 FINGERPRINT_MAX_LENGTH 文字が同じでも
	// それ以降が違う行同士が、同じフィンガープリントとして誤ってペアリングされるのを防ぐ。
	return `${out.slice(0, FINGERPRINT_MAX_LENGTH)}${fnv1aHex(out)}`;
}

/** 対応づけられた行の組(original側インデックス / modified側インデックス、ともに昇順)。 */
export interface ILcsPair {
	readonly o: number;
	readonly m: number;
}

/** 文字列の並び（同じ文字列どうしを等しいとみなす。LcsDiff はハッシュが一致した後に文字列そのものも比べる）。 */
class ParadisStringListSequence implements ISequence {
	constructor(private readonly items: readonly string[]) { }
	getElements(): string[] {
		return this.items as string[];
	}
}

/**
 * 2 つの並びの最長共通部分列（LCS）で対応する位置の組を、前から順に返す。`vs/base` の LcsDiff で求めるので、
 * (n+1)×(m+1) の表を持たない。LCS が何通りもあるときにどれを選ぶかは LcsDiff に従う（長さは同じ）。
 * `continueProcessing` が投げると、その例外がそのまま出る（取り消し・締め切りに使う）。
 */
export function paradisLcsPairs(original: ISequence, modified: ISequence, originalLength: number, modifiedLength: number, continueProcessing?: () => void): readonly ILcsPair[] {
	const predicate: IContinueProcessingPredicate | null = continueProcessing ? () => { continueProcessing(); return true; } : null;
	const changes = new LcsDiff(original, modified, predicate).ComputeDiff(false).changes;
	const pairs: ILcsPair[] = [];
	let o = 0;
	let m = 0;
	const matchUntil = (originalEnd: number) => {
		while (o < originalEnd) {
			pairs.push({ o: o++, m: m++ });
		}
	};
	for (const change of changes) {
		matchUntil(change.originalStart);
		o = change.originalStart + change.originalLength;
		m = change.modifiedStart + change.modifiedLength;
	}
	matchUntil(originalLength);
	if (m !== modifiedLength) {
		// 末尾の一致は両側で同じ長さになる。ずれたら LcsDiff の結果を読み違えている。
		throw new Error('Unexpected LCS result');
	}
	return pairs;
}

/** 2 つの文字列の、文字単位の LCS の対応。 */
export function paradisCharacterLcsPairs(original: string, modified: string): readonly ILcsPair[] {
	return paradisLcsPairs(new StringDiffSequence(original), new StringDiffSequence(modified), original.length, modified.length);
}

/**
 * フィンガープリント配列同士の LCS マッチング。ペア配列を返す。
 * 行列積が上限を超える場合は undefined を返す(計算量の保護。呼び出し側は
 * 従来のインデックスペアリングへフォールバックする)。
 */
export function computeLcsRowPairs(a: readonly string[], b: readonly string[]): readonly ILcsPair[] | undefined {
	if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
		return undefined;
	}
	return paradisLcsPairs(new ParadisStringListSequence(a), new ParadisStringListSequence(b), a.length, b.length);
}
