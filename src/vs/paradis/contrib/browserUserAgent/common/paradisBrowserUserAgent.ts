/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの User-Agent 調整（paradis.browser.userAgent.*）の設定キーと、UA 文字列の組み立て。
// electron-main（実際の適用）と browser（設定スキーマ登録）の両方から使うため common に置く。

import { escapeRegExpCharacters } from '../../../../base/common/strings.js';

/** true のとき、内蔵ブラウザの UA に `ParaCode/<ver>` トークンを残す（既定 true = 残す）。 */
export const PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY = 'paradis.browser.userAgent.includeParaCodeToken';

/** Keep an honest app identity by default; Chrome-shaped UAs were rejected by Google sign-in. */
export const PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_DEFAULT = true;

/**
 * Electron 既定の UA を組み立て直し、既定ではアプリ名を残して Para Code と名乗る。
 *
 * - `Electron/x.y.z` は常に消す。アプリ名は既定で残す（消すと Google のログインが拒否されるため）。
 * - `<アプリ名>/<バージョン>`（例 `ParaCode/1.139.1`）は `includeAppToken` が false のとき消す。
 *   Electron は UA にアプリ名を空白を除いて入れるので、ここでも空白を除いた名前で照合する。
 * - `includeAppToken` が false のときは、`Chrome/150.0.7871.250` を `Chrome/150.0.0.0` にする。Google Chrome は
 *   UA の版を major だけにしている（User-Agent Reduction）ので、細かい版が付いていると Chrome に見えない。
 *   細かい版は Client Hints の fullVersionList で渡す（paradisChromeClientHints.ts）。
 */
export function paradisBuildBrowserUserAgent(originalUA: string, appName: string, includeAppToken = PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_DEFAULT): string {
	let userAgent = originalUA.replace(/\sElectron\/\S+/g, '');
	const appToken = appName.replace(/\s/g, '');
	if (!includeAppToken && appToken) {
		userAgent = userAgent.replace(new RegExp(`\\s${escapeRegExpCharacters(appToken)}/\\S+`, 'g'), '');
	}
	if (!includeAppToken) {
		userAgent = userAgent.replace(/\bChrome\/(?<major>\d+)(?:\.\d+){3}\b/g, 'Chrome/$<major>.0.0.0');
	}
	return userAgent.trim();
}
