/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 外から来た値（JSON・IPC・hook の入力）の形を確かめる小さな補助。どの層からも読めるように何も import しない。
// モバイルのバンドルに入る mobileRelay/common のファイル（app/mobile が相対 import するもの）は、Metro が
// src/vs の中の相対 import を解決しないので、ここを import せずに自前の補助を持つ。

/** `null` と配列を除くオブジェクトか（`{}` の形の JSON の値）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** {@link isRecord} なら値そのもの、違えば `undefined`（`asRecord(input)?.key` のように続けて読む）。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/** 有限の数ならその値、違えば `undefined`（`NaN`・`Infinity`・数でない値を弾く）。 */
export function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
