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

/**
 * アカウントの取得状態。
 *
 * cswap の usageStatus（json_output.py のセンチネル）と1:1で対応させる。特に以下の2つは
 * 「壊れている」ように見えて壊れていないので、'error' と同列にしてはいけない:
 *  - 'refreshing'   : cswap の 'token_expired'。使用中アカウントのトークンが切れているが、
 *                     所有者である Claude Code 自身が更新する。ユーザーの操作は要らない
 *  - 'unavailable'  : 使用状況を読めていないだけ。cswap は制限に達したアカウントの再取得を
 *                     枠のリセットまで止めるため（レート予算の節約）、日常的にこの状態になる
 *
 * 再ログインが要るのは 'relogin_required'（リフレッシュトークンが失効）・'no_credentials'・
 * 'error' のみ。
 */
export type ParadisLimitsAccountStatus = 'ok' | 'refreshing' | 'relogin_required' | 'no_credentials' | 'unavailable' | 'error';

/** 'unavailable' の内訳。表示の分岐キーにする（statusDetail は自由文字列なので分岐に使わない）。 */
export type ParadisLimitsUnavailableReason = 'not_fetched' | 'api_key' | 'keychain_unavailable';

/** 再ログインで解消し得る状態か（'refreshing'・'unavailable' は再ログインしても直らない）。 */
export function paradisLimitsNeedsRelogin(status: ParadisLimitsAccountStatus): boolean {
	return status === 'relogin_required' || status === 'no_credentials' || status === 'error';
}

/**
 * cswap の usageStatus をこちらの状態へ写す。
 *
 * cswap 側の契約が変わったときに真っ先に壊れる箇所なので、純関数にしてテストできるようにする。
 * 未知の値は 'error'（＝人の対処が要る）に倒す: 黙って「取得できず」に混ぜると、本当に壊れた
 * アカウントが放置される。
 */
export function paradisLimitsStatusFromCswap(usageStatus: string | undefined): { readonly status: ParadisLimitsAccountStatus; readonly unavailableReason?: ParadisLimitsUnavailableReason } {
	switch (usageStatus) {
		case 'ok': return { status: 'ok' };
		case 'token_expired': return { status: 'refreshing' };
		case 'relogin_required': return { status: 'relogin_required' };
		case 'no_credentials': return { status: 'no_credentials' };
		case 'api_key': return { status: 'unavailable', unavailableReason: 'api_key' };
		case 'keychain_unavailable': return { status: 'unavailable', unavailableReason: 'keychain_unavailable' };
		case 'unavailable':
		case undefined: return { status: 'unavailable', unavailableReason: 'not_fetched' };
		default: return { status: 'error' };
	}
}

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
	/** Codex: Para Codeが自動作成した追加ホームで、安全な削除条件を満たすか。 */
	readonly removable?: boolean;
	/** Codex: 同じaccount_idを持つ、自分以外のホームの表示用ラベル。 */
	readonly duplicateHomeLabels?: readonly string[];
	readonly status: ParadisLimitsAccountStatus;
	/** status が 'unavailable' のときの内訳(表示の分岐に使う)。 */
	readonly unavailableReason?: ParadisLimitsUnavailableReason;
	/** 診断用の補足(HTTPエラーや未知のusageStatus生値等)。表示の分岐キーには使わない。 */
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

const CODEX_FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const CODEX_SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

type ParadisCodexLimitWindowRole = 'fiveHour' | 'sevenDay' | 'unknown';

function paradisCodexLimitWindowRole(durationMinutes: number | undefined): ParadisCodexLimitWindowRole {
	switch (durationMinutes) {
		case CODEX_FIVE_HOUR_WINDOW_MINUTES:
			return 'fiveHour';
		case CODEX_SEVEN_DAY_WINDOW_MINUTES:
			return 'sevenDay';
		default:
			return 'unknown';
	}
}

/** Codexのprimary/secondaryを実際の期間から5時間枠・7日枠へ正規化する。 */
export function paradisNormalizeCodexLimitWindows<T>(
	primary: T | null | undefined,
	secondary: T | null | undefined,
	durationMinutes: (window: T) => number | undefined,
): { readonly fiveHour?: T; readonly sevenDay?: T } {
	if (primary !== null && primary !== undefined && secondary !== null && secondary !== undefined) {
		const primaryRole = paradisCodexLimitWindowRole(durationMinutes(primary));
		const secondaryRole = paradisCodexLimitWindowRole(durationMinutes(secondary));
		if (primaryRole === 'sevenDay' && secondaryRole !== 'sevenDay') {
			return { fiveHour: secondary, sevenDay: primary };
		}
		return { fiveHour: primary, sevenDay: secondary };
	}
	if (primary !== null && primary !== undefined) {
		return paradisCodexLimitWindowRole(durationMinutes(primary)) === 'sevenDay'
			? { sevenDay: primary }
			: { fiveHour: primary };
	}
	if (secondary !== null && secondary !== undefined) {
		return paradisCodexLimitWindowRole(durationMinutes(secondary)) === 'sevenDay'
			? { sevenDay: secondary }
			: { fiveHour: secondary };
	}
	return {};
}

/** アカウント追加/再ログインセッションの進行状態。renderer側ダイアログがポーリングで参照する。 */
export type ParadisLimitsSetupPhase =
	| 'starting'
	| 'waiting_browser'
	| 'waiting_code'
	| 'registering'
	| 'waiting_duplicate'
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
	/** Codex: 重複確認時に破棄する新規ホームの絶対パス(ローカルはゴミ箱へ移動、リモートは完全削除)。 */
	readonly homePath?: string;
	/** Codex: 同じaccount_idが見つかった既存ホームの表示用ラベル。 */
	readonly duplicateHomeLabels?: readonly string[];
	readonly error?: string;
}

export interface IParadisLimitsSetupHandle {
	readonly sessionId: string;
}

export type ParadisLimitsDuplicateDecision = 'keep' | 'discard';

export interface IParadisLimitsCodexRemovalTarget {
	readonly homePath: string;
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

/**
 * リセットの絶対時刻を短く整形する（例: '00:30'、日を跨ぐなら '7/29 00:30'）。
 *
 * 相対表記だけだと、7日枠のように残りが長い枠で「結局いつ空くのか」が掴めない。
 * PC・モバイルとも epoch ms だけを運び、見せ方は表示する端末側で決める
 * （PC側で文字列化するとタイムゾーン差がそのまま混入する）。
 */
export function paradisLimitsFormatResetClock(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined || !isFinite(resetsAt) || resetsAt <= now) {
		return undefined;
	}
	const date = new Date(resetsAt);
	const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	return new Date(now).toDateString() === date.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
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
