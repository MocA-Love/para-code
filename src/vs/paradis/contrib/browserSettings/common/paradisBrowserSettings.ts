/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの設定のうち、Orca の設定ページに合わせて足したもの（ホームページ）と、
// 「設定 (Para Code)」から開く画面のコマンドの ID。

/** 新しいタブ（URL を決めずに開いたタブ）で開くページ。空なら新しいタブの画面のまま。 */
export const PARADIS_BROWSER_HOME_PAGE_SETTING = 'paradis.browser.homePage';

/** 「ほかのブラウザのログインを取り込む」ダイアログを開く。 */
export const PARADIS_BROWSER_IMPORT_LOGINS_COMMAND_ID = 'paradis.browser.importLogins';

/** サイトごとに許可・ブロックした権限の一覧を開く。 */
export const PARADIS_BROWSER_SITE_PERMISSIONS_COMMAND_ID = 'paradis.browser.showSitePermissions';

/** ホームページに使える URL か（http・https だけ）。前後の空白は無視する。使えなければ undefined。 */
export function paradisNormalizeHomePage(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	// 「example.com」のようにスキームを省いたものは https として扱う
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(candidate);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}
