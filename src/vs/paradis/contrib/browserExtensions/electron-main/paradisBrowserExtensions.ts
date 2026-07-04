/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのセッションへ同梱Chrome拡張（現状は React DevTools のみ）をロードする。
// 呼び出し元は browserSession.ts の configure()（PARA-PATCH 1行）。
//
// Electronの拡張サポートは「DevTools系拡張向けの部分実装」であることに注意:
// - unpacked（展開済みディレクトリ）のみロード可能、Chrome Web Store からのインストール/自動更新は無い
// - browser action（ツールバーアイコン+ポップアップUI）や Native Messaging は動かない
// - React DevTools は devtools_page ベースなので対象内（DevToolsを開くと React / Profiler タブが出る）
// 同梱物の出所・更新手順は ../README.md を参照。

import { FileAccess } from '../../../../base/common/network.js';

/**
 * ロード試行済みのセッション。`loadExtension` は同一セッションへ同じ拡張を二重ロードすると
 * エラーになるため、セッション単位で一度だけ試行する（BrowserSession のファクトリは
 * Electronセッションごとに1インスタンスへメモ化されるが、防御的にここでも重複を弾く）。
 */
const attemptedSessions = new WeakSet<Electron.Session>();

/**
 * 同梱ブラウザ拡張を内蔵ブラウザ用のElectronセッションへロードする。
 * fire-and-forget（ロード失敗してもブラウザ機能自体は損なわれないため、起動をブロックしない）。
 */
export function paradisInstallBrowserExtensions(session: Electron.Session): void {
	// 拡張はpersistentなセッションにしかロードできない（in-memoryセッションではElectronがエラーを投げる）。
	// 内蔵ブラウザの Ephemeral スコープ（persist: 接頭辞なしの partition）はここで除外される。
	if (!session.isPersistent() || attemptedSessions.has(session)) {
		return;
	}
	attemptedSessions.add(session);

	const reactDevtoolsPath = FileAccess.asFileUri('vs/paradis/contrib/browserExtensions/electron-main/media/react-devtools').fsPath;
	// allowFileAccess: file:// で開いたローカルHTML（信頼済みフォルダ配下）でもReactを検査できるようにする
	session.extensions.loadExtension(reactDevtoolsPath, { allowFileAccess: true }).catch(error => {
		// mainプロセスにはこの経路で使えるログサービスが無いため console に残す（メインプロセスログに出る）
		console.error('[paradis] Failed to load the bundled React DevTools extension:', error);
	});
}
