/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルのコンポーザーの「セッションの輪」とシートに出す、会話 1 本分の状態（agent.session-status.v1）。
 *
 * - キャッシュの hit / miss: Claude Code 2.1.291 の `cn.record`（プロンプトキャッシュの台帳）と同じ式を、transcript
 *   （Codex は rollout の `token_count`）の usage に当てる。{@link ParadisPromptCacheLedger}
 * - コンテキストの使用率: 同梱の Claude Mod の `session.measure` があればそれ、無ければ最後のリクエストの入力の合計と
 *   モデルのコンテキストの大きさ（Codex は `model_context_window`）
 * - キャッシュの残り時間: 呼び出し側が既存の `promptCache`（paradisAgentInsights.ts）から期限の時刻を渡す
 *
 * 読み取りは行ごとに {@link ParadisAgentSessionStatusTracker.observe} へ渡すだけで、ファイルも時計も触らない。
 */

/** Claude Code の `ba`: 読めた量の減りがこれ未満なら miss にしない。 */
const MISS_MIN_DROP_TOKENS = 2_000;
/** Claude Code の `M*0.95`: 前後の小さい方の入力のうち、これ未満しか読めなければ減ったとみなす。 */
const MISS_READ_RATIO = 0.95;
const TTL_5M_MS = 5 * 60 * 1000;
const TTL_1H_MS = 60 * 60 * 1000;
/** Claude のコンテキストの大きさ（1M を使っていると分からないとき）。 */
const CLAUDE_CONTEXT_WINDOW = 200_000;
const CLAUDE_CONTEXT_WINDOW_1M = 1_000_000;
/** Codex の TUI がコンテキストの残りを出すときに差し引く固定の分（codex-rs の `BASELINE_TOKENS`）。 */
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;
/** 覚えておくセッションの開き直し（resume）の時刻の数。 */
const MAX_RESTART_MARKS = 8;

export type ParadisPromptCacheTtl = '5m' | '1h';
export type ParadisPromptCacheOutcome = 'hit' | 'miss' | 'expected' | 'cold' | 'uncached';

/** リクエスト 1 回分の usage（Claude Code の `cn.record` に渡す形）。 */
export interface IParadisPromptCacheRequest {
	/** 応答の時刻（transcript の行の時計）。 */
	readonly at: number;
	/** キャッシュに載らなかった入力。 */
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
	/** このリクエストで書いたキャッシュの長さ（書いていなければ undefined）。 */
	readonly ttl: ParadisPromptCacheTtl | undefined;
}

interface ILedgerEntry extends IParadisPromptCacheRequest {
	readonly outcome: ParadisPromptCacheOutcome;
}

/** 台帳の集計（モバイルへ送る形のもと）。 */
export interface IParadisPromptCacheSummary {
	readonly requests: number;
	readonly hits: number;
	readonly misses: number;
	readonly expected: number;
	readonly cold: number;
	/** cache_read ÷ (cache_read + cache_creation + input)。入力が 0 なら undefined。 */
	readonly hitRatio: number | undefined;
}

/**
 * Claude Code 2.1.291 の `cn`（`record` / `expectDrop` / `summary`）を写した台帳。式は次のとおり:
 *
 * - 最初のリクエストは `cold`。セッション全体でもこのリクエストでもキャッシュを使っていなければ `uncached`
 * - 直前がキャッシュを使っておらず、今回使ったら `cold`
 * - それ以外は、直前と今回の入力の合計（input + cache_read + cache_creation）の小さい方を M とし、
 *   cache_read < M×0.95 かつ M − cache_read ≥ 2000 なら減った。減ったとき、予告（圧縮など。{@link expectDrop}）の後で、
 *   直前のリクエストから直前の TTL 以内なら `expected`、そうでなければ `miss`。減っていなければ `hit`
 * - TTL は書いたリクエストの長さ。読むだけのリクエストは直前の長さを引き継ぐ
 *
 * `ttlUnknown` を付けると（Codex。有効期限の根拠が記録に無い）、予告の後の減りは時間に関わらず `expected` にする。
 */
export class ParadisPromptCacheLedger {
	private last: ILedgerEntry | undefined;
	private requests = 0;
	private hits = 0;
	private misses = 0;
	private expected = 0;
	private cold = 0;
	private cacheReadTokens = 0;
	private cacheCreationTokens = 0;
	private inputTokens = 0;
	private dropExpectedAt: number | undefined;

	constructor(private readonly ttlUnknown = false) { }

	/** 次のリクエストで読めた量が減るのは予告済み（圧縮の区切りなど）。 */
	expectDrop(at: number): void {
		this.dropExpectedAt = at;
	}

	record(request: IParadisPromptCacheRequest): ParadisPromptCacheOutcome {
		const previous = this.last;
		const dropExpected = this.dropExpectedAt !== undefined && previous !== undefined
			&& (this.ttlUnknown || (previous.ttl !== undefined && request.at - previous.at < ttlMs(previous.ttl)));
		this.dropExpectedAt = undefined;
		const cachingSeen = this.cacheReadTokens + this.cacheCreationTokens > 0 || request.cacheReadTokens + request.cacheCreationTokens > 0;
		let outcome: ParadisPromptCacheOutcome;
		if (previous === undefined) {
			outcome = 'cold';
		} else if (!cachingSeen) {
			outcome = 'uncached';
		} else if (previous.cacheReadTokens + previous.cacheCreationTokens === 0 && request.cacheReadTokens + request.cacheCreationTokens > 0) {
			outcome = 'cold';
		} else {
			const smaller = Math.min(total(previous), total(request));
			const dropped = request.cacheReadTokens < smaller * MISS_READ_RATIO && smaller - request.cacheReadTokens >= MISS_MIN_DROP_TOKENS;
			outcome = dropped ? (dropExpected ? 'expected' : 'miss') : 'hit';
		}
		const ttl = request.cacheCreationTokens === 0 && previous !== undefined ? previous.ttl : request.ttl;
		this.last = { ...request, ttl, outcome };
		this.requests++;
		this.cacheReadTokens += request.cacheReadTokens;
		this.cacheCreationTokens += request.cacheCreationTokens;
		this.inputTokens += request.inputTokens;
		switch (outcome) {
			case 'hit': this.hits++; break;
			case 'miss': this.misses++; break;
			case 'expected': this.expected++; break;
			case 'cold': this.cold++; break;
		}
		return outcome;
	}

	/** 最後のリクエスト（コンテキストの使用率に使う）。 */
	get lastRequest(): IParadisPromptCacheRequest | undefined {
		return this.last;
	}

	get size(): number {
		return this.requests;
	}

	summary(): IParadisPromptCacheSummary {
		const all = this.cacheReadTokens + this.cacheCreationTokens + this.inputTokens;
		return {
			requests: this.requests, hits: this.hits, misses: this.misses, expected: this.expected, cold: this.cold,
			hitRatio: all > 0 ? this.cacheReadTokens / all : undefined,
		};
	}

	/** 写しを作る（同じ message id の行が続いたときに、前の記録をやり直すため）。 */
	clone(): ParadisPromptCacheLedger {
		const copy = new ParadisPromptCacheLedger(this.ttlUnknown);
		Object.assign(copy, this);
		return copy;
	}
}

function total(request: IParadisPromptCacheRequest): number {
	return request.inputTokens + request.cacheReadTokens + request.cacheCreationTokens;
}

function ttlMs(ttl: ParadisPromptCacheTtl): number {
	return ttl === '1h' ? TTL_1H_MS : TTL_5M_MS;
}

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function lineTime(line: Readonly<Record<string, unknown>>): number | undefined {
	const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
	return Number.isFinite(at) ? at : undefined;
}

/** Claude の usage に書かれたキャッシュの長さ（Claude Code の `pTn`: 1時間が 1 以上なら 1時間）。 */
export function paradisClaudeCacheTtl(usage: Readonly<Record<string, unknown>>): ParadisPromptCacheTtl | undefined {
	const creation = rec(usage.cache_creation);
	if (count(creation?.ephemeral_1h_input_tokens) > 0) {
		return '1h';
	}
	return count(creation?.ephemeral_5m_input_tokens) > 0 ? '5m' : undefined;
}

/** Claude の transcript の 1 行がリクエストの応答なら、その usage（message id 付き）。 */
export function paradisReadClaudeCacheRequest(line: Readonly<Record<string, unknown>>): (IParadisPromptCacheRequest & { readonly messageId: string | undefined }) | undefined {
	if (line.type !== 'assistant' || line.isSidechain === true) {
		return undefined;
	}
	const message = rec(line.message);
	const usage = rec(message?.usage);
	const at = lineTime(line);
	// 中断・エラーで Claude Code が作る行（`<synthetic>`）は API のリクエストではない
	if (usage === undefined || at === undefined || message?.model === '<synthetic>') {
		return undefined;
	}
	const request = { at, inputTokens: count(usage.input_tokens), cacheReadTokens: count(usage.cache_read_input_tokens), cacheCreationTokens: count(usage.cache_creation_input_tokens), ttl: paradisClaudeCacheTtl(usage) };
	if (total(request) === 0) {
		return undefined;
	}
	return { ...request, messageId: typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined };
}

/** Codex の rollout の 1 行が `token_count` なら、その回のリクエストと累計とコンテキストの大きさ。 */
export function paradisReadCodexTokenCount(line: Readonly<Record<string, unknown>>): { readonly request: IParadisPromptCacheRequest; readonly cumulativeTokens: number; readonly contextTokens: number; readonly window: number | undefined } | undefined {
	const payload = rec(line.payload);
	if (line.type !== 'event_msg' || payload?.type !== 'token_count') {
		return undefined;
	}
	const info = rec(payload.info);
	const last = rec(info?.last_token_usage);
	const at = lineTime(line);
	if (last === undefined || at === undefined) {
		return undefined;
	}
	// Codex の input_tokens はキャッシュから読んだ分を含む
	const input = count(last.input_tokens);
	const cacheReadTokens = Math.min(count(last.cached_input_tokens), input);
	const cacheCreationTokens = Math.min(count(last.cache_write_input_tokens), input - cacheReadTokens);
	const output = count(last.output_tokens);
	const contextTokens = count(last.total_tokens) || input + output;
	const window = count(info?.model_context_window);
	return {
		request: { at, inputTokens: input - cacheReadTokens - cacheCreationTokens, cacheReadTokens, cacheCreationTokens, ttl: undefined },
		cumulativeTokens: count(rec(info?.total_token_usage)?.total_tokens),
		contextTokens,
		window: window > 0 ? window : undefined,
	};
}

/** 圧縮の区切り（Claude の `compact_boundary`、Codex の `compacted` / `context_compacted`）なら、その時刻。 */
export function paradisReadCompactionNotice(line: Readonly<Record<string, unknown>>): number | undefined {
	const payload = rec(line.payload);
	const isNotice = (line.type === 'system' && line.subtype === 'compact_boundary')
		|| line.type === 'compacted'
		|| (line.type === 'event_msg' && payload?.type === 'context_compacted');
	return isNotice ? lineTime(line) : undefined;
}

/**
 * Claude のコンテキストの大きさ。transcript のモデル名には 1M の印が無いことが多いので、名前に `[1m]` があるか、
 * 入力が 200K を超えていたら 1M とみなす（Claude Mod の `session.measure` があるときはそちらを使う）。
 */
export function paradisClaudeContextWindow(model: string | undefined, tokens: number): number {
	return (model !== undefined && /\[1m\]/i.test(model)) || tokens > CLAUDE_CONTEXT_WINDOW ? CLAUDE_CONTEXT_WINDOW_1M : CLAUDE_CONTEXT_WINDOW;
}

/** Codex の TUI と同じ使用率（固定の {@link CODEX_CONTEXT_BASELINE_TOKENS} を窓と使用量の両方から引く）。 */
export function paradisCodexContextPercent(tokens: number, window: number): number {
	if (window <= CODEX_CONTEXT_BASELINE_TOKENS) {
		return 100;
	}
	const used = Math.max(0, tokens - CODEX_CONTEXT_BASELINE_TOKENS);
	return clampPercent(used / (window - CODEX_CONTEXT_BASELINE_TOKENS) * 100);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

/** モバイルへ送るキャッシュの集計（agent.session-status.v1）。 */
export interface IParadisAgentCacheStatus {
	readonly requests: number;
	readonly hits: number;
	readonly misses: number;
	readonly expected: number;
	readonly cold: number;
	/** 0〜1（小数 3 桁）。 */
	readonly hitRatio?: number;
	/** キャッシュが切れる時刻（PC の時計。Claude だけ）。アプリが数え下げる。 */
	readonly expiresAt?: number;
	/** 最後に書いたキャッシュの長さ（ms。Claude だけ）。 */
	readonly ttlMs?: number;
	/** 長い会話の末尾だけを読んだ（数は読めた範囲のもの）。 */
	readonly partial?: true;
}

/** モバイルへ送るコンテキストの使用率。 */
export interface IParadisAgentContextStatus {
	/** 最後のリクエストの入力（Codex は TUI と同じ数え方の使用量）。 */
	readonly tokens?: number;
	readonly window: number;
	/** 0〜100 の整数。 */
	readonly percent: number;
	/** `mod`: Claude Mod の `session.measure`、`transcript`: transcript / rollout の usage。 */
	readonly source: 'mod' | 'transcript';
}

/** snapshot / delta の任意項目 `sessionStatus` の中身。 */
export interface IParadisAgentSessionStatus {
	readonly agent: 'claude' | 'codex';
	/** リクエストがまだ 1 回も無ければ省く。 */
	readonly cache?: IParadisAgentCacheStatus;
	readonly context?: IParadisAgentContextStatus;
}

/** Claude Mod の `session.measure` の `context`。 */
export interface IParadisAgentContextMeasure {
	readonly tokens?: number;
	readonly window: number;
	readonly percent?: number;
}

/**
 * 会話 1 本分の状態を、transcript / rollout の行から組み立てる。
 *
 * - Claude は同じ message id の行（内容のブロックごとに分かれる）を 1 回のリクエストとして数える。後の行で入力の数が
 *   変わっていれば、前の記録をやり直す
 * - セッションの開き直し（行の `sessionId` が変わった・{@link markRestart} の時刻を越えた）で数え直す。
 *   Claude Code も resume・/clear で台帳を空にする
 * - 圧縮の区切りは「次は減る」の予告として扱う
 */
export class ParadisAgentSessionStatusTracker {
	private ledger: ParadisPromptCacheLedger;
	/** 最後に記録した Claude の message id と、その記録の前の台帳。 */
	private lastMessage: { readonly id: string; readonly request: IParadisPromptCacheRequest; readonly before: ParadisPromptCacheLedger } | undefined;
	private sessionId: string | undefined;
	private codexCumulative = 0;
	private codexContext: { readonly tokens: number; readonly window: number } | undefined;
	private measure: IParadisAgentContextMeasure | undefined;
	private readonly restartMarks: number[] = [];

	constructor(readonly agent: 'claude' | 'codex') {
		this.ledger = new ParadisPromptCacheLedger(agent === 'codex');
	}

	/** 中身を空にする（transcript の読み直し・会話の取り替え）。開き直しの時刻は残す。 */
	clear(): void {
		this.reset();
		this.codexCumulative = 0;
		this.sessionId = undefined;
		this.measure = undefined;
	}

	/** セッションを開き直した時刻（SessionStart の resume / clear）。この時刻を越えたリクエストから数え直す。 */
	markRestart(at: number): void {
		if (!this.restartMarks.includes(at)) {
			this.restartMarks.push(at);
			this.restartMarks.sort((a, b) => a - b);
			if (this.restartMarks.length > MAX_RESTART_MARKS) {
				this.restartMarks.shift();
			}
		}
	}

	/** Claude Mod の `session.measure`（そのセッションのもの）。変われば true。 */
	applyMeasure(measure: IParadisAgentContextMeasure): boolean {
		const before = JSON.stringify(this.measure);
		this.measure = measure;
		return JSON.stringify(measure) !== before;
	}

	/** transcript / rollout の 1 行を読む。数が変わったら true。 */
	observe(line: Readonly<Record<string, unknown>>): boolean {
		const sessionId = typeof line.sessionId === 'string' && line.sessionId.length > 0 ? line.sessionId : undefined;
		if (this.agent === 'claude' && sessionId !== undefined) {
			if (this.sessionId !== undefined && sessionId !== this.sessionId) {
				this.reset();
				this.measure = undefined;
			}
			this.sessionId = sessionId;
		}
		const notice = paradisReadCompactionNotice(line);
		if (notice !== undefined) {
			this.ledger.expectDrop(notice);
			return false;
		}
		return this.agent === 'claude' ? this.observeClaude(line) : this.observeCodex(line);
	}

	private observeClaude(line: Readonly<Record<string, unknown>>): boolean {
		const read = paradisReadClaudeCacheRequest(line);
		if (read === undefined) {
			return false;
		}
		const { messageId, ...request } = read;
		if (messageId !== undefined && this.lastMessage?.id === messageId) {
			if (total(request) === total(this.lastMessage.request) && request.cacheReadTokens === this.lastMessage.request.cacheReadTokens) {
				return false;
			}
			// 同じリクエストの後の行で数が変わった。前の記録の前に戻してやり直す
			this.ledger = this.lastMessage.before;
		} else {
			this.restartIfCrossed(request.at);
		}
		const before = this.ledger.clone();
		this.ledger.record(request);
		this.lastMessage = messageId !== undefined ? { id: messageId, request, before } : undefined;
		return true;
	}

	private observeCodex(line: Readonly<Record<string, unknown>>): boolean {
		const read = paradisReadCodexTokenCount(line);
		// 同じ累計の token_count は繰り返し書かれる（レート制限の更新など）。変わったときだけ 1 回のリクエストとして数える。
		// 累計が減ったらセッションが替わった（数え直す）
		if (read === undefined || read.cumulativeTokens === 0 || read.cumulativeTokens === this.codexCumulative) {
			return false;
		}
		if (read.cumulativeTokens < this.codexCumulative) {
			this.reset();
		}
		this.codexCumulative = read.cumulativeTokens;
		this.restartIfCrossed(read.request.at);
		this.ledger.record(read.request);
		if (read.window !== undefined) {
			this.codexContext = { tokens: read.contextTokens, window: read.window };
		}
		return true;
	}

	private restartIfCrossed(at: number): void {
		const previous = this.ledger.lastRequest?.at;
		if (previous !== undefined && this.restartMarks.some(mark => previous < mark && mark <= at)) {
			this.reset();
			this.measure = undefined;
		}
	}

	private reset(): void {
		this.ledger = new ParadisPromptCacheLedger(this.agent === 'codex');
		this.lastMessage = undefined;
		this.codexContext = undefined;
	}

	/**
	 * 送る形にする。`promptCache` は Claude の既存の残り時間の材料（最後にキャッシュを使ったリクエストの時刻と長さ）、
	 * `partial` は長い会話の末尾だけを読んだか、`model` は Claude のモデル名。
	 */
	snapshot(options: { readonly promptCache?: { readonly lastUsedAt: number; readonly ttlMs: number }; readonly partial?: boolean; readonly model?: string } = {}): IParadisAgentSessionStatus {
		const summary = this.ledger.summary();
		const cache: IParadisAgentCacheStatus | undefined = summary.requests > 0 ? {
			requests: summary.requests, hits: summary.hits, misses: summary.misses, expected: summary.expected, cold: summary.cold,
			...(summary.hitRatio !== undefined ? { hitRatio: Math.round(summary.hitRatio * 1000) / 1000 } : {}),
			...(this.agent === 'claude' && options.promptCache !== undefined ? { expiresAt: options.promptCache.lastUsedAt + options.promptCache.ttlMs, ttlMs: options.promptCache.ttlMs } : {}),
			...(options.partial === true ? { partial: true as const } : {}),
		} : undefined;
		const context = this.context(options.model);
		return { agent: this.agent, ...(cache !== undefined ? { cache } : {}), ...(context !== undefined ? { context } : {}) };
	}

	private context(model: string | undefined): IParadisAgentContextStatus | undefined {
		if (this.agent === 'codex') {
			return this.codexContext !== undefined
				? { tokens: this.codexContext.tokens, window: this.codexContext.window, percent: paradisCodexContextPercent(this.codexContext.tokens, this.codexContext.window), source: 'transcript' }
				: undefined;
		}
		const measure = this.measure;
		if (measure !== undefined && measure.window > 0 && (measure.percent !== undefined || measure.tokens !== undefined)) {
			const percent = measure.percent ?? (measure.tokens ?? 0) / measure.window * 100;
			return { ...(measure.tokens !== undefined ? { tokens: measure.tokens } : {}), window: measure.window, percent: clampPercent(percent), source: 'mod' };
		}
		const last = this.ledger.lastRequest;
		if (last === undefined) {
			return undefined;
		}
		const tokens = total(last);
		const window = paradisClaudeContextWindow(model, tokens);
		return { tokens, window, percent: clampPercent(tokens / window * 100), source: 'transcript' };
	}
}
