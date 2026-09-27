/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 金額とトークン数の表示の整形。AI コストのタブと、スペース別の使用量のタブで共有する。

/** `$12.34`（1000 ドル以上は整数でカンマ区切り）。 */
export function paradisFormatUsd(value: number): string {
	if (value >= 1000) {
		return `$${Math.round(value).toLocaleString('en-US')}`;
	}
	return `$${value.toFixed(2)}`;
}

/** 1.2K / 34M / 5.6B のような短い表記。 */
export function paradisFormatTokens(value: number): string {
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
	}
	if (value >= 1e6) {
		return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
	}
	if (value >= 1e3) {
		return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
	}
	return String(Math.round(value));
}
