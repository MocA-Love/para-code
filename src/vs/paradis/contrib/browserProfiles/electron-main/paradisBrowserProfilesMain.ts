/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 名前付きブラウザプロファイルの main 側。app.ts の PARA-PATCH 点から1行で登録される。
//
// ここが持つのは「main にしか答えられないこと」だけ:
//  - 実際にビューへ紐付いている Electron セッションは何か（＝今どのプロファイルか）
//  - プロファイルの保存内容を丸ごと消す
//  - パーティションの Cookie 件数
// 台帳（表示名・色・時刻）は renderer 側にあり、ここには一切持ち込まない。

import { session } from 'electron';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BrowserSession } from '../../../../platform/browserView/electron-main/browserSession.js';
import { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import {
	IParadisBrowserProfilesMainService,
	IParadisBrowserProfileStats,
	IParadisViewSessionInfo,
	PARADIS_BROWSER_PROFILE_CHANNEL,
} from '../common/paradisBrowserProfileChannel.js';
import {
	IParadisBrowserProfilePartition,
	paradisBrowserProfilePartition,
	paradisProfileIdFromSessionId,
	PARADIS_BROWSER_PROFILE_SCOPE,
} from '../common/paradisBrowserProfileId.js';

/** app.ts から渡される channel の登録先（IPCServer をそのまま受けるための最小面）。 */
export interface IParadisBrowserProfileChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

export class ParadisBrowserProfilesMainService implements IParadisBrowserProfilesMainService {

	// 依存は DI で受ける。`IApplicationStorageMainService` は upstream の decorator が
	// `IStorageMainService` 型で宣言されており、`accessor.get()` 経由では narrow できない
	// （既存の browserViewMainService.ts と同じく注入で受けるのが正しい形）。
	constructor(
		@IBrowserViewMainService private readonly browserViewMainService: IBrowserViewMainService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
	) { }

	/**
	 * 「今このビューがどのプロファイルか」の権威。
	 *
	 * renderer 側にも viewId → profileId の台帳はあるが、あれは再起動後の復元用の写しでしか
	 * ない。Electron セッションは `WebContentsView` の構築時に固定されるため、実際に紐付いて
	 * いるセッションを見るのが唯一ずれない答えになる。
	 */
	async resolveViewSession(viewId: string): Promise<IParadisViewSessionInfo | undefined> {
		const session = this.browserViewMainService.tryGetBrowserView(viewId)?.session;
		if (!session) {
			return undefined;
		}
		return { scope: session.storageScope, profileId: paradisProfileIdFromSessionId(session.id) };
	}

	/**
	 * プロファイルの保存内容を丸ごと消す（削除時・「データだけ消す」時）。
	 *
	 * **`BrowserSession.getOrCreate()` を呼ばないこと。** あれは生成時に `configure()` を走らせ、
	 * 同梱拡張（React DevTools）の fire-and-forget ロード・preload 登録・`protocol.handle(file)`
	 * を行う。消すためだけに作ると「拡張ロード（非同期）→ clearData()」の順になり、拡張の
	 * 書き込みが clear の後に着地しうる（消したはずのパーティションが残る）。
	 *
	 * 既に生きているセッションがあるときだけそれを使う。そちらは trust / history / permissions
	 * （application storage 側の記録）も一緒に消せるため。生きていない場合はパーティションを
	 * 直接消す: そのIDは削除後に再利用されない（IDは作成のたびに新しく生成される）ので、
	 * 残る記録は孤児になるだけで別のプロファイルへ現れることはない。
	 */
	async clearProfileData(profileId: string): Promise<void> {
		const partition = this._partition(profileId);
		if (!partition) {
			return;
		}

		// **消す前に、そのプロファイルを使っているビューを全ウィンドウ分落とす。**
		// 生きたページは clearData() の直後から同じパーティションへ Cookie を書き戻すので、
		// 残したまま消すと「消えていない」状態になる。renderer 側にも自ウィンドウのタブを
		// 閉じる処理はあるが、あちらが知っているのは自分のウィンドウの分だけなので、
		// 正しさの担保はここに置く（破棄すると各ウィンドウのタブは onDidClose 経由で自動的に閉じる）。
		for (const viewId of this.browserViewMainService.paradisGetBrowserViewIdsForSession(partition.sessionId)) {
			await this.browserViewMainService.destroyBrowserView(viewId);
		}

		const live = BrowserSession.get(partition.sessionId);
		if (live) {
			live.connectStorage(this.applicationStorageMainService);
			await live.clearData();
			return;
		}
		await session.fromPartition(partition.partition).clearData();
	}

	/**
	 * 管理モーダルに出す統計。Electron にはパーティション単位のストレージ使用量を返す API が
	 * 無いので、確実に取れる Cookie 件数だけを返す。取れなければ undefined（UI は「—」）。
	 *
	 * ここでも `BrowserSession` は作らない。管理モーダルを開くだけで全プロファイル分が呼ばれるので、
	 * 作ってしまうと同梱拡張の読み込み・preload 登録・`protocol.handle` という副作用が、ただ一覧を
	 * 眺めただけのプロファイルにまで走る（`session.fromPartition()` 自体がディスク上に何を作るかは
	 * Electron の実装次第なので、そこまでは主張しない）。
	 */
	async getProfileStats(profileId: string): Promise<IParadisBrowserProfileStats> {
		const partition = this._partition(profileId);
		if (!partition) {
			return { cookieCount: undefined, openViewCount: 0 };
		}
		// 開いているタブ数は全ウィンドウ分をここで数える（renderer は自分のウィンドウしか知らない）。
		const openViewCount = this.browserViewMainService.paradisGetBrowserViewIdsForSession(partition.sessionId).length;
		try {
			const cookies = await session.fromPartition(partition.partition).cookies.get({});
			return { cookieCount: cookies.length, openViewCount };
		} catch {
			return { cookieCount: undefined, openViewCount };
		}
	}

	/** 壊れたIDをパーティション名へ持ち込ませないための入り口。 */
	private _partition(profileId: string): IParadisBrowserProfilePartition | undefined {
		return paradisBrowserProfilePartition({ scope: PARADIS_BROWSER_PROFILE_SCOPE, profileId });
	}
}

/** app.ts の PARA-PATCH 点から呼ばれる登録関数。 */
export function paradisRegisterBrowserProfiles(
	channelHost: IParadisBrowserProfileChannelHost,
	instantiationService: IInstantiationService,
): IDisposable {
	const disposables = new DisposableStore();
	const service = instantiationService.createInstance(ParadisBrowserProfilesMainService);
	channelHost.registerChannel(PARADIS_BROWSER_PROFILE_CHANNEL, ProxyChannel.fromService(service, disposables));
	return disposables;
}
