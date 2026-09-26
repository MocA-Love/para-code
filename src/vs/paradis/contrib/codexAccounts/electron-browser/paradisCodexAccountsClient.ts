/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の Codex アカウントチャネルを呼ぶ薄いクライアント。

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisCodexResetConsumeRequest,
	IParadisCodexResetConsumeResult,
	IParadisCodexResetCreditOffer,
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
}
