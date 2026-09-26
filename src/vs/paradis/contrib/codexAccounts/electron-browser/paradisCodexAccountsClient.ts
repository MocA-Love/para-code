/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の Codex アカウントチャネルを呼ぶ薄いクライアント。

import { Event } from '../../../../base/common/event.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisCodexAccountsState,
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
	IParadisCodexResetCredits,
	PARADIS_CODEX_ACCOUNTS_CHANNEL
} from '../common/paradisCodexAccounts.js';

export class ParadisCodexAccountsClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) { }

	private get channel() {
		// 接続先（REH）には生やしていない。台帳と選択はこの PC に1つだけ持つ。
		return this.sharedProcessService.getChannel(PARADIS_CODEX_ACCOUNTS_CHANNEL);
	}

	readResetCredits(homePath: string, bypassCache = false): Promise<IParadisCodexResetCreditOffer> {
		return this.channel.call<IParadisCodexResetCreditOffer>('readResetCredits', [homePath, bypassCache]);
	}

	consumeResetCredit(request: IParadisCodexResetConsumeRequest): Promise<IParadisCodexResetConsumeResult> {
		return this.channel.call<IParadisCodexResetConsumeResult>('consumeResetCredit', [request]);
	}

	/** 読み取り済みのリセットクレジット（ホームの絶対パス → 残り）。app-server は起こさない。 */
	peekResetCredits(): Promise<Record<string, IParadisCodexResetCredits>> {
		return this.channel.call<Record<string, IParadisCodexResetCredits>>('peekResetCredits');
	}

	getState(): Promise<IParadisCodexAccountsState> {
		return this.channel.call<IParadisCodexAccountsState>('getState');
	}

	/** undefined で既定のホームへ戻す。 */
	selectHome(homePath: string | undefined): Promise<IParadisCodexAccountsState> {
		return this.channel.call<IParadisCodexAccountsState>('selectHome', [homePath]);
	}

	/** 選択が変わった（どのウィンドウから変えても届く）。 */
	get onDidChangeState(): Event<IParadisCodexAccountsState> {
		return this.channel.listen<IParadisCodexAccountsState>('onDidChangeState');
	}
}
