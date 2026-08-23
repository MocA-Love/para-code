/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel 差分の行アライメント。行の「表示値フィンガープリント」に対して最長共通部分列(LCS)を求め、
// 挿入/削除された行を独立した差分行として切り出すための純関数群。
// 依存を持たない(common 層)。diff 本体(electron-browser)から使い、単体テストは node で走る。

import { IParadisRowData } from './paradisSpreadsheet.js';

/** LCS DP テーブルのセル数((行数+1)×(行数+1))上限。超過時は呼び出し側がインデックス対比へフォールバックする(1999×1999行までは許容、2000×2000行は超過)。 */
const MAX_LCS_CELLS = 4_000_000;

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

/**
 * フィンガープリント配列同士の LCS マッチング。ペア配列を返す。
 * 行列積が上限を超える場合は undefined を返す(計算量・メモリ保護。呼び出し側は
 * 従来のインデックスペアリングへフォールバックする)。
 */
export function computeLcsRowPairs(a: readonly string[], b: readonly string[]): readonly ILcsPair[] | undefined {
	const n = a.length;
	const m = b.length;
	if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
		return undefined;
	}
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		const current = i * width;
		const next = current + width;
		for (let j = m - 1; j >= 0; j--) {
			dp[current + j] = a[i] === b[j]
				? dp[next + j + 1] + 1
				: Math.max(dp[next + j], dp[current + j + 1]);
		}
	}
	const pairs: ILcsPair[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push({ o: i, m: j });
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}
