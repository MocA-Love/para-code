// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * コンポーザーの「セッションの輪」（入口 E2）と、押すと開くシート（案 A）の中身。画面から切り出した純関数だけを置く。
 *
 * PC は agent の snapshot / delta に任意項目 `sessionStatus`・`sessionStatusAt` を載せる（`agent.session-status.v1`。PC 側は
 * `src/vs/paradis/contrib/agentChat/common/paradisAgentSessionStatus.ts`）。古い PC は送らないので、そのときは今の
 * 「裏で動いているもの」のピルを出す。
 *
 * 決まり（q.html Q265〜Q268、`mobile-statusline-mock.html` の E2 と案 A）:
 * - 輪の弧はコンテキストの使用率（70% で黄、90% で赤。それ未満は灰色）。右上の点はキャッシュが切れる間際（黄）・切れた（赤）。
 *   輪の中の数字は動いているシェルと Monitor の件数
 * - キャッシュの残り時間は PC が送る期限の時刻からアプリが数え下げる。応答中は数えない
 * - 取れない項目は行を残して理由を灰色で書く（Codex のキャッシュの残り時間など）
 */

import type { AgentMonitor } from './agentMonitors.js';
import type { AgentShell } from './agentShells.js';
import type { PrViewResult } from './features/code/pullRequest.js';

/** 残りがこれ以下になったら、キャッシュが切れる間際として黄色の点を出す（PC の残り時間の表示と同じ 1 分）。 */
export const CACHE_WARNING_MS = 60 * 1000;
/** コンテキストの使用率の境目（statusline と同じ）。 */
export const CONTEXT_WARN_PERCENT = 70;
export const CONTEXT_DANGER_PERCENT = 90;

export interface AgentCacheStatus {
	requests: number;
	hits: number;
	misses: number;
	/** 圧縮などの後の予告どおりの作り直し。 */
	expected: number;
	cold: number;
	/** cache_read ÷ 入力の合計（0〜1）。 */
	hitRatio?: number;
	/** キャッシュが切れる時刻（手元の時計。{@link localizeAgentSessionStatus} で直したもの）。Claude だけ。 */
	expiresAt?: number;
	ttlMs?: number;
	/** 長い会話の末尾だけを PC が読んだ（数は読めた範囲のもの）。 */
	partial?: true;
}

export interface AgentContextStatus {
	tokens?: number;
	window: number;
	/** 0〜100。 */
	percent: number;
	source: 'mod' | 'transcript';
}

export interface AgentSessionStatus {
	agent: 'claude' | 'codex';
	cache?: AgentCacheStatus;
	context?: AgentContextStatus;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function countOf(value: unknown): number | undefined {
	return finite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function parseCache(value: unknown): AgentCacheStatus | undefined {
	const raw = value as Partial<Record<keyof AgentCacheStatus, unknown>> | null | undefined;
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const requests = countOf(raw.requests);
	const hits = countOf(raw.hits);
	const misses = countOf(raw.misses);
	const expected = countOf(raw.expected);
	const cold = countOf(raw.cold);
	if (requests === undefined || hits === undefined || misses === undefined || expected === undefined || cold === undefined) {
		return undefined;
	}
	return {
		requests, hits, misses, expected, cold,
		...(finite(raw.hitRatio) && raw.hitRatio >= 0 && raw.hitRatio <= 1 ? { hitRatio: raw.hitRatio } : {}),
		...(finite(raw.expiresAt) && finite(raw.ttlMs) && raw.ttlMs > 0 ? { expiresAt: raw.expiresAt, ttlMs: raw.ttlMs } : {}),
		...(raw.partial === true ? { partial: true as const } : {}),
	};
}

function parseContext(value: unknown): AgentContextStatus | undefined {
	const raw = value as Partial<Record<keyof AgentContextStatus, unknown>> | null | undefined;
	if (raw === null || typeof raw !== 'object' || !finite(raw.window) || raw.window <= 0 || !finite(raw.percent)) {
		return undefined;
	}
	const tokens = countOf(raw.tokens);
	return {
		...(tokens !== undefined ? { tokens } : {}),
		window: raw.window,
		percent: Math.max(0, Math.min(100, Math.round(raw.percent))),
		source: raw.source === 'mod' ? 'mod' : 'transcript',
	};
}

/** PC から届いた `sessionStatus` を読む。形が違えば undefined（届かなかったのと同じ）。 */
export function parseAgentSessionStatus(value: unknown): AgentSessionStatus | undefined {
	const raw = value as { agent?: unknown; cache?: unknown; context?: unknown } | null | undefined;
	if (raw === null || typeof raw !== 'object' || (raw.agent !== 'claude' && raw.agent !== 'codex')) {
		return undefined;
	}
	const cache = parseCache(raw.cache);
	const context = parseContext(raw.context);
	return { agent: raw.agent, ...(cache !== undefined ? { cache } : {}), ...(context !== undefined ? { context } : {}) };
}

/** 期限の時刻を PC の時計から手元の時計へ直す（`sessionStatusAt` は PC の送信時刻）。 */
export function localizeAgentSessionStatus(status: AgentSessionStatus, sessionStatusAt: unknown, receivedAt: number): AgentSessionStatus {
	if (!finite(sessionStatusAt) || status.cache?.expiresAt === undefined) {
		return status;
	}
	return { ...status, cache: { ...status.cache, expiresAt: status.cache.expiresAt + (receivedAt - sessionStatusAt) } };
}

/** キャッシュの残り時間の行の状態。 */
export type CacheTimeState =
	| { readonly kind: 'codex' }
	| { readonly kind: 'none' }
	| { readonly kind: 'working' }
	| { readonly kind: 'alive'; readonly remainingMs: number; readonly warning: boolean }
	| { readonly kind: 'expired' };

export function cacheTimeState(status: AgentSessionStatus | undefined, now: number, working: boolean): CacheTimeState {
	if (status?.agent === 'codex') {
		return { kind: 'codex' };
	}
	const expiresAt = status?.cache?.expiresAt;
	if (expiresAt === undefined) {
		return { kind: 'none' };
	}
	if (working) {
		return { kind: 'working' };
	}
	const remainingMs = expiresAt - now;
	return remainingMs > 0 ? { kind: 'alive', remainingMs, warning: remainingMs <= CACHE_WARNING_MS } : { kind: 'expired' };
}

export type RingTone = 'idle' | 'warn' | 'danger';

export interface SessionRingModel {
	/** 弧の長さ（0〜100）。分からなければ 0。 */
	readonly percent: number;
	readonly arcTone: RingTone;
	/** 右上の点（キャッシュ）。無ければ出さない。 */
	readonly dot: 'warn' | 'danger' | undefined;
	/** 動いているシェルと Monitor の件数（0 なら数字を出さない）。 */
	readonly running: number;
	readonly accessibilityLabel: string;
}

export function contextTone(percent: number | undefined): RingTone {
	return percent === undefined ? 'idle' : percent >= CONTEXT_DANGER_PERCENT ? 'danger' : percent >= CONTEXT_WARN_PERCENT ? 'warn' : 'idle';
}

/** 輪の見た目と読み上げの文。 */
export function sessionRingModel(status: AgentSessionStatus | undefined, monitors: readonly AgentMonitor[] | undefined, shells: readonly AgentShell[] | undefined, now: number, working: boolean): SessionRingModel {
	const percent = status?.context?.percent;
	const cache = cacheTimeState(status, now, working);
	const runningShells = (shells ?? []).filter(shell => shell.status === 'running').length;
	const runningMonitors = (monitors ?? []).filter(monitor => monitor.status === 'running').length;
	const running = runningShells + runningMonitors;
	const parts = [
		percent !== undefined ? `コンテキスト ${percent}%` : undefined,
		cache.kind === 'alive' ? `キャッシュの残り ${formatCacheRemaining(cache.remainingMs)}` : cache.kind === 'expired' ? 'キャッシュは切れています' : undefined,
		running > 0 ? `実行中 ${running} 件` : undefined,
	].filter(part => part !== undefined);
	return {
		percent: percent ?? 0,
		arcTone: contextTone(percent),
		dot: cache.kind === 'expired' ? 'danger' : cache.kind === 'alive' && cache.warning ? 'warn' : undefined,
		running,
		accessibilityLabel: `セッションの状態${parts.length > 0 ? `。${parts.join('、')}` : ''}。押すと開きます`,
	};
}

/** 輪の見た目が次に変わる時刻（キャッシュが間際になる・切れる）。変わらなければ undefined。 */
export function nextSessionRingChange(status: AgentSessionStatus | undefined, now: number, working: boolean): number | undefined {
	const state = cacheTimeState(status, now, working);
	const expiresAt = status?.cache?.expiresAt;
	if (state.kind !== 'alive' || expiresAt === undefined) {
		return undefined;
	}
	return state.warning ? expiresAt : expiresAt - CACHE_WARNING_MS;
}

/** 残り時間（「39分」「1時間2分」「48秒」）。分は切り上げる（「0分」を出さない）。 */
export function formatCacheRemaining(remainingMs: number): string {
	const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
	if (seconds < 60) {
		return `${seconds}秒`;
	}
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) {
		return `${minutes}分`;
	}
	const rest = minutes % 60;
	return rest > 0 ? `${Math.floor(minutes / 60)}時間${rest}分` : `${minutes / 60}時間`;
}

/** シートの行の文字と色（`dim` は灰色、`tone` は注意の色）。 */
export interface SessionSheetValue {
	readonly text: string;
	readonly dim?: true;
	readonly tone?: 'warn' | 'danger';
}

/** キャッシュの行の見出し（「キャッシュ（1時間）」）。 */
export function cacheRowLabel(status: AgentSessionStatus | undefined): string {
	const ttlMs = status?.agent === 'claude' ? status.cache?.ttlMs : undefined;
	return ttlMs === undefined ? 'キャッシュ' : ttlMs >= 60 * 60 * 1000 ? 'キャッシュ（1時間）' : `キャッシュ（${Math.round(ttlMs / 60_000)}分）`;
}

export function cacheTimeValue(state: CacheTimeState): SessionSheetValue {
	switch (state.kind) {
		case 'codex': return { text: 'Codex では取れません', dim: true };
		case 'none': return { text: 'まだありません', dim: true };
		case 'working': return { text: '応答中は数えません', dim: true };
		case 'alive': return state.warning ? { text: `残り ${formatCacheRemaining(state.remainingMs)}`, tone: 'warn' } : { text: `残り ${formatCacheRemaining(state.remainingMs)}` };
		case 'expired': return { text: '切れています（次の依頼は割高）', tone: 'danger' };
	}
}

/** hit / miss の行（「hit 94% · ミス 2 回」）。 */
export function hitMissValue(status: AgentSessionStatus | undefined): SessionSheetValue {
	const cache = status?.cache;
	if (cache === undefined) {
		return { text: 'まだありません', dim: true };
	}
	const rate = cache.hitRatio !== undefined ? `${Math.round(cache.hitRatio * 100)}%` : '—';
	return { text: `hit ${rate} · ミス ${cache.misses} 回${cache.partial === true ? '（直近の分）' : ''}` };
}

/** トークン数の短い表記（「142.8K」「1M」）。 */
export function formatTokens(tokens: number): string {
	const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
	if (tokens >= 1_000_000) {
		return `${trim(tokens / 1_000_000)}M`;
	}
	if (tokens >= 1_000) {
		return `${trim(tokens / 1_000)}K`;
	}
	return String(tokens);
}

/** コンテキストの行（「14%（142.8K / 1M）」）。 */
export function contextValue(status: AgentSessionStatus | undefined): SessionSheetValue {
	const context = status?.context;
	if (context === undefined) {
		return { text: 'まだありません', dim: true };
	}
	const tone = contextTone(context.percent);
	const text = context.tokens !== undefined ? `${context.percent}%（${formatTokens(context.tokens)} / ${formatTokens(context.window)}）` : `${context.percent}%（${formatTokens(context.window)}）`;
	return tone === 'idle' ? { text } : { text, tone };
}

/** プルリクエストの行（「#258 承認済み」。出せないときは理由を灰色で）。 */
export function pullRequestValue(view: PrViewResult | undefined, enabled: boolean, error: string | undefined): SessionSheetValue {
	if (!enabled) {
		return { text: 'この PC では取れません', dim: true };
	}
	if (view === undefined) {
		return { text: error !== undefined ? '取得できませんでした' : '読み込んでいます', dim: true };
	}
	if (view.kind === 'unavailable') {
		switch (view.reason) {
			case 'no-gh': return { text: 'gh がありません', dim: true };
			case 'no-auth': return { text: 'GitHub にログインしていません', dim: true };
			case 'no-pr': return { text: 'このブランチの PR はありません', dim: true };
			case 'detached': return { text: 'ブランチがありません', dim: true };
			case 'error': return { text: '取得できませんでした', dim: true };
		}
	}
	const pr = view.pr;
	const state = pr.state === 'merged' ? 'マージ済み' : pr.state === 'closed' ? '閉じています' : pr.state === 'draft' ? '下書き'
		: pr.reviewDecision === 'APPROVED' ? '承認済み' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '修正の依頼あり' : 'オープン';
	return { text: `#${pr.number} ${state}` };
}
