/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのファイル検索 (find/grep) を、そのワークスペースがあるマシン (shared process /
// SSH 接続先の REH サーバー) へ問い合わせるためのチャネル契約。実体は node/paradisMobileSearch.ts
// (ripgrep 実行)。shared process 版と REH 版は同じ実装をそのまま登録するだけで済むよう、
// この専用チャネルへ切り出してある。

export const PARADIS_REMOTE_SEARCH_CHANNEL = 'paradisRemoteSearch';

export interface IParadisFileSearchResult {
	/** ルート相対パス ('/'区切り)。ランク順。 */
	readonly files: string[];
	readonly truncated: boolean;
}

export interface IParadisTextSearchMatch {
	/** ルート相対パス ('/'区切り)。 */
	readonly path: string;
	/** 1始まりの行番号。 */
	readonly line: number;
	/** マッチ行のテキスト (トリム・長さ制限済み)。 */
	readonly text: string;
}

export interface IParadisTextSearchResult {
	readonly matches: IParadisTextSearchMatch[];
	readonly truncated: boolean;
}
