/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ListenerLeakError } from '../../../../base/common/event.js';

// onUnexpectedError で拾った例外は、送る直前にメッセージも中身も捨てられる（名前とスタックだけが残る）。
// 原因の見当がつくよう、例外が持っている固定の値だけを `safe_` の欄に移す。
//  - ListenerLeakError: リスナーの数・種類・Emitter の名前（名前は upstream のコードが付ける定数）
//  - `code`: Node のエラーコード（`ERR_MODULE_NOT_FOUND` など）。拡張機能ホストから届いたものにも付いている

/** Node や VS Code のエラーコードの形。長い16進やパスのような値は通さない。 */
const errorCodeLike = /^[A-Z][A-Za-z0-9_]{1,49}$/;
/** `[<emitter>] potential listener LEAK detected, <kind>` の <emitter>。 */
const leakEmitterName = /^\[(?<name>[A-Za-z][\w.-]{0,63})\] potential listener LEAK detected/;

/** 予期しない例外から Sentry に送ってよい値を取り出す。何も無ければ undefined。getter が投げても落ちない。 */
export function paradisUnhandledErrorSafeExtra(error: unknown): Record<string, string | number> | undefined {
	try {
		const extra: Record<string, string | number> = {};
		if (ListenerLeakError.is(error)) {
			if (Number.isSafeInteger(error.listenerCount)) {
				extra.safe_listener_count = error.listenerCount;
			}
			if (error.kind === 'dominated' || error.kind === 'popular') {
				extra.safe_leak_kind = error.kind;
			}
			const emitter = leakEmitterName.exec(error.message)?.groups?.name;
			if (emitter !== undefined) {
				extra.safe_emitter_name = emitter;
			}
		}
		if (typeof error === 'object' && error !== null) {
			const code: unknown = (error as { code?: unknown }).code;
			if (typeof code === 'string' && errorCodeLike.test(code)) {
				extra.safe_error_code = code;
			}
		}
		return Object.keys(extra).length > 0 ? extra : undefined;
	} catch {
		return undefined;
	}
}
