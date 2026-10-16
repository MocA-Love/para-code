/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバーに出す使用量の集め方・束ね方・並べ方・文字。すべて純関数にしてテストで固定する。
//
// 値は各ウィンドウが取ったもの（手元のウィンドウは手元、SSH のウィンドウは接続先）を出どころごとに
// 受け取る。同じアカウントはモバイル版の合計（app/mobile/src/features/usage/usageAggregate.ts の
// accountMergeKey）と同じ規則で束ね、足さずに新しい方の値を使う。開いていない接続先の値は取りに
// 行かず、前に受け取った値を古さを添えて出す。

import { localize } from '../../../../nls.js';
import type { IParadisLimitsAccount, IParadisLimitsWindow } from '../../limitsMonitor/common/paradisLimitsMonitor.js';
import { IParadisMenuBarAccount, IParadisMenuBarCost, IParadisMenuBarSettings, IParadisMenuBarUsageSource, IParadisMenuBarWindowUsage, ParadisMenuBarProvider } from './paradisMenuBar.js';

/** これより上の使用率は「上限に近い」とみなす（文字の色・「近いときだけ」の表示・余裕の数）。 */
export const PARADIS_MENU_BAR_NEAR_LIMIT_PERCENT = 80;
/** 値がこれより古いと、メニューに「n 分前の値」と添える。 */
export const PARADIS_MENU_BAR_STALE_AFTER_MS = 15 * 60_000;

export const PARADIS_MENU_BAR_PROVIDERS: readonly ParadisMenuBarProvider[] = ['claude', 'codex'];

// ---- limits のスナップショットから送る形へ ------------------------------------------------------

/** メールの @ より前。メールが無ければ `fallback`。 */
export function paradisMenuBarAccountName(email: string | undefined, fallback: string): string {
	const local = email?.split('@')[0]?.trim();
	return local && local.length > 0 ? local : fallback;
}

function windowUsage(window: IParadisLimitsWindow | undefined): IParadisMenuBarWindowUsage | undefined {
	if (!window || !Number.isFinite(window.usedPercent)) {
		return undefined;
	}
	return window.resetsAt !== undefined && Number.isFinite(window.resetsAt)
		? { percent: window.usedPercent, resetsAt: window.resetsAt }
		: { percent: window.usedPercent };
}

export interface IParadisMenuBarLimitsInput {
	readonly claude: { readonly accounts: readonly IParadisLimitsAccount[] };
	readonly codex: { readonly accounts: readonly IParadisLimitsAccount[] };
}

/**
 * 使用量パネルと同じスナップショットから、メニューバーへ送るアカウントを作る。値の無いアカウント
 * （再ログインが要るものなど）は出さない。
 *
 * @param selectedCodexHome そのウィンドウで新しく開くターミナルが使う Codex のホーム（使用中の印）
 */
export function paradisMenuBarAccountsFromLimits(snapshot: IParadisMenuBarLimitsInput, sourceKey: string, remote: boolean, selectedCodexHome: string | undefined): IParadisMenuBarAccount[] {
	const accounts: IParadisMenuBarAccount[] = [];
	const add = (account: IParadisLimitsAccount, provider: ParadisMenuBarProvider, key: string, name: string, active: boolean) => {
		const fiveHour = windowUsage(account.fiveHour);
		const sevenDay = windowUsage(account.sevenDay);
		if (!fiveHour && !sevenDay) {
			return;
		}
		accounts.push({
			provider, key, name, active,
			...(fiveHour ? { fiveHour } : {}),
			...(sevenDay ? { sevenDay } : {}),
			...(account.fetchedAt !== undefined && Number.isFinite(account.fetchedAt) ? { fetchedAt: account.fetchedAt } : {}),
		});
	};
	for (const account of snapshot.claude.accounts) {
		const email = account.email?.trim().toLowerCase();
		const key = email ? `claude|email:${email}|org:${account.organizationName?.trim() ?? ''}` : `claude|source:${sourceKey}|${account.id}`;
		// SSH のウィンドウの Claude は、接続先でいまログインしている 1 アカウントだけが届く
		add(account, 'claude', key, paradisMenuBarAccountName(account.email, 'Claude'), remote || account.active === true);
	}
	for (const account of snapshot.codex.accounts) {
		const key = account.accountId ? `codex|id:${account.accountId}` : `codex|source:${sourceKey}|${account.id}`;
		add(account, 'codex', key, paradisMenuBarAccountName(account.email, account.homeLabel ?? 'Codex'), account.id === selectedCodexHome);
	}
	return accounts;
}

// ---- 束ねる ----------------------------------------------------------------------------------

/** main が覚えている出どころ 1 つ。 */
export interface IParadisMenuBarStoredSource extends IParadisMenuBarUsageSource {
	/** main が受け取った時刻。 */
	readonly receivedAt: number;
}

/** 束ねたアカウント 1 つ。 */
export interface IParadisMenuBarMergedAccount {
	readonly provider: ParadisMenuBarProvider;
	readonly key: string;
	readonly name: string;
	/** このサービスで使用中（横に出す）のアカウント。サービスごとに多くても 1 つ。 */
	readonly current: boolean;
	readonly fiveHour?: IParadisMenuBarWindowUsage;
	readonly sevenDay?: IParadisMenuBarWindowUsage;
	readonly fetchedAt: number;
}

interface IMergeEntry {
	account: IParadisMenuBarAccount;
	fetchedAt: number;
	activeLocal: boolean;
	activeRemote: boolean;
}

/**
 * 出どころの値を束ねる。同じアカウントは新しい方の値を使う。使用中は手元のウィンドウの印を優先し、
 * 手元のウィンドウが無いときだけ接続先の印を使う。
 */
export function paradisMergeMenuBarUsage(sources: readonly IParadisMenuBarStoredSource[], includeRemote: boolean): IParadisMenuBarMergedAccount[] {
	const entries = new Map<string, IMergeEntry>();
	for (const source of sources) {
		if (source.remote && !includeRemote) {
			continue;
		}
		for (const account of source.accounts) {
			const fetchedAt = account.fetchedAt ?? source.fetchedAt;
			const existing = entries.get(account.key);
			const activeLocal = account.active && !source.remote;
			const activeRemote = account.active && source.remote;
			if (!existing) {
				entries.set(account.key, { account, fetchedAt, activeLocal, activeRemote });
				continue;
			}
			existing.activeLocal ||= activeLocal;
			existing.activeRemote ||= activeRemote;
			if (fetchedAt > existing.fetchedAt) {
				existing.account = account;
				existing.fetchedAt = fetchedAt;
			}
		}
	}
	const result: IParadisMenuBarMergedAccount[] = [];
	for (const provider of PARADIS_MENU_BAR_PROVIDERS) {
		const list = [...entries.values()].filter(entry => entry.account.provider === provider);
		const newest = (candidates: IMergeEntry[]) => candidates.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
		const current = newest(list.filter(entry => entry.activeLocal)) ?? newest(list.filter(entry => entry.activeRemote));
		for (const entry of list) {
			result.push({
				provider,
				key: entry.account.key,
				name: entry.account.name,
				current: entry === current,
				...(entry.account.fiveHour ? { fiveHour: entry.account.fiveHour } : {}),
				...(entry.account.sevenDay ? { sevenDay: entry.account.sevenDay } : {}),
				fetchedAt: entry.fetchedAt,
			});
		}
	}
	return result;
}

// ---- 値の読み方 -----------------------------------------------------------------------------

/** 枠の使用率。リセット時刻を過ぎた枠は今の値が分からないので undefined。 */
export function paradisMenuBarPercent(window: IParadisMenuBarWindowUsage | undefined, now: number): number | undefined {
	if (!window || (window.resetsAt !== undefined && window.resetsAt <= now)) {
		return undefined;
	}
	return Math.round(window.percent);
}

/** 設定の「横に出す枠」の値。 */
export function paradisMenuBarHeadlinePercent(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, window: IParadisMenuBarSettings['usageWindow'], now: number): number | undefined {
	const five = paradisMenuBarPercent(account.fiveHour, now);
	const week = paradisMenuBarPercent(account.sevenDay, now);
	switch (window) {
		case 'fiveHour': return five;
		case 'sevenDay': return week;
		case 'higher': return five === undefined ? week : week === undefined ? five : Math.max(five, week);
	}
}

/** 5 時間と週のうち多い方。どちらも分からなければ undefined。 */
function higherPercent(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, now: number): number | undefined {
	return paradisMenuBarHeadlinePercent(account, 'higher', now);
}

/** 5 時間と週のどちらかが上限に達しているか。 */
export function paradisMenuBarExhausted(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, now: number): boolean {
	return (higherPercent(account, now) ?? 0) >= 100;
}

/** 5 時間と週のどちらも上限に近くないか（値が分かるときだけ）。 */
export function paradisMenuBarHasRoom(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, now: number): boolean {
	const higher = higherPercent(account, now);
	return higher !== undefined && higher < PARADIS_MENU_BAR_NEAR_LIMIT_PERCENT;
}

/** あるサービスのアカウントを、使用中・余裕の多い順・上限に達したものの順に並べる。 */
export function paradisSortMenuBarAccounts(accounts: readonly IParadisMenuBarMergedAccount[], provider: ParadisMenuBarProvider, now: number): IParadisMenuBarMergedAccount[] {
	const rank = (account: IParadisMenuBarMergedAccount) => {
		if (account.current) {
			return -1;
		}
		if (paradisMenuBarExhausted(account, now)) {
			return 1000;
		}
		// 値の分からないものは上限に達したものの手前
		return higherPercent(account, now) ?? 500;
	};
	return accounts
		.filter(account => account.provider === provider)
		.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** そのサービスの使用中のアカウント。 */
export function paradisMenuBarCurrentAccount(accounts: readonly IParadisMenuBarMergedAccount[], provider: ParadisMenuBarProvider): IParadisMenuBarMergedAccount | undefined {
	return accounts.find(account => account.provider === provider && account.current);
}

// ---- 横の文字 -------------------------------------------------------------------------------

const PROVIDER_LETTER: Readonly<Record<ParadisMenuBarProvider, string>> = { claude: 'C', codex: 'X' };

/** 横の文字のひとかたまり。`hot` は上限に近い（色を変える）。 */
export interface IParadisMenuBarTitleSegment {
	readonly text: string;
	readonly hot: boolean;
}

function percentText(percent: number | undefined): string {
	return percent === undefined ? '-' : `${percent}%`;
}

/**
 * 横に出す使用量の文字。Claude Code（C）と Codex（X）の使用中のアカウントの値。アカウントが複数あるときは
 * 設定で「余裕のある数／アカウントの数」も出せる。使用中のアカウントが無いサービスは出さない。
 */
export function paradisMenuBarUsageTitle(accounts: readonly IParadisMenuBarMergedAccount[], settings: Pick<IParadisMenuBarSettings, 'usageStyle' | 'usageWindow' | 'multipleAccounts'>, now: number): IParadisMenuBarTitleSegment[] {
	const segments: IParadisMenuBarTitleSegment[] = [];
	for (const provider of PARADIS_MENU_BAR_PROVIDERS) {
		const current = paradisMenuBarCurrentAccount(accounts, provider);
		if (!current) {
			continue;
		}
		const percent = paradisMenuBarHeadlinePercent(current, settings.usageWindow, now);
		const hot = percent !== undefined && percent >= PARADIS_MENU_BAR_NEAR_LIMIT_PERCENT;
		if (settings.usageStyle === 'nearLimit' && !hot) {
			continue;
		}
		const all = accounts.filter(account => account.provider === provider);
		const available = `${all.filter(account => paradisMenuBarHasRoom(account, now)).length}/${all.length}`;
		const letter = PROVIDER_LETTER[provider];
		const mode = all.length > 1 && settings.usageStyle !== 'nearLimit' ? settings.multipleAccounts : 'active';
		switch (mode) {
			case 'active':
				segments.push({ text: `${letter} ${percentText(percent)}`, hot });
				break;
			case 'available':
				segments.push({ text: `${letter} ${available}`, hot: false });
				break;
			case 'both':
				segments.push({ text: `${letter} ${percentText(percent)} ${available}`, hot });
				break;
		}
	}
	return segments;
}

/** バーと輪に使う、Claude Code と Codex の使用中のアカウントの値。 */
export function paradisMenuBarHeadlineValues(accounts: readonly IParadisMenuBarMergedAccount[], window: IParadisMenuBarSettings['usageWindow'], now: number): { readonly claude?: number; readonly codex?: number } {
	const value = (provider: ParadisMenuBarProvider) => {
		const current = paradisMenuBarCurrentAccount(accounts, provider);
		return current ? paradisMenuBarHeadlinePercent(current, window, now) : undefined;
	};
	const claude = value('claude');
	const codex = value('codex');
	return { ...(claude !== undefined ? { claude } : {}), ...(codex !== undefined ? { codex } : {}) };
}

// ---- メニューの行の文字 -----------------------------------------------------------------------

/** 行の「5時間 42%・週 31%」。 */
export function paradisMenuBarAccountLine(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, now: number): string {
	return localize('paradis.menuBar.accountLine', "5時間 {0}・週 {1}", percentText(paradisMenuBarPercent(account.fiveHour, now)), percentText(paradisMenuBarPercent(account.sevenDay, now)));
}

function clock(date: Date): string {
	return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 上限に達しているときだけ「15:52 に戻る」（1 日より先なら「10/18 18:00 に戻る」）。 */
export function paradisMenuBarBackText(account: Pick<IParadisMenuBarMergedAccount, 'fiveHour' | 'sevenDay'>, now: number): string | undefined {
	const reached = [account.fiveHour, account.sevenDay]
		.filter((window): window is IParadisMenuBarWindowUsage => window !== undefined && window.percent >= 100 && window.resetsAt !== undefined && window.resetsAt > now)
		.map(window => window.resetsAt!);
	if (reached.length === 0) {
		return undefined;
	}
	// 両方に達していたら、遅い方まで使えない
	const back = new Date(Math.max(...reached));
	const when = back.getTime() - now < 24 * 60 * 60_000 ? clock(back) : `${back.getMonth() + 1}/${back.getDate()} ${clock(back)}`;
	return localize('paradis.menuBar.backAt', "{0} に戻る", when);
}

/** 使用中のアカウントの値が古いとき、その古さ（分）。新しければ undefined。 */
export function paradisMenuBarStaleMinutes(accounts: readonly IParadisMenuBarMergedAccount[], now: number): number | undefined {
	const current = accounts.filter(account => account.current);
	if (current.length === 0) {
		return undefined;
	}
	const oldest = Math.min(...current.map(account => account.fetchedAt));
	return now - oldest > PARADIS_MENU_BAR_STALE_AFTER_MS ? Math.floor((now - oldest) / 60_000) : undefined;
}

// ---- 今日のコスト ---------------------------------------------------------------------------

export interface IParadisMenuBarTodayCost {
	readonly totalUsd: number;
	readonly parts: readonly { readonly label: string; readonly usd: number }[];
}

function sameLocalDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** 出どころごとの今日のコストを足す。今日取れた値だけを使う（モバイル版の合計と同じ）。 */
export function paradisMenuBarTodayCost(costs: readonly IParadisMenuBarCost[], includeRemote: boolean, now: number): IParadisMenuBarTodayCost | undefined {
	const today = costs.filter(cost => (includeRemote || !cost.remote) && sameLocalDay(cost.fetchedAt, now));
	if (today.length === 0) {
		return undefined;
	}
	return {
		totalUsd: today.reduce((sum, cost) => sum + cost.usd, 0),
		parts: today.map(cost => ({ label: cost.remote ? (cost.label ?? cost.sourceKey) : localize('paradis.menuBar.thisMachine', "この PC"), usd: cost.usd })),
	};
}

export function paradisMenuBarFormatUsd(usd: number): string {
	return `$${usd.toFixed(2)}`;
}
