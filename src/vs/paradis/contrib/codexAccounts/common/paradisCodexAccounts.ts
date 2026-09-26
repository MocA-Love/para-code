/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント（ホーム）まわりの共有定義。
//
// - リセットクレジット: Codex の使用枠を即時に戻せる権利。残数と期限は app-server の
//   `account/rateLimits/read` の `rateLimitResetCredits`、消費は
//   `account/rateLimitResetCredit/consume`（codex-cli 0.155.1 の JSON-RPC スキーマで確認）。
// - 切替: 新しく開くターミナルへ渡す `CODEX_HOME` の選択。全ウィンドウ共通（q.html Q07）で、
//   正は shared process が持つ（ウィンドウごとの保存にすると食い違うため）。
//
// 実体は shared process 側（node/paradisCodexAccountsService.ts）。renderer はチャネル経由で呼ぶ。

export const PARADIS_CODEX_ACCOUNTS_CHANNEL = 'paradisCodexAccounts';

// ---------- リセットクレジット ----------

/** app-server の `RateLimitResetCreditStatus` と同じ。未知の値は 'unknown' に倒す。 */
export type ParadisCodexResetCreditStatus = 'available' | 'redeeming' | 'redeemed' | 'unknown';

export interface IParadisCodexResetCredit {
	readonly status: ParadisCodexResetCreditStatus;
	/** 期限(epoch ms)。期限の無いクレジットは undefined。 */
	readonly expiresAt?: number;
	/** 付与時刻(epoch ms)。 */
	readonly grantedAt?: number;
}

export interface IParadisCodexResetCredits {
	/** 使える残数。 */
	readonly availableCount: number;
	/** 使えるクレジットのうち最も早い期限(epoch ms)。分からなければ undefined。 */
	readonly nextExpiresAt?: number;
	/**
	 * 明細。app-server が明細を返さないときは undefined（残数だけ分かっている状態）。
	 * 明細は上限付きで返ることがあるので、長さが availableCount と一致するとは限らない。
	 */
	readonly credits?: readonly IParadisCodexResetCredit[];
}

/** 読み取りに失敗したときの理由。表示の分岐に使う。 */
export type ParadisCodexResetCreditsReadError = 'auth' | 'unavailable';

/** 1つのホームについての、リセットクレジットの提示内容。 */
export interface IParadisCodexResetCreditOffer {
	readonly homePath: string;
	/** 取れなかったときは undefined（error に理由）。 */
	readonly credits?: IParadisCodexResetCredits;
	readonly error?: ParadisCodexResetCreditsReadError;
	/**
	 * 確認ダイアログで見せた内容を特定する値。消費の要求にそのまま付けて返してもらい、
	 * その間に内容が変わっていたら（別のウィンドウで使われた等）消費しない。
	 * 残数が 0 のときは入らない。
	 */
	readonly offerRevision?: string;
	/** 前回の消費要求の結果が分からないまま残っている（次の消費は同じ要求の再送になる）。 */
	readonly pendingUnknown?: boolean;
	readonly fetchedAt: number;
}

/** app-server の `ConsumeAccountRateLimitResetCreditOutcome` と同じ。 */
export type ParadisCodexResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/**
 * provider（OpenAI）へ要求を出す前に断った理由。
 * - offerChanged: 確認した時点から残数・期限が変わっている（最新を読み直してから聞き直す）
 * - alreadyAttempted: 同じ提示に対する消費を、別のクリック・別のウィンドウが既に出した
 * - unknownHome: 知らないホームを指している
 * - ledgerUnavailable: 二重消費を防ぐ台帳を読めない（安全側に倒して何もしない）
 */
export type ParadisCodexResetRejection = 'offerChanged' | 'alreadyAttempted' | 'unknownHome' | 'ledgerUnavailable';

export type IParadisCodexResetConsumeResult =
	| { readonly kind: 'consumed'; readonly outcome: ParadisCodexResetOutcome }
	| { readonly kind: 'rejected'; readonly reason: ParadisCodexResetRejection };

export interface IParadisCodexResetConsumeRequest {
	readonly homePath: string;
	readonly offerRevision: string;
	/** 1回の「使う」操作につき1つ。同じ操作を再送するときは同じ値を使う。 */
	readonly idempotencyKey: string;
}

const RESET_OUTCOMES: ReadonlySet<string> = new Set<ParadisCodexResetOutcome>(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

/** app-server の応答の outcome を検証する。知らない値は undefined（呼び出し側で失敗扱い）。 */
export function paradisCodexResetOutcome(value: unknown): ParadisCodexResetOutcome | undefined {
	return typeof value === 'string' && RESET_OUTCOMES.has(value) ? value as ParadisCodexResetOutcome : undefined;
}

function toEpochMs(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		// app-server は秒で返す。ミリ秒で返ってきても壊れないよう、桁で見分ける。
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) {
			return toEpochMs(numeric);
		}
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toStatus(value: unknown): ParadisCodexResetCreditStatus {
	return value === 'available' || value === 'redeeming' || value === 'redeemed' ? value : 'unknown';
}

/**
 * app-server の `rateLimitResetCredits`（`RateLimitResetCreditsSummary`）を正規化する。
 * 形が合わなければ undefined（「リセットクレジットの仕組みが無いアカウント」と同じ扱い）。
 */
export function paradisMapCodexResetCredits(raw: unknown): IParadisCodexResetCredits | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const summary = raw as { availableCount?: unknown; credits?: unknown };
	const rawCount = typeof summary.availableCount === 'string' ? Number(summary.availableCount) : summary.availableCount;
	if (typeof rawCount !== 'number' || !Number.isFinite(rawCount)) {
		return undefined;
	}
	let credits: IParadisCodexResetCredit[] | undefined;
	if (Array.isArray(summary.credits)) {
		credits = [];
		for (const entry of summary.credits) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const credit = entry as { status?: unknown; expiresAt?: unknown; grantedAt?: unknown };
			credits.push({
				status: toStatus(credit.status),
				expiresAt: toEpochMs(credit.expiresAt),
				grantedAt: toEpochMs(credit.grantedAt),
			});
		}
	}
	const expiries = (credits ?? [])
		.filter(credit => credit.status === 'available' && credit.expiresAt !== undefined)
		.map(credit => credit.expiresAt!)
		.sort((a, b) => a - b);
	return {
		availableCount: Math.max(0, Math.floor(rawCount)),
		nextExpiresAt: expiries[0],
		credits,
	};
}

/**
 * 確認ダイアログで見せた提示を特定する値を作る。
 *
 * アカウント・残数・明細・取得時刻を含める。取得し直すと値が変わるので、古い内容を見て
 * 押した「使う」は、新しい内容に対しては通らない（ユーザーは最新の残数を見て判断し直す）。
 */
export function paradisCodexResetOfferRevision(accountId: string | undefined, credits: IParadisCodexResetCredits, fetchedAt: number): string {
	const rows = (credits.credits ?? [])
		.map(credit => [credit.status, credit.expiresAt ?? null, credit.grantedAt ?? null])
		.map(row => JSON.stringify(row))
		.sort();
	return `v1:${JSON.stringify([accountId ?? null, credits.availableCount, credits.nextExpiresAt ?? null, rows, fetchedAt])}`;
}

// ---------- アカウント（ホーム）の一覧と切替 ----------

export interface IParadisCodexHome {
	/** 絶対パス。 */
	readonly homePath: string;
	/** '~/.codex-2' のような表示用ラベル。 */
	readonly label: string;
	/** 選択が無いときに Codex が使う既定のホーム（$CODEX_HOME か ~/.codex）。 */
	readonly isDefault: boolean;
	/** auth.json があるか（ログイン済みか）。 */
	readonly signedIn: boolean;
	/** id_token から読んだメールアドレス（表示用。検証はしない）。 */
	readonly email?: string;
}

/** 全ウィンドウ共通の「新しく開くターミナルで使う Codex のホーム」。 */
export interface IParadisCodexAccountSelection {
	/** 選んだホームの絶対パス。undefined は既定のホーム（ターミナルへ何も渡さない）。 */
	readonly homePath?: string;
	/** 変更のたびに増える。古い通知が新しい選択を上書きしないために使う。 */
	readonly revision: number;
	/** 最後に切り替えた時刻(epoch ms)。 */
	readonly changedAt?: number;
}

export interface IParadisCodexAccountsState {
	readonly homes: readonly IParadisCodexHome[];
	readonly selection: IParadisCodexAccountSelection;
}

/** 選択が指しているホーム。選択が無い・一覧に無いときは既定のホーム。 */
export function paradisSelectedCodexHome(state: IParadisCodexAccountsState): IParadisCodexHome | undefined {
	const selected = state.selection.homePath;
	if (selected !== undefined) {
		const match = state.homes.find(home => home.homePath === selected);
		if (match) {
			return match;
		}
	}
	return state.homes.find(home => home.isDefault);
}

/**
 * 選択から、新しく開くターミナルへ渡す CODEX_HOME を決める。既定のホーム・一覧に無いホーム
 * （消されたアカウント）なら undefined（何も渡さない）。
 */
export function paradisCodexLaunchHomeFor(state: IParadisCodexAccountsState): string | undefined {
	const selected = state.selection.homePath;
	if (selected === undefined) {
		return undefined;
	}
	const home = state.homes.find(candidate => candidate.homePath === selected);
	return home !== undefined && home.signedIn && !home.isDefault ? home.homePath : undefined;
}

/** 実行中のコマンドが Codex の対話画面らしいか。シェル統合が無いときはプロセス名で見る。 */
export function paradisLooksLikeRunningCodex(executingCommand: string | undefined, processName: string | undefined): boolean {
	if (executingCommand !== undefined && executingCommand.trim().length > 0) {
		const first = executingCommand.trim().split(/\s+/)[0] ?? '';
		return /(?:^|[\\/])codex(?:\.cmd|\.exe)?$/i.test(first);
	}
	return processName !== undefined && /^codex(?:\.exe)?$/i.test(processName.trim());
}

/** 会話ログのハードリンクの結果（件数だけ。パスは返さない）。 */
export interface IParadisCodexSessionLinkSummary {
	readonly linked: number;
	readonly skippedExisting: number;
	readonly skippedUnsupported: number;
	readonly failed: number;
}
