/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// GitHub API 利用状況ビューの共有型と集計ロジック（環境非依存の純粋部分）。
// shared process 側(node/paradisGithubMetricsChannel.ts)が計測・収集し、
// renderer 側(electron-browser/*)がスナップショットを描画する。
//
// 計測対象は2種類ある。混同しないよう UI でも区別して表示すること:
//  1. アカウント全体のレート枠 (`gh api rate_limit` が返す core/graphql/search)。
//     Para Code 以外(ブラウザ・他ツール・拡張)の消費も含む。
//  2. Para Code 自身が発行した gh 呼び出し (worktree の PR 状態取得など)。
//     「誰が枠を食っているか」の内訳はこちらでしか分からない。

/** shared process 側チャネル名。 */
export const PARADIS_GITHUB_METRICS_CHANNEL = 'paradisGithubMetrics';

/** ローリング集計の窓幅。Superset の Metrics 画面と揃えて5分。 */
export const PARADIS_GITHUB_ROLLING_WINDOW_MS = 5 * 60 * 1000;

/** 呼び出しイベントの保持上限（超過分は古い順に捨てる）。 */
const MAX_CALL_EVENTS = 2000;
/** 直近エラーの保持件数。 */
const MAX_LAST_ERRORS = 20;
/** 記録するエラーメッセージの最大長。gh の stderr をそのまま溜め込まないための上限。 */
const MAX_ERROR_MESSAGE_LENGTH = 500;
/**
 * 呼び出し元・スペース別の集計マップが際限なく増えないための上限。gh CLI 経由の呼び出しは callSite が
 * 固定の小さな集合だが、IPC経由（recordCall、別プロセスからの入力）はカーディナリティを保証できないため
 * 持たせる。上限に達した後に現れる新規キーはこの集計には現れない（既存キーの集計は影響を受けない）。
 */
const MAX_DISTINCT_CALL_SITES = 200;
const MAX_DISTINCT_SPACES = 500;
/** callSite として記録する文字列の最大長。 */
const MAX_CALL_SITE_LENGTH = 200;
/** worktreePath の上限。IPC経由の入力と同一プロセスの呼び出しの両方をここで抑える(callSite と対称)。 */
const MAX_WORKTREE_PATH_LENGTH = 200;
/** 1つの callSite 集計が保持する worktree キーの上限。超過後の新規パスは内訳に現れない(全体件数には数える)。 */
const MAX_DISTINCT_WORKTREES_PER_SITE = 200;
/** 1つのスペース集計が保持する callSite キーの上限。worktreeCounts と同じ admission control。 */
const MAX_DISTINCT_CALL_SITES_PER_SPACE = 200;

/**
 * gh の stderr 由来のメッセージを表示・保持できる長さへ丸める。
 * プロキシ環境などで stderr が数十行になることがあり、そのまま持つとダッシュボードの
 * 表示が崩れ、デバッグバンドルにも丸ごと載る。呼び出し・レート枠の双方でこれを通す。
 */
export function paradisTruncateGithubErrorMessage(message: string): string {
	return message.length > MAX_ERROR_MESSAGE_LENGTH ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : message;
}

/**
 * レート枠サンプルの保持件数。取得間隔は状況により20秒〜数分と幅があるため、
 * 保持できる時間も数時間〜1日と変動する（1時間窓の集計には十分な数）。
 */
const MAX_RATE_LIMIT_SAMPLES = 720;
/** スパークライン用に返す消費量系列の最大長。 */
const MAX_CONSUMPTION_SERIES = 40;

/**
 * ステータスバーの残量%表示や警告色の対象にする資源。
 * search 等は枠が小さく（30/分）通常運用で常に低い値を示すため、代表値には含めない。
 */
export const PARADIS_GITHUB_PRIMARY_RESOURCES: readonly string[] = ['core', 'graphql'];

/** 低優先トラフィックを絞りたい水準（この割合以下で「注意」）。 */
export const PARADIS_GITHUB_WARNING_RATIO = 0.25;
/** これ以下は「逼迫」。 */
export const PARADIS_GITHUB_CRITICAL_RATIO = 0.05;

export type ParadisGithubSeverity = 'ok' | 'warning' | 'critical';

/** `gh api rate_limit` の1資源分。 */
export interface IParadisGithubRateLimitEntry {
	readonly resource: string;
	readonly limit: number;
	readonly used: number;
	readonly remaining: number;
	/** 枠がリセットされる時刻（ミリ秒エポック）。 */
	readonly resetAt: number;
}

/**
 * 呼び出し1回が消費するGitHubの資源区分。`gh api rate_limit` が返す資源名（'core'/'graphql'/'search'…）と
 * 語彙を揃え、`core` はREST全般を指す（gh CLI・sessions側GitHubApiClientの'rest'は記録の境界でcoreへ正規化する）。
 */
export type IParadisGithubCallResource = 'core' | 'graphql';

/** Para Code が発行した gh 呼び出し1回分。 */
export interface IParadisGithubCallEvent {
	readonly at: number;
	/** 例: `gh pr view`。引数の値（パス等）は含めない。 */
	readonly callSite: string;
	readonly resource: IParadisGithubCallResource;
	readonly durationMs: number;
	readonly success: boolean;
	readonly rateLimited: boolean;
	readonly errorMessage?: string;
	/** worktreeに紐付かない呼び出し（Agent Sessionsウィンドウ自身のPR機能等）は未設定。 */
	readonly worktreePath?: string;
}

/**
 * IPC経由で届いた値を安全な {@link IParadisGithubCallEvent} へ検証・変換する。
 * `recordCall`（別プロセスからの入力）は同一プロセス内の呼び出し（`paradisRecordGithubCall`）と違い
 * 型を保証できないため、記録の前に必ずここを通す。不正な値は undefined を返し、呼び出し側は記録をスキップする。
 */
export function paradisCoerceGithubCallEvent(value: unknown): IParadisGithubCallEvent | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;

	const at = typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : undefined;
	const resource = raw.resource === 'core' || raw.resource === 'graphql' ? raw.resource : undefined;
	const durationMs = typeof raw.durationMs === 'number' && isFinite(raw.durationMs) ? Math.max(0, raw.durationMs) : undefined;
	const callSite = typeof raw.callSite === 'string' && raw.callSite.length > 0 ? raw.callSite.slice(0, MAX_CALL_SITE_LENGTH) : undefined;
	if (at === undefined || resource === undefined || durationMs === undefined || callSite === undefined) {
		return undefined;
	}

	return {
		at,
		callSite,
		resource,
		durationMs,
		success: raw.success === true,
		rateLimited: raw.rateLimited === true,
		errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : undefined,
		worktreePath: typeof raw.worktreePath === 'string' && raw.worktreePath.length > 0 ? raw.worktreePath.slice(0, MAX_WORKTREE_PATH_LENGTH) : undefined,
	};
}

/**
 * worktreeに紐付かない gh 呼び出し（Agent Sessionsウィンドウ自身のGitHub APIクライアント経由の呼び出しなど）を
 * 束ねる仮想スペースID。実在のパスと衝突しない値にするため、redact後のパス（`~/...`等）が取り得ない
 * 制御文字を先頭に置く。表示名への変換はUI層（editor/mobile）の責務とし、ここではローカライズしない。
 */
export const PARADIS_GITHUB_UNSCOPED_SPACE = '\u0000agent-sessions';

export interface IParadisGithubCallCounts {
	readonly calls: number;
	readonly failures: number;
	readonly rateLimited: number;
	readonly avgDurationMs: number;
	readonly maxDurationMs: number;
	/** この集計対象（窓）の中で最後に呼ばれた時刻。窓の中で1件も呼ばれていなければ undefined。 */
	readonly lastRunAt: number | undefined;
}

/** 呼び出し元ごとの集計行。 */
export interface IParadisGithubOperationStat {
	readonly callSite: string;
	/** この callSite が消費する資源。呼び出し元は常に単一の資源にひもづくため、資源ごとの絞り込みに使う。 */
	readonly resource: IParadisGithubCallResource;
	readonly session: IParadisGithubCallCounts;
	readonly rolling5m: IParadisGithubCallCounts;
	readonly rolling1h: IParadisGithubCallCounts;
	readonly lastRunAt: number | undefined;
	readonly lastErrorAt: number | undefined;
	readonly lastErrorMessage: string | undefined;
	/** セッション中に最も多く呼ばれた作業ツリー（内訳の手がかり）。 */
	readonly topWorktreePath: string | undefined;
}

/**
 * スペース（worktree、または {@link PARADIS_GITHUB_UNSCOPED_SPACE}）ごとの集計行。
 * 呼び出し元別と直交する切り口で、「どのスペースが枠を食っているか」を第一級で見せる。
 */
export interface IParadisGithubSpaceStat {
	readonly space: string;
	readonly session: IParadisGithubCallCounts;
	readonly rolling5m: IParadisGithubCallCounts;
	readonly rolling1h: IParadisGithubCallCounts;
	/** このスペースで最も多く呼ばれた callSite（内訳の手がかり）。 */
	readonly topCallSite: string | undefined;
	/** セッション呼び出しのうち core（REST）が占める割合（0〜1）。残りが graphql。内訳バーの色分けに使う。 */
	readonly coreRatio: number;
	/** 直近5分・直近1時間それぞれの窓内での core 比率。窓を切り替えたときにバーの色分けが数値と食い違わないよう、窓ごとに持つ。 */
	readonly rolling5mCoreRatio: number;
	readonly rolling1hCoreRatio: number;
}

export interface IParadisGithubErrorEntry {
	readonly at: number;
	readonly callSite: string;
	readonly message: string;
	readonly worktreePath?: string;
}

/** レート枠の消費ペース（Para Code 以外の消費も含む）。 */
export interface IParadisGithubConsumption {
	readonly resource: string;
	/** 直近5分の消費量。サンプルが足りなければ undefined。 */
	readonly rolling5m: number | undefined;
	/** 直近1時間の消費量。 */
	readonly rolling1h: number | undefined;
	/** 1分あたりの消費量（直近1時間ベース、なければ5分ベース）。 */
	readonly perMinute: number | undefined;
	/** このペースで枠を使い切るまでの時間（ms）。リセットの方が早いか消費ゼロなら undefined。 */
	readonly exhaustionEtaMs: number | undefined;
	/** サンプル間の消費量（古い順）。スパークライン用。 */
	readonly series: readonly number[];
}

export interface IParadisGithubTotals {
	readonly sessionCalls: number;
	readonly sessionFailures: number;
	readonly rolling5mCalls: number;
	readonly rolling5mFailures: number;
	readonly rolling5mRateLimited: number;
}

export interface IParadisGithubMetricsSnapshot {
	readonly generatedAt: number;
	readonly sessionStartedAt: number;
	/** gh CLI が使えるか（未インストール・未認証時は false）。 */
	readonly ghAvailable: boolean;
	/** レート枠の取得に失敗した場合の理由（UI に短く出す）。 */
	readonly rateLimitError: string | undefined;
	readonly rateLimitFetchedAt: number | undefined;
	readonly rateLimits: readonly IParadisGithubRateLimitEntry[];
	readonly consumption: readonly IParadisGithubConsumption[];
	readonly operations: readonly IParadisGithubOperationStat[];
	readonly spaces: readonly IParadisGithubSpaceStat[];
	readonly totals: IParadisGithubTotals;
	readonly lastErrors: readonly IParadisGithubErrorEntry[];
}

// ---------- gh api rate_limit のパース ----------

interface IRawRateLimitResource {
	readonly limit?: unknown;
	readonly used?: unknown;
	readonly remaining?: unknown;
	readonly reset?: unknown;
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && isFinite(value) ? value : undefined;
}

/**
 * `gh api rate_limit` の stdout を資源ごとのエントリへ変換する。
 * 壊れた/欠けたフィールドを含む資源は黙って捨てる（表示できないだけで他の資源は活かす）。
 */
export function paradisParseGhRateLimit(stdout: string): IParadisGithubRateLimitEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const resources = (parsed as { resources?: Record<string, IRawRateLimitResource> } | undefined)?.resources;
	if (!resources || typeof resources !== 'object') {
		return [];
	}

	const entries: IParadisGithubRateLimitEntry[] = [];
	for (const [resource, raw] of Object.entries(resources)) {
		const limit = toFiniteNumber(raw?.limit);
		const remaining = toFiniteNumber(raw?.remaining);
		const reset = toFiniteNumber(raw?.reset);
		if (limit === undefined || remaining === undefined || limit <= 0) {
			continue;
		}
		entries.push({
			resource,
			limit,
			remaining,
			used: toFiniteNumber(raw?.used) ?? Math.max(0, limit - remaining),
			// GitHub は秒エポックで返す
			resetAt: reset !== undefined ? reset * 1000 : 0,
		});
	}
	return entries;
}

// ---------- ステータスバー表示用の要約 ----------

/**
 * 主要資源（core / graphql）のうち最も余裕のない残量割合（0〜1）。
 * 対象資源が1つも無ければ undefined。
 */
export function paradisGithubWorstRemainingRatio(entries: readonly IParadisGithubRateLimitEntry[]): number | undefined {
	let worst: number | undefined;
	for (const entry of entries) {
		if (!PARADIS_GITHUB_PRIMARY_RESOURCES.includes(entry.resource) || entry.limit <= 0) {
			continue;
		}
		const ratio = Math.max(0, Math.min(1, entry.remaining / entry.limit));
		worst = worst === undefined ? ratio : Math.min(worst, ratio);
	}
	return worst;
}

export function paradisGithubSeverity(ratio: number | undefined): ParadisGithubSeverity {
	if (ratio === undefined) {
		return 'ok';
	}
	if (ratio <= PARADIS_GITHUB_CRITICAL_RATIO) {
		return 'critical';
	}
	if (ratio <= PARADIS_GITHUB_WARNING_RATIO) {
		return 'warning';
	}
	return 'ok';
}

/** 残り時間を `M:SS` / `H:MM:SS` 形式にする（0以下は `0:00`）。 */
export function paradisGithubFormatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ---------- 呼び出しログ ----------

/** 直近1時間のローリング集計の窓幅。呼び出し元・スペースの「1時間」軸に使う。 */
const PARADIS_GITHUB_HOUR_WINDOW_MS = 60 * 60 * 1000;

interface IOperationAggregate {
	calls: number;
	failures: number;
	rateLimited: number;
	totalDurationMs: number;
	maxDurationMs: number;
	lastRunAt: number | undefined;
	lastErrorAt: number | undefined;
	lastErrorMessage: string | undefined;
	/** この callSite の資源。呼び出しごとに変わらない前提で、直近のイベントの値を保持する。 */
	resource: IParadisGithubCallResource | undefined;
	worktreeCounts: Map<string, number>;
}

interface ISpaceAggregate {
	calls: number;
	failures: number;
	rateLimited: number;
	totalDurationMs: number;
	maxDurationMs: number;
	lastRunAt: number | undefined;
	coreCalls: number;
	callSiteCounts: Map<string, number>;
}

function createAggregate(): IOperationAggregate {
	return {
		calls: 0,
		failures: 0,
		rateLimited: 0,
		totalDurationMs: 0,
		maxDurationMs: 0,
		lastRunAt: undefined,
		lastErrorAt: undefined,
		lastErrorMessage: undefined,
		resource: undefined,
		worktreeCounts: new Map<string, number>(),
	};
}

function createSpaceAggregate(): ISpaceAggregate {
	return {
		calls: 0,
		failures: 0,
		rateLimited: 0,
		totalDurationMs: 0,
		maxDurationMs: 0,
		lastRunAt: undefined,
		coreCalls: 0,
		callSiteCounts: new Map<string, number>(),
	};
}

/** 呼び出し件数系の共通フィールドを持つ集計から表示用カウントを作る（callSite別・スペース別の両方で使う）。 */
function toCounts(aggregate: { calls: number; failures: number; rateLimited: number; totalDurationMs: number; maxDurationMs: number; lastRunAt?: number }): IParadisGithubCallCounts {
	return {
		calls: aggregate.calls,
		failures: aggregate.failures,
		rateLimited: aggregate.rateLimited,
		avgDurationMs: aggregate.calls > 0 ? aggregate.totalDurationMs / aggregate.calls : 0,
		maxDurationMs: aggregate.maxDurationMs,
		lastRunAt: aggregate.lastRunAt,
	};
}

function applyEvent(aggregate: IOperationAggregate, event: IParadisGithubCallEvent): void {
	aggregate.calls++;
	aggregate.resource = event.resource;
	if (!event.success) {
		aggregate.failures++;
		aggregate.lastErrorAt = event.at;
		aggregate.lastErrorMessage = event.errorMessage;
	}
	if (event.rateLimited) {
		aggregate.rateLimited++;
	}
	aggregate.totalDurationMs += event.durationMs;
	aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, event.durationMs);
	aggregate.lastRunAt = aggregate.lastRunAt === undefined ? event.at : Math.max(aggregate.lastRunAt, event.at);
	if (event.worktreePath) {
		// 上限に達した後の新規パスは内訳に現れない（calls等の全体件数には引き続き数える）。
		// 既存パスのカウントは影響を受けない(sessionAggregates の MAX_DISTINCT_CALL_SITES と同じ設計)。
		const counts = aggregate.worktreeCounts;
		if (counts.has(event.worktreePath) || counts.size < MAX_DISTINCT_WORKTREES_PER_SITE) {
			counts.set(event.worktreePath, (counts.get(event.worktreePath) ?? 0) + 1);
		}
	}
}

function applySpaceEvent(aggregate: ISpaceAggregate, event: IParadisGithubCallEvent): void {
	aggregate.calls++;
	if (event.resource === 'core') {
		aggregate.coreCalls++;
	}
	if (!event.success) {
		aggregate.failures++;
	}
	if (event.rateLimited) {
		aggregate.rateLimited++;
	}
	aggregate.totalDurationMs += event.durationMs;
	aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, event.durationMs);
	aggregate.lastRunAt = aggregate.lastRunAt === undefined ? event.at : Math.max(aggregate.lastRunAt, event.at);
	// 上限に達した後の新規 callSite は内訳に現れない（calls等の全体件数には引き続き数える）。
	// 既存 callSite のカウントは影響を受けない(worktreeCounts の MAX_DISTINCT_WORKTREES_PER_SITE と同じ設計)。
	if (aggregate.callSiteCounts.has(event.callSite) || aggregate.callSiteCounts.size < MAX_DISTINCT_CALL_SITES_PER_SPACE) {
		aggregate.callSiteCounts.set(event.callSite, (aggregate.callSiteCounts.get(event.callSite) ?? 0) + 1);
	}
}

/** 件数マップの最頻キー（内訳の「most from」の手がかり）。 */
function pickTop(counts: Map<string, number>): string | undefined {
	let top: string | undefined;
	let topCount = 0;
	for (const [key, count] of counts) {
		if (count > topCount) {
			topCount = count;
			top = key;
		}
	}
	return top;
}

/** スペース集計のうち core（REST）が占める割合（0〜1）。呼び出しが無ければ 1（graphqlの消費が無い状態）。 */
function coreRatioOf(aggregate: ISpaceAggregate): number {
	return aggregate.calls > 0 ? aggregate.coreCalls / aggregate.calls : 1;
}

/**
 * Para Code が発行した gh 呼び出しの記録。セッション累計は集計値として、
 * 直近5分・直近1時間は生イベントのリングバッファから都度計算する。
 * 呼び出し元（callSite）別とスペース（worktree、または {@link PARADIS_GITHUB_UNSCOPED_SPACE}）別の
 * 両方の切り口を保持する。
 */
export class ParadisGithubCallLog {

	private readonly events: IParadisGithubCallEvent[] = [];
	private readonly sessionAggregates = new Map<string, IOperationAggregate>();
	private readonly sessionSpaceAggregates = new Map<string, ISpaceAggregate>();
	private readonly lastErrors: IParadisGithubErrorEntry[] = [];
	private sessionCalls = 0;
	private sessionFailures = 0;

	constructor(readonly sessionStartedAt: number) { }

	record(rawEvent: IParadisGithubCallEvent): void {
		// エラーメッセージと worktreePath は lastErrors やデバッグバンドルにも載るため、記録の時点で
		// 長さを抑える。IPC 経由の入力は coerce で丸め済みだが、同一プロセスからの呼び出しは
		// 素通りするため、ここでも効かせておく。
		const errorMessage = rawEvent.errorMessage !== undefined ? paradisTruncateGithubErrorMessage(rawEvent.errorMessage) : undefined;
		const worktreePath = rawEvent.worktreePath !== undefined ? rawEvent.worktreePath.slice(0, MAX_WORKTREE_PATH_LENGTH) : undefined;
		const event: IParadisGithubCallEvent = errorMessage === rawEvent.errorMessage && worktreePath === rawEvent.worktreePath
			? rawEvent
			: { ...rawEvent, errorMessage, worktreePath };

		this.events.push(event);
		if (this.events.length > MAX_CALL_EVENTS) {
			this.events.splice(0, this.events.length - MAX_CALL_EVENTS);
		}

		// 上限に達した後の新規キーはこの集計に現れない（totals.sessionCalls等の全体件数には引き続き数える）。
		// 既存キーの集計は影響を受けない
		let aggregate = this.sessionAggregates.get(event.callSite);
		if (!aggregate && this.sessionAggregates.size < MAX_DISTINCT_CALL_SITES) {
			aggregate = createAggregate();
			this.sessionAggregates.set(event.callSite, aggregate);
		}
		if (aggregate) {
			applyEvent(aggregate, event);
		}

		const spaceId = event.worktreePath ?? PARADIS_GITHUB_UNSCOPED_SPACE;
		let spaceAggregate = this.sessionSpaceAggregates.get(spaceId);
		if (!spaceAggregate && this.sessionSpaceAggregates.size < MAX_DISTINCT_SPACES) {
			spaceAggregate = createSpaceAggregate();
			this.sessionSpaceAggregates.set(spaceId, spaceAggregate);
		}
		if (spaceAggregate) {
			applySpaceEvent(spaceAggregate, event);
		}

		this.sessionCalls++;
		if (!event.success) {
			this.sessionFailures++;
			this.lastErrors.unshift({
				at: event.at,
				callSite: event.callSite,
				message: event.errorMessage ?? '',
				worktreePath: event.worktreePath,
			});
			if (this.lastErrors.length > MAX_LAST_ERRORS) {
				this.lastErrors.length = MAX_LAST_ERRORS;
			}
		}
	}

	snapshot(now: number): { operations: IParadisGithubOperationStat[]; spaces: IParadisGithubSpaceStat[]; totals: IParadisGithubTotals; lastErrors: IParadisGithubErrorEntry[] } {
		const window5mStart = now - PARADIS_GITHUB_ROLLING_WINDOW_MS;
		const window1hStart = now - PARADIS_GITHUB_HOUR_WINDOW_MS;

		const rolling5mByCallSite = new Map<string, IOperationAggregate>();
		const rolling1hByCallSite = new Map<string, IOperationAggregate>();
		const rolling5mBySpace = new Map<string, ISpaceAggregate>();
		const rolling1hBySpace = new Map<string, ISpaceAggregate>();
		let rolling5mCalls = 0;
		let rolling5mFailures = 0;
		let rolling5mRateLimited = 0;

		// 1回のループで1時間窓・5分窓の両方（callSite別・スペース別）を積む。
		// 5分窓は1時間窓の部分集合なので、1時間に入った時点で両方に足せるかを判定する。
		for (const event of this.events) {
			if (event.at < window1hStart) {
				continue;
			}
			const spaceId = event.worktreePath ?? PARADIS_GITHUB_UNSCOPED_SPACE;

			let hourOp = rolling1hByCallSite.get(event.callSite);
			if (!hourOp) {
				hourOp = createAggregate();
				rolling1hByCallSite.set(event.callSite, hourOp);
			}
			applyEvent(hourOp, event);

			let hourSpace = rolling1hBySpace.get(spaceId);
			if (!hourSpace) {
				hourSpace = createSpaceAggregate();
				rolling1hBySpace.set(spaceId, hourSpace);
			}
			applySpaceEvent(hourSpace, event);

			if (event.at < window5mStart) {
				continue;
			}

			let fiveMinOp = rolling5mByCallSite.get(event.callSite);
			if (!fiveMinOp) {
				fiveMinOp = createAggregate();
				rolling5mByCallSite.set(event.callSite, fiveMinOp);
			}
			applyEvent(fiveMinOp, event);

			let fiveMinSpace = rolling5mBySpace.get(spaceId);
			if (!fiveMinSpace) {
				fiveMinSpace = createSpaceAggregate();
				rolling5mBySpace.set(spaceId, fiveMinSpace);
			}
			applySpaceEvent(fiveMinSpace, event);

			rolling5mCalls++;
			if (!event.success) {
				rolling5mFailures++;
			}
			if (event.rateLimited) {
				rolling5mRateLimited++;
			}
		}

		const operations: IParadisGithubOperationStat[] = [];
		for (const [callSite, aggregate] of this.sessionAggregates) {
			operations.push({
				callSite,
				// 資源は既存イベントから常に決まるはずだが、記録がまだ無い理論上のケースだけ core にフォールバックする
				resource: aggregate.resource ?? 'core',
				session: toCounts(aggregate),
				rolling5m: toCounts(rolling5mByCallSite.get(callSite) ?? emptyAggregateFallback),
				rolling1h: toCounts(rolling1hByCallSite.get(callSite) ?? emptyAggregateFallback),
				lastRunAt: aggregate.lastRunAt,
				lastErrorAt: aggregate.lastErrorAt,
				lastErrorMessage: aggregate.lastErrorMessage,
				topWorktreePath: pickTop(aggregate.worktreeCounts),
			});
		}
		// 直近5分の多い順 → セッション累計の多い順（ダッシュボードの並び順をここで確定させる）
		operations.sort((a, b) => b.rolling5m.calls - a.rolling5m.calls || b.session.calls - a.session.calls);

		const spaces: IParadisGithubSpaceStat[] = [];
		for (const [space, aggregate] of this.sessionSpaceAggregates) {
			const rolling5mAggregate = rolling5mBySpace.get(space) ?? emptySpaceAggregateFallback;
			const rolling1hAggregate = rolling1hBySpace.get(space) ?? emptySpaceAggregateFallback;
			spaces.push({
				space,
				session: toCounts(aggregate),
				rolling5m: toCounts(rolling5mAggregate),
				rolling1h: toCounts(rolling1hAggregate),
				topCallSite: pickTop(aggregate.callSiteCounts),
				coreRatio: coreRatioOf(aggregate),
				rolling5mCoreRatio: coreRatioOf(rolling5mAggregate),
				rolling1hCoreRatio: coreRatioOf(rolling1hAggregate),
			});
		}
		spaces.sort((a, b) => b.rolling5m.calls - a.rolling5m.calls || b.session.calls - a.session.calls);

		return {
			operations,
			spaces,
			totals: {
				sessionCalls: this.sessionCalls,
				sessionFailures: this.sessionFailures,
				rolling5mCalls,
				rolling5mFailures,
				rolling5mRateLimited,
			},
			lastErrors: this.lastErrors.slice(),
		};
	}
}

/** ウィンドウ内に1件もヒットしなかった callSite / スペースに使う、再利用可能な「0件」集計。toCounts() にしか渡さないので読み取り専用に近い扱いでよい。 */
const emptyAggregateFallback: IOperationAggregate = createAggregate();
const emptySpaceAggregateFallback: ISpaceAggregate = createSpaceAggregate();

// ---------- レート枠の履歴と消費ペース ----------

interface IRateLimitSample {
	readonly at: number;
	readonly byResource: Map<string, IParadisGithubRateLimitEntry>;
}

/**
 * レート枠のサンプル履歴。連続するサンプルの残量差からアカウント全体の消費量を復元する。
 * 枠のリセットを跨いだ区間（残量が増えた区間）は「リセット後の消費分」だけを数える。
 * リセット前に何回使われたかはサンプル間隔の外なので分からず、推測すると過大計上になるため。
 */
export class ParadisGithubRateLimitHistory {

	private readonly samples: IRateLimitSample[] = [];

	record(entries: readonly IParadisGithubRateLimitEntry[], at: number): void {
		if (entries.length === 0) {
			return;
		}
		const byResource = new Map<string, IParadisGithubRateLimitEntry>();
		for (const entry of entries) {
			byResource.set(entry.resource, entry);
		}
		this.samples.push({ at, byResource });
		if (this.samples.length > MAX_RATE_LIMIT_SAMPLES) {
			this.samples.splice(0, this.samples.length - MAX_RATE_LIMIT_SAMPLES);
		}
	}

	consumption(now: number): IParadisGithubConsumption[] {
		const latest = this.samples[this.samples.length - 1];
		if (!latest) {
			return [];
		}

		const result: IParadisGithubConsumption[] = [];
		for (const resource of latest.byResource.keys()) {
			const deltas = this.deltas(resource);
			const rolling5m = sumDeltas(deltas, now - PARADIS_GITHUB_ROLLING_WINDOW_MS, now);
			const rolling1h = sumDeltas(deltas, now - 60 * 60 * 1000, now);

			let perMinute: number | undefined;
			if (rolling1h !== undefined && rolling1h.paceSpanMs > 0) {
				perMinute = rolling1h.paceConsumed / (rolling1h.paceSpanMs / 60_000);
			} else if (rolling5m !== undefined && rolling5m.paceSpanMs > 0) {
				perMinute = rolling5m.paceConsumed / (rolling5m.paceSpanMs / 60_000);
			}

			const current = latest.byResource.get(resource);
			let exhaustionEtaMs: number | undefined;
			if (current && perMinute !== undefined && perMinute > 0) {
				const eta = (current.remaining / perMinute) * 60_000;
				// リセットの方が先に来るなら「枯渇しない」として出さない
				const untilReset = current.resetAt - now;
				exhaustionEtaMs = untilReset > 0 && eta >= untilReset ? undefined : eta;
			}

			result.push({
				resource,
				rolling5m: rolling5m?.consumed,
				rolling1h: rolling1h?.consumed,
				perMinute,
				exhaustionEtaMs,
				series: deltas.slice(-MAX_CONSUMPTION_SERIES).map(delta => delta.consumed),
			});
		}
		return result;
	}

	/** 連続サンプル間の消費量。 */
	private deltas(resource: string): IConsumptionDelta[] {
		const deltas: IConsumptionDelta[] = [];
		let previous: { at: number; entry: IParadisGithubRateLimitEntry } | undefined;
		for (const sample of this.samples) {
			const entry = sample.byResource.get(resource);
			if (!entry) {
				continue;
			}
			if (previous) {
				const acrossReset = entry.remaining > previous.entry.remaining;
				const consumed = acrossReset
					// 枠がリセットされた区間。リセット後の消費分のみを数える
					? Math.max(0, entry.limit - entry.remaining)
					: previous.entry.remaining - entry.remaining;
				deltas.push({ at: sample.at, spanMs: sample.at - previous.at, consumed, acrossReset });
			}
			previous = { at: sample.at, entry };
		}
		return deltas;
	}
}

interface IConsumptionDelta {
	/** 区間の終端（後側のサンプル時刻）。 */
	readonly at: number;
	readonly spanMs: number;
	readonly consumed: number;
	/** 枠のリセットを跨いだ区間。消費量が区間長に対応しないのでペース計算からは外す。 */
	readonly acrossReset: boolean;
}

/**
 * 窓の中の消費量を合計する。
 *
 * サンプリングは UI が開いているときにしか行われないため、区間の長さは数十秒から数時間まで
 * ばらつく。区間が窓の境界をまたぐ場合に丸ごと足すと「直近5分の消費」に数時間分が混ざるので、
 * 窓に入っている時間の比で按分する（区間内は一様に消費されたとみなす近似）。
 */
function sumDeltas(deltas: readonly IConsumptionDelta[], since: number, now: number): { consumed: number; spanMs: number; paceSpanMs: number; paceConsumed: number } | undefined {
	let consumed = 0;
	let spanMs = 0;
	let paceConsumed = 0;
	let paceSpanMs = 0;
	for (const delta of deltas) {
		if (delta.at <= since || delta.at > now || delta.spanMs <= 0) {
			continue;
		}
		const overlap = Math.min(delta.spanMs, delta.at - since);
		const factor = overlap / delta.spanMs;
		consumed += delta.consumed * factor;
		spanMs += overlap;
		// リセット跨ぎはペース（req/min）と枯渇予測の母数に入れない
		if (!delta.acrossReset) {
			paceConsumed += delta.consumed * factor;
			paceSpanMs += overlap;
		}
	}
	return spanMs > 0 ? { consumed, spanMs, paceConsumed, paceSpanMs } : undefined;
}

// ---------- 呼び出しの記録シンク ----------

let callSink: ParadisGithubCallLog | undefined;

/**
 * 計測の受け口を設定する（shared process 側で GitHub 利用状況チャネルを登録したときに1回だけ）。
 * 設定されるまでの記録は捨てられる。
 */
export function paradisSetGithubCallSink(log: ParadisGithubCallLog | undefined): void {
	callSink = log;
}

/**
 * 現在の受け口を解除する。自分が設定したものだけを外すので、
 * 別のインスタンスが後から設定した受け口を巻き添えで消さない。
 */
export function paradisClearGithubCallSink(log: ParadisGithubCallLog): void {
	if (callSink === log) {
		callSink = undefined;
	}
}

/**
 * gh 呼び出しを1件記録する。計測が無効（チャネル未登録）なら何もしない。
 * 計測は呼び出し側の処理より常に優先度が低いので、失敗しても握りつぶす。
 */
export function paradisRecordGithubCall(event: IParadisGithubCallEvent): void {
	try {
		callSink?.record(event);
	} catch {
		// 計測の失敗で gh 呼び出し自体を壊さない
	}
}

// ---------- リモートプロセスからの記録転送 ----------
//
// 上の callSink は同一プロセス内(shared process)専用。Agent Sessionsウィンドウ自身の
// GitHub APIクライアント（sessions/contrib/github）は別プロセス(renderer)で動くため、
// モジュール変数を共有できず直接 record() を呼べない。electron-browser 層が
// paradisSetGithubCallTransport() でIPC転送関数を差し込み、renderer 側は
// paradisRecordRemoteGithubCall() だけを知っていればよいようにする。
// web/browser専用ビルド等、転送が未設定の環境では黙って何もしない（no-op）。

let callTransport: ((event: IParadisGithubCallEvent) => void) | undefined;

/**
 * リモートプロセス（Agent Sessionsウィンドウ等）からの記録の転送先を設定する。
 * electron-browser 層のcontributionが、shared process への IPC 呼び出しをここに差し込む。
 */
export function paradisSetGithubCallTransport(transport: ((event: IParadisGithubCallEvent) => void) | undefined): void {
	callTransport = transport;
}

/**
 * 別プロセス（renderer）で発生した gh 呼び出しを記録する。転送先が未設定なら何もしない
 * （web ビルド等、電子デスクトップ専用の転送が使えない環境でも安全に呼べる）。
 */
export function paradisRecordRemoteGithubCall(event: IParadisGithubCallEvent): void {
	try {
		callTransport?.(event);
	} catch {
		// 計測の失敗で呼び出し元の処理を壊さない
	}
}

/**
 * 絶対パスのホームディレクトリ部分を `~` に置き換える。
 * 計測結果はダッシュボードに出るうえデバッグバンドルとして共有されるため、
 * 記録する時点でユーザー名を含むパスを残さない。
 */
export function paradisRedactHomePath(path: string, home: string | undefined): string {
	if (!home || home.length === 0 || !path.startsWith(home)) {
		return path;
	}
	return `~${path.slice(home.length)}`;
}

/**
 * gh の引数から表示用の呼び出し元名を作る（`['pr','view','--json',…]` → `gh pr view`）。
 * ダッシュボードに出るうえデバッグバンドルにも載るため、パス状の引数は先頭セグメントだけに丸めて
 * リポジトリ名などが不用意に混ざらないようにする。
 */
export function paradisGithubCallSiteFromArgs(args: readonly string[]): string {
	const parts: string[] = ['gh'];
	for (const arg of args) {
		if (arg.startsWith('-') || parts.length >= 3) {
			break;
		}
		const slash = arg.indexOf('/');
		parts.push(slash >= 0 ? `${arg.slice(0, slash)}/…` : arg);
	}
	return parts.join(' ');
}

/**
 * 「PR が無い」は gh が終了コード1で返すが、運用上は正常系なので失敗として数えない。
 * これを失敗に数えると、PR を作っていない作業ツリーの数だけエラーが並んでしまう。
 */
export function paradisIsGithubNoPullRequestMessage(message: string | undefined): boolean {
	return !!message && /no (open )?pull requests? found/i.test(message);
}

/** gh の stderr / エラーメッセージがレート制限由来かを判定する。 */
export function paradisIsGithubRateLimitMessage(message: string | undefined): boolean {
	if (!message) {
		return false;
	}
	const lower = message.toLowerCase();
	return lower.includes('rate limit') || lower.includes('ratelimited') || lower.includes('secondary rate');
}
