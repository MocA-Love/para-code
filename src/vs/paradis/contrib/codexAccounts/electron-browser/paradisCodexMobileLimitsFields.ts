/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルへ送る使用量（limits）の Codex アカウントに、任意項目を足す。
//
//  - active: 新しく開くターミナルで使う Codex のアカウント（既存の任意項目。今まで Claude にしか
//    入っていなかった。モバイルは既に「使用中」と表示する）
//  - resetCredits: リセットクレジットの残りと期限（新しい任意項目。読み取り済みのものだけ）
//
// 既存の項目の形は変えない。読み取りに失敗したら元のスナップショットをそのまま返す。

import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisLimitsAccount, IParadisLimitsSnapshot } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisCodexResetCredits, paradisSelectedCodexHome } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';

/** モバイルへ送る Codex アカウントの追加項目。 */
export interface IParadisCodexMobileLimitsAccount extends IParadisLimitsAccount {
	readonly resetCredits?: {
		readonly availableCount: number;
		/** epoch ms */
		readonly nextExpiresAt?: number;
	};
}

export class ParadisCodexMobileLimitsFields {

	private readonly client: ParadisCodexAccountsClient;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) {
		this.client = instantiationService.createInstance(ParadisCodexAccountsClient);
	}

	async addTo(snapshot: IParadisLimitsSnapshot): Promise<IParadisLimitsSnapshot> {
		// SSH 中の使用量は接続先のホームを並べている。選択とリセットはこの PC のものなので混ぜない。
		if (this.remoteAgentService.getConnection() || snapshot.codex.accounts.length === 0) {
			return snapshot;
		}
		let selectedHome: string | undefined;
		let credits: Record<string, IParadisCodexResetCredits>;
		try {
			const [state, peeked] = await Promise.all([this.client.getState(), this.client.peekResetCredits()]);
			selectedHome = paradisSelectedCodexHome(state)?.homePath;
			credits = peeked;
		} catch {
			return snapshot;
		}
		const accounts = snapshot.codex.accounts.map(account => {
			const resetCredits = credits[account.id];
			const extended: IParadisCodexMobileLimitsAccount = {
				...account,
				...(account.id === selectedHome ? { active: true } : {}),
				...(resetCredits ? { resetCredits: { availableCount: resetCredits.availableCount, nextExpiresAt: resetCredits.nextExpiresAt } } : {}),
			};
			return extended;
		});
		return { ...snapshot, codex: { ...snapshot.codex, accounts } };
	}
}
