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

/**
 * 素のオブジェクトか（プロトタイプが `Object.prototype` か `null`）。{@link isRecord} と違い、クラスのインスタンス・`Map`・`Date` を弾く。
 * IPC で届いた引数のように、形を厳密に確かめたい値に使う。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** 素の配列で、添字の要素がすべて列挙できるデータプロパティか（余分な自前のキー・穴・アクセサを弾く）。 */
export function isExactPlainArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
		return false;
	}
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return false;
		}
	}
	return true;
}

/** {@link isPlainRecord} で、自前のキーが `expectedKeys` とちょうど同じ、どれも列挙できるデータプロパティか（シンボルのキー・アクセサを弾く）。 */
export function isExactPlainRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
	if (!isPlainRecord(value)) {
		return false;
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
		return false;
	}
	return expectedKeys.every(key => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value');
	});
}
