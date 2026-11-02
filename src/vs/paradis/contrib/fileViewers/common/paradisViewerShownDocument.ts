/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * webview（retainContextWhenHidden）にいま残っている文書の記録。タブを離れて戻ったときに、
 * 同じものが残っていれば描き直さないために使う。
 */
export interface IParadisShownDocument<TWebview> {
	readonly resource: URI;
	/** 描いた webview。作り直した webview には前の中身が無い。 */
	readonly webview: TWebview;
	/** 中身を決めた値（etag・読み出し結果・表示の設定など）。1 つでも `!==` なら描き直す。 */
	readonly keys: readonly unknown[];
	/** 描き終わりの知らせが届いたか。届いていない表示は白紙のことがあるので使い回さない。 */
	readonly confirmed: boolean;
}

/** 記録の中身が、いま描こうとしているものと同じで、描き終わりも確かめてあるか。 */
export function canReuseParadisShownDocument<TWebview>(shown: IParadisShownDocument<TWebview> | undefined, resource: URI, webview: TWebview | undefined, keys: readonly unknown[]): boolean {
	return !!shown && shown.confirmed && webview !== undefined && shown.webview === webview && isEqual(shown.resource, resource)
		&& shown.keys.length === keys.length && shown.keys.every((key, index) => key === keys[index]);
}
