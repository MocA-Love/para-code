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
//  - resetCredits: リセットクレジットの残りと期限（任意項目）。1件ごとの期限（`credits`）も付ける
//
// リセットの残りは、モバイルが使用量を要求するたびに読む（PC で使用量パネルを開いたかどうかに関係なく
// 届けるため）。読み取りは shared process が3分キャッシュするので、HTTP はホームごとに3分に1回まで。
// 読み取りが {@link PARADIS_CODEX_MOBILE_RESET_READ_DEADLINE_MS} 内に終わらないホームは、手元にある読み取り済みの値で返し、
// 読み取りはそのまま続けて次の要求で使う（モバイルへの応答を HTTP の時間切れまで待たせない）。
//
// 既存の項目の形は変えない。選択の読み取りに失敗したら元のスナップショットをそのまま返す。
// SSH の接続先を開いたウィンドウでは、Codex のアカウントは接続先のホームで、選択とリセットも接続先の
// ものを読む（クライアントが接続先のチャネルを呼ぶ）。モバイルは表示するだけで切り替えない。

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IParadisLimitsAccount, IParadisLimitsSnapshot } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisCodexResetCredits, paradisSelectedCodexHome } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';

/** モバイルへの応答のために、リセットの読み取りを待つ時間（既定）。 */
export const PARADIS_CODEX_MOBILE_RESET_READ_DEADLINE_MS = 3_000;

/** モバイルへ送るリセットクレジット（すべて任意。古いアプリは知らない項目を読まない）。 */
export interface IParadisCodexMobileResetCredits {
	readonly availableCount: number;
	/** epoch ms */
	readonly nextExpiresAt?: number;
	/**
	 * 使えるクレジット1件ごとの期限（期限の早い順。期限の無いものは `expiresAt` を省く）。明細が無いときは
	 * 項目ごと省く。明細は上限付きのことがあり、件数が `availableCount` より少ないことがある。
	 */
	readonly credits?: readonly { readonly expiresAt?: number }[];
}

/** モバイルへ送る Codex アカウントの追加項目。 */
export interface IParadisCodexMobileLimitsAccount extends IParadisLimitsAccount {
	readonly resetCredits?: IParadisCodexMobileResetCredits;
}

/** モバイルへ送る形にする（ID は送らない。モバイルは表示するだけで使わない）。 */
export function paradisCodexMobileResetCredits(credits: IParadisCodexResetCredits): IParadisCodexMobileResetCredits {
	const details = credits.credits
		?.filter(credit => credit.status === 'available')
		.map(credit => credit.expiresAt)
		.sort((a, b) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))
		.map(expiresAt => (expiresAt !== undefined ? { expiresAt } : {}));
	return {
		availableCount: credits.availableCount,
		...(credits.nextExpiresAt !== undefined ? { nextExpiresAt: credits.nextExpiresAt } : {}),
		...(details !== undefined ? { credits: details } : {}),
	};
}

export class ParadisCodexMobileLimitsFields {

	private readonly client: ParadisCodexAccountsClient;

	/** @param readDeadlineMs リセットの読み取りを待つ時間（ふつうは {@link PARADIS_CODEX_MOBILE_RESET_READ_DEADLINE_MS}）。 */
	constructor(
		private readonly readDeadlineMs: number,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.client = instantiationService.createInstance(ParadisCodexAccountsClient);
	}

	async addTo(snapshot: IParadisLimitsSnapshot): Promise<IParadisLimitsSnapshot> {
		if (snapshot.codex.accounts.length === 0) {
			return snapshot;
		}
		let selectedHome: string | undefined;
		let credits: Record<string, IParadisCodexResetCredits>;
		try {
			const [state, read] = await Promise.all([this.client.getState(), this.readResetCredits(snapshot.codex.accounts)]);
			selectedHome = paradisSelectedCodexHome(state)?.homePath;
			credits = read;
		} catch {
			return snapshot;
		}
		const accounts = snapshot.codex.accounts.map(account => {
			const resetCredits = credits[account.id];
			const extended: IParadisCodexMobileLimitsAccount = {
				...account,
				...(account.id === selectedHome ? { active: true } : {}),
				...(resetCredits ? { resetCredits: paradisCodexMobileResetCredits(resetCredits) } : {}),
			};
			return extended;
		});
		return { ...snapshot, codex: { ...snapshot.codex, accounts } };
	}

	/**
	 * 値の取れているアカウントのリセットを読む（キャッシュつき）。期限内に読めなかった・読めなかったホームは、
	 * 手元にある読み取り済みの値で埋める。失敗しても例外にしない（リセットの項目が付かないだけ）。
	 */
	private async readResetCredits(accounts: readonly IParadisLimitsAccount[]): Promise<Record<string, IParadisCodexResetCredits>> {
		const homes = accounts.filter(account => account.status === 'ok').map(account => account.id);
		const result: Record<string, IParadisCodexResetCredits> = {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, this.readDeadlineMs); });
		try {
			await Promise.race([
				Promise.all(homes.map(async homePath => {
					try {
						const offer = await this.client.readResetCredits(homePath, false);
						if (offer.credits) {
							result[homePath] = offer.credits;
						}
					} catch {
						// 読めないホームは手元の値で埋める
					}
				})),
				deadline,
			]);
		} finally {
			clearTimeout(timer);
		}
		if (homes.some(homePath => result[homePath] === undefined)) {
			try {
				const peeked = await this.client.peekResetCredits();
				for (const homePath of homes) {
					result[homePath] ??= peeked[homePath];
				}
			} catch {
				// 手元の値も無ければ付けない
			}
		}
		for (const homePath of Object.keys(result)) {
			if (result[homePath] === undefined) {
				delete result[homePath];
			}
		}
		return result;
	}
}
