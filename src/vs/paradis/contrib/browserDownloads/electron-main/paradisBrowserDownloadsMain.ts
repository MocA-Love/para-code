/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ダウンロード一覧の main 側の登録口。app.ts の PARA-PATCH 点から1行で呼ばれる。
//
// renderer へ公開するのは IParadisBrowserDownloadsMainService の操作だけ。一覧の実体
// （ParadisBrowserDownloadsTracker）をそのまま ProxyChannel に渡すと、`track` や `dispose` まで
// renderer から呼べてしまうので、必要なメソッドだけを持つ薄い面を作って渡す。

import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { BrowserSession } from '../../../../platform/browserView/electron-main/browserSession.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { paradisProfileIdFromSessionId } from '../../browserProfiles/common/paradisBrowserProfileId.js';
import { IParadisBrowserDownloadsMainService, PARADIS_BROWSER_DOWNLOADS_CHANNEL } from '../common/paradisBrowserDownloads.js';
import { paradisGetBrowserDownloadsTracker, paradisSetBrowserDownloadOriginResolver } from './paradisBrowserDownloads.js';
import { IParadisDownloadOrigin } from './paradisBrowserDownloadsTracker.js';

/** Electron のセッションから、ダウンロードの出どころ（エージェント専用の保存領域か・どのプロファイルか）を引く。 */
function resolveOrigin(session: Electron.Session): IParadisDownloadOrigin {
	for (const id of BrowserSession.getBrowserContextIds()) {
		const browserSession = BrowserSession.get(id);
		if (browserSession?.electronSession === session) {
			const profileId = paradisProfileIdFromSessionId(browserSession.id);
			return {
				agentSession: browserSession.storageScope === BrowserViewStorageScope.Agent,
				...(profileId ? { profileId } : {}),
			};
		}
	}
	return { agentSession: false };
}

export function paradisRegisterBrowserDownloads(
	server: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	configurationService: IConfigurationService,
): IDisposable {
	const downloads = paradisGetBrowserDownloadsTracker(configurationService);
	paradisSetBrowserDownloadOriginResolver(resolveOrigin);
	const store = new DisposableStore();
	const surface: IParadisBrowserDownloadsMainService = {
		onDidChangeDownloads: downloads.onDidChangeDownloads,
		list: () => downloads.list(),
		cancel: id => downloads.cancel(id),
		open: id => downloads.open(id),
		showInFolder: id => downloads.showInFolder(id),
		remove: id => downloads.remove(id),
		clearFinished: () => downloads.clearFinished(),
		openDownloadsFolder: () => downloads.openDownloadsFolder(),
		setAgentProfiles: profileIds => downloads.setAgentProfiles(profileIds),
	};
	// 一覧を見ているウィンドウが無い間の進み具合を main に溜め込まない。renderer は購読し始めた
	// ときに list() で全件を取り直す。
	server.registerChannel(PARADIS_BROWSER_DOWNLOADS_CHANNEL, ProxyChannel.fromService(surface, store, { unbufferedEvents: ['onDidChangeDownloads'] }));
	store.add(toDisposable(() => downloads.dispose()));
	return store;
}
