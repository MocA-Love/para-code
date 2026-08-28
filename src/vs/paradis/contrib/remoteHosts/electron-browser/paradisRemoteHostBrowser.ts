/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 未接続ホストのブラウズ実装 (Electron 専用)。
//
// ホスト一覧も中身の読み取りも shared process のチャネルへ回す。
//
// upstream にも `ISSHRemoteAgentHostService.listSSHConfigHosts()` があるが、あのサービスは
// Agent Sessions ウィンドウのエントリ (sessions.desktop.main.ts) からしか登録されない。
// 通常ウィンドウで注入すると解決に失敗し、この contribution ごと握り潰されて
// 「未接続ホストが1行も出ない + 起動のたびにエラーログ」になる (CLAUDE.md が繰り返し
// 警告している sessions 依存の罠)。パーサ本体は common 層なので node から借りている。
//
// ビュー本体 (browser 層) は Web ビルドにも載るため、DI ではなく
// configureParadisRemoteHostBrowser で差し込む。このファイルが読まれない Web では
// 未接続ホストの行が出ないだけで、他は今までどおり動く。

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { configureParadisRemoteHostBrowser, IParadisRemoteHostBrowser, IParadisSshListing, IParadisSshListRequest, PARADIS_REMOTE_HOSTS_CHANNEL } from '../common/paradisRemoteHosts.js';

/**
 * 同じ場所の一覧を覚えておく時間。
 *
 * ビューの refresh() は展開済みノードを全部読み直すため、スペース台帳の変更や転送完了の
 * たびに ssh が階層のぶんだけ同時に起きる (1本あたり最長20秒)。接続できないホストを
 * 開いたままだと、そのぶんが常時張り付く。短い間だけ結果を使い回して、繰り返しの
 * 読み直しを1本に畳む。
 */
const PARADIS_SSH_LISTING_TTL_MS = 15_000;

class ParadisRemoteHostBrowser extends Disposable implements IWorkbenchContribution, IParadisRemoteHostBrowser {

	static readonly ID = 'paradis.contrib.remoteHostBrowser';

	/** 進行中・直近の一覧取得。キーは `<host>\u0000<path>`。 */
	private readonly listings = new Map<string, { readonly at: number; readonly result: Promise<IParadisSshListing> }>();

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		configureParadisRemoteHostBrowser(this);
		this._register(toDisposable(() => {
			this.listings.clear();
			configureParadisRemoteHostBrowser(undefined);
		}));
	}

	async listConfiguredHosts(): Promise<readonly string[]> {
		try {
			return await this.sharedProcessService
				.getChannel(PARADIS_REMOTE_HOSTS_CHANNEL)
				.call<readonly string[]>('listConfiguredHosts');
		} catch (error) {
			// config が無い・読めないだけなら未接続ホストが出ないだけで済ませる
			// (ビュー全体を失敗させない)
			this.logService.warn('[ParadisRemoteHosts] failed to read ssh config hosts', error);
			return [];
		}
	}

	async listDirectory(host: string, path: string): Promise<IParadisSshListing> {
		const key = `${host}\u0000${path}`;
		const now = Date.now();
		const cached = this.listings.get(key);
		// 進行中のものには相乗りする (同じ場所へ ssh を二重に起こさない)
		if (cached && now - cached.at < PARADIS_SSH_LISTING_TTL_MS) {
			return cached.result;
		}
		const request: IParadisSshListRequest = { host, path };
		const result = this.sharedProcessService
			.getChannel(PARADIS_REMOTE_HOSTS_CHANNEL)
			.call<IParadisSshListing>('listDirectory', request)
			.then(value => {
				if (value.truncated) {
					this.logService.warn(`[ParadisRemoteHosts] listing truncated for ${host}:${path}`);
				}
				return value;
			});
		// 失敗はすぐ捨てる。次に開いたときは (鍵を入れた後などで) 通るかもしれない
		result.catch(() => this.listings.delete(key));
		this.listings.set(key, { at: now, result });
		return result;
	}
}

// ビューは開かれるたびに一覧を取り直すので、差し込みが AfterRestored でも取りこぼさない
registerWorkbenchContribution2(ParadisRemoteHostBrowser.ID, ParadisRemoteHostBrowser, WorkbenchPhase.AfterRestored);
