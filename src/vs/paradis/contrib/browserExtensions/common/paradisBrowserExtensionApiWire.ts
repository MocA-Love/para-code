/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/shared/browser-extension-worker-api.ts

// 拡張機能の中で動く Para Code の詰め物（chrome.* の足りない API）と、main の私用スキームの取り決め。
//
// service worker の preload は使わない（Electron の不具合 electron#52310 で、preload の実行中の GC で
// 拡張のレンダラーが落ちる。Orca が実測）。詰め物は拡張の中で fetch で main と話す。各セッションの
// スキームの受け手がセッションを、Electron が付ける呼び出し元の origin が拡張機能を決め、その拡張機能の
// ファイルからしか読めない起動ごとのトークンが一致しなければ断る。

/** main と話す私用スキーム（mainImpl.ts で privileged に登録する）。 */
export const PARADIS_EXTENSION_API_SCHEME = 'paracode-extension-api';
/** API の呼び出し（POST、本文は {@link IParadisExtensionApiRequestBody}）。 */
export const PARADIS_EXTENSION_API_CALL_URL = `${PARADIS_EXTENSION_API_SCHEME}://api/call`;
/** イベントを受ける長く続く応答（1 行 1 件の JSON）。拡張機能の文脈（worker・ページ）ごとに 1 本。 */
export const PARADIS_EXTENSION_API_EVENTS_URL = `${PARADIS_EXTENSION_API_SCHEME}://api/events`;

// Para Code が拡張機能の写しに書くファイル。Chromium は "_" で始まる名前を予約しているので使わない。
/** 詰め物の本体。 */
export const PARADIS_EXTENSION_SHIM_FILE = 'paracode-extension-api.js';
/** 背景の worker の入口（詰め物を読んでから拡張機能自身の worker を読む）。 */
export const PARADIS_EXTENSION_WORKER_WRAPPER_FILE = 'paracode-background.js';
/** 起動ごとのトークン。 */
export const PARADIS_EXTENSION_TOKEN_FILE = 'paracode-extension-api-token.json';
/** content script の詰め物（manifest の各 content script の先頭に入れる）。 */
export const PARADIS_EXTENSION_CONTENT_SCRIPT_FILE = 'paracode-content-script-api.js';
/** 拡張機能そのままの manifest（書き換えを何度でも元からやり直せるように）。 */
export const PARADIS_EXTENSION_ORIGINAL_MANIFEST_FILE = 'paracode-original-manifest.json';

/** Para Code が写しに書くファイルの名前（拡張機能自身のファイルと重なったら断る）。 */
export const PARADIS_EXTENSION_PRIVATE_FILES: readonly string[] = [
	PARADIS_EXTENSION_SHIM_FILE,
	PARADIS_EXTENSION_WORKER_WRAPPER_FILE,
	PARADIS_EXTENSION_TOKEN_FILE,
	PARADIS_EXTENSION_ORIGINAL_MANIFEST_FILE,
	PARADIS_EXTENSION_CONTENT_SCRIPT_FILE,
];

/** 呼び出しの種類。 */
export type ParadisExtensionApiRequest =
	| { readonly type: 'call'; readonly namespace: string; readonly method: string; readonly args: readonly unknown[]; readonly userGesture?: boolean }
	| { readonly type: 'listen'; readonly namespace: string; readonly event: string; readonly active: boolean };

/**
 * POST の本文。トークン（`t`）と文脈の名前（`c`。worker は 'worker'、ページはページごとの乱数）は URL の
 * 問い合わせに書く（main が本文を読む前に確かめられるように）。
 */
export interface IParadisExtensionApiRequestBody {
	readonly request?: ParadisExtensionApiRequest;
}

/** 呼び出し先の URL（トークンと文脈の名前を付けたもの）。 */
export function paradisExtensionApiUrl(endpoint: string, token: string, connection: string): string {
	return `${endpoint}?t=${encodeURIComponent(token)}&c=${encodeURIComponent(connection)}`;
}

/** 呼び出しの答え。 */
export type ParadisExtensionApiReply =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

/** イベント 1 件。 */
export interface IParadisExtensionApiEvent {
	readonly namespace: string;
	readonly event: string;
	readonly args: readonly unknown[];
}

// undefined を運ぶための印。undefined はこの印 1 文字、この印で始まる本物の文字列にはもう 1 つ足すので、
// 拡張機能のどの文字列も undefined には読まれない。
const ESCAPE = '\u0000';

/** undefined（タプルの省略した引数など）を保つ JSON。 */
export function paradisEncodeExtensionWire(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => entry === undefined
		? ESCAPE
		: typeof entry === 'string' && entry.startsWith(ESCAPE) ? ESCAPE + entry : entry);
}

export function paradisDecodeExtensionWire(text: string): unknown {
	return JSON.parse(text, (_key, entry: unknown) => typeof entry !== 'string' || !entry.startsWith(ESCAPE)
		? entry
		: entry === ESCAPE ? undefined : entry.slice(1));
}
