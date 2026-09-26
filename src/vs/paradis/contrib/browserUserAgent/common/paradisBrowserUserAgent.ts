/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの User-Agent 調整（paradis.browser.userAgent.*）の設定キーと、UA 文字列の組み立て。
// electron-main（実際の適用）と browser（設定スキーマ登録）の両方から使うため common に置く。

import { escapeRegExpCharacters } from '../../../../base/common/strings.js';

/** true のとき、内蔵ブラウザの UA に `ParaCode/<ver>` トークンを残す（既定 false = 消す）。 */
export const PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY = 'paradis.browser.userAgent.includeParaCodeToken';

/**
 * Electron 既定の UA から、埋め込みブラウザであることを示すトークンを取り除いた UA を返す。
 *
 * - `Electron/x.y.z` は常に消す（Google などが埋め込みブラウザとしてログインを拒否するため）。
 * - `<アプリ名>/<バージョン>`（例 `ParaCode/1.139.1`）は `includeAppToken` が false のとき消す。
 *   Electron は UA にアプリ名を空白を除いて入れるので、ここでも空白を除いた名前で照合する。
 */
export function paradisBuildBrowserUserAgent(originalUA: string, appName: string, includeAppToken: boolean): string {
	let userAgent = originalUA.replace(/\sElectron\/\S+/g, '');
	const appToken = appName.replace(/\s/g, '');
	if (!includeAppToken && appToken) {
		userAgent = userAgent.replace(new RegExp(`\\s${escapeRegExpCharacters(appToken)}/\\S+`, 'g'), '');
	}
	return userAgent.trim();
}
