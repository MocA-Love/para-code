/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「一覧から隠したアカウント」の台帳の読み書きと、隠した対象と同じアカウントかどうかの判定。
// ウィジェット(electron-browser)から DOM とストレージを切り離した部分だけを持つ。

/** 非表示台帳。キーは account.id、値は非表示にした時点の email(分からなければ undefined)。 */
export type ParadisHiddenLimitsAccounts = Map<string, string | undefined>;

/** 判定に必要なアカウントの情報だけを表す。 */
export interface IParadisHideableLimitsAccount {
	readonly id: string;
	readonly email?: string;
}

/**
 * 保存された台帳を読む。**壊れた値は「非表示なし」に倒す。**
 *
 * 旧形式(id の文字列だけの配列)も受け付ける。その頃は email を持っていないので undefined 扱いになり、
 * {@link paradisIsLimitsAccountHidden} の緩い側(id だけで一致とみなす)へ落ちる。
 */
export function paradisParseHiddenLimitsAccounts(raw: string | undefined): ParadisHiddenLimitsAccounts {
	const hidden: ParadisHiddenLimitsAccounts = new Map();
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
		// 壊れた値は無視する(全アカウント表示側に倒す。非表示状態を失うだけで実害はない)
	}
	return hidden;
}

/** 台帳を保存用の JSON にする。読み側が受け付ける新形式(オブジェクトの配列)で書く。 */
export function paradisSerializeHiddenLimitsAccounts(hidden: ReadonlyMap<string, string | undefined>): string {
	return JSON.stringify([...hidden.entries()].map(([id, email]) => ({ id, email })));
}

/**
 * account.id が非表示にした時点と同じアカウントを指しているか。
 *
 * id(ホームパス/スロット番号)は削除→再利用で別アカウントに割り当てられ得るため、
 * 非表示にした時点のemailと食い違ったら「もう同じアカウントではない」とみなし、
 * 台帳から明示的に消さなくても自動的に非表示を解く。
 *
 * ただし両方のemailが分かっているときだけ不一致を見る: node/paradisLimitsMonitorChannel.ts
 * の fetchCodexAccount は auth.json が読めない('error')・アクセストークンが無い
 * ('no_credentials')場合、同じidのままemailを載せずに返す。片方(または両方)が
 * undefinedなだけで「別アカウントになった」と誤判定すると、トークン読み取りが
 * 一時的にこけただけ・ログアウトしただけで、隠していたはずの行が勝手に復活する。
 */
export function paradisIsLimitsAccountHidden(
	hidden: ReadonlyMap<string, string | undefined>,
	account: IParadisHideableLimitsAccount,
): boolean {
	if (!hidden.has(account.id)) {
		return false;
	}
	const hiddenEmail = hidden.get(account.id);
	return hiddenEmail === undefined || account.email === undefined || hiddenEmail === account.email;
}
