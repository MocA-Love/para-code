/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが手にしているタブ（webContents）を覚え、ブラウザ拡張のページ（chrome-extension://）を開かせない
// ための台帳。fork の見張り（vs/paradis/contrib/agentBrowser/electron-main/paradisExtensionNavigationGuard.ts）が
// 書き込み、upstream の browserView.ts の window.open の処理（PARA-PATCH 1 行）が読む。upstream のファイルから
// vs/paradis への import を増やさないため、ここ（platform の fork のファイル）に置く。

/** URL の解析が読み飛ばす文字（WHATWG URL: 前後の C0 制御文字と空白、途中のタブと改行）。 */
const URL_IGNORED_INNER_CHARACTERS = /[\t\n\r]/g;
const URL_IGNORED_EDGE_CHARACTERS = /^[\x00-\x20]+|[\x00-\x20]+$/g;

/** 中の URL の origin を受け継ぐ（または中の URL を表示する）包みのスキーム。 */
const WRAPPING_SCHEME_PREFIXES = ['blob:', 'filesystem:', 'view-source:'];

/**
 * URL か origin がブラウザ拡張のものか。文字列でなければ false。
 * 大文字小文字、前後の空白・制御文字、途中のタブ・改行、`blob:` / `filesystem:` / `view-source:` の包みを
 * ほどいてから見る（Chromium が同じ URL として解釈する書き方をすべて拾う）。
 */
export function paradisIsBrowserExtensionUrl(value: unknown): boolean {
	if (typeof value !== 'string') {
		return false;
	}
	let url = value.replace(URL_IGNORED_INNER_CHARACTERS, '').replace(URL_IGNORED_EDGE_CHARACTERS, '').toLowerCase();
	for (let unwrapped = true; unwrapped;) {
		unwrapped = false;
		for (const prefix of WRAPPING_SCHEME_PREFIXES) {
			if (url.startsWith(prefix)) {
				url = url.slice(prefix.length).replace(URL_IGNORED_EDGE_CHARACTERS, '');
				unwrapped = true;
			}
		}
	}
	return url.startsWith('chrome-extension:');
}

/** エージェントが手にしている webContents。 */
const held = new WeakSet<object>();
/** 拡張のページへの移動を止めたときに、利用者へ知らせる先（タブごと）。 */
const blockedListeners = new WeakMap<object, () => void>();

/** エージェントがタブを手にした（true）・手放した（false）。 */
export function paradisSetExtensionPageHold(webContents: object, isHeld: boolean): void {
	if (isHeld) {
		held.add(webContents);
	} else {
		held.delete(webContents);
	}
}

/** エージェントが手にしているタブか。 */
export function paradisIsExtensionPageHeld(webContents: object): boolean {
	return held.has(webContents);
}

/** 止めたことを利用者へ知らせる先を置く（無ければ知らせない）。 */
export function paradisSetExtensionPageBlockedListener(webContents: object, listener: (() => void) | undefined): void {
	if (listener) {
		blockedListeners.set(webContents, listener);
	} else {
		blockedListeners.delete(webContents);
	}
}

/** 止めたことを利用者へ知らせる。 */
export function paradisNoteExtensionPageBlocked(webContents: object): void {
	try {
		blockedListeners.get(webContents)?.();
	} catch {
		// 知らせられなくても止めたことは変わらない
	}
}

/**
 * window.open（target=_blank を含む）を、開く前に断るか。エージェントが手にしているタブが拡張のページを
 * 新しいタブで開こうとしたら断り、利用者へ知らせる。
 */
export function paradisDeniesExtensionWindowOpen(opener: object, url: string): boolean {
	if (!held.has(opener) || !paradisIsBrowserExtensionUrl(url)) {
		return false;
	}
	paradisNoteExtensionPageBlocked(opener);
	return true;
}
