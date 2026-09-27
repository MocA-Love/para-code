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

import * as fs from 'fs';
import { app, shell } from 'electron';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { paradisConfigureBrowserDownloadsWithPath, paradisResolveBrowserDownloadsDirectory } from './paradisBrowserDownloadsCore.js';
import { IParadisDownloadOrigin, ParadisBrowserDownloadsTracker } from './paradisBrowserDownloadsTracker.js';
import { paradisEnsureDownloadQuarantine } from './paradisDownloadQuarantine.js';
import { paradisIsAgentDownload, paradisNotifyAgentDownloadStarted, paradisSetAgentDownloadsTracker } from './paradisAgentDownloads.js';

/**
 * main プロセスに1つだけのダウンロード一覧。セッション（グローバル・ワークスペース・プロファイル・
 * エージェント…）ごとに `will-download` を配線するので、どのセッションのダウンロードもここへ集まる。
 * 最初に触った側（セッションの configure() か app.ts から呼ばれる登録）が作る。どちらも同じ main の
 * IConfigurationService を渡してくる。終了処理で dispose された後も差し替えない（dispose 済みの一覧は
 * 何も記録しないので、終了間際に作られたセッションが繋がっていない新しい一覧へ記録することが無い）。
 */
let tracker: ParadisBrowserDownloadsTracker | undefined;

/**
 * Electron のセッションから、どの保存領域（エージェント専用か・どのプロファイルか）かを引く口。
 * BrowserSession を知っている paradisBrowserDownloadsMain.ts が登録する（ここから BrowserSession を
 * import すると、browserSession.ts との間で import が循環するため）。
 */
let originResolver: ((session: Electron.Session) => IParadisDownloadOrigin) | undefined;

export function paradisSetBrowserDownloadOriginResolver(resolver: (session: Electron.Session) => IParadisDownloadOrigin): void {
	originResolver = resolver;
}

export function paradisGetBrowserDownloadsTracker(configurationService: IConfigurationService): ParadisBrowserDownloadsTracker {
	if (!tracker) {
		tracker = new ParadisBrowserDownloadsTracker(
			{
				openPath: path => shell.openPath(path),
				showItemInFolder: path => shell.showItemInFolder(path),
				exists: path => fs.existsSync(path),
				ensureQuarantine: async (path, sourceUrl) => (await paradisEnsureDownloadQuarantine(path, sourceUrl)) !== 'failed',
			},
			() => paradisResolveBrowserDownloadsDirectory(configurationService, () => app.getPath('downloads')),
		);
		// エージェントが書き出す PDF とクリックでのダウンロードの待ち合わせが、同じ一覧を使う
		paradisSetAgentDownloadsTracker(tracker);
	}
	return tracker;
}

/**
 * 内蔵ブラウザ用のElectronセッションへダウンロード自動保存を配線する。設定は `will-download` の
 * たびに読み直すため、有効/無効やパスの変更はアプリの再起動なしに次回のダウンロードから反映される。
 *
 * mainプロセスの `IConfigurationService` はrenderer側の設定レジストリ（既定値を持つ）をロードしない
 * ため、未設定時 `getValue` は `undefined` を返す。`=== false` / `isAbsolute(...)` の判定はどちらも
 * `undefined` を「既定へフォールバック」側へ倒すため、既定ON・既定パスの意図した挙動になる。
 */
export function paradisConfigureBrowserDownloads(session: Electron.Session, configurationService: IConfigurationService): void {
	const downloads = paradisGetBrowserDownloadsTracker(configurationService);
	paradisConfigureBrowserDownloadsWithPath(session, configurationService, () => app.getPath('downloads'), (item, from, webContents) => {
		// エージェントに共有中のタブ・エージェントのクリックを待っているタブからのものはエージェント由来にする
		const origin = originResolver?.(from) ?? { agentSession: false };
		const id = downloads.track(item, { ...origin, agentInitiated: paradisIsAgentDownload(webContents) });
		paradisNotifyAgentDownloadStarted(webContents, id);
	});
}
