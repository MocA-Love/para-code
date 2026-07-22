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
import * as fs from 'fs';
import { basename, extname, isAbsolute, join } from '../../../../base/common/path.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER, PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY, PARADIS_BROWSER_DOWNLOADS_PATH_KEY } from '../common/paradisBrowserDownloads.js';

/**
 * `will-download` を配線済みのElectronセッション。同一セッションへの二重配線
 * （リスナー累積による `setSavePath` の多重呼び出し）を防ぐためのガード。
 * `browserExtensions` の `attemptedSessions` と同じ理由・同じ形。
 */
const configuredSessions = new WeakSet<Electron.Session>();

/**
 * 内蔵ブラウザ用のElectronセッションへダウンロード自動保存を配線する。設定は `will-download` の
 * たびに読み直すため、有効/無効やパスの変更はアプリの再起動なしに次回のダウンロードから反映される。
 *
 * mainプロセスの `IConfigurationService` はrenderer側の設定レジストリ（既定値を持つ）をロードしない
 * ため、未設定時 `getValue` は `undefined` を返す。`=== false` / `isAbsolute(...)` の判定はどちらも
 * `undefined` を「既定へフォールバック」側へ倒すため、既定ON・既定パスの意図した挙動になる。
 */
export function paradisConfigureBrowserDownloads(session: Electron.Session, configurationService: IConfigurationService): void {
	if (configuredSessions.has(session)) {
		return;
	}
	configuredSessions.add(session);

	session.on('will-download', (_event, item) => {
		if (configurationService.getValue<boolean>(PARADIS_BROWSER_DOWNLOADS_ENABLED_KEY) === false) {
			return; // 無効化時はElectron既定の保存ダイアログにフォールバックさせる
		}

		// 相対パスはmainプロセスのcwd基準で予測不能な場所を指しかねないため、絶対パスのみ受け入れる。
		const customPath = configurationService.getValue<string>(PARADIS_BROWSER_DOWNLOADS_PATH_KEY)?.trim();
		const targetDirectory = customPath && isAbsolute(customPath)
			? customPath
			: join(app.getPath('downloads'), PARADIS_BROWSER_DOWNLOADS_DEFAULT_SUBFOLDER);

		try {
			fs.mkdirSync(targetDirectory, { recursive: true });
		} catch (error) {
			console.error('[paradis] Failed to create the browser downloads directory, falling back to the save dialog:', error);
			return;
		}

		// ダウンロード先ファイル名はナビゲーション先のサイトやCDP経由の自動操作の影響を受けるため、
		// パス区切りを剥がして targetDirectory の外へ書き込めないようにする。
		item.setSavePath(paradisResolveUniqueDownloadPath(targetDirectory, basename(item.getFilename())));
	});
}

/** 同名ファイルが既にある場合、ブラウザの一般的な挙動に合わせて ` (1)`, ` (2)`, ... を付けて衝突を避ける。 */
function paradisResolveUniqueDownloadPath(directory: string, filename: string): string {
	const ext = extname(filename);
	const base = filename.slice(0, filename.length - ext.length);

	let candidate = join(directory, filename);
	for (let i = 1; fs.existsSync(candidate); i++) {
		candidate = join(directory, `${base} (${i})${ext}`);
	}
	return candidate;
}
