/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から Codex アカウントチャネルを呼ぶ薄いクライアント。
//
// SSH の接続先を開いているウィンドウでは接続先（REH）のチャネルを呼ぶ。接続先の Codex は接続先の
// ホームで動くので、選択・リセットクレジット・動いている Codex の判定もすべて接続先のものを使う。
// 手元のウィンドウは従来どおり shared process。

import { Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	IParadisCodexAccountsClientPreferences,
	IParadisCodexAccountsState,
	IParadisCodexPaneProcess,
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetCredits,
	PARADIS_CODEX_ACCOUNTS_CHANNEL,
	PARADIS_CODEX_SHARE_CONVERSATIONS_SETTING
} from '../common/paradisCodexAccounts.js';

export class ParadisCodexAccountsClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	private get channel() {
		// getConnection() は繋いでいなければ null（接続先のウィンドウでは再接続中も同じ接続を返す）。
		const connection = this.remoteAgentService.getConnection();
		return connection
			? connection.getChannel(PARADIS_CODEX_ACCOUNTS_CHANNEL)
			: this.sharedProcessService.getChannel(PARADIS_CODEX_ACCOUNTS_CHANNEL);
	}

	/** 接続先は利用者の設定を読めないので、選択に効く設定を問い合わせに添える。 */
	private preferences(): IParadisCodexAccountsClientPreferences {
		return { shareConversations: this.configurationService.getValue<unknown>(PARADIS_CODEX_SHARE_CONVERSATIONS_SETTING) !== false };
	}

	readResetCredits(homePath: string, bypassCache = false): Promise<IParadisCodexResetCreditOffer> {
		return this.channel.call<IParadisCodexResetCreditOffer>('readResetCredits', [homePath, bypassCache]);
	}

	consumeResetCredit(request: IParadisCodexResetConsumeRequest): Promise<IParadisCodexResetConsumeResult> {
		return this.channel.call<IParadisCodexResetConsumeResult>('consumeResetCredit', [request]);
	}

	/** 読み取り済みのリセットクレジット（ホームの絶対パス → 残り）。読みに行かない。 */
	peekResetCredits(): Promise<Record<string, IParadisCodexResetCredits>> {
		return this.channel.call<Record<string, IParadisCodexResetCredits>>('peekResetCredits');
	}

	getState(): Promise<IParadisCodexAccountsState> {
		return this.channel.call<IParadisCodexAccountsState>('getState', [this.preferences()]);
	}

	/** undefined で既定のホームへ戻す。 */
	selectHome(homePath: string | undefined): Promise<IParadisCodexAccountsState> {
		return this.channel.call<IParadisCodexAccountsState>('selectHome', [homePath, this.preferences()]);
	}

	/** 渡したシェルのうち、子孫で Codex が動いているものと、読めたらその Codex の実際のホーム。 */
	shellsRunningCodex(shellPids: readonly number[]): Promise<IParadisCodexPaneProcess[]> {
		return this.channel.call<IParadisCodexPaneProcess[]>('shellsRunningCodex', [shellPids]);
	}

	/** 選択が変わった（どのウィンドウから変えても届く）。 */
	get onDidChangeState(): Event<IParadisCodexAccountsState> {
		return this.channel.listen<IParadisCodexAccountsState>('onDidChangeState');
	}
}
