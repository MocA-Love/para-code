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

/** Para Code が発行した gh 呼び出し1回分。 */
export interface IParadisGithubCallEvent {
	readonly at: number;
	/** 例: `gh pr view`。引数の値（パス等）は含めない。 */
	readonly callSite: string;
	readonly durationMs: number;
	readonly success: boolean;
	readonly rateLimited: boolean;
	readonly errorMessage?: string;
	readonly worktreePath?: string;
}

export interface IParadisGithubCallCounts {
	readonly calls: number;
	readonly failures: number;
	readonly rateLimited: number;
	readonly avgDurationMs: number;
	readonly maxDurationMs: number;
}

/** 呼び出し元ごとの集計行。 */
export interface IParadisGithubOperationStat {
	readonly callSite: string;
	readonly session: IParadisGithubCallCounts;
	readonly rolling5m: IParadisGithubCallCounts;
	readonly lastRunAt: number | undefined;
	readonly lastErrorAt: number | undefined;
	readonly lastErrorMessage: string | undefined;
	/** セッション中に最も多く呼ばれた作業ツリー（内訳の手がかり）。 */
	readonly topWorktreePath: string | undefined;
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

interface IOperationAggregate {
	calls: number;
	failures: number;
	rateLimited: number;
	totalDurationMs: number;
	maxDurationMs: number;
	lastRunAt: number | undefined;
	lastErrorAt: number | undefined;
	lastErrorMessage: string | undefined;
	worktreeCounts: Map<string, number>;
}

function emptyCounts(): IParadisGithubCallCounts {
	return { calls: 0, failures: 0, rateLimited: 0, avgDurationMs: 0, maxDurationMs: 0 };
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
		worktreeCounts: new Map<string, number>(),
	};
}

function toCounts(aggregate: IOperationAggregate): IParadisGithubCallCounts {
	return {
		calls: aggregate.calls,
		failures: aggregate.failures,
		rateLimited: aggregate.rateLimited,
		avgDurationMs: aggregate.calls > 0 ? aggregate.totalDurationMs / aggregate.calls : 0,
		maxDurationMs: aggregate.maxDurationMs,
	};
}

function applyEvent(aggregate: IOperationAggregate, event: IParadisGithubCallEvent): void {
	aggregate.calls++;
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
		aggregate.worktreeCounts.set(event.worktreePath, (aggregate.worktreeCounts.get(event.worktreePath) ?? 0) + 1);
	}
}

/**
 * Para Code が発行した gh 呼び出しの記録。セッション累計は集計値として、
 * 直近5分は生イベントのリングバッファから都度計算する。
 */
export class ParadisGithubCallLog {

	private readonly events: IParadisGithubCallEvent[] = [];
	private readonly sessionAggregates = new Map<string, IOperationAggregate>();
	private readonly lastErrors: IParadisGithubErrorEntry[] = [];
	private sessionCalls = 0;
	private sessionFailures = 0;

	constructor(readonly sessionStartedAt: number) { }

	record(rawEvent: IParadisGithubCallEvent): void {
		// エラーメッセージはデバッグバンドルにも載るので、記録の時点で長さを抑える
		const truncated = rawEvent.errorMessage !== undefined ? paradisTruncateGithubErrorMessage(rawEvent.errorMessage) : undefined;
		const event: IParadisGithubCallEvent = truncated !== rawEvent.errorMessage ? { ...rawEvent, errorMessage: truncated } : rawEvent;

		this.events.push(event);
		if (this.events.length > MAX_CALL_EVENTS) {
			this.events.splice(0, this.events.length - MAX_CALL_EVENTS);
		}

		let aggregate = this.sessionAggregates.get(event.callSite);
		if (!aggregate) {
			aggregate = createAggregate();
			this.sessionAggregates.set(event.callSite, aggregate);
		}
		applyEvent(aggregate, event);

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

	snapshot(now: number): { operations: IParadisGithubOperationStat[]; totals: IParadisGithubTotals; lastErrors: IParadisGithubErrorEntry[] } {
		const windowStart = now - PARADIS_GITHUB_ROLLING_WINDOW_MS;
		const rollingAggregates = new Map<string, IOperationAggregate>();
		let rolling5mCalls = 0;
		let rolling5mFailures = 0;
		let rolling5mRateLimited = 0;

		for (const event of this.events) {
			if (event.at < windowStart) {
				continue;
			}
			let aggregate = rollingAggregates.get(event.callSite);
			if (!aggregate) {
				aggregate = createAggregate();
				rollingAggregates.set(event.callSite, aggregate);
			}
			applyEvent(aggregate, event);
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
			const rolling = rollingAggregates.get(callSite);
			let topWorktreePath: string | undefined;
			let topCount = 0;
			for (const [worktreePath, count] of aggregate.worktreeCounts) {
				if (count > topCount) {
					topCount = count;
					topWorktreePath = worktreePath;
				}
			}
			operations.push({
				callSite,
				session: toCounts(aggregate),
				rolling5m: rolling ? toCounts(rolling) : emptyCounts(),
				lastRunAt: aggregate.lastRunAt,
				lastErrorAt: aggregate.lastErrorAt,
				lastErrorMessage: aggregate.lastErrorMessage,
				topWorktreePath,
			});
		}
		// 直近5分の多い順 → セッション累計の多い順（ダッシュボードの並び順をここで確定させる）
		operations.sort((a, b) => b.rolling5m.calls - a.rolling5m.calls || b.session.calls - a.session.calls);

		return {
			operations,
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
