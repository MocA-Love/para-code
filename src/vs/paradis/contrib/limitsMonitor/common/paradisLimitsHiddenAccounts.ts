/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisLimitsAccount, IParadisLimitsSnapshot } from './paradisLimitsMonitor.js';

/**
 * AI利用リミットのパネルで「一覧から隠した」アカウントの台帳。
 *
 * パネル（タイトルバーの小窓）・macOS のメニューバー・モバイルへ送る使用量が、同じ台帳と同じ判定で
 * 隠すためにここへまとめる。台帳を書き換えるのはパネルだけ（paradisLimitsMonitorWidget.ts）。
 */

/** 隠したアカウントの `{ id, email }` の配列を JSON で持つストレージキー（プロファイル単位）。 */
export const PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY = 'paradis.limitsMonitor.hiddenAccountIds';

/** 隠したアカウントの id → 隠した時点の email（分からなければ undefined）。 */
export type ParadisLimitsHiddenAccounts = ReadonlyMap<string, string | undefined>;

/** 保存した台帳を読む。壊れた値は空として扱う（全アカウント表示側に倒す。非表示状態を失うだけで実害はない）。 */
export function paradisParseLimitsHiddenAccounts(raw: string | undefined): Map<string, string | undefined> {
	const hidden = new Map<string, string | undefined>();
	if (!raw) {
		return hidden;
	}
	try {
		const entries: unknown = JSON.parse(raw);
		if (Array.isArray(entries)) {
			for (const entry of entries) {
				if (typeof entry === 'string') {
					// 旧形式(id文字列のみ)からの移行。emailは分からないのでundefinedのまま扱う。
					hidden.set(entry, undefined);
				} else if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
					hidden.set(entry.id, typeof entry.email === 'string' ? entry.email : undefined);
				}
			}
		}
	} catch {
		// 壊れた値は無視する
	}
	return hidden;
}

/** いまの台帳をストレージから読む。 */
export function paradisReadLimitsHiddenAccounts(storageService: IStorageService): Map<string, string | undefined> {
	return paradisParseLimitsHiddenAccounts(storageService.get(PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY, StorageScope.PROFILE));
}

/** 台帳をストレージへ書く。 */
export function paradisStoreLimitsHiddenAccounts(storageService: IStorageService, hidden: ParadisLimitsHiddenAccounts): void {
	// Codexの account.id はホームの絶対パス(例: /Users/<user>/.codex-2)で、マシン固有。
	// StorageTarget.USERはSettings Syncの対象になるため、他マシンでは無関係な非表示設定
	// やゴミが乗ってしまう。MACHINEにして同期対象から外す。
	const entries = [...hidden.entries()].map(([id, email]) => ({ id, email }));
	storageService.store(PARADIS_LIMITS_HIDDEN_ACCOUNTS_STORAGE_KEY, JSON.stringify(entries), StorageScope.PROFILE, StorageTarget.MACHINE);
}

/**
 * account.id が非表示にした時点と同じアカウントを指しているか。
 *
 * account.id だけをキーにしない: Codexのidはホームの絶対パスで、削除された分は次の
 * アカウント追加で別のアカウントに再割り当てされ得る(node/paradisLimitsMonitorChannel.ts)。
 * Claude の登録していないいまのログインは常に 'claude-live' で、ログインし直すと別の
 * アカウントを指す。非表示にした時点のemailと食い違ったら「もう同じアカウントではない」とみなし、
 * 台帳から明示的に消さなくても自動的に非表示を解く。
 *
 * ただし両方のemailが分かっているときだけ不一致を見る: fetchCodexAccount は auth.json が読めない
 * ('error')・アクセストークンが無い('no_credentials')場合、同じidのままemailを載せずに返す。
 * 片方(または両方)がundefinedなだけで「別アカウントになった」と誤判定すると、トークン読み取りが
 * 一時的にこけただけ・ログアウトしただけで、隠していたはずの行が勝手に復活する。
 */
export function paradisIsLimitsAccountHidden(hidden: ParadisLimitsHiddenAccounts, account: Pick<IParadisLimitsAccount, 'id' | 'email'>): boolean {
	if (!hidden.has(account.id)) {
		return false;
	}
	const hiddenEmail = hidden.get(account.id);
	return hiddenEmail === undefined || account.email === undefined || hiddenEmail === account.email;
}

/** 隠したアカウントを両方のプロバイダの `accounts` から除いた使用量（macOS のメニューバー向け）。 */
export function paradisLimitsWithoutHidden(snapshot: IParadisLimitsSnapshot, hidden: ParadisLimitsHiddenAccounts): IParadisLimitsSnapshot {
	if (hidden.size === 0) {
		return snapshot;
	}
	return {
		...snapshot,
		claude: { ...snapshot.claude, accounts: snapshot.claude.accounts.filter(account => !paradisIsLimitsAccountHidden(hidden, account)) },
		codex: { ...snapshot.codex, accounts: snapshot.codex.accounts.filter(account => !paradisIsLimitsAccountHidden(hidden, account)) },
	};
}
