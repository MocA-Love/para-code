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
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { PARADIS_BROWSER_DOWNLOADS_CHANNEL } from '../common/paradisBrowserDownloads.js';
import { paradisConfigureBrowserDownloadsWithPath, paradisResolveBrowserDownloadsDirectory } from './paradisBrowserDownloadsCore.js';
import { ParadisBrowserDownloadsTracker } from './paradisBrowserDownloadsTracker.js';

/**
 * main プロセスに1つだけのダウンロード一覧。セッション（グローバル・ワークスペース・プロファイル・
 * エージェント…）ごとに `will-download` を配線するので、どのセッションのダウンロードもここへ集まる。
 * 最初に触った側（セッションの configure() か app.ts のチャネル登録）が作る。どちらも同じ main の
 * IConfigurationService を渡してくる。
 */
let tracker: ParadisBrowserDownloadsTracker | undefined;

function paradisGetBrowserDownloadsTracker(configurationService: IConfigurationService): ParadisBrowserDownloadsTracker {
	if (!tracker) {
		tracker = new ParadisBrowserDownloadsTracker(
			{
				openPath: path => shell.openPath(path),
				showItemInFolder: path => shell.showItemInFolder(path),
				exists: path => fs.existsSync(path),
			},
			() => paradisResolveBrowserDownloadsDirectory(configurationService, () => app.getPath('downloads')),
		);
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
	paradisConfigureBrowserDownloadsWithPath(session, configurationService, () => app.getPath('downloads'), item => downloads.track(item));
}

/** app.ts の PARA-PATCH 点から1行で呼ばれ、renderer 向けのダウンロード一覧チャネルを登録する。 */
export function paradisRegisterBrowserDownloads(
	server: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	configurationService: IConfigurationService,
): IDisposable {
	const downloads = paradisGetBrowserDownloadsTracker(configurationService);
	const store = new DisposableStore();
	// 一覧を見ているウィンドウが無い間の進み具合を main に溜め込まない。renderer は購読し始めた
	// ときに list() で全件を取り直す。
	server.registerChannel(PARADIS_BROWSER_DOWNLOADS_CHANNEL, ProxyChannel.fromService(downloads, store, { unbufferedEvents: ['onDidChangeDownloads'] }));
	store.add(toDisposable(() => {
		downloads.dispose();
		if (tracker === downloads) {
			tracker = undefined;
		}
	}));
	return store;
}
