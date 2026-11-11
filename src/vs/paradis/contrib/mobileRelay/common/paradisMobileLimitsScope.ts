/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisLimitsAccount, IParadisLimitsProviderSnapshot, IParadisLimitsSnapshot, IParadisLimitsWindow, paradisLimitsPreviousValue } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { ParadisLimitsHiddenAccounts, paradisIsLimitsAccountHidden } from '../../limitsMonitor/common/paradisLimitsHiddenAccounts.js';

/** モバイルの `limits` の問い合わせのうち、Claude の出どころを決めるのに使う項目。 */
export interface IParadisMobileLimitsRequestTarget {
	readonly ws?: unknown;
	readonly rendererGeneration?: unknown;
	/**
	 * 新しいアプリの使用量の画面が、接続先（SSH など）を選んだときだけ付ける `true`。任意項目なので、
	 * 古いアプリは付けない。
	 */
	readonly claudeHost?: unknown;
}

/**
 * `limits` の問い合わせで、Claude を手元の shared process から取るか。
 *
 * 接続先のウィンドウは Claude に接続先のログインを出す。その値を返すのは、アプリが明示的に頼んだ
 * （`claudeHost: true` を付け、ウィンドウを名指しした＝`ws` を持たず `rendererGeneration` を持つ）問い合わせ
 * だけにする。それ以外は、どのウィンドウに届いても従来どおり手元のアカウントを返す:
 *  - ホームやウィジェット（ウィンドウを選ばずに送り、リレーが最初に見つけたウィンドウへ配る）
 *  - 古いアプリ（使用量の画面はウィンドウを名指しするが、接続先のログインの表示を知らない。接続先の名前も
 *    直し方の文言も出せないので、手元のアカウントのまま見せる）
 */
export function paradisMobileLimitsClaudeFromLocal(target: IParadisMobileLimitsRequestTarget): boolean {
	const hasWorkspace = typeof target.ws === 'string' && target.ws.length > 0;
	const namesWindow = !hasWorkspace && typeof target.rendererGeneration === 'number' && Number.isInteger(target.rendererGeneration);
	return !(namesWindow && target.claudeHost === true);
}

/** モバイルへ送る、控えている間の前の値（5時間・7日・追加の枠）。 */
export interface IParadisMobileLimitsPreviousWindows {
	readonly fiveHour?: IParadisLimitsWindow;
	readonly sevenDay?: IParadisLimitsWindow;
	readonly scoped?: readonly IParadisLimitsWindow[];
}

/** モバイルへ送るアカウント。前の値は任意項目なので、古いアプリは無視する。 */
export interface IParadisMobileLimitsAccount extends IParadisLimitsAccount {
	readonly previousWindows?: IParadisMobileLimitsPreviousWindows;
	readonly previousFetchedAt?: number;
}

/**
 * PC の使用量のパネルで隠したアカウント。アプリが「非表示中のアカウント」に名前を出し、ほかの PC と束ねる
 * ためだけの項目で、使用率は送らない。
 */
export type IParadisMobileLimitsHiddenAccount = Pick<IParadisLimitsAccount, 'provider' | 'id' | 'email' | 'organizationName' | 'accountId' | 'homeLabel'>;

export interface IParadisMobileLimitsProviderSnapshot extends Omit<IParadisLimitsProviderSnapshot, 'accounts'> {
	readonly accounts: readonly IParadisMobileLimitsAccount[];
	/**
	 * PC で隠したアカウント（`accounts` からは除いてある）。隠したものが無ければ項目ごと無い。任意項目なので、
	 * 古いアプリは読まず、隠したアカウントが単に出なくなる。
	 */
	readonly hiddenAccounts?: readonly IParadisMobileLimitsHiddenAccount[];
}

export interface IParadisMobileLimitsSnapshot extends Omit<IParadisLimitsSnapshot, 'claude' | 'codex' | 'antigravity' | 'antigravitySignedOut'> {
	readonly claude: IParadisMobileLimitsProviderSnapshot;
	readonly codex: IParadisMobileLimitsProviderSnapshot;
	/** Antigravity CLI の分（agy を入れていない PC では無い）。任意項目なので、知らないアプリは無視する。 */
	readonly antigravity?: IParadisMobileLimitsProviderSnapshot;
}

/**
 * モバイルへ送るときのアカウント。取れていない（'ok' 以外の）アカウントの枠（`fiveHour`・`sevenDay`・`scoped`）と
 * `fetchedAt` は、今までどおり空にする。古いアプリは状態を見ずに枠を今の値として出す箇所（ホームのカード）があるため。
 *
 * PC が控えている間に残している前の値（{@link paradisLimitsPreviousValue}）は、新しい任意項目の
 * `previousWindows`・`previousFetchedAt` で送る。新しいアプリだけがこれを読み、古さを添えて薄く出す。
 */
export function paradisMobileLimitsAccount(account: IParadisLimitsAccount): IParadisMobileLimitsAccount {
	if (account.status === 'ok') {
		return account;
	}
	const { fiveHour, sevenDay, scoped, fetchedAt, ...rest } = account;
	if (fiveHour === undefined && sevenDay === undefined && scoped === undefined && fetchedAt === undefined) {
		return account;
	}
	// アプリが前の値を出すのは控えている間（'not_fetched'）だけ。取得回数の上限で待っている間の前の値は送らない。
	if (account.unavailableReason !== 'not_fetched' || !paradisLimitsPreviousValue(account, 0)) {
		return rest;
	}
	return {
		...rest,
		previousWindows: {
			...(fiveHour !== undefined ? { fiveHour } : {}),
			...(sevenDay !== undefined ? { sevenDay } : {}),
			...(scoped !== undefined ? { scoped } : {}),
		},
		previousFetchedAt: fetchedAt,
	};
}

function paradisMobileLimitsHiddenAccount(account: IParadisLimitsAccount): IParadisMobileLimitsHiddenAccount {
	const { provider, id, email, organizationName, accountId, homeLabel } = account;
	return {
		provider,
		id,
		...(email !== undefined ? { email } : {}),
		...(organizationName !== undefined ? { organizationName } : {}),
		...(accountId !== undefined ? { accountId } : {}),
		...(homeLabel !== undefined ? { homeLabel } : {}),
	};
}

function paradisMobileLimitsProvider(provider: IParadisLimitsProviderSnapshot, hidden: ParadisLimitsHiddenAccounts): IParadisMobileLimitsProviderSnapshot {
	const visible: IParadisMobileLimitsAccount[] = [];
	const hiddenAccounts: IParadisMobileLimitsHiddenAccount[] = [];
	for (const account of provider.accounts) {
		if (paradisIsLimitsAccountHidden(hidden, account)) {
			hiddenAccounts.push(paradisMobileLimitsHiddenAccount(account));
		} else {
			visible.push(paradisMobileLimitsAccount(account));
		}
	}
	return { ...provider, accounts: visible, ...(hiddenAccounts.length > 0 ? { hiddenAccounts } : {}) };
}

/**
 * モバイルへ送る使用量（{@link paradisMobileLimitsAccount} をすべてのプロバイダに当てる）。PC の使用量のパネルで
 * 隠したアカウント（`hidden`）は `accounts` から除き、`hiddenAccounts` へ移す。
 */
export function paradisMobileLimitsSnapshot(snapshot: IParadisLimitsSnapshot, hidden: ParadisLimitsHiddenAccounts = new Map()): IParadisMobileLimitsSnapshot {
	// antigravitySignedOut（ファイルの更新時刻と大きさ）は PC の中だけで使う印なので送らない
	const { antigravity, antigravitySignedOut: _signedOut, ...rest } = snapshot;
	return {
		...rest,
		claude: paradisMobileLimitsProvider(snapshot.claude, hidden),
		codex: paradisMobileLimitsProvider(snapshot.codex, hidden),
		...(antigravity ? { antigravity: paradisMobileLimitsProvider(antigravity, hidden) } : {}),
	};
}
