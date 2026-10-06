// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PcResourceSummary } from '../../appState.js';
import {
	pcReplyErrorCode,
	type GithubCallCounts,
	type GithubOperationStat,
	type GithubRateLimitEntry,
	type GithubSpaceStat,
	type GithubUsageResult,
	type RateLimitAccount,
	type RateLimitProviderSnapshot,
	type RateLimitsResult,
	type RateLimitWindow,
	type RtkCommandRow,
	type RtkSavingsResult,
	type UsageAgent,
	type UsageDashboardResult,
	type UsageDayData,
	type UsageModelSlice,
} from '../../store.js';
import { dayCost, localDateKey } from '../../usageFormat.js';
import { hasPreviousValue } from '../settings/usageSummary.js';
import type { VoiceUsageResult } from './voiceUsageWire.js';

/**
 * 使用量の「全 PC の合計」（案 B）の算出。画面から切り離した純関数で、`usageAggregate.test.ts` で固定している。
 *
 * 値の出どころ（{@link UsageSourceInfo}）は、ペアリング済みの PC（手元のウィンドウ）と、その PC が開いている
 * SSH の接続先。同じ機械（`machineIdHash` が一致）は1つの {@link UsageEntry} にまとめて1回だけ数える。
 *
 * 足し方は指標ごとに違う:
 *  - コスト・RTK・GitHub の呼び出し件数: 足す（PC ごとのローカルの記録なので重ならない）
 *  - Claude / Codex の上限: アカウントで束ねて1つ（足さない）。束ねる鍵は {@link accountMergeKey}
 *  - GitHub のレート枠: `account.login` で束ねて1つ。届かない古い PC は PC ごとに並べる
 *  - システム: 足さない（PC ごとに1行）
 *
 * オフラインの PC は最後に取れた値を「古い値」（`old`）として合計に入れる。ただし今日のコストは、今日取れた値だけを入れる。
 */

/** 機械のハッシュ（desktop state と `renderers[].host`）を送る PC の capability（PC の広告一覧と同じ名前）。 */
export const USAGE_MACHINE_ID_CAPABILITY = 'usage.machine-id.v1';

export type UsageSourceKind = 'pc' | 'ssh';
/** `voice` は読み上げ（Aivis・ElevenLabs）の使用量（PC の値。`usage.voice.v1` の PC だけ）。 */
export type UsageKind = 'limits' | 'cost' | 'rtk' | 'github' | 'voice';

/** 値の出どころ1つ（ペアリング済みの PC 1台、または PC が開いている SSH の接続先1つ）。 */
export interface UsageSourceInfo {
	/** `pc:<pcId>` か `ssh:<pcId>:<hostId>`（{@link pcSourceKey} / {@link sshSourceKey}）。 */
	readonly key: string;
	readonly kind: UsageSourceKind;
	/** PC の ID（SSH なら、その接続先を開いている PC）。 */
	readonly pcId: string;
	readonly pcName: string;
	/** SSH の接続先の表示名。 */
	readonly hostLabel?: string | undefined;
	/** いま値を取りに行けるか（PC がオンラインで、SSH ならそのウィンドウが応答できる）。 */
	readonly online: boolean;
	/** 機械のハッシュ（PC は desktop state、SSH はその接続先のウィンドウの `host.machineIdHash`）。届かない PC では undefined。 */
	readonly machineIdHash?: string | undefined;
	/** CPU・メモリ・SSD（PC のみ。desktop state の値）。 */
	readonly resources?: PcResourceSummary | undefined;
}

/** 取った値と、その時刻（PC が付けた取得時刻。無ければ受け取った時刻）。 */
export interface Timed<T> {
	readonly value: T;
	readonly at: number;
	/** アプリがこの値を受け取った時刻（取り直していない値の古さを測る。無ければ `at`）。 */
	readonly receivedAt?: number | undefined;
}

/**
 * 受け取ってからこの時間を過ぎた値は、出どころがオンラインでも古い値として扱う（ホーム・ウィジェットでは
 * 取りに行かない SSH の接続先の保存済みの値など）。PC 側の集計の時刻（`at`）ではなく受け取った時刻で測る。
 */
export const USAGE_UNREFRESHED_MS = 15 * 60_000;

/** 出どころ1つぶんの値。 */
export interface SourceUsageValues {
	readonly limits?: Timed<RateLimitsResult> | undefined;
	readonly cost?: Timed<UsageDashboardResult> | undefined;
	readonly rtk?: Timed<RtkSavingsResult> | undefined;
	readonly github?: Timed<GithubUsageResult> | undefined;
	readonly voice?: Timed<VoiceUsageResult> | undefined;
}

/** 1つの機械（同じ機械の出どころをまとめたもの）。「PC ごと」の1行。 */
export interface UsageEntry {
	/** 代表の出どころの鍵（PC を優先）。行を押したときの行き先。 */
	readonly key: string;
	readonly kind: UsageSourceKind;
	readonly pcId: string;
	/** 見出し（PC なら PC の名前、SSH なら接続先の名前）。 */
	readonly label: string;
	/** SSH の接続先なら、それを開いている PC の名前（重複を除いた台帳の順）。 */
	readonly viaPcs: readonly string[];
	/** PC で、同じ機械へ SSH でも繋いでいる（「PC（SSH でも接続中）」）。 */
	readonly alsoViaSsh: boolean;
	/** まとめた出どころの鍵（代表を含む）。 */
	readonly sourceKeys: readonly string[];
	/** まとめた出どころのどれかがいま取りに行ける。 */
	readonly online: boolean;
	readonly resources?: PcResourceSummary | undefined;
	/** 指標ごとに、まとめた出どころのうち取得時刻が最も新しい値。 */
	readonly values: SourceUsageValues;
}

export function pcSourceKey(pcId: string): string {
	return `pc:${pcId}`;
}

export function sshSourceKey(pcId: string, hostId: string): string {
	return `ssh:${pcId}:${hostId}`;
}

/** 出どころの機械のハッシュ（届いていなければ undefined。そのときは別の機械として扱う）。 */
export function machineOf(source: UsageSourceInfo): string | undefined {
	return source.machineIdHash;
}

/**
 * 出どころを機械ごとにまとめる。`machineIdHash` が一致するものは1つにし、PC があれば PC を代表にする。
 * ハッシュが無い出どころは別の機械として扱う。並びは PC（台帳の順）→ SSH の接続先。
 */
export function buildUsageEntries(sources: readonly UsageSourceInfo[], valuesByKey: Readonly<Record<string, SourceUsageValues | undefined>>): UsageEntry[] {
	const ordered = [...sources.filter(source => source.kind === 'pc'), ...sources.filter(source => source.kind === 'ssh')];
	const groups: UsageSourceInfo[][] = [];
	const byMachine = new Map<string, UsageSourceInfo[]>();
	for (const source of ordered) {
		const machine = machineOf(source);
		const existing = machine !== undefined ? byMachine.get(machine) : undefined;
		if (existing !== undefined) {
			existing.push(source);
			continue;
		}
		const group = [source];
		groups.push(group);
		if (machine !== undefined) {
			byMachine.set(machine, group);
		}
	}
	return groups.map(group => {
		const primary = group[0]!;
		const values: { -readonly [K in keyof SourceUsageValues]: SourceUsageValues[K] } = {};
		for (const kind of ['limits', 'cost', 'rtk', 'github', 'voice'] as const) {
			for (const source of group) {
				const candidate = valuesByKey[source.key]?.[kind];
				const current = values[kind];
				if (candidate !== undefined && (current === undefined || candidate.at > current.at)) {
					(values as Record<UsageKind, Timed<unknown> | undefined>)[kind] = candidate;
				}
			}
		}
		const viaPcs = primary.kind === 'ssh' ? [...new Set(group.filter(source => source.kind === 'ssh').map(source => source.pcName))] : [];
		return {
			key: primary.key,
			kind: primary.kind,
			pcId: primary.pcId,
			label: primary.kind === 'pc' ? primary.pcName : (primary.hostLabel ?? primary.pcName),
			viaPcs,
			alsoViaSsh: primary.kind === 'pc' && group.some(source => source.kind === 'ssh'),
			sourceKeys: group.map(source => source.key),
			online: group.some(source => source.online),
			resources: group.find(source => source.resources !== undefined)?.resources,
			values,
		};
	});
}

/** 「PC ごと」の行の見出し（同じ機械へ SSH でも繋いでいれば添える）。 */
export function entryTitle(entry: UsageEntry): string {
	return entry.alsoViaSsh ? `${entry.label}（SSH でも接続中）` : entry.label;
}

/** 「PC ごと」の行の補足（SSH の接続先なら、どの PC から繋いでいるか）。 */
export function entryKindLabel(entry: UsageEntry): string | undefined {
	return entry.kind === 'ssh' ? `${entry.viaPcs.join('・')} から SSH` : undefined;
}

/**
 * 値が古いか（出どころがオフライン、PC が前回の値を返した、または受け取ってから
 * {@link USAGE_UNREFRESHED_MS} を過ぎた＝取り直していない）。
 */
export function isOldValue(entry: UsageEntry, value: Timed<object> | undefined, now: number): boolean {
	return value !== undefined && (!entry.online || staleOf(value) || now - (value.receivedAt ?? value.at) > USAGE_UNREFRESHED_MS);
}

/** PC が前回の値を返したか（`usage`・`limits`・`github` だけが `stale` を送る。`rtk` は送らない）。 */
export function staleOf(value: Timed<object> | undefined): boolean {
	return value !== undefined && (value.value as { stale?: unknown }).stale === true;
}

// --- Claude / Codex の上限 ------------------------------------------------------------

/**
 * PC をまたいで同じアカウントかを決める鍵。束ねられないアカウントは出どころごとの鍵になる。
 *  - Claude: メール（＋組織名があれば組織名）
 *  - Codex: `accountId`（PC が sha256 にして送る）があればそれ。無ければ束ねない（同じメールで別のワークスペースを
 *    持つ人を1つに潰さないため）
 */
export function accountMergeKey(account: RateLimitAccount, entryKey: string): string {
	const email = account.email?.trim().toLowerCase();
	if (account.provider === 'codex') {
		if (account.accountId !== undefined && account.accountId.length > 0) {
			return `codex|id:${account.accountId}`;
		}
	} else if (email !== undefined && email.length > 0) {
		const organization = account.organizationName?.trim();
		return `claude|email:${email}|org:${organization ?? ''}`;
	}
	return `${account.provider}|source:${entryKey}|${account.id}`;
}

/** アカウントを見ている出どころ（チップ1つ）。 */
export interface SeenOn {
	readonly key: string;
	readonly label: string;
	/** その出どころの値が古い（オフラインの PC の最後の値など）。 */
	readonly old: boolean;
}

/** 束ねた1アカウント。 */
export interface AggregatedAccount {
	readonly key: string;
	readonly provider: 'claude' | 'codex';
	/**
	 * 採った値（値の取れているもの → 新しいもの → 取得時刻の新しいもの、の順で選ぶ）。Codex の枠のリセット
	 * （`resetCredits`）だけは、リセットを添えている PC の中から別に選んで差し込む（{@link aggregateAccounts}）。
	 */
	readonly account: RateLimitAccount;
	readonly at: number;
	/** 採った値が古い。 */
	readonly old: boolean;
	/** 採った値の出どころが SSH の接続先の Claude のログインなら、その接続先。 */
	readonly remoteHost: RateLimitProviderSnapshot['remoteHost'];
	/** このアカウントが見えている出どころ（「PC ごと」の並び順）。 */
	readonly seenOn: readonly SeenOn[];
}

interface AccountCandidate {
	readonly account: RateLimitAccount;
	readonly at: number;
	readonly old: boolean;
	readonly remoteHost: RateLimitProviderSnapshot['remoteHost'];
}

/**
 * アカウントの値の取得時刻。PC がアカウントごとに付けた `fetchedAt` を優先し、無ければ応答の時刻
 * （`responseAt` は応答の `fetchedAt`、それも無ければ受け取った時刻。`usageStore.ts` が決める）。
 */
export function accountFetchedAt(account: RateLimitAccount, responseAt: number): number {
	return account.fetchedAt !== undefined && Number.isFinite(account.fetchedAt) ? account.fetchedAt : responseAt;
}

function betterCandidate(a: AccountCandidate, b: AccountCandidate): AccountCandidate {
	const okA = a.account.status === 'ok';
	const okB = b.account.status === 'ok';
	if (okA !== okB) {
		return okA ? a : b;
	}
	// どちらも取れていなければ、控えている間の前の値を持つ方（値を見せられる）
	const previousA = hasPreviousValue(a.account);
	const previousB = hasPreviousValue(b.account);
	if (previousA !== previousB) {
		return previousA ? a : b;
	}
	if (a.old !== b.old) {
		return a.old ? b : a;
	}
	return b.at > a.at ? b : a;
}

/** リセットを添えている値どうしで、新しいもの（古くない → 取得時刻の新しいもの）を選ぶ。 */
function betterResetCandidate(a: AccountCandidate, b: AccountCandidate): AccountCandidate {
	if (a.old !== b.old) {
		return a.old ? b : a;
	}
	return b.at > a.at ? b : a;
}

/**
 * アカウントごとに束ねる。並びは見つかった順（「PC ごと」の並び → PC 側の並び）。
 * 接続先にログインが無い（`host_not_logged_in`）ものは数えない（その接続先では使っていない）。
 *
 * Codex の枠のリセット（`resetCredits`）は、採った値の PC が添えていない（古い PC・読めなかった）ことがある。
 * そのまま採るとリセットの行が消えるので、リセットだけはリセットを添えている PC の中の新しい値から採る。
 */
export function aggregateAccounts(entries: readonly UsageEntry[], provider: 'claude' | 'codex', now: number): AggregatedAccount[] {
	const order: string[] = [];
	const best = new Map<string, AccountCandidate>();
	const bestReset = new Map<string, AccountCandidate>();
	const seen = new Map<string, SeenOn[]>();
	for (const entry of entries) {
		const limits = entry.values.limits;
		if (limits === undefined) {
			continue;
		}
		const snapshot = limits.value[provider];
		const old = isOldValue(entry, limits, now);
		for (const account of snapshot.accounts) {
			if (account.status === 'unavailable' && account.unavailableReason === 'host_not_logged_in') {
				continue;
			}
			const key = accountMergeKey(account, entry.key);
			const candidate: AccountCandidate = { account, at: accountFetchedAt(account, limits.at), old, remoteHost: snapshot.remoteHost };
			const current = best.get(key);
			if (current === undefined) {
				order.push(key);
				best.set(key, candidate);
				seen.set(key, []);
			} else {
				best.set(key, betterCandidate(current, candidate));
			}
			if (account.resetCredits !== undefined) {
				const currentReset = bestReset.get(key);
				bestReset.set(key, currentReset === undefined ? candidate : betterResetCandidate(currentReset, candidate));
			}
			const chips = seen.get(key)!;
			if (!chips.some(chip => chip.key === entry.key)) {
				chips.push({ key: entry.key, label: entry.label, old });
			}
		}
	}
	return order.map(key => {
		const chosen = best.get(key)!;
		const resetSource = bestReset.get(key);
		const account = resetSource !== undefined && resetSource.account.resetCredits !== chosen.account.resetCredits
			? { ...chosen.account, resetCredits: resetSource.account.resetCredits }
			: chosen.account;
		return { key, provider, account, at: chosen.at, old: chosen.old, remoteHost: chosen.remoteHost, seenOn: seen.get(key) ?? [] };
	});
}

/** 枠のリセット時刻を過ぎているか（過ぎた枠の使用率は、取り直すまで確かでない）。 */
export function isWindowExpired(window: RateLimitWindow | undefined, now: number): boolean {
	return window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt <= now;
}

/** 確かな使用率。リセット時刻を過ぎた枠は undefined（並び替え・ウィジェットの選択に使わない）。 */
export function windowPercent(window: RateLimitWindow | undefined, now: number): number | undefined {
	return window !== undefined && Number.isFinite(window.usedPercent) && !isWindowExpired(window, now) ? window.usedPercent : undefined;
}

/** ホームのカードに出すアカウントの数（provider ごと。残りは「ほか N 件」）。 */
export const HOME_ACCOUNTS_PER_PROVIDER = 2;

/**
 * ホームのカードに出すアカウントの順。値の取れているものを、いま使っているもの → 5時間の使用率の高いものの順に
 * （リセット時刻を過ぎた枠の使用率は数えない）。値の取れているものが1つも無ければ、状態を伝えるために先頭の1つだけ。
 */
export function homeAccounts(accounts: readonly AggregatedAccount[], now: number): AggregatedAccount[] {
	const ok = accounts.filter(item => item.account.status === 'ok');
	if (ok.length === 0) {
		return accounts.slice(0, 1);
	}
	return [...ok].sort((a, b) => {
		const activeA = a.account.active === true ? 1 : 0;
		const activeB = b.account.active === true ? 1 : 0;
		if (activeA !== activeB) {
			return activeB - activeA;
		}
		return (windowPercent(b.account.fiveHour, now) ?? -1) - (windowPercent(a.account.fiveHour, now) ?? -1);
	});
}

/**
 * ウィジェットの「全 PC の合計」に出すアカウント。新しい値（オフラインの PC の最後の値ではない）で値の取れたもののうち、
 * 5 時間の使用率が最も高いもの（いちばん先に上限に届くもの）。リセット時刻を過ぎた枠は数えない。
 */
export function widgetAccount(accounts: readonly AggregatedAccount[], now: number): RateLimitAccount | undefined {
	let best: { account: RateLimitAccount; percent: number } | undefined;
	for (const item of accounts) {
		const percent = windowPercent(item.account.fiveHour, now);
		if (item.old || item.account.status !== 'ok' || percent === undefined) {
			continue;
		}
		if (best === undefined || percent > best.percent) {
			best = { account: item.account, percent };
		}
	}
	return best?.account;
}

/** 「PC 3 台・接続先 1」（出どころの数。全 PC の合計の見出しに添える）。 */
export function scopeCountLabel(entries: readonly UsageEntry[]): string {
	const pcs = entries.filter(entry => entry.kind === 'pc').length;
	const remotes = entries.length - pcs;
	return remotes > 0 ? `PC ${pcs} 台・接続先 ${remotes}` : `PC ${pcs} 台`;
}

/** 上限を1つでも取れた出どころがあるか（「読み込み中」と「アカウントが無い」を分けるため）。 */
export function hasAnyLimits(entries: readonly UsageEntry[]): boolean {
	return entries.some(entry => entry.values.limits !== undefined);
}

/** アカウントが1つも無いときの説明に使う、最も新しい provider のスナップショット。 */
export function latestProviderSnapshot(entries: readonly UsageEntry[], provider: 'claude' | 'codex'): RateLimitProviderSnapshot | undefined {
	let latest: Timed<RateLimitsResult> | undefined;
	for (const entry of entries) {
		const limits = entry.values.limits;
		if (limits !== undefined && (latest === undefined || limits.at > latest.at)) {
			latest = limits;
		}
	}
	return latest?.value[provider];
}

// --- コスト（ccusage） ------------------------------------------------------------------

function isSameLocalDay(at: number, now: number): boolean {
	return localDateKey(new Date(at)) === localDateKey(new Date(now));
}

/**
 * 複数の出どころのダッシュボードを1つに足す。日付・モデル（＋エージェント）ごとに足し、プロジェクトは名前で、
 * セッションは新しい順に並べ直す。今日より前に取った値の今日以降の行は入れない（今日のコストは今日取れた分だけ）。
 * 1つも無ければ undefined。
 */
export function mergeUsageDashboards(items: readonly Timed<UsageDashboardResult>[], now: number): UsageDashboardResult | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const today = localDateKey(new Date(now));
	const days = new Map<string, Map<string, UsageModelSlice>>();
	const projects = new Map<string, { name: string; rawName: string; costs: Map<string, number> }>();
	const sessions: UsageDashboardResult['sessions'] = [];
	const failedReports: string[] = [];
	let block: UsageDashboardResult['block'];
	let fetchedAt = Number.POSITIVE_INFINITY;
	for (const item of items) {
		const data = item.value;
		const fresh = isSameLocalDay(item.at, now);
		fetchedAt = Math.min(fetchedAt, item.at);
		for (const day of data.days) {
			if (!fresh && day.date >= today) {
				continue;
			}
			const models = days.get(day.date) ?? new Map<string, UsageModelSlice>();
			days.set(day.date, models);
			for (const slice of day.models) {
				const key = `${slice.agent}\u0000${slice.model}`;
				const existing = models.get(key);
				models.set(key, existing === undefined ? { ...slice } : {
					...existing,
					cost: existing.cost + slice.cost,
					inputTokens: existing.inputTokens + slice.inputTokens,
					outputTokens: existing.outputTokens + slice.outputTokens,
					cacheCreationTokens: existing.cacheCreationTokens + slice.cacheCreationTokens,
					cacheReadTokens: existing.cacheReadTokens + slice.cacheReadTokens,
				});
			}
		}
		for (const project of data.projects) {
			const entry = projects.get(project.name) ?? { name: project.name, rawName: project.rawName, costs: new Map<string, number>() };
			projects.set(project.name, entry);
			for (const daily of project.dailyCosts) {
				if (!fresh && daily.date >= today) {
					continue;
				}
				entry.costs.set(daily.date, (entry.costs.get(daily.date) ?? 0) + daily.cost);
			}
		}
		sessions.push(...data.sessions);
		failedReports.push(...data.failedReports);
		// 進行中のブロック（5時間）は出どころごとに別物なので、まだ終わっていないものだけを足す。
		if (data.block !== undefined && data.block.endTime > now) {
			block = block === undefined ? { ...data.block } : {
				startTime: Math.min(block.startTime, data.block.startTime),
				endTime: Math.max(block.endTime, data.block.endTime),
				costUSD: block.costUSD + data.block.costUSD,
				...(block.costPerHour !== undefined || data.block.costPerHour !== undefined ? { costPerHour: (block.costPerHour ?? 0) + (data.block.costPerHour ?? 0) } : {}),
			};
		}
	}
	const mergedDays: UsageDayData[] = [...days.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, models]) => ({ date, models: [...models.values()] }));
	return {
		days: mergedDays,
		...(block !== undefined ? { block } : {}),
		sessions: sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)),
		projects: [...projects.values()].map(project => ({
			name: project.name,
			rawName: project.rawName,
			dailyCosts: [...project.costs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, cost]) => ({ date, cost })),
		})),
		failedReports: [...new Set(failedReports)],
		fetchedAt,
	};
}

/** 「PC ごと」の今日のコストの1行。 */
export interface CostRow {
	readonly key: string;
	readonly label: string;
	/** 今日取れた値の今日のコスト。今日取れていなければ undefined。 */
	readonly today: number | undefined;
	readonly at: number | undefined;
	readonly old: boolean;
}

export interface CostSummary {
	/** 全出どころを足したダッシュボード（{@link mergeUsageDashboards}）。 */
	readonly merged: UsageDashboardResult | undefined;
	/** 今日取れた出どころの今日のコストの合計。今日取れたものが1つも無ければ undefined。 */
	readonly today: number | undefined;
	readonly rows: readonly CostRow[];
	/** 今日の値が無い（今日まだ取れていない）出どころの見出し。合計に入っていないことを書くため。 */
	readonly missingToday: readonly string[];
}

/**
 * 今日のコストの合計だけ（ホーム用の軽い版。ダッシュボードを足し合わせない）。今日取れた出どころだけを足し、
 * どこからも今日取れていなければ undefined。
 */
export function todayCostTotal(entries: readonly UsageEntry[], now: number, agent: UsageAgent | 'all' = 'all'): number | undefined {
	const todayKey = localDateKey(new Date(now));
	let total: number | undefined;
	for (const entry of entries) {
		const cost = entry.values.cost;
		if (cost === undefined || !isSameLocalDay(cost.at, now)) {
			continue;
		}
		const row = cost.value.days.find(day => day.date === todayKey);
		total = (total ?? 0) + (row !== undefined ? dayCost(row, agent) : 0);
	}
	return total;
}

export function summarizeCost(entries: readonly UsageEntry[], now: number, agent: UsageAgent | 'all' = 'all'): CostSummary {
	const items: Timed<UsageDashboardResult>[] = [];
	const rows: CostRow[] = [];
	const missingToday: string[] = [];
	let today: number | undefined;
	const todayKey = localDateKey(new Date(now));
	for (const entry of entries) {
		const cost = entry.values.cost;
		if (cost !== undefined) {
			items.push(cost);
		}
		const fresh = cost !== undefined && isSameLocalDay(cost.at, now);
		const row = fresh ? cost.value.days.find(day => day.date === todayKey) : undefined;
		const value = fresh ? (row !== undefined ? dayCost(row, agent) : 0) : undefined;
		if (value !== undefined) {
			today = (today ?? 0) + value;
		} else {
			missingToday.push(entry.label);
		}
		rows.push({ key: entry.key, label: entry.label, today: value, at: cost?.at, old: isOldValue(entry, cost, now) });
	}
	return { merged: mergeUsageDashboards(items, now), today, rows, missingToday };
}

// --- RTK -------------------------------------------------------------------------------

/**
 * 複数の出どころの RTK を1つに足す。日別・累計は足し、コマンドは名前で束ねる（平均の削減率は回数で重み付け）。
 * 直近のコマンドは年を持たない表示なので並べ替えず、出どころの名前を添えて順に並べる。
 */
export function mergeRtk(items: readonly { readonly label: string; readonly value: RtkSavingsResult; readonly at: number }[]): RtkSavingsResult | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const days = new Map<string, { commands: number; inputTokens: number; savedTokens: number }>();
	const commands = new Map<string, RtkCommandRow>();
	const totals = { commands: 0, inputTokens: 0, savedTokens: 0 };
	const history: RtkSavingsResult['history'] = [];
	const failedReports: string[] = [];
	let fetchedAt = Number.POSITIVE_INFINITY;
	const labelled = items.length > 1;
	for (const item of items) {
		const data = item.value;
		fetchedAt = Math.min(fetchedAt, item.at);
		for (const day of data.days) {
			const existing = days.get(day.date) ?? { commands: 0, inputTokens: 0, savedTokens: 0 };
			days.set(day.date, {
				commands: existing.commands + day.commands,
				inputTokens: existing.inputTokens + day.inputTokens,
				savedTokens: existing.savedTokens + day.savedTokens,
			});
		}
		totals.commands += data.totals.commands;
		totals.inputTokens += data.totals.inputTokens;
		totals.savedTokens += data.totals.savedTokens;
		for (const row of data.commands) {
			const existing = commands.get(row.command);
			if (existing === undefined) {
				commands.set(row.command, { ...row });
			} else {
				const count = existing.count + row.count;
				commands.set(row.command, {
					command: row.command,
					count,
					savedTokens: existing.savedTokens + row.savedTokens,
					avgSavingsPct: count > 0 ? (existing.avgSavingsPct * existing.count + row.avgSavingsPct * row.count) / count : 0,
				});
			}
		}
		history.push(...data.history.map(entry => (labelled ? { ...entry, timestampLabel: `${item.label} · ${entry.timestampLabel}` } : entry)));
		failedReports.push(...data.failedReports);
	}
	return {
		days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, ...day })),
		totals,
		commands: [...commands.values()].sort((a, b) => b.savedTokens - a.savedTokens),
		history,
		failedReports: [...new Set(failedReports)],
		fetchedAt,
	};
}

/** 「PC ごと」の RTK の1行（今日と累計の節約トークン）。 */
export interface RtkRow {
	readonly key: string;
	readonly label: string;
	readonly today: number | undefined;
	readonly total: number | undefined;
	readonly at: number | undefined;
	readonly old: boolean;
}

export function summarizeRtk(entries: readonly UsageEntry[], now: number): { readonly merged: RtkSavingsResult | undefined; readonly rows: readonly RtkRow[] } {
	const todayKey = localDateKey(new Date(now));
	const items = entries
		.filter(entry => entry.values.rtk !== undefined)
		.map(entry => ({ label: entry.label, value: entry.values.rtk!.value, at: entry.values.rtk!.at }));
	const rows = entries.map(entry => {
		const rtk = entry.values.rtk;
		return {
			key: entry.key,
			label: entry.label,
			today: rtk !== undefined ? (rtk.value.days.find(day => day.date === todayKey)?.savedTokens ?? 0) : undefined,
			total: rtk?.value.totals.savedTokens,
			at: rtk?.at,
			old: isOldValue(entry, rtk, now),
		};
	});
	return { merged: mergeRtk(items), rows };
}

// --- GitHub ----------------------------------------------------------------------------

/** GitHub のアカウント1つぶんのレート枠（`login` が届かない PC は PC ごとに1つ）。 */
export interface GithubAccountLimits {
	readonly key: string;
	/** GitHub のアカウント。届かない古い PC は undefined（見出しは PC の名前）。 */
	readonly login: string | undefined;
	readonly label: string;
	readonly rateLimits: readonly GithubRateLimitEntry[];
	readonly rateLimitError: string | undefined;
	readonly ghAvailable: boolean;
	readonly at: number;
	readonly old: boolean;
	readonly seenOn: readonly SeenOn[];
}

/** GitHub の値の取得時刻（新しい PC は `fetchedAt`、古い PC は `generatedAt`）。 */
export function githubFetchedAt(data: GithubUsageResult): number {
	return data.fetchedAt ?? data.generatedAt;
}

/**
 * レート枠をアカウントで束ねる。同じアカウントは足さず、レート枠の取れているもの → 新しいもの → 取得時刻の
 * 新しいもの、の順に1つを採る。`account.login` が届かない PC は束ねずに PC ごとに並べる。
 */
export function aggregateGithubAccounts(entries: readonly UsageEntry[], now: number): GithubAccountLimits[] {
	const order: string[] = [];
	const chosen = new Map<string, GithubAccountLimits>();
	for (const entry of entries) {
		const github = entry.values.github;
		if (github === undefined) {
			continue;
		}
		const login = github.value.account?.login;
		const key = login !== undefined && login.length > 0 ? `login:${login.toLowerCase()}` : `source:${entry.key}`;
		const old = isOldValue(entry, github, now);
		const candidate: GithubAccountLimits = {
			key,
			login,
			label: login ?? entry.label,
			rateLimits: github.value.rateLimits,
			rateLimitError: github.value.rateLimitError,
			ghAvailable: github.value.ghAvailable,
			at: github.at,
			old,
			seenOn: [],
		};
		const current = chosen.get(key);
		const chip: SeenOn = { key: entry.key, label: entry.label, old };
		if (current === undefined) {
			order.push(key);
			chosen.set(key, { ...candidate, seenOn: [chip] });
			continue;
		}
		const seenOn = [...current.seenOn, chip];
		const hasA = current.rateLimits.length > 0;
		const hasB = candidate.rateLimits.length > 0;
		const pickB = hasA !== hasB ? hasB : current.old !== candidate.old ? current.old : candidate.at > current.at;
		chosen.set(key, { ...(pickB ? candidate : current), seenOn });
	}
	return order.map(key => chosen.get(key)!);
}

function mergeCounts(a: GithubCallCounts, b: GithubCallCounts): GithubCallCounts {
	const calls = a.calls + b.calls;
	const lastRunAt = Math.max(a.lastRunAt ?? 0, b.lastRunAt ?? 0);
	return {
		calls,
		failures: a.failures + b.failures,
		rateLimited: a.rateLimited + b.rateLimited,
		avgDurationMs: calls > 0 ? (a.avgDurationMs * a.calls + b.avgDurationMs * b.calls) / calls : 0,
		maxDurationMs: Math.max(a.maxDurationMs, b.maxDurationMs),
		...(lastRunAt > 0 ? { lastRunAt } : {}),
	};
}

function weightedRatio(a: number, aWeight: number, b: number, bWeight: number): number {
	const total = aWeight + bWeight;
	return total > 0 ? (a * aWeight + b * bWeight) / total : (a + b) / 2;
}

/**
 * 呼び出し件数を足した1つのスナップショット（内訳の画面にそのまま渡せる形）。レート枠と消費の推移は
 * アカウント単位の値なので空にする（レート枠は {@link aggregateGithubAccounts} で出す）。
 */
export function mergeGithub(items: readonly GithubUsageResult[]): GithubUsageResult | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const operations = new Map<string, GithubOperationStat>();
	const spaces = new Map<string, GithubSpaceStat>();
	const totals = { sessionCalls: 0, sessionFailures: 0, rolling5mCalls: 0, rolling5mFailures: 0, rolling5mRateLimited: 0 };
	const lastErrors: GithubUsageResult['lastErrors'] = [];
	let generatedAt = 0;
	let sessionStartedAt = Number.POSITIVE_INFINITY;
	for (const data of items) {
		generatedAt = Math.max(generatedAt, data.generatedAt);
		sessionStartedAt = Math.min(sessionStartedAt, data.sessionStartedAt);
		for (const op of data.operations) {
			const key = `${op.callSite}\u0000${op.resource}`;
			const existing = operations.get(key);
			if (existing === undefined) {
				operations.set(key, { ...op });
				continue;
			}
			const newerError = (op.lastErrorAt ?? 0) > (existing.lastErrorAt ?? 0) ? op : existing;
			const lastRunAt = Math.max(existing.lastRunAt ?? 0, op.lastRunAt ?? 0);
			operations.set(key, {
				callSite: op.callSite,
				resource: op.resource,
				session: mergeCounts(existing.session, op.session),
				rolling5m: mergeCounts(existing.rolling5m, op.rolling5m),
				rolling1h: mergeCounts(existing.rolling1h, op.rolling1h),
				...(lastRunAt > 0 ? { lastRunAt } : {}),
				...(newerError.lastErrorAt !== undefined ? { lastErrorAt: newerError.lastErrorAt } : {}),
				...(newerError.lastErrorMessage !== undefined ? { lastErrorMessage: newerError.lastErrorMessage } : {}),
				...((existing.topWorktreePath ?? op.topWorktreePath) !== undefined ? { topWorktreePath: existing.topWorktreePath ?? op.topWorktreePath } : {}),
			});
		}
		for (const space of data.spaces) {
			const existing = spaces.get(space.space);
			if (existing === undefined) {
				spaces.set(space.space, { ...space });
				continue;
			}
			spaces.set(space.space, {
				space: space.space,
				session: mergeCounts(existing.session, space.session),
				rolling5m: mergeCounts(existing.rolling5m, space.rolling5m),
				rolling1h: mergeCounts(existing.rolling1h, space.rolling1h),
				...((existing.session.calls >= space.session.calls ? existing.topCallSite ?? space.topCallSite : space.topCallSite ?? existing.topCallSite) !== undefined
					? { topCallSite: existing.session.calls >= space.session.calls ? existing.topCallSite ?? space.topCallSite : space.topCallSite ?? existing.topCallSite }
					: {}),
				coreRatio: weightedRatio(existing.coreRatio, existing.session.calls, space.coreRatio, space.session.calls),
				rolling5mCoreRatio: weightedRatio(existing.rolling5mCoreRatio, existing.rolling5m.calls, space.rolling5mCoreRatio, space.rolling5m.calls),
				rolling1hCoreRatio: weightedRatio(existing.rolling1hCoreRatio, existing.rolling1h.calls, space.rolling1hCoreRatio, space.rolling1h.calls),
			});
		}
		totals.sessionCalls += data.totals.sessionCalls;
		totals.sessionFailures += data.totals.sessionFailures;
		totals.rolling5mCalls += data.totals.rolling5mCalls;
		totals.rolling5mFailures += data.totals.rolling5mFailures;
		totals.rolling5mRateLimited += data.totals.rolling5mRateLimited;
		lastErrors.push(...data.lastErrors);
	}
	return {
		generatedAt,
		sessionStartedAt,
		ghAvailable: items.some(data => data.ghAvailable),
		rateLimits: [],
		consumption: [],
		operations: [...operations.values()],
		spaces: [...spaces.values()],
		totals,
		lastErrors: lastErrors.sort((a, b) => b.at - a.at).slice(0, 50),
	};
}

/** 「PC ごと」の GitHub の呼び出し件数の1行。 */
export interface GithubRow {
	readonly key: string;
	readonly label: string;
	readonly sessionCalls: number | undefined;
	readonly rolling5mCalls: number | undefined;
	readonly at: number | undefined;
	readonly old: boolean;
}

const NO_CALLS: GithubCallCounts = { calls: 0, failures: 0, rateLimited: 0, avgDurationMs: 0, maxDurationMs: 0 };

/**
 * 直近（5分・1時間）の呼び出しを 0 にした値。オフラインの PC の最後の値の「直近」はもう直近ではないので、合計に入れない
 * （セッションの累計は残す）。
 */
function withoutRecentCalls(data: GithubUsageResult): GithubUsageResult {
	return {
		...data,
		operations: data.operations.map(op => ({ ...op, rolling5m: NO_CALLS, rolling1h: NO_CALLS })),
		spaces: data.spaces.map(space => ({ ...space, rolling5m: NO_CALLS, rolling1h: NO_CALLS })),
		totals: { ...data.totals, rolling5mCalls: 0, rolling5mFailures: 0, rolling5mRateLimited: 0 },
	};
}

export function summarizeGithub(entries: readonly UsageEntry[], now: number): { readonly accounts: readonly GithubAccountLimits[]; readonly merged: GithubUsageResult | undefined; readonly rows: readonly GithubRow[] } {
	const withGithub = entries.filter(entry => entry.kind === 'pc');
	return {
		accounts: aggregateGithubAccounts(withGithub, now),
		merged: mergeGithub(withGithub.flatMap(entry => {
			const github = entry.values.github;
			if (github === undefined) {
				return [];
			}
			return [isOldValue(entry, github, now) ? withoutRecentCalls(github.value) : github.value];
		})),
		rows: withGithub.map(entry => ({
			key: entry.key,
			label: entry.label,
			sessionCalls: entry.values.github?.value.totals.sessionCalls,
			// オフラインの PC の「直近5分」はもう直近ではないので出さない
			rolling5mCalls: isOldValue(entry, entry.values.github, now) ? undefined : entry.values.github?.value.totals.rolling5mCalls,
			at: entry.values.github?.at,
			old: isOldValue(entry, entry.values.github, now),
		})),
	};
}

// --- 取得の失敗 ------------------------------------------------------------------------

/** PC が時間内に答えなかった（PC の集計が重い）。PC の `{ code: 'no-response' }` と、アプリ側の待ち切れを同じに扱う。 */
export function isNoResponseError(error: unknown): boolean {
	return pcReplyErrorCode(error) === 'no-response' || (error instanceof Error && error.message === 'request timeout');
}

/**
 * 取得に失敗したときに出す一文。時間切れはエラー文をそのまま出さず、前回の値を残していることを書く。
 */
export function usageErrorText(error: unknown, hasPrevious: boolean): string {
	if (isNoResponseError(error)) {
		return hasPrevious
			? 'PC の集計に時間がかかっています。前回の値を表示しています'
			: 'PC の集計に時間がかかっています。しばらくしてから取り直してください';
	}
	return String(error instanceof Error ? error.message : error);
}
