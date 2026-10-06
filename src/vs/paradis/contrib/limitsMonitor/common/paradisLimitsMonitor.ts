/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニター(Claude Code / Codex のレート制限可視化)の共有型定義。
// データ源はshared process側が保有する:
//   - Claude: node/paradisClaudeAccountService.ts。Claude の使用量 API を直接呼び、アカウントの
//     保存と切り替えもここで行う（以前の claude-swap (cswap) 依存は撤去した）
//   - Codex: node/paradisLimitsMonitorChannel.ts。 ~/.codex* 各ホームの auth.json を読み、wham/usage API をHTTP直叩き。トークンの
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
 * アカウントの取得状態。以下の2つは「壊れている」ように見えて壊れていないので、'error' と
 * 同列にしてはいけない:
 *  - 'refreshing'   : 使用中アカウントのトークンが切れているが、所有者である Claude Code 自身が
 *                     更新する。ユーザーの操作は要らない
 *  - 'unavailable'  : 使用状況を読めていないだけ（まだ取っていない、取得回数の上限で待っている、
 *                     API キーで使っている、キーチェーンが読めない）
 *
 * 再ログインが要るのは 'relogin_required'（リフレッシュトークンが失効）・'no_credentials'・
 * 'error' のみ。
 */
export type ParadisLimitsAccountStatus = 'ok' | 'refreshing' | 'relogin_required' | 'no_credentials' | 'unavailable' | 'error';

/**
 * 'unavailable' の内訳。表示の分岐キーにする（statusDetail は自由文字列なので、分岐には
 * {@link paradisLimitsNotFetchedCause} が知っている決まった値だけを使う）。
 * 'rate_limited' は Claude の使用量 API に 429 を返されて待っている間（時間が経てば戻る）。
 * 'host_not_logged_in' と 'host_fetch_failed' は接続先（SSH・WSL・コンテナなど）の Claude のカードだけで
 * 使う。接続先では Claude を使っていない・API キーで使っている・外へ通信できないことがよくあるので、
 * 「認証情報なし」「エラー」を赤い再ログインの表示にせず、灰色の「取得できず」に落とす
 * （{@link paradisClaudeHostAccountsState}）。
 */
export type ParadisLimitsUnavailableReason = 'not_fetched' | 'api_key' | 'keychain_unavailable' | 'rate_limited' | 'host_not_logged_in' | 'host_fetch_failed';

/**
 * Claude の 'not_fetched' に添える `statusDetail`（モバイルへもこの文字列のまま届く。変えるとモバイルの
 * 説明文の出し分け（app/mobile の usageSummary.ts）が外れるので、変えない）。
 * - SHARED_WITH_CLAUDE_SWAP: claude-swap と同じログインを共有しているかもしれないので、トークンの更新を控えている
 * - SAME_LINEAGE: いまのログインと同じ系列のトークンなので、更新を Claude Code に任せている
 */
export const PARADIS_CLAUDE_DETAIL_SHARED_WITH_CLAUDE_SWAP = 'shared with claude-swap';
export const PARADIS_CLAUDE_DETAIL_SAME_LINEAGE = 'same lineage as the current login';

/**
 * 'not_fetched' の本当の理由。
 * - shared_with_claude_swap / same_lineage: 上の `statusDetail` のとおり（取りに行くのを控えている）
 * - not_yet: まだ一度も取れていない（使用中と控えが入れ替わった直後など）
 */
export type ParadisLimitsNotFetchedCause = 'shared_with_claude_swap' | 'same_lineage' | 'not_yet';

export function paradisLimitsNotFetchedCause(statusDetail: string | undefined): ParadisLimitsNotFetchedCause {
	switch (statusDetail) {
		case PARADIS_CLAUDE_DETAIL_SHARED_WITH_CLAUDE_SWAP: return 'shared_with_claude_swap';
		case PARADIS_CLAUDE_DETAIL_SAME_LINEAGE: return 'same_lineage';
		default: return 'not_yet';
	}
}

/** 値の古さ（「12分前」「3時間前」「2日前」の数と単位）。 */
export interface IParadisLimitsAge {
	readonly amount: number;
	readonly unit: 'minutes' | 'hours' | 'days';
}

export function paradisLimitsAge(at: number, now: number): IParadisLimitsAge {
	const minutes = Math.max(0, Math.floor((now - at) / 60_000));
	if (minutes < 60) {
		return { amount: minutes, unit: 'minutes' };
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? { amount: hours, unit: 'hours' } : { amount: Math.floor(hours / 24), unit: 'days' };
}

/**
 * 取りに行くのを控えている（'not_fetched'）が、前に取れた値を残しているアカウントの見せ方。
 * 前の値が無い・控えていないときは undefined（いつもの説明文を出す）。
 *
 * PC は claude-swap と共有しているかもしれない控えのアカウントのトークンを更新しない。その間も前に取れた
 * 値（枠と取得時刻）を残して送るので、カードは前の値を薄く出し、古さと控えている理由を添える。
 * 古い PC はこの状態で値を送らないので、ここは undefined になり、前と同じ表示になる。
 */
export interface IParadisLimitsPreviousValue {
	readonly age: IParadisLimitsAge;
	readonly cause: ParadisLimitsNotFetchedCause;
}

export function paradisLimitsPreviousValue(account: Pick<IParadisLimitsAccount, 'status' | 'unavailableReason' | 'statusDetail' | 'fetchedAt' | 'fiveHour' | 'sevenDay' | 'scoped'>, now: number): IParadisLimitsPreviousValue | undefined {
	if (account.status !== 'unavailable' || account.unavailableReason !== 'not_fetched' || account.fetchedAt === undefined || !Number.isFinite(account.fetchedAt)) {
		return undefined;
	}
	if (!account.fiveHour && !account.sevenDay && (account.scoped ?? []).length === 0) {
		return undefined;
	}
	return { age: paradisLimitsAge(account.fetchedAt, now), cause: paradisLimitsNotFetchedCause(account.statusDetail) };
}

/**
 * 枠1つの見せ方。リセット時刻を過ぎた枠は、取り直すまで今の使用率が分からないので、古い使用率を出さずに
 * 'reset'（「リセット済み（今の値は不明）」）にする。
 */
export type ParadisLimitsWindowView =
	| { readonly kind: 'value'; readonly percent: number; readonly countdown?: string }
	| { readonly kind: 'reset' };

export function paradisLimitsWindowView(window: IParadisLimitsWindow, now: number): ParadisLimitsWindowView {
	if (window.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt <= now) {
		return { kind: 'reset' };
	}
	const countdown = paradisLimitsFormatCountdown(window.resetsAt, now);
	return countdown !== undefined ? { kind: 'value', percent: window.usedPercent, countdown } : { kind: 'value', percent: window.usedPercent };
}

/** 再ログインで解消し得る状態か（'refreshing'・'unavailable' は再ログインしても直らない）。 */
export function paradisLimitsNeedsRelogin(status: ParadisLimitsAccountStatus): boolean {
	return status === 'relogin_required' || status === 'no_credentials' || status === 'error';
}

export interface IParadisLimitsAccount {
	readonly provider: ParadisLimitsProvider;
	/**
	 * 安定ID。Claude は Para Code に登録したアカウントが 'para-claude:<uuid>'、登録していない
	 * いまのログインが 'claude-live'。Codex はホームの絶対パス。
	 */
	readonly id: string;
	readonly email?: string;
	/** Claude: この PC の Claude Code がいま使っているアカウントか。 */
	readonly active?: boolean;
	/** Claude: Para Code に登録済み（認証情報を保存してあり、切り替えに使える）。 */
	readonly managed?: boolean;
	/** Claude: いまのログインだが Para Code に登録していない（登録ボタンを出す）。 */
	readonly registrable?: boolean;
	/** Claude: 組織名（同じメールで個人と組織を持つ場合の見分け用）。 */
	readonly organizationName?: string;
	/** 使用状況を最後に取れた時刻（epoch ms）。 */
	readonly fetchedAt?: number;
	/** Codex: '~/.codex-2' のような表示用ホームラベル。 */
	readonly homeLabel?: string;
	/** Codex: Para Codeが自動作成した追加ホームで、安全な削除条件を満たすか。 */
	readonly removable?: boolean;
	/** Codex: 同じaccount_idを持つ、自分以外のホームの表示用ラベル。 */
	readonly duplicateHomeLabels?: readonly string[];
	/**
	 * Codex: auth.json の account_id（ChatGPT のアカウント／ワークスペースの ID）の
	 * `sha256('para-code-codex-account-v1:' + account_id)` の hex。モバイルが複数の PC の上限を合わせるとき、
	 * 同じアカウントを1つに束ねる鍵にする（PC ごとの `id` はホームのパスなので使えない）。比べるだけなので生の値は送らない。
	 */
	readonly accountId?: string;
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

/** Claude: claude-swap に登録されていたが、Para Code にはまだ登録していないアカウント（表示のみ）。 */
export interface IParadisLimitsLegacyAccount {
	readonly email: string;
	readonly organizationName?: string;
}

/** Claude: 接続先（SSH など）のログインを出しているときの接続先。 */
export interface IParadisLimitsRemoteHost {
	/** 接続先の表示名（SSH のホスト名など）。分からなければ undefined。 */
	readonly label?: string;
}

export interface IParadisLimitsProviderSnapshot {
	readonly accounts: readonly IParadisLimitsAccount[];
	/** Claude: 移行の案内に出す claude-swap のアカウント（読み取り専用。書き込みはしない）。 */
	readonly legacyAccounts?: readonly IParadisLimitsLegacyAccount[];
	/** データ源自体が使えない場合の理由。accountsは空になる。 */
	readonly sourceError?: string;
	/**
	 * Claude: SSH のウィンドウで、接続先の Claude Code がいまログインしているアカウントだけを出している
	 * （読み取り専用。手元のアカウントの一覧・切り替え・登録は出さない）。手元のウィンドウでは undefined。
	 * モバイルへもこのまま届く（任意項目なので、知らないアプリは無視する）。
	 */
	readonly remoteHost?: IParadisLimitsRemoteHost;
}

export interface IParadisLimitsSnapshot {
	readonly claude: IParadisLimitsProviderSnapshot;
	readonly codex: IParadisLimitsProviderSnapshot;
	/** Codex の分を取り終えた時刻（epoch ms）。Claude の古さはアカウントごとの `fetchedAt` で見る。 */
	readonly fetchedAt: number;
	/** Codex の分が TTL を過ぎた前回の値（裏で取り直している）。古い PC・接続先では未設定。 */
	readonly stale?: boolean;
}

export interface IParadisLimitsFetchOptions {
	readonly bypassCache?: boolean;
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
