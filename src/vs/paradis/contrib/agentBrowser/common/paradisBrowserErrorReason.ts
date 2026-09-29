/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome-devtools-mcp のツールが返したエラー文から、Sentry に送ってよい固定の語だけを取り出す。
// 文そのものはページの URL やセレクタを含みうるので送らない。Para Code 自身が CDP の応答へ入れる
// `PARA_BROWSER_RETRYABLE:` / `PARA_BROWSER_OUTCOME_UNKNOWN:` の理由を種類に畳み、
// 「click_at の Protocol error」が Para Code の入力の関所で断ったものか、ページ側の失敗かを見分ける。

/** Para Code の関所が CDP の応答に入れる理由の種類。関所を通っていない（Para Code が断ったのではない）なら `none`。 */
export type ParadisBrowserErrorReasonCode =
	| 'none'
	| 'user-focus'
	| 'focus-state-unavailable'
	| 'authority-changed'
	| 'key-suppression'
	| 'dispatch-incomplete'
	| 'barrier-timeout'
	| 'binding-changed'
	| 'command-rejected'
	| 'bridge-unavailable'
	| 'retryable-other'
	| 'outcome-unknown-other';

/** 上から順に当てる。先に当たったものを採る（「focus authority」は authority の変化として数える）。 */
const REASONS: readonly [RegExp, ParadisBrowserErrorReasonCode][] = [
	[/focused by the user|BrowserView became focused/i, 'user-focus'],
	[/authority (?:changed|became unavailable|is unavailable)/i, 'authority-changed'],
	[/focus state (?:is|became) unavailable/i, 'focus-state-unavailable'],
	[/key suppression/i, 'key-suppression'],
	[/input barrier timeout/i, 'barrier-timeout'],
	[/did not complete/i, 'dispatch-incomplete'],
	[/binding (?:changed|generation|state|is unavailable)|no browser page is bound|scopes? (?:changed|cannot be bound)|shared (?:page|browser tab)|page shared with this terminal pane changed/i, 'binding-changed'],
	[/not an allowed|suppressible exact key signature|invalid exact BrowserView descriptor|could not be serialized/i, 'command-rejected'],
	[/DevTools bridge (?:terminated|resource limit)/i, 'bridge-unavailable'],
];

const PREFIX = /PARA_BROWSER_(?<status>RETRYABLE|OUTCOME_UNKNOWN):(?<reason>[^\n]*)/;
/** CDP のメソッド名（`Input.dispatchMouseEvent` など）。固定の名前なので送ってよい。 */
const PROTOCOL_METHOD = /Protocol error \((?<method>[A-Z][A-Za-z]{0,39}\.[a-z][A-Za-z]{0,63})\)/;

/**
 * ツールのエラー文から、Sentry の `safe_` 欄に載せてよい値だけを返す。
 * `safe_error_code` は常に返す。CDP のメソッド名が読めたときだけ `safe_cdp_method` も返す。
 */
export function paradisClassifyBrowserToolErrorText(text: string): { readonly safe_error_code: ParadisBrowserErrorReasonCode; readonly safe_cdp_method?: string } {
	const method = PROTOCOL_METHOD.exec(text)?.groups?.method;
	const withMethod = method !== undefined ? { safe_cdp_method: method } : {};
	const match = PREFIX.exec(text);
	if (!match?.groups) {
		return { safe_error_code: 'none', ...withMethod };
	}
	const reason = match.groups.reason;
	const known = REASONS.find(([pattern]) => pattern.test(reason));
	const code = known ? known[1] : match.groups.status === 'RETRYABLE' ? 'retryable-other' : 'outcome-unknown-other';
	return { safe_error_code: code, ...withMethod };
}
