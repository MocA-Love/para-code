/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログ（Claude Code の transcript・Codex の rollout）から、使用量と作業実績を数える部品。
//
// 1ファイルを1行ずつ {@link ParadisActivityTranscriptParser} に通すと、日別・モデル別のトークン数、
// ターン数（ユーザーの依頼の数）、稼働時間、作成した PR をまとめた {@link IParadisActivityFileSummary}
// が得られる。読むのは shared process の worker（別スレッド）で、集計と按分はここにある純粋関数で行う。
// Node の API に依存しないので common に置き、テストから直接呼ぶ。

import {
	paradisParseCodexSessionMetaItem,
	paradisTranscriptMessageFromItem,
	paradisTranscriptNumber,
	paradisTranscriptRecord,
	paradisTranscriptString,
	paradisTranscriptTimestamp,
} from '../../sessionResume/common/paradisSessionTranscript.js';

export const PARADIS_AGENT_ACTIVITY_CHANNEL = 'paradisAgentActivity';

export type ParadisActivityAgent = 'claude' | 'codex';

export const PARADIS_ACTIVITY_AGENTS: readonly ParadisActivityAgent[] = ['claude', 'codex'];

/** 連続する2つの記録の間がこれより空いていたら、その間は作業していなかったとみなす。 */
export const PARADIS_ACTIVITY_IDLE_GAP_MS = 5 * 60_000;

export interface IParadisTokenCounts {
	readonly input: number;
	readonly output: number;
	readonly cacheCreation: number;
	readonly cacheRead: number;
}

export interface IParadisActivityDay {
	/** ユーザーの依頼の数。 */
	readonly turns: number;
	/** 記録の間隔が {@link PARADIS_ACTIVITY_IDLE_GAP_MS} 以下の区間を足した時間。 */
	readonly activeMs: number;
	/** モデル名 → その日のトークン数。 */
	readonly models: { readonly [model: string]: IParadisTokenCounts };
}

export interface IParadisActivityFileSummary {
	readonly agent: ParadisActivityAgent;
	readonly sessionId?: string;
	/** エージェントが記録した作業ディレクトリ。スペースへの振り分けに使う。 */
	readonly cwd?: string;
	/** ユーザーが起動した会話なら true。サブエージェントの記録は false（トークンは数えるがエージェント数には入れない）。 */
	readonly root: boolean;
	/** 日付（ローカル時刻の YYYY-MM-DD）→ その日の記録。 */
	readonly days: { readonly [day: string]: IParadisActivityDay };
	/** エージェントが作った PR の URL と、それが記録された日。 */
	readonly prs: readonly { readonly url: string; readonly day: string }[];
	/**
	 * 識別子の付いた応答（Claude Code の `message.id:requestId`）のトークン。再開・分岐で前の会話の行が
	 * 新しいファイルへ写されることがあるので、`days.models` には入れず、集計時にファイルをまたいで重複を除く。
	 */
	readonly keyedUsage?: readonly (readonly [key: string, day: string, model: string, input: number, output: number, cacheCreation: number, cacheRead: number])[];
	/** 識別子（行の `uuid`）の付いたユーザーの依頼。同じ理由で `days.turns` には入れない。 */
	readonly keyedTurns?: readonly (readonly [key: string, day: string])[];
}

// ---- 電文（renderer ⇔ shared process） ----------------------------------------------------------

export interface IParadisSpaceUsageSpace {
	readonly key: string;
	readonly name: string;
	/** このスペースの作業ディレクトリ（worktree のパス）。手元のマシンの絶対パス。 */
	readonly roots: readonly string[];
}

export interface IParadisSpaceUsageRequest {
	/** YYYY-MM-DD（含む）。 */
	readonly since: string;
	/** YYYY-MM-DD（含む）。 */
	readonly until: string;
	readonly spaces: readonly IParadisSpaceUsageSpace[];
	/** true なら手元のキャッシュを使わず、変わっていないファイルも読み直す。 */
	readonly bypassCache?: boolean;
}

/** どのスペースにも属さない作業ディレクトリの会話をまとめる入れ物のキー。 */
export const PARADIS_SPACE_USAGE_OTHER_KEY = '__paradis_other__';

export interface IParadisSpaceUsageBucket {
	readonly key: string;
	/** 日付 → モデル名 → トークン数。 */
	readonly days: { readonly [day: string]: { readonly [model: string]: IParadisTokenCounts } };
	/** 期間内に記録があった会話（サブエージェントを除く）の数。 */
	readonly sessions: number;
}

export interface IParadisSpaceUsageResult {
	readonly buckets: readonly IParadisSpaceUsageBucket[];
	readonly scannedFiles: number;
	readonly failedFiles: number;
	readonly computedAt: number;
}

export interface IParadisWorkStatsRequest {
	readonly since: string;
	readonly until: string;
	readonly bypassCache?: boolean;
}

export interface IParadisWorkStatsAgent {
	/** 期間内にユーザーの依頼が1回以上あった会話の数（サブエージェントを除く）。 */
	readonly sessions: number;
	readonly turns: number;
	readonly activeMs: number;
	/** 期間内に作った PR の数（URL で重複を除く）。 */
	readonly prs: number;
	readonly days: { readonly [day: string]: { readonly turns: number; readonly activeMs: number } };
}

export interface IParadisWorkStatsResult {
	readonly agents: { readonly [agent in ParadisActivityAgent]: IParadisWorkStatsAgent };
	readonly computedAt: number;
}

// ---- 日付 --------------------------------------------------------------------------------------

/** ローカル時刻の YYYY-MM-DD。 */
export function paradisActivityDayKey(time: number | Date): string {
	const date = typeof time === 'number' ? new Date(time) : time;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD をローカル時刻のその日の 0 時として読む。形式が違えば undefined。 */
export function paradisActivityParseDay(day: string): number | undefined {
	const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<date>\d{2})$/.exec(day);
	if (!match?.groups) {
		return undefined;
	}
	const value = new Date(Number(match.groups.year), Number(match.groups.month) - 1, Number(match.groups.date)).getTime();
	return Number.isFinite(value) ? value : undefined;
}

// ---- 1ファイルの解析 ----------------------------------------------------------------------------

const ZERO_TOKENS: IParadisTokenCounts = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

interface IMutableDay {
	turns: number;
	activeMs: number;
	models: Map<string, IParadisTokenCounts>;
}

function addTokens(a: IParadisTokenCounts, b: IParadisTokenCounts): IParadisTokenCounts {
	return { input: a.input + b.input, output: a.output + b.output, cacheCreation: a.cacheCreation + b.cacheCreation, cacheRead: a.cacheRead + b.cacheRead };
}

export function paradisTotalTokens(tokens: IParadisTokenCounts): number {
	return tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
}

function nonNegative(value: unknown): number {
	const number = paradisTranscriptNumber(value);
	return number !== undefined && number > 0 ? number : 0;
}

const PR_URL_PATTERN = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const PR_CREATE_COMMAND_PATTERN = /\bgh\s+pr\s+create\b/;

/** Codex の累計トークン（`token_count` の `total_token_usage`）。 */
interface ICodexTotals {
	readonly input: number;
	readonly cached: number;
	readonly output: number;
}

/**
 * 1ファイルぶんの会話ログを1行ずつ受け取り、使用量と作業実績をまとめる。
 *
 * - Claude Code: `assistant` 行の `message.usage` を `message.id` と `requestId` の組で重複を除いて数える
 *   （1つの応答が内容ブロックごとに複数行へ分かれて書かれるため。ccusage と同じ扱い）
 * - Codex: `event_msg` / `token_count` の累計値の増分を、直前の `turn_context` のモデルへ足す
 * - ターン数: ユーザーの発言（セッション履歴と同じ規則で拾ったもの）の数。サブエージェントの発言は数えない
 * - PR: Claude Code が記録する `pr-link` 行と、`gh pr create` の実行結果に出た PR の URL
 */
export class ParadisActivityTranscriptParser {

	private readonly days = new Map<string, IMutableDay>();
	private readonly seenUsage = new Set<string>();
	private readonly keyedUsage: [string, string, string, number, number, number, number][] = [];
	private readonly keyedTurns: [string, string][] = [];
	private readonly prCommandIds = new Set<string>();
	private readonly prs = new Map<string, string>();
	private sessionId: string | undefined;
	private cwd: string | undefined;
	private root = true;
	private lastTimestamp: number | undefined;
	private codexModel = 'unknown';
	private codexTotals: ICodexTotals | undefined;
	private lineCount = 0;

	constructor(
		private readonly agent: ParadisActivityAgent,
		/** Claude Code のサブエージェント用ファイル（`subagents/` の下）なら true。 */
		subagentFile = false,
	) {
		this.root = !subagentFile;
	}

	pushLine(line: string): void {
		if (!line) {
			return;
		}
		let item: Record<string, unknown> | undefined;
		try {
			item = paradisTranscriptRecord(JSON.parse(line));
		} catch {
			return;
		}
		if (!item) {
			return;
		}
		this.lineCount++;
		const timestamp = paradisTranscriptTimestamp(item.timestamp);
		if (timestamp !== undefined) {
			this.trackActivity(timestamp);
		}
		if (this.agent === 'claude') {
			this.pushClaude(item, timestamp);
		} else {
			this.pushCodex(item, timestamp);
		}
	}

	finish(): IParadisActivityFileSummary {
		const days: { [day: string]: IParadisActivityDay } = {};
		for (const [day, value] of this.days) {
			const models: { [model: string]: IParadisTokenCounts } = {};
			for (const [model, tokens] of value.models) {
				models[model] = tokens;
			}
			days[day] = { turns: value.turns, activeMs: value.activeMs, models };
		}
		return {
			agent: this.agent,
			sessionId: this.sessionId,
			cwd: this.cwd,
			root: this.root,
			days,
			prs: [...this.prs].map(([url, day]) => ({ url, day })),
			keyedUsage: this.keyedUsage,
			keyedTurns: this.keyedTurns,
		};
	}

	private day(timestamp: number): IMutableDay {
		const key = paradisActivityDayKey(timestamp);
		let day = this.days.get(key);
		if (!day) {
			day = { turns: 0, activeMs: 0, models: new Map() };
			this.days.set(key, day);
		}
		return day;
	}

	private trackActivity(timestamp: number): void {
		const previous = this.lastTimestamp;
		if (previous !== undefined && timestamp > previous && timestamp - previous <= PARADIS_ACTIVITY_IDLE_GAP_MS) {
			this.day(previous).activeMs += timestamp - previous;
		}
		if (previous === undefined || timestamp > previous) {
			this.lastTimestamp = timestamp;
		}
	}

	private addUsage(timestamp: number | undefined, model: string, tokens: IParadisTokenCounts): void {
		if (timestamp === undefined || paradisTotalTokens(tokens) === 0) {
			return;
		}
		const day = this.day(timestamp);
		day.models.set(model, addTokens(day.models.get(model) ?? ZERO_TOKENS, tokens));
	}

	private addTurn(timestamp: number | undefined): void {
		if (timestamp !== undefined && this.root) {
			this.day(timestamp).turns++;
		}
	}

	private addPr(url: string, timestamp: number | undefined): void {
		if (timestamp !== undefined && this.root && !this.prs.has(url)) {
			this.prs.set(url, paradisActivityDayKey(timestamp));
		}
	}

	private pushClaude(item: Record<string, unknown>, timestamp: number | undefined): void {
		this.sessionId ??= paradisTranscriptString(item.sessionId);
		this.cwd ??= paradisTranscriptString(item.cwd);
		const type = item.type;
		if (type === 'pr-link') {
			const url = paradisTranscriptString(item.prUrl);
			if (url && PR_URL_PATTERN.test(url)) {
				this.addPr(url, timestamp);
			}
			return;
		}
		const message = paradisTranscriptRecord(item.message);
		if (type === 'assistant' && message) {
			const usage = paradisTranscriptRecord(message.usage);
			if (usage) {
				const messageId = paradisTranscriptString(message.id);
				const requestId = paradisTranscriptString(item.requestId);
				const key = messageId && requestId ? `${messageId}:${requestId}` : undefined;
				if (!key || !this.seenUsage.has(key)) {
					if (key) {
						this.seenUsage.add(key);
					}
					const model = paradisTranscriptString(message.model) ?? 'unknown';
					const tokens: IParadisTokenCounts = {
						input: nonNegative(usage.input_tokens),
						output: nonNegative(usage.output_tokens),
						cacheCreation: nonNegative(usage.cache_creation_input_tokens),
						cacheRead: nonNegative(usage.cache_read_input_tokens),
					};
					if (model === '<synthetic>' || timestamp === undefined || paradisTotalTokens(tokens) === 0) {
						// 数えるものが無い
					} else if (key) {
						this.keyedUsage.push([key, paradisActivityDayKey(timestamp), model, tokens.input, tokens.output, tokens.cacheCreation, tokens.cacheRead]);
					} else {
						this.addUsage(timestamp, model, tokens);
					}
				}
			}
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const record = paradisTranscriptRecord(block);
				const input = paradisTranscriptRecord(record?.input);
				const id = paradisTranscriptString(record?.id);
				if (record?.type === 'tool_use' && id && PR_CREATE_COMMAND_PATTERN.test(paradisTranscriptString(input?.command) ?? '')) {
					this.prCommandIds.add(id);
				}
			}
			return;
		}
		if (type === 'user' && message) {
			if (item.isSidechain === true) {
				return;
			}
			for (const block of Array.isArray(message.content) ? message.content : []) {
				const record = paradisTranscriptRecord(block);
				const toolUseId = paradisTranscriptString(record?.tool_use_id);
				if (record?.type === 'tool_result' && toolUseId && this.prCommandIds.has(toolUseId)) {
					const url = PR_URL_PATTERN.exec(JSON.stringify(record.content ?? ''))?.[0];
					if (url) {
						this.addPr(url, timestamp);
					}
				}
			}
			const spoken = paradisTranscriptMessageFromItem(item, 'claude', 64);
			if (spoken?.role === 'user' && !spoken.text.startsWith('<local-command-')) {
				const uuid = paradisTranscriptString(item.uuid);
				if (uuid && timestamp !== undefined && this.root) {
					this.keyedTurns.push([uuid, paradisActivityDayKey(timestamp)]);
				} else {
					this.addTurn(timestamp);
				}
			}
		}
	}

	private pushCodex(item: Record<string, unknown>, timestamp: number | undefined): void {
		const payload = paradisTranscriptRecord(item.payload);
		if (item.type === 'session_meta') {
			const meta = paradisParseCodexSessionMetaItem(item);
			if (meta && this.sessionId === undefined) {
				this.sessionId = meta.id;
				this.cwd = meta.cwd;
				this.root = !meta.subagent;
			}
			return;
		}
		if (item.type === 'turn_context') {
			this.codexModel = paradisTranscriptString(payload?.model) ?? this.codexModel;
			this.cwd ??= paradisTranscriptString(payload?.cwd);
			return;
		}
		if (item.type === 'event_msg' && payload?.type === 'token_count') {
			const info = paradisTranscriptRecord(payload.info);
			const total = paradisTranscriptRecord(info?.total_token_usage);
			const last = paradisTranscriptRecord(info?.last_token_usage);
			if (total) {
				const current: ICodexTotals = { input: nonNegative(total.input_tokens), cached: nonNegative(total.cached_input_tokens), output: nonNegative(total.output_tokens) };
				const previous = this.codexTotals;
				this.codexTotals = current;
				let delta: ICodexTotals;
				if (!previous) {
					delta = last ? { input: nonNegative(last.input_tokens), cached: nonNegative(last.cached_input_tokens), output: nonNegative(last.output_tokens) } : current;
				} else if (current.input < previous.input || current.output < previous.output) {
					// 累計が巻き戻った（会話の圧縮などで数え直しになった）。今回ぶんだけを足す。
					delta = last ? { input: nonNegative(last.input_tokens), cached: nonNegative(last.cached_input_tokens), output: nonNegative(last.output_tokens) } : { input: 0, cached: 0, output: 0 };
				} else {
					delta = { input: current.input - previous.input, cached: Math.max(0, current.cached - previous.cached), output: current.output - previous.output };
				}
				// Codex の input_tokens はキャッシュから読んだ分を含む。キャッシュ分は別に数える。
				const cached = Math.min(delta.cached, delta.input);
				this.addUsage(timestamp, this.codexModel, { input: delta.input - cached, output: delta.output, cacheCreation: 0, cacheRead: cached });
			}
			return;
		}
		if (item.type === 'response_item') {
			if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
				const callId = paradisTranscriptString(payload.call_id);
				// 引数は JSON（`["gh","pr","create"]` のような配列のこともある）。区切りを空白にしてから照合する。
				const argumentsText = `${paradisTranscriptString(payload.arguments) ?? ''} ${paradisTranscriptString(payload.input) ?? ''}`.replace(/["',[\]]+/g, ' ');
				if (callId && PR_CREATE_COMMAND_PATTERN.test(argumentsText)) {
					this.prCommandIds.add(callId);
				}
				return;
			}
			if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
				const callId = paradisTranscriptString(payload.call_id);
				if (callId && this.prCommandIds.has(callId)) {
					const url = PR_URL_PATTERN.exec(JSON.stringify(payload.output ?? ''))?.[0];
					if (url) {
						this.addPr(url, timestamp);
					}
				}
				return;
			}
			const spoken = paradisTranscriptMessageFromItem(item, 'codex', 64);
			if (spoken?.role === 'user') {
				this.addTurn(timestamp);
			}
		}
	}

	/** 読んだ JSON 行の数（テスト・診断用）。 */
	get parsedLines(): number {
		return this.lineCount;
	}
}

// ---- 集計 --------------------------------------------------------------------------------------

function inRange(day: string, since: string, until: string): boolean {
	return day >= since && day <= until;
}

function normalizeRoot(path: string, caseInsensitive: boolean): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * 作業ディレクトリを、それを含むもっとも深いスペースへ振り分ける関数を作る。
 * worktree がリポジトリの中（`.claude/worktrees/...` など）にあっても、worktree 側が勝つ。
 */
export function paradisCreateSpaceMatcher(spaces: readonly IParadisSpaceUsageSpace[], caseInsensitive: boolean): (cwd: string | undefined) => string | undefined {
	const roots = spaces.flatMap(space => space.roots.map(root => ({ key: space.key, root: normalizeRoot(root, caseInsensitive) })))
		.filter(entry => entry.root.length > 0)
		.sort((a, b) => b.root.length - a.root.length);
	return cwd => {
		if (!cwd) {
			return undefined;
		}
		const normalized = normalizeRoot(cwd, caseInsensitive);
		return roots.find(entry => normalized === entry.root || normalized.startsWith(`${entry.root}/`))?.key;
	};
}

/** ファイルごとの集計を、スペースごとの日別・モデル別トークン数へまとめる。 */
export function paradisAggregateSpaceUsage(
	summaries: Iterable<IParadisActivityFileSummary>,
	request: Pick<IParadisSpaceUsageRequest, 'since' | 'until'>,
	matchSpace: (cwd: string | undefined) => string | undefined,
): IParadisSpaceUsageBucket[] {
	const buckets = new Map<string, { days: Map<string, Map<string, IParadisTokenCounts>>; sessions: number }>();
	// 再開・分岐で前の会話の応答が新しいファイルへ写されることがあるので、応答の識別子はファイルをまたいで
	// 1回だけ数える（ccusage と同じ扱い。先に渡されたファイルが勝つ）。
	const seenUsage = new Set<string>();
	const add = (key: string, day: string, model: string, tokens: IParadisTokenCounts) => {
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { days: new Map(), sessions: 0 };
			buckets.set(key, bucket);
		}
		let models = bucket.days.get(day);
		if (!models) {
			models = new Map();
			bucket.days.set(day, models);
		}
		models.set(model, addTokens(models.get(model) ?? ZERO_TOKENS, tokens));
	};
	for (const summary of summaries) {
		const key = matchSpace(summary.cwd) ?? PARADIS_SPACE_USAGE_OTHER_KEY;
		let active = false;
		for (const [day, value] of Object.entries(summary.days)) {
			if (!inRange(day, request.since, request.until)) {
				continue;
			}
			for (const [model, tokens] of Object.entries(value.models)) {
				add(key, day, model, tokens);
				active = true;
			}
		}
		for (const [usageKey, day, model, input, output, cacheCreation, cacheRead] of summary.keyedUsage ?? []) {
			if (seenUsage.has(usageKey)) {
				continue;
			}
			seenUsage.add(usageKey);
			if (inRange(day, request.since, request.until)) {
				add(key, day, model, { input, output, cacheCreation, cacheRead });
				active = true;
			}
		}
		if (active && summary.root) {
			buckets.get(key)!.sessions++;
		}
	}
	return [...buckets].map(([key, bucket]) => ({
		key,
		sessions: bucket.sessions,
		days: Object.fromEntries([...bucket.days].map(([day, models]) => [day, Object.fromEntries(models)])),
	}));
}

/**
 * ファイルごとの集計を、エージェントごとの作業実績へまとめる。再開・分岐で写された依頼は、行の識別子で
 * ファイルをまたいで1回だけ数える（写しただけのファイルはエージェント数にも入らない）。稼働時間は
 * ファイルごとの記録の間隔から出すので、写された区間は重ねて数えることがある。
 */
export function paradisAggregateWorkStats(summaries: Iterable<IParadisActivityFileSummary>, request: Pick<IParadisWorkStatsRequest, 'since' | 'until'>): IParadisWorkStatsResult['agents'] {
	const agents = new Map<ParadisActivityAgent, { sessions: number; turns: number; activeMs: number; prs: Set<string>; days: Map<string, { turns: number; activeMs: number }> }>();
	for (const agent of PARADIS_ACTIVITY_AGENTS) {
		agents.set(agent, { sessions: 0, turns: 0, activeMs: 0, prs: new Set(), days: new Map() });
	}
	const seenTurns = new Set<string>();
	for (const summary of summaries) {
		if (!summary.root) {
			continue;
		}
		const target = agents.get(summary.agent)!;
		const dayEntry = (day: string) => {
			const entry = target.days.get(day) ?? { turns: 0, activeMs: 0 };
			target.days.set(day, entry);
			return entry;
		};
		let turns = 0;
		for (const [day, value] of Object.entries(summary.days)) {
			if (!inRange(day, request.since, request.until) || (value.turns === 0 && value.activeMs === 0)) {
				continue;
			}
			const entry = dayEntry(day);
			entry.turns += value.turns;
			entry.activeMs += value.activeMs;
			target.turns += value.turns;
			target.activeMs += value.activeMs;
			turns += value.turns;
		}
		for (const [turnKey, day] of summary.keyedTurns ?? []) {
			if (seenTurns.has(turnKey)) {
				continue;
			}
			seenTurns.add(turnKey);
			if (inRange(day, request.since, request.until)) {
				dayEntry(day).turns++;
				target.turns++;
				turns++;
			}
		}
		if (turns > 0) {
			target.sessions++;
		}
		for (const pr of summary.prs) {
			if (inRange(pr.day, request.since, request.until)) {
				target.prs.add(pr.url);
			}
		}
	}
	const finish = (agent: ParadisActivityAgent): IParadisWorkStatsAgent => {
		const value = agents.get(agent)!;
		return { sessions: value.sessions, turns: value.turns, activeMs: value.activeMs, prs: value.prs.size, days: Object.fromEntries(value.days) };
	};
	return { claude: finish('claude'), codex: finish('codex') };
}

/** 作業実績タブのエージェントの絞り込み。 */
export type ParadisWorkStatsAgentFilter = 'all' | ParadisActivityAgent;

/** 指定のエージェント（または全部）の実績を足し合わせる。 */
export function paradisCombineWorkStats(result: IParadisWorkStatsResult, filter: ParadisWorkStatsAgentFilter, days: readonly string[]): { sessions: number; turns: number; activeMs: number; prs: number; dailyTurns: number[] } {
	const agents: IParadisWorkStatsAgent[] = (filter === 'all' ? PARADIS_ACTIVITY_AGENTS : [filter]).map(agent => result.agents[agent]);
	return {
		sessions: agents.reduce((sum, agent) => sum + agent.sessions, 0),
		turns: agents.reduce((sum, agent) => sum + agent.turns, 0),
		activeMs: agents.reduce((sum, agent) => sum + agent.activeMs, 0),
		prs: agents.reduce((sum, agent) => sum + agent.prs, 0),
		dailyTurns: days.map(day => agents.reduce((sum, agent) => sum + (agent.days[day]?.turns ?? 0), 0)),
	};
}

// ---- 金額の按分 ---------------------------------------------------------------------------------

/**
 * トークンの種類ごとの重み（入力 = 1）。Claude・OpenAI とも、出力は入力の約5〜8倍、キャッシュ書き込みは
 * 約1.25倍、キャッシュ読み取りは約0.1倍の単価で、この比はモデルが変わってもほぼ保たれる。
 * 生のトークン数で割ると、量は多いが安いキャッシュ読み取りが按分をほぼ決めてしまうため、この比で重みを付ける。
 * 金額そのものは常に ccusage の値を使う（ここは価格表ではない）。
 */
const TOKEN_WEIGHTS: IParadisTokenCounts = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 };

export function paradisWeightedTokens(tokens: IParadisTokenCounts): number {
	return tokens.input * TOKEN_WEIGHTS.input + tokens.output * TOKEN_WEIGHTS.output
		+ tokens.cacheCreation * TOKEN_WEIGHTS.cacheCreation + tokens.cacheRead * TOKEN_WEIGHTS.cacheRead;
}

/** ccusage の日別・モデル別の金額（按分の元）。 */
export interface IParadisCostDay {
	readonly date: string;
	readonly models: readonly { readonly model: string; readonly agent: string; readonly cost: number }[];
}

export interface IParadisSpaceCost {
	readonly key: string;
	readonly cost: number;
	readonly tokens: number;
	readonly sessions: number;
}

export interface IParadisSpaceCostAllocation {
	readonly spaces: readonly IParadisSpaceCost[];
	/** 会話ログに対応する記録が見つからず、どのスペースにも分けられなかった金額。 */
	readonly unallocatedCost: number;
	readonly totalCost: number;
}

function modelKey(model: string): string {
	// ccusage と会話ログでモデル名の綴りが揃わないことがある（接頭辞・日付の有無）。比較用に正規化する。
	return model.toLowerCase().replace(/^\[[^\]]*\]\s*/, '').replace(/-\d{8}$/, '');
}

function agentForModel(model: string): string {
	const name = modelKey(model);
	if (name.startsWith('claude')) {
		return 'claude';
	}
	if (name.startsWith('gpt') || name.includes('codex') || /^o\d/.test(name)) {
		return 'codex';
	}
	return 'other';
}

/**
 * ccusage の金額を、スペースごとのトークン比率で按分する。
 *
 * 日ごと・モデルごとに「そのモデルをその日に使ったトークン（種類ごとに重み付け）」の比で分ける。
 * 同じモデルの記録が会話ログに無ければ、同じエージェントのその日の全モデルの比で分ける。それも無い金額と、
 * Claude Code・Codex 以外（Gemini など）の金額は {@link IParadisSpaceCostAllocation.unallocatedCost} に残す。
 * こうすると、スペース別の合計と未割り当ての和が ccusage の合計に一致する。
 */
export function paradisAllocateSpaceCosts(costDays: readonly IParadisCostDay[], buckets: readonly IParadisSpaceUsageBucket[], since: string, until: string): IParadisSpaceCostAllocation {
	const costs = new Map<string, number>(buckets.map(bucket => [bucket.key, 0]));
	let unallocatedCost = 0;
	let totalCost = 0;
	for (const costDay of costDays) {
		if (!inRange(costDay.date, since, until)) {
			continue;
		}
		const weightsByModel = new Map<string, Map<string, number>>();
		const weightsByAgent = new Map<string, Map<string, number>>();
		for (const bucket of buckets) {
			for (const [model, tokens] of Object.entries(bucket.days[costDay.date] ?? {})) {
				const weight = paradisWeightedTokens(tokens);
				if (weight <= 0) {
					continue;
				}
				for (const [map, key] of [[weightsByModel, modelKey(model)], [weightsByAgent, agentForModel(model)]] as const) {
					let inner = map.get(key);
					if (!inner) {
						inner = new Map();
						map.set(key, inner);
					}
					inner.set(bucket.key, (inner.get(bucket.key) ?? 0) + weight);
				}
			}
		}
		for (const entry of costDay.models) {
			if (!(entry.cost > 0)) {
				continue;
			}
			totalCost += entry.cost;
			const agent = entry.agent === 'claude' || entry.agent === 'codex' ? entry.agent : agentForModel(entry.model);
			// 同じモデル、なければ同じエージェントの記録だけで分ける。別のエージェントや他のツール（Gemini など）の
			// 金額をスペースへ配らないよう、どちらも無い分は未割り当てに残す。
			const weights = weightsByModel.get(modelKey(entry.model)) ?? (agent === 'other' ? undefined : weightsByAgent.get(agent));
			const sum = weights ? [...weights.values()].reduce((a, b) => a + b, 0) : 0;
			if (!weights || sum <= 0) {
				unallocatedCost += entry.cost;
				continue;
			}
			for (const [key, weight] of weights) {
				costs.set(key, (costs.get(key) ?? 0) + entry.cost * weight / sum);
			}
		}
	}
	const spaces = buckets.map(bucket => {
		let tokens = 0;
		for (const [day, models] of Object.entries(bucket.days)) {
			if (inRange(day, since, until)) {
				for (const value of Object.values(models)) {
					tokens += paradisTotalTokens(value);
				}
			}
		}
		return { key: bucket.key, cost: costs.get(bucket.key) ?? 0, tokens, sessions: bucket.sessions };
	});
	return { spaces, unallocatedCost, totalCost };
}
