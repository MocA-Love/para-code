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

/** 手にした・手放したを知らせる先（拡張機能のサイドパネルが、共有の始まったタブの横で閉じるのに使う）。 */
const holdListeners = new Set<(webContents: object, isHeld: boolean) => void>();

/** エージェントがタブを手にした（true）・手放した（false）。 */
export function paradisSetExtensionPageHold(webContents: object, isHeld: boolean): void {
	const was = held.has(webContents);
	if (isHeld) {
		held.add(webContents);
	} else {
		held.delete(webContents);
	}
	if (was !== isHeld) {
		for (const listener of [...holdListeners]) {
			try {
				listener(webContents, isHeld);
			} catch {
				// 知らせる先の失敗で、台帳の更新を止めない
			}
		}
	}
}

/** エージェントがタブを手にした・手放したときに呼ぶ。返り値を呼ぶと外れる。 */
export function paradisOnDidChangeExtensionPageHold(listener: (webContents: object, isHeld: boolean) => void): { dispose(): void } {
	holdListeners.add(listener);
	return { dispose: () => holdListeners.delete(listener) };
}

/** エージェントが手にしているタブか。 */
export function paradisIsExtensionPageHeld(webContents: object): boolean {
	return held.has(webContents);
}

/**
 * 利用者が設定でオンにした「共有中のタブでも拡張機能の画面を出す」（既定はオフ）。オンの間は、手にしているタブの横の
 * サイドパネルと、手にしているタブの中に拡張機能が差す枠（iframe）を止めない。ページ本体を拡張のページへ移すこと・
 * 拡張のページを新しいタブで開くことは、オンでも止める。
 */
let extensionUiAllowedWhileHeld = false;
const extensionUiAllowedListeners = new Set<() => void>();

/** 設定の値を入れる（electron-main の拡張機能の管理が、起動時と設定が変わったときに呼ぶ）。 */
export function paradisSetExtensionUiAllowedWhileHeld(allowed: boolean): void {
	if (extensionUiAllowedWhileHeld === allowed) {
		return;
	}
	extensionUiAllowedWhileHeld = allowed;
	for (const listener of [...extensionUiAllowedListeners]) {
		try {
			listener();
		} catch {
			// 知らせる先の失敗で、値の更新を止めない
		}
	}
}

/** 共有中のタブでも拡張機能のサイドパネルと枠を出してよいか。 */
export function paradisIsExtensionUiAllowedWhileHeld(): boolean {
	return extensionUiAllowedWhileHeld;
}

/** 上の値が変わったときに呼ぶ。返り値を呼ぶと外れる。 */
export function paradisOnDidChangeExtensionUiAllowedWhileHeld(listener: () => void): { dispose(): void } {
	extensionUiAllowedListeners.add(listener);
	return { dispose: () => extensionUiAllowedListeners.delete(listener) };
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
