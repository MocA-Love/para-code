/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザでのダウンロードを、保存先を選ぶシステムダイアログを出さずに固定フォルダへ自動保存する。
// Electronは `will-download` で `item.setSavePath()` を呼ばない限り既定でネイティブの保存ダイアログを
// 出すため、CDPが自動操作でダウンロードを踏んでもLLMからは検証できない（保存先を選ぶ人間の操作待ちで
// 止まる）という問題があった。CDPの `Browser.setDownloadBehavior` はゲートウェイ
// (paradisCdpFilterProxy.ts) が複数paneでの同一Electronセッション共有を守るため拒否しているので、
// ここではmainプロセス側で恒久的に配線する。呼び出し元は browserSession.ts の configure()（PARA-PATCH 1行）。

import { app } from 'electron';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { paradisConfigureBrowserDownloadsWithPath } from './paradisBrowserDownloadsCore.js';

/**
 * 内蔵ブラウザ用のElectronセッションへダウンロード自動保存を配線する。設定は `will-download` の
 * たびに読み直すため、有効/無効やパスの変更はアプリの再起動なしに次回のダウンロードから反映される。
 *
 * mainプロセスの `IConfigurationService` はrenderer側の設定レジストリ（既定値を持つ）をロードしない
 * ため、未設定時 `getValue` は `undefined` を返す。`=== false` / `isAbsolute(...)` の判定はどちらも
 * `undefined` を「既定へフォールバック」側へ倒すため、既定ON・既定パスの意図した挙動になる。
 */
export function paradisConfigureBrowserDownloads(session: Electron.Session, configurationService: IConfigurationService): void {
	paradisConfigureBrowserDownloadsWithPath(session, configurationService, () => app.getPath('downloads'));
}
