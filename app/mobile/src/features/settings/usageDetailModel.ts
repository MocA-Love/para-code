// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	GITHUB_MONITOR_SPACE,
	GITHUB_UNSCOPED_SPACE,
	mobileWarmLeaseOwnerRevision,
	shouldMaintainMobileWarmLease,
	type GithubCallCounts,
	type GithubCallResource,
	type GithubOperationStat,
	type GithubSpaceStat,
	type MobileDisposable,
	type MobileWarmLeaseLifecycle,
	type RtkSavingsResult,
	type UsageAgent,
	type UsageDashboardResult,
} from '../../store.js';
import { dayCost, localDateKey } from '../../usageFormat.js';

/**
 * 使用量の詳細4画面（`/settings/usage/cost`・`rtk`・`github`・`system`）の表示の算出。
 * 旧画面（`legacy-screens/(settings)/ccusage.tsx`・`rtk.tsx`・`github-usage.tsx`・`system.tsx`）の
 * 中に書かれていた純粋な計算を、画面から切り離してここへ移した（判定は変えていない）。
 * 日付の区切りは「今」を引数で受け取る（既定は `Date.now()`）ので、テストで固定できる。
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// warm lease（画面が開いている間だけ PC 側のキャッシュを温めておく）
// ---------------------------------------------------------------------------

export interface CostWarmLeaseScreenState {
	readonly focused: boolean;
	readonly appActive: boolean;
	readonly online: boolean;
	readonly activePcId: string | undefined;
	readonly controllerRevision: number;
}

/** コスト画面の effect が持つ lease の入力を一度に当てる（旧 `updateCcusageWarmLeaseLifecycle` と同じ）。 */
export function updateCostWarmLeaseLifecycle(
	lifecycle: MobileWarmLeaseLifecycle,
	state: CostWarmLeaseScreenState,
	acquire: () => MobileDisposable,
): void {
	lifecycle.update(shouldMaintainMobileWarmLease('ccusage', {
		focused: state.focused,
		appActive: state.appActive,
		online: state.online,
		volumeAxis: false,
	}), acquire, mobileWarmLeaseOwnerRevision(state.activePcId, state.controllerRevision));
}

export interface SystemSpaceDiskWarmLeaseScreenState {
	readonly focused: boolean;
	readonly appActive: boolean;
	readonly online: boolean;
	readonly volumeAxis: boolean;
	readonly activePcId: string | undefined;
	readonly controllerRevision: number;
}

/** システム画面の effect が持つ spaceDisk の lease（旧 `updateSystemSpaceDiskWarmLeaseLifecycle` と同じ）。 */
export function updateSystemSpaceDiskWarmLeaseLifecycle(
	lifecycle: MobileWarmLeaseLifecycle,
	state: SystemSpaceDiskWarmLeaseScreenState,
	acquire: () => MobileDisposable,
): void {
	lifecycle.update(shouldMaintainMobileWarmLease('spaceDisk', state), acquire,
		mobileWarmLeaseOwnerRevision(state.activePcId, state.controllerRevision));
}

// ---------------------------------------------------------------------------
// コスト（ccusage）
// ---------------------------------------------------------------------------

/** エージェントの絞り込み。'all' は絞り込みなし。 */
export type AgentFilter = UsageAgent | 'all';

export const AGENT_LABEL: Record<UsageAgent, string> = {
	claude: 'Claude',
	codex: 'Codex',
	gemini: 'Gemini',
	other: 'その他',
};

export function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return String(tokens);
}

export interface ModelCost {
	readonly model: string;
	readonly agent: UsageAgent;
	readonly cost: number;
	readonly tokens: number;
}

/** データに実際に出てくるエージェント（使っていないものを選択肢に並べない）。 */
export function agentsInData(data: UsageDashboardResult): UsageAgent[] {
	const seen = new Set<UsageAgent>();
	for (const day of data.days) {
		for (const slice of day.models) {
			seen.add(slice.agent);
		}
	}
	return (['claude', 'codex', 'gemini', 'other'] as const).filter(agent => seen.has(agent));
}

/** 直近 windowDays 日のモデル別の合計（コストの多い順）。 */
export function aggregateModels(data: UsageDashboardResult, windowDays: number, agent: AgentFilter, now: number = Date.now()): ModelCost[] {
	const cutoff = localDateKey(new Date(now - (windowDays - 1) * DAY_MS));
	const byModel = new Map<string, { model: string; agent: UsageAgent; cost: number; tokens: number }>();
	for (const day of data.days) {
		if (day.date < cutoff) {
			continue;
		}
		for (const slice of day.models) {
			if (agent !== 'all' && slice.agent !== agent) {
				continue;
			}
			const entry = byModel.get(slice.model) ?? { model: slice.model, agent: slice.agent, cost: 0, tokens: 0 };
			entry.cost += slice.cost;
			entry.tokens += slice.inputTokens + slice.outputTokens + slice.cacheCreationTokens + slice.cacheReadTokens;
			byModel.set(slice.model, entry);
		}
	}
	return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * 直近 windowDays 日のプロジェクト別の合計（コストの多い順、0 円は除く）。
 * プロジェクトの記録はエージェントの内訳を持たないので、エージェントの絞り込みは効かない。
 */
export function aggregateProjects(data: UsageDashboardResult, windowDays: number, now: number = Date.now()): { name: string; cost: number }[] {
	const cutoff = localDateKey(new Date(now - (windowDays - 1) * DAY_MS));
	return data.projects
		.map(project => ({
			name: project.name,
			cost: project.dailyCosts.reduce((sum, entry) => (entry.date >= cutoff ? sum + entry.cost : sum), 0),
		}))
		.filter(project => project.cost > 0)
		.sort((a, b) => b.cost - a.cost);
}

/** 直近 windowDays 日の日別のコスト（新しい日が先頭、記録の無い日は 0）。 */
export function recentDailyCosts(data: UsageDashboardResult, windowDays: number, agent: AgentFilter, now: number = Date.now()): { date: string; cost: number }[] {
	const byDate = new Map(data.days.map(day => [day.date, dayCost(day, agent)]));
	const out: { date: string; cost: number }[] = [];
	for (let i = 0; i < windowDays; i++) {
		const date = localDateKey(new Date(now - i * DAY_MS));
		out.push({ date, cost: byDate.get(date) ?? 0 });
	}
	return out;
}

// ---------------------------------------------------------------------------
// RTK の節約
// ---------------------------------------------------------------------------

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) {
		return '0';
	}
	if (tokens >= 1_000_000_000) {
		return `${(tokens / 1_000_000_000).toFixed(1)}B`;
	}
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return String(Math.round(tokens));
}

/** 節約率（%）。PC 側と同じく「入力に対して何%削れたか」。 */
export function savingsPercent(savedTokens: number, inputTokens: number): number {
	return inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0;
}

/** 直近 windowDays 日の日別の節約量（新しい日が先頭、記録の無い日は 0）。 */
export function recentRtkDays(data: RtkSavingsResult, windowDays: number, now: number = Date.now()): { date: string; savedTokens: number }[] {
	const byDate = new Map(data.days.map(day => [day.date, day.savedTokens]));
	const out: { date: string; savedTokens: number }[] = [];
	for (let i = 0; i < windowDays; i++) {
		const date = localDateKey(new Date(now - i * DAY_MS));
		out.push({ date, savedTokens: byDate.get(date) ?? 0 });
	}
	return out;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

export type GithubWindowKey = '5m' | '1h' | 'session';
export type GithubGroupKey = 'caller' | 'space';

/** 所要時間が長いと言える境目（ms）。超えたら目に留まる色にする。 */
export const SLOW_CALL_MS = 1_500;

export function countsForWindow(stat: { session: GithubCallCounts; rolling5m: GithubCallCounts; rolling1h: GithubCallCounts }, windowKey: GithubWindowKey): GithubCallCounts {
	switch (windowKey) {
		case '5m': return stat.rolling5m;
		case '1h': return stat.rolling1h;
		case 'session': return stat.session;
	}
}

export function githubSpaceLabel(space: string): string {
	if (space === GITHUB_UNSCOPED_SPACE) {
		return 'Agent Sessions ウィンドウ（worktree 外）';
	}
	if (space === GITHUB_MONITOR_SPACE) {
		return '残量の取得（自動監視）';
	}
	return space;
}

export function githubResourceLabel(resource: string): string {
	switch (resource) {
		case 'core': return 'REST';
		case 'graphql': return 'GraphQL';
		case 'search': return 'Search';
		default: return resource;
	}
}

/** 内訳の1行。`coreRatio` は棒のうち Core（REST）が占める割合（0〜1）。 */
export interface GithubBreakdownRow {
	readonly key: string;
	readonly name: string;
	readonly sub: string;
	readonly coreRatio: number;
	readonly value: number;
	readonly counts: GithubCallCounts;
}

function resourceCoreRatio(resource: GithubCallResource): number {
	return resource === 'core' ? 1 : 0;
}

/** 呼び出し元ごとの内訳（呼び出しの多い順）。 */
export function githubCallerRows(operations: readonly GithubOperationStat[], windowKey: GithubWindowKey): GithubBreakdownRow[] {
	return operations
		.map(operation => {
			const counts = countsForWindow(operation, windowKey);
			return {
				key: operation.callSite,
				name: operation.callSite,
				sub: operation.topWorktreePath ? `most: ${githubSpaceLabel(operation.topWorktreePath)}` : githubResourceLabel(operation.resource),
				coreRatio: resourceCoreRatio(operation.resource),
				value: counts.calls,
				counts,
			};
		})
		.sort((a, b) => b.value - a.value);
}

/** スペースごとの内訳（呼び出しの多い順）。Core の割合は選んだ期間のものを使う。 */
export function githubSpaceRows(spaces: readonly GithubSpaceStat[], windowKey: GithubWindowKey): GithubBreakdownRow[] {
	return spaces
		.map(space => {
			const counts = countsForWindow(space, windowKey);
			return {
				key: space.space,
				name: githubSpaceLabel(space.space),
				sub: space.topCallSite ? `most: ${space.topCallSite}` : '—',
				coreRatio: windowKey === '5m' ? space.rolling5mCoreRatio : windowKey === '1h' ? space.rolling1hCoreRatio : space.coreRatio,
				value: counts.calls,
				counts,
			};
		})
		.sort((a, b) => b.value - a.value);
}

/** レート枠のリセットまで（「12分後リセット」「1時間5分後リセット」）。 */
export function githubResetLabel(resetAt: number, now: number): string {
	const ms = resetAt - now;
	if (ms <= 0) {
		return 'まもなくリセット';
	}
	const minutes = Math.floor(ms / 60_000);
	if (minutes >= 60) {
		return `${Math.floor(minutes / 60)}時間${minutes % 60}分後リセット`;
	}
	return `${minutes}分後リセット`;
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** 棒の長さ（%）。最大値に対する割合で、0 でも細く見えるよう下限を持つ。 */
export function barPercent(value: number, max: number, minPercent = 2): number {
	if (!(max > 0) || !Number.isFinite(value)) {
		return minPercent;
	}
	return Math.min(100, Math.max(minPercent, (value / max) * 100));
}

/** 旧い PC が知らない要求に返すフェイルセーフの文言を、PC 側の更新を促す文に置き換える。 */
export function unsupportedRequestMessage(error: unknown, whenUnsupported: string): string {
	const message = String(error instanceof Error ? error.message : error);
	return message.includes('unsupported request') ? whenUnsupported : message;
}
