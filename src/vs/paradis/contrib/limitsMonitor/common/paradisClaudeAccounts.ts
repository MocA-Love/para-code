/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のアカウントと使用量のチャネル（shared process）の型。
//
// 使用量の取得とアカウントの保存・切り替えは shared process の1か所にまとめ、全ウィンドウへ同じ
// 結果を配る（アカウントの選択は全ウィンドウ共通、という決定）。SSH で接続先に繋いでいる間も
// このチャネルは手元の shared process に聞く。切り替えるのは「この PC」の Claude のログインで、
// 接続先の Claude のログインには触らない。

import { IParadisLimitsAccount, IParadisLimitsProviderSnapshot, IParadisLimitsRemoteHost } from './paradisLimitsMonitor.js';

export const PARADIS_CLAUDE_ACCOUNTS_CHANNEL = 'paradisClaudeAccounts';

/**
 * SSH の接続先の Claude のログインの使用量を聞くコマンド。チャネルは Codex と同じ
 * `PARADIS_LIMITS_MONITOR_CHANNEL`（REH に生えている方）で、REH だけが答える（shared process には無い）。
 * 引数は {@link IParadisClaudeStateRequest}、戻り値は {@link IParadisClaudeAccountsState}（アカウントは常に1件）。
 */
export const PARADIS_CLAUDE_HOST_STATE_COMMAND = 'getClaudeHostState';

/** 接続先のログインのカードの ID（登録したアカウントやこの PC のログインとは別物）。 */
export const PARADIS_CLAUDE_HOST_ACCOUNT_ID = 'claude-host';

export interface IParadisClaudeAccountsState {
	readonly claude: IParadisLimitsProviderSnapshot;
	/** 表示中のアカウントのうち、いちばん古い取得時刻（epoch ms）。一度も取れていなければ undefined。 */
	readonly oldestFetchedAt?: number;
	/** 切り替えの最中か（ボタンを押せなくする）。 */
	readonly switching: boolean;
}

export interface IParadisClaudeStateRequest {
	/**
	 * 手動の更新。180 秒より古い結果だけ取り直す（それより新しい結果は API を呼ばずにそのまま返す）。
	 * 取り直した結果は `onDidChangeState` で届く。
	 */
	readonly refresh?: boolean;
	/**
	 * 変更の通知を受けて読み直すだけの問い合わせ。「誰かが見ている」とは数えない（数えると、通知 →
	 * 読み直し → 取得 → 通知…の輪で、誰も見ていなくても取得が止まらなくなる）。
	 */
	readonly passive?: boolean;
}

/** 切り替えの結果。IPC 越しに例外の種類を運べないので、結果の値で返す。 */
export type ParadisClaudeSwitchOutcome =
	/** 切り替えた。 */
	| 'switched'
	/** すでにそのアカウントを使っている。 */
	| 'already_active'
	/** ほかの切り替え・登録が進行中。 */
	| 'busy'
	/** いまのログインが Para Code に登録されていない（切り替えると失われるので止めた）。 */
	| 'unmanaged_live'
	/** 指定したアカウントが見つからない。 */
	| 'not_found'
	/** 保存してある認証情報が読めない・使えない（再ログインが要る）。 */
	| 'no_credentials'
	/** Claude Code がトークンを更新している最中で、ロックを取れなかった。少し待てば通る。 */
	| 'locked'
	/**
	 * いま使っているアカウントの最新のトークン（Claude Code が更新したもの）の持ち主を確かめられず、
	 * 保存し直せなかった。そのまま切り替えるとそのアカウントの最新のリフレッシュトークンを失うので
	 * 止めた。通信できるようになれば通る。
	 */
	| 'unverified'
	/** それ以外の失敗。変更は元に戻した。 */
	| 'failed';

export interface IParadisClaudeSwitchResult {
	readonly outcome: ParadisClaudeSwitchOutcome;
	/** 切り替え先のメールアドレス。 */
	readonly email?: string;
	/** 切り替える前に使っていたアカウントのメールアドレス。 */
	readonly previousEmail?: string;
	/** 'failed' のとき、途中まで書いた変更を元に戻せたか。 */
	readonly rolledBack?: boolean;
	/** 診断用の補足（固定の英文。秘密の値は含めない）。 */
	readonly detail?: string;
}

/** いまログインしているアカウントを Para Code に登録した結果。 */
export type ParadisClaudeRegisterOutcome =
	| 'registered'
	| 'updated'
	| 'no_live_login'
	| 'not_oauth'
	| 'busy'
	/** トークンの持ち主を確かめられなかった（通信できない、またはログインの途中で書き換わった）。 */
	| 'unverified'
	| 'failed';

export interface IParadisClaudeRegisterResult {
	readonly outcome: ParadisClaudeRegisterOutcome;
	readonly email?: string;
}

/**
 * アカウント追加・再ログインの失敗の種類。`IParadisLimitsSetupState.error` にこの値が入る
 * （ダイアログが日本語の説明に置き換える。これ以外の値は診断用の英文としてそのまま出す）。
 */
export type ParadisClaudeSetupErrorCode =
	| 'busy'
	| 'cancelled'
	| 'no_credentials'
	| 'no_identity'
	| 'different_account'
	| 'not_found'
	| 'keychain_unavailable'
	| 'unsupported';

/**
 * 接続先のログインのカードに要らない項目（手元の切り替え・登録に使うもの）を落とし、「認証情報なし」と
 * 「エラー」を灰色の「取得できず」に落とす。接続先（SSH・WSL・コンテナ・トンネル）では Claude を使って
 * いない・API キーや環境変数のトークンで使っている・外へ通信できないことがよくあり、赤い「!」と再ログインの
 * 案内を出すと、直す必要の無いものを壊れているように見せてしまう。
 */
function paradisClaudeHostAccount(account: IParadisLimitsAccount): IParadisLimitsAccount {
	const { active: _active, managed: _managed, registrable: _registrable, ...rest } = account;
	if (rest.status === 'no_credentials') {
		return { ...rest, status: 'unavailable', unavailableReason: 'host_not_logged_in' };
	}
	if (rest.status === 'error') {
		return { ...rest, status: 'unavailable', unavailableReason: 'host_fetch_failed' };
	}
	return rest;
}

/**
 * 接続先（SSH など）のウィンドウで出す Claude の状態を組み立てる（接続先のログインだけを出す）。
 *
 * 接続先から届いた状態に接続先の印（`remoteHost`）を付け、手元のアカウントの操作に使う項目
 * （使用中・登録済み・登録できる、claude-swap の案内、切り替え中）は落とす。接続先に聞けなかったときは
 * `state` を undefined にして、`sourceError` に理由を入れる。
 */
export function paradisClaudeHostAccountsState(state: IParadisClaudeAccountsState | undefined, remoteHost: IParadisLimitsRemoteHost, sourceError?: string): IParadisClaudeAccountsState {
	if (!state) {
		return { claude: { accounts: [], sourceError, remoteHost }, switching: false };
	}
	const claude: IParadisLimitsProviderSnapshot = {
		accounts: state.claude.accounts.map(paradisClaudeHostAccount),
		...(state.claude.sourceError !== undefined ? { sourceError: state.claude.sourceError } : {}),
		remoteHost,
	};
	return { claude, ...(state.oldestFetchedAt !== undefined ? { oldestFetchedAt: state.oldestFetchedAt } : {}), switching: false };
}
