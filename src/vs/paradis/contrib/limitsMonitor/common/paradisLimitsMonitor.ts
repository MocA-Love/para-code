/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニター(Claude Code / Codex のレート制限可視化)の共有型定義。
// データ源はshared process側(node/paradisLimitsMonitorChannel.ts)が保有する:
//   - Claude: claude-swap (cswap --list --json) のサブプロセス実行。認証はcswap自身が管理する
//     ため、Para CodeはKeychain/credentialsに一切触れない
//   - Codex: ~/.codex* 各ホームの auth.json を読み、wham/usage API をHTTP直叩き。トークンの
//     リフレッシュ/永続化は行わず、401時のみ `codex app-server` RPC にフォールバックして
//     codex CLI 自身にリフレッシュさせる(auth.jsonへの書き込みを自前で行わないため)

export const PARADIS_LIMITS_MONITOR_CHANNEL = 'paradisLimitsMonitor';

export type ParadisLimitsProvider = 'claude' | 'codex';

/** 1つのレート制限ウィンドウ(5時間枠・7日枠・モデル別枠)。 */
export interface IParadisLimitsWindow {
	/** 使用率(0-100)。 */
	readonly usedPercent: number;
	/** リセット時刻(epoch ms)。APIが返さない場合は undefined。 */
	readonly resetsAt?: number;
	/** モデル別枠の名前(例: 'Fable')。5時間/7日枠では undefined。 */
	readonly label?: string;
}

export type ParadisLimitsAccountStatus = 'ok' | 'token_expired' | 'no_credentials' | 'error';

export interface IParadisLimitsAccount {
	readonly provider: ParadisLimitsProvider;
	/** 安定ID。Claudeは 'claude-swap:<slot>'、Codexはホームの絶対パス。 */
	readonly id: string;
	readonly email?: string;
	/** Claude: cswap上でアクティブなスロットか。 */
	readonly active?: boolean;
	/** Codex: '~/.codex-2' のような表示用ホームラベル。 */
	readonly homeLabel?: string;
	/** Claude: cswapのスロット番号(再ログイン時の --slot 指定に使う)。 */
	readonly slot?: number;
	readonly status: ParadisLimitsAccountStatus;
	/** status が ok 以外のときの補足(cswapのusageStatus生値やHTTPエラー等)。 */
	readonly statusDetail?: string;
	readonly planType?: string;
	readonly fiveHour?: IParadisLimitsWindow;
	readonly sevenDay?: IParadisLimitsWindow;
	readonly scoped?: readonly IParadisLimitsWindow[];
}

export interface IParadisLimitsProviderSnapshot {
	readonly accounts: readonly IParadisLimitsAccount[];
	/** データ源自体が使えない場合の理由(cswap未インストール等)。accountsは空になる。 */
	readonly sourceError?: string;
	/** Claudeのみ: cswap実行ファイルが見つからなかった(パネルでセットアップ案内を出す)。 */
	readonly cswapMissing?: boolean;
}

export interface IParadisLimitsSnapshot {
	readonly claude: IParadisLimitsProviderSnapshot;
	readonly codex: IParadisLimitsProviderSnapshot;
	readonly fetchedAt: number;
}

export interface IParadisLimitsFetchOptions {
	readonly bypassCache?: boolean;
	/** 設定 paradis.limitsMonitor.cswapPath の値(絶対パス)。 */
	readonly cswapPath?: string;
	/** 設定 paradis.limitsMonitor.codexHomes の値(自動走査に追加するホーム)。 */
	readonly codexHomes?: readonly string[];
}

/** アカウント追加/再ログインセッションの進行状態。renderer側ダイアログがポーリングで参照する。 */
export type ParadisLimitsSetupPhase =
	| 'starting'
	| 'waiting_browser'
	| 'waiting_code'
	| 'registering'
	| 'done'
	| 'error';

export interface IParadisLimitsSetupState {
	readonly phase: ParadisLimitsSetupPhase;
	/** ログインURL(ブラウザが自動で開かない場合のフォールバックリンク表示用)。 */
	readonly url?: string;
	/** 完了時に判明したメールアドレス(取れた場合のみ)。 */
	readonly email?: string;
	/** Codex: 追加先ホームの表示ラベル(~/.codex-3 等)。 */
	readonly homeLabel?: string;
	readonly error?: string;
}

export interface IParadisLimitsSetupHandle {
	readonly sessionId: string;
}

export type ParadisLimitsSeverity = 'normal' | 'elevated' | 'high';

const SEVERITY_ELEVATED_PERCENT = 60;
const SEVERITY_HIGH_PERCENT = 85;

export function paradisLimitsSeverity(usedPercent: number): ParadisLimitsSeverity {
	if (usedPercent >= SEVERITY_HIGH_PERCENT) {
		return 'high';
	}
	if (usedPercent >= SEVERITY_ELEVATED_PERCENT) {
		return 'elevated';
	}
	return 'normal';
}

/** アカウントの全ウィンドウの最大使用率(トリガーのリング表示に使う)。データ無しは undefined。 */
export function paradisLimitsWorstPercent(account: IParadisLimitsAccount): number | undefined {
	const values: number[] = [];
	if (account.fiveHour) {
		values.push(account.fiveHour.usedPercent);
	}
	if (account.sevenDay) {
		values.push(account.sevenDay.usedPercent);
	}
	for (const scoped of account.scoped ?? []) {
		values.push(scoped.usedPercent);
	}
	return values.length > 0 ? Math.max(...values) : undefined;
}

/** 'in 3h 23m' / 'in 3d 12h' 形式の残り時間表示。過去や不正値は undefined。 */
export function paradisLimitsFormatCountdown(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !isFinite(resetsAt)) {
		return undefined;
	}
	const remainingMs = resetsAt - now;
	if (remainingMs <= 0) {
		return undefined;
	}
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}
