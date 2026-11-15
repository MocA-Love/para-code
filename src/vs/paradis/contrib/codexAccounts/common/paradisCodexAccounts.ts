/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント（ホーム）まわりの共有定義。
//
// - リセットクレジット: Codex の使用枠を即時に戻せる権利。残数と期限は ChatGPT のバックエンドの
//   `wham/rate-limit-reset-credits`（app-server の `account/rateLimits/read` の `rateLimitResetCredits`
//   と同じ内容）。Para Code は残りと期限を見せるだけで、使う操作は持たない（Codex 本体・ChatGPT から使う）。
//   読み取りの応答の各クレジットの `id` の根拠は openai/codex のコミット 3a69ec3ef8fb（2026-10-03）の
//   codex-rs/backend-client/src/types.rs:33-35（`RateLimitResetCreditDetails` の `id`）。
// - 切替: 新しく開くターミナルへ渡す `CODEX_HOME` の選択。全ウィンドウ共通で、正は shared process が
//   持つ（ウィンドウごとの保存にすると食い違うため）。SSH の接続先を開いたウィンドウでは、接続先（REH）が
//   同じものを接続先のホームについて持ち、同じ接続先の全ウィンドウで共通になる。
//
// 実体は shared process と REH の node/paradisCodexAccountsService.ts。renderer はチャネル経由で呼ぶ
// （接続中は接続先のチャネル）。

import { paradisLimitsCalendarDayOffset } from '../../limitsMonitor/common/paradisLimitsDates.js';

export const PARADIS_CODEX_ACCOUNTS_CHANNEL = 'paradisCodexAccounts';

/**
 * 切り替えたとき、切替元と切替先のホームの間で会話ログをハードリンクし合うか（既定オン）。
 * 別の組織のアカウントへ会話の中身を持ち込みたくない人のためにオフにできる。
 */
export const PARADIS_CODEX_SHARE_CONVERSATIONS_SETTING = 'paradis.codexAccounts.shareConversations';

/**
 * ウィンドウの設定のうち、接続先（REH）の選択に効かせるもの。REH は利用者の設定（APPLICATION）を
 * 読めないので、ウィンドウが問い合わせのたびに添える。shared process は自分で設定を読むので使わない。
 */
export interface IParadisCodexAccountsClientPreferences {
	readonly shareConversations: boolean;
}

/** チャネルの引数から {@link IParadisCodexAccountsClientPreferences} を取り出す。形が合わなければ undefined。 */
export function paradisCodexAccountsClientPreferences(value: unknown): IParadisCodexAccountsClientPreferences | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const shareConversations = (value as { shareConversations?: unknown }).shareConversations;
	return typeof shareConversations === 'boolean' ? { shareConversations } : undefined;
}

// ---------- リセットクレジット ----------

/** app-server の `RateLimitResetCreditStatus` と同じ。未知の値は 'unknown' に倒す。 */
export type ParadisCodexResetCreditStatus = 'available' | 'redeeming' | 'redeemed' | 'unknown';

export interface IParadisCodexResetCredit {
	/** バックエンドが付けるクレジットの ID（中身は解釈しない。表示には使わない）。 */
	readonly id?: string;
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
	readonly fetchedAt: number;
}

/** クレジットの ID の長さの上限（これを超える値は捨てる）。 */
export const PARADIS_CODEX_RESET_CREDIT_ID_MAX_LENGTH = 200;

/** クレジットの ID として受け付ける値か。空・長すぎる・文字列でないものは undefined。 */
export function paradisCodexResetCreditId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= PARADIS_CODEX_RESET_CREDIT_ID_MAX_LENGTH ? value : undefined;
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
			const credit = entry as { id?: unknown; status?: unknown; expiresAt?: unknown; grantedAt?: unknown };
			const id = paradisCodexResetCreditId(credit.id);
			credits.push({
				...(id !== undefined ? { id } : {}),
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
 * ChatGPT のバックエンド `GET /backend-api/wham/rate-limit-reset-credits` の応答（snake_case）を
 * 正規化する。形が合わなければ undefined。
 */
export function paradisMapCodexBackendResetCredits(raw: unknown): IParadisCodexResetCredits | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const response = raw as { available_count?: unknown; credits?: unknown };
	const credits = Array.isArray(response.credits)
		? response.credits.map(entry => {
			const credit = (entry && typeof entry === 'object' ? entry : {}) as { id?: unknown; status?: unknown; expires_at?: unknown; granted_at?: unknown };
			return { id: credit.id, status: typeof credit.status === 'string' ? credit.status.toLowerCase() : undefined, expiresAt: credit.expires_at, grantedAt: credit.granted_at };
		})
		: undefined;
	const availableCount = typeof response.available_count === 'number'
		? response.available_count
		: credits?.filter(credit => credit.status === 'available').length;
	return paradisMapCodexResetCredits({ availableCount, credits: credits ?? null });
}

/**
 * メーターの下のリセットの1行の決まり（モバイルの usageSummary.ts の `resetCreditsFacts` と同じ。両方のテストが同じ表で確かめる）。
 * - count: 残り回数
 * - nextExpiresAt / nextDayOffset: 使えるもののうち最も早い期限と、それが暦の上で何日後か（期限のあるものが無ければ無い）
 * - hasNoExpiry: 期限の無いものがある
 * - listable: 1件ごとの期限の一覧を開けるか（残りが2回以上で、使えるものの明細が1件でもある）
 */
export interface IParadisCodexResetSummary {
	readonly count: number;
	readonly listable: boolean;
	readonly nextExpiresAt?: number;
	readonly nextDayOffset?: number;
	readonly hasNoExpiry: boolean;
}

export function paradisCodexResetSummary(credits: IParadisCodexResetCredits, now: number): IParadisCodexResetSummary {
	const count = Math.max(0, Math.floor(credits.availableCount));
	const available = credits.credits?.filter(credit => credit.status === 'available');
	const nextExpiresAt = available
		?.map(credit => credit.expiresAt)
		.filter((at): at is number => at !== undefined)
		.sort((a, b) => a - b)[0] ?? credits.nextExpiresAt;
	return {
		count,
		listable: count >= 2 && (available?.length ?? 0) > 0,
		...(count > 0 && nextExpiresAt !== undefined ? { nextExpiresAt, nextDayOffset: paradisLimitsCalendarDayOffset(nextExpiresAt, now) } : {}),
		hasNoExpiry: available?.some(credit => credit.expiresAt === undefined) === true,
	};
}

/**
 * 期限の一覧の1行。
 * - dated: 期限のあるクレジット
 * - noExpiry: 期限の無いクレジット
 * - unknown: 明細が無い・明細が残り回数より少ないときの、期限の分からない残り（`count` 回分）
 */
export type ParadisCodexResetCreditRow =
	| { readonly kind: 'dated'; readonly expiresAt: number }
	| { readonly kind: 'noExpiry' }
	| { readonly kind: 'unknown'; readonly count: number };

/**
 * 残りのリセットを、期限の一覧の行にする（期限の早い順、期限の無いものはその後、期限の分からない残りは最後）。
 *
 * 明細は上限付きで返ることがあり、残り回数と件数が合わないことがある。
 * - 明細が無い: 残り回数ぶんを「期限は不明」の1行にする
 * - 明細が残り回数より少ない: 足りない回数を「ほか N 回（期限は不明）」の1行で足す
 * - 明細が残り回数より多い: 残り回数を正とし、期限の早いものから残り回数ぶんだけ出す
 */
export function paradisCodexResetCreditRows(credits: IParadisCodexResetCredits): ParadisCodexResetCreditRow[] {
	const count = credits.availableCount;
	if (count <= 0) {
		return [];
	}
	if (!credits.credits) {
		return [{ kind: 'unknown', count }];
	}
	const available = credits.credits.filter(credit => credit.status === 'available');
	const dated = available
		.filter(credit => credit.expiresAt !== undefined)
		.sort((a, b) => a.expiresAt! - b.expiresAt!)
		.map((credit): ParadisCodexResetCreditRow => ({ kind: 'dated', expiresAt: credit.expiresAt! }));
	const noExpiry = available
		.filter(credit => credit.expiresAt === undefined)
		.map((): ParadisCodexResetCreditRow => ({ kind: 'noExpiry' }));
	const rows = [...dated, ...noExpiry].slice(0, count);
	if (rows.length < count) {
		rows.push({ kind: 'unknown', count: count - rows.length });
	}
	return rows;
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
	/**
	 * Para Code が hook・MCP などの設定を書いてよいホームか（既定のホーム、Para Code が作った `~/.codex-<数字>`、
	 * 設定で足したもの、一度でも選んだもの）。手で作った名前のホームは、選ぶまで false。古い版は送らない。
	 */
	readonly configurable?: boolean;
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
	/**
	 * 今の選択のホーム（選んでいなければ既定のホーム）の絶対パスを1行だけ書いたファイル（選択を持つマシンの上の
	 * パス）。ターミナルの Codex のランチャー（`resources/paradis/bin/codex`）が起動のたびに読み、開いた後に
	 * 切り替えたターミナルでも今の選択で起動する。書けていなければ undefined。
	 */
	readonly launchHomeFile?: string;
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

/** ターミナルのシェルの下で動いている Codex（shared process がプロセス表で見つけたもの）。 */
export interface IParadisCodexPaneProcess {
	readonly shellPid: number;
	/** その Codex の `CODEX_HOME` を読めたか（自分のプロセスで、macOS / Linux のときだけ読める）。 */
	readonly homeKnown: boolean;
	/** 読めたときの実際のホーム。既定のホームなら undefined（新しく開くターミナルの選択と同じ表し方）。 */
	readonly codexHome?: string;
}

/**
 * 動いている Codex が実際に使っているホーム（既定のホームは undefined）。
 * 1. その Codex のプロセスの `CODEX_HOME` を読めたらそれ（再接続したペインや、手で `CODEX_HOME=… codex`
 *    としたものも正しく分かる）
 * 2. 読めなければ、そのペインを開いたときのホーム（新しく開いたペインだけ覚えている）
 * 3. どちらも無い（再接続したペインで、環境変数も読めない）なら、切替の直前の選択で開いたものとみなす
 */
export function paradisRunningCodexHome(process: IParadisCodexPaneProcess | undefined, paneHome: { readonly known: boolean; readonly homePath?: string }, previous: string | undefined): string | undefined {
	if (process?.homeKnown) {
		return process.codexHome;
	}
	return paneHome.known ? paneHome.homePath : previous;
}

/** 会話ログのハードリンクの結果（件数だけ。パスは返さない）。 */
export interface IParadisCodexSessionLinkSummary {
	readonly linked: number;
	readonly skippedExisting: number;
	/** 前にそのホームにあったのに消されていた（削除・アーカイブ）ので足し戻さなかった数。 */
	readonly skippedRemoved: number;
	/** 出どころが切り替えた2ホームのどちらでもない（または分からない）のでリンクしなかった数。 */
	readonly skippedOtherOrigin: number;
	readonly skippedUnsupported: number;
	readonly failed: number;
	/** 台帳が読めなかったので、リンクせずに作り直した。 */
	readonly ledgerUnavailable?: boolean;
}
