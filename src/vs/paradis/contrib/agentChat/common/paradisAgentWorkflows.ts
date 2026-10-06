/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の Workflow（台本で子を束ねるバックグラウンドの実行）を、実行 1 つを単位として追う。
// モバイルのトークに 1 枚のカードを出し、押すと段階ごとの画面を開く（agent.workflows.v1）。
//
// 材料（Claude Code 2.1.177〜2.1.291 の実物で確認。workflow-verify の記録）:
//  - 親の transcript: Workflow の tool_use の input.script（`export const meta = {...}` の名前・説明・段階）と、
//    その結果の toolUseResult（`status: async_launched`・`taskType: local_workflow`・taskId・runId・workflowName・summary）。
//    終わりは `<task-notification>` の status（completed / failed / killed）
//  - `<session>/subagents/workflows/<runId>/journal.jsonl`: 子の started / result / failed（2.1.291 は started に label・phase）
//  - 同じフォルダの `agent-<id>.meta.json`: 2.1.284 から description（= ラベル）・workflowPhase
//  - `<session>/workflows/<runId>.json`: 終わったときに 1 回だけ書かれる。子ごとの状態・トークン・ツール回数・所要時間
//  - resume（resumeFromRunId）は同じ runId のまま新しいタスク ID で走り、journal に追記する
//
// 実行中のトークンは子の transcript を足し上げないと分からない（214 体で 41MB）ので出さない。終わった後の
// `<runId>.json` の値だけを送る。Node の API は使わない（ファイルを読むのは mobileRelay/node/paradisClaudeWorkflowFiles.ts）。

import type { IParadisShellSignal } from './paradisAgentShells.js';

/** 段階 1 つ。 */
export interface IParadisAgentWorkflowPhase {
	readonly title: string;
	readonly detail?: string;
}

/** stopped は killed（止めた）と、ペインが止まって推定したもの（estimated）。 */
export type ParadisAgentWorkflowStatus = 'running' | 'completed' | 'failed' | 'stopped';
/** 子の状態。stopped は Workflow が終わったのに結果の無かった子。 */
export type ParadisAgentWorkflowAgentState = 'running' | 'done' | 'failed' | 'stopped';

/** モバイルへ送る子 1 体。 */
export interface IParadisAgentWorkflowAgent {
	/** 子の ID（サブエージェントの一覧・詳細と同じ）。 */
	readonly id: string;
	readonly label?: string;
	/** 段階の番号（`phases` の添字。0 始まり）。分からなければ無い。 */
	readonly phase?: number;
	readonly state: ParadisAgentWorkflowAgentState;
	/** 起動した時刻（PC の時計）。 */
	readonly startedAt?: number;
	readonly durationMs?: number;
	readonly tokens?: number;
	readonly toolCalls?: number;
	readonly lastTool?: string;
	/** resume でキャッシュから返った。 */
	readonly cached?: true;
}

/** 状態ごとの子の数（送らなかった子も含む）。 */
export interface IParadisAgentWorkflowCounts {
	readonly running: number;
	readonly done: number;
	readonly failed: number;
	readonly stopped: number;
}

/** モバイルへ送る Workflow の実行 1 つ（agent の snapshot / delta の任意項目 `workflows`）。 */
export interface IParadisAgentWorkflow {
	readonly runId: string;
	readonly taskId?: string;
	/** 起動した Workflow の tool_use の ID（トークの行とカードを結ぶ）。 */
	readonly toolUseId?: string;
	readonly name: string;
	readonly summary?: string;
	readonly status: ParadisAgentWorkflowStatus;
	/** 状態を印ではなく推定で決めた（ペインが止まった）。 */
	readonly estimated?: true;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
	readonly phases: readonly IParadisAgentWorkflowPhase[];
	/** 子（上限 {@link PARADIS_WORKFLOW_LIMITS.agentsSent} 体。動いている・失敗を優先して残す）。 */
	readonly agents: readonly IParadisAgentWorkflowAgent[];
	/** 子の総数（送らなかった子も含む）。 */
	readonly agentCount: number;
	readonly counts: IParadisAgentWorkflowCounts;
	readonly totalTokens?: number;
	readonly totalToolCalls?: number;
	readonly error?: string;
}

export const PARADIS_WORKFLOW_LIMITS = {
	/** 1 つの会話で持つ実行の数（新しい順）。 */
	runs: 10,
	/** 1 つの実行で持つ子の数（Claude Code の上限は 1000）。 */
	agents: 1_000,
	/** 1 つの実行でモバイルへ送る子の数。 */
	agentsSent: 120,
	phases: 30,
	nameLength: 120,
	summaryLength: 300,
	labelLength: 120,
	phaseTitleLength: 80,
	phaseDetailLength: 200,
	errorLength: 300,
	toolNameLength: 60,
	/** 台本から meta を探す範囲（先頭から）。 */
	scriptScanLength: 64 * 1024,
} as const;

/** transcript から読む Workflow の手がかり。 */
export type IParadisWorkflowSignal =
	/** Workflow の tool_use（台本の meta）。 */
	| { readonly type: 'script'; readonly toolUseId: string; readonly name?: string; readonly description?: string; readonly phases?: readonly IParadisAgentWorkflowPhase[]; readonly resumeFromRunId?: string; readonly at: number }
	/** 起動の結果（toolUseResult）。 */
	| { readonly type: 'launched'; readonly toolUseId?: string; readonly taskId: string; readonly runId: string; readonly name?: string; readonly summary?: string; readonly at: number };

/** journal.jsonl の 1 行（読む側が要るものだけ）。 */
export interface IParadisWorkflowJournalEntry {
	readonly type: 'started' | 'result' | 'failed';
	readonly agentId: string;
	readonly label?: string;
	readonly phase?: string;
}

/** 実行のフォルダで見つけた子（meta.json と transcript のファイルの時刻）。 */
export interface IParadisWorkflowChildFile {
	readonly agentId: string;
	readonly label?: string;
	readonly phase?: string;
	/** transcript のファイルを作った時刻（PC の時計）。 */
	readonly startedAt?: number;
}

/** `<runId>.json`（終わったときに書かれる）から読んだもの。 */
export interface IParadisWorkflowResultFile {
	readonly status?: string;
	readonly name?: string;
	readonly summary?: string;
	readonly startTime?: number;
	readonly endTime?: number;
	readonly durationMs?: number;
	readonly phases: readonly IParadisAgentWorkflowPhase[];
	readonly agents: readonly IParadisWorkflowResultAgent[];
	readonly agentCount?: number;
	readonly totalTokens?: number;
	readonly totalToolCalls?: number;
	readonly error?: string;
}

export interface IParadisWorkflowResultAgent {
	readonly agentId: string;
	readonly label?: string;
	/** 1 始まり（ファイルのまま）。 */
	readonly phaseIndex?: number;
	readonly phaseTitle?: string;
	readonly state?: string;
	readonly startedAt?: number;
	readonly durationMs?: number;
	readonly tokens?: number;
	readonly toolCalls?: number;
	readonly lastToolName?: string;
	readonly cached?: boolean;
}

const RUN_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function clip(value: string | undefined, limit: number): string | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) {
		return undefined;
	}
	// allow-any-unicode-next-line
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// ---- 台本の meta -----------------------------------------------------------------------------------

/** `start`（開き括弧の位置）から対になる閉じ括弧の位置。文字列とコメントを飛ばす。見つからなければ -1。 */
function matchingBracket(text: string, start: number): number {
	const open = text[start];
	const close = open === '{' ? '}' : open === '[' ? ']' : undefined;
	if (close === undefined) {
		return -1;
	}
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\'' || ch === '"' || ch === '`') {
			i = skipString(text, i);
			if (i < 0) {
				return -1;
			}
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (ch === '{' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ']') {
			depth--;
			if (depth === 0) {
				return ch === close ? i : -1;
			}
		}
	}
	return -1;
}

/** 文字列の終わりの引用符の位置。閉じていなければ -1。 */
function skipString(text: string, start: number): number {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
		} else if (text[i] === quote) {
			return i;
		}
	}
	return -1;
}

/** `{ ... }` の中の、一番外側の階層にある `key: '文字列'` の値（テンプレートの埋め込みがあるものは読まない）。 */
function literalProperty(block: string, key: string): string | undefined {
	let depth = 0;
	for (let i = 0; i < block.length; i++) {
		const ch = block[i];
		if (ch === '\'' || ch === '"' || ch === '`') {
			const end = skipString(block, i);
			if (end < 0) {
				return undefined;
			}
			i = end;
			continue;
		}
		if (ch === '{' || ch === '[') {
			depth++;
			continue;
		}
		if (ch === '}' || ch === ']') {
			depth--;
			continue;
		}
		if (depth !== 1 || !block.startsWith(key, i) || /[A-Za-z0-9_$]/.test(block[i - 1] ?? '')) {
			continue;
		}
		const match = /^\s*:\s*(['"`])/.exec(block.slice(i + key.length));
		if (match === null) {
			continue;
		}
		const quoteAt = i + key.length + match[0].length - 1;
		const end = skipString(block, quoteAt);
		if (end < 0) {
			return undefined;
		}
		const raw = block.slice(quoteAt + 1, end);
		if (match[1] === '`' && raw.includes('${')) {
			return undefined;
		}
		return raw.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
	}
	return undefined;
}

/** 台本の `export const meta = {...}` から名前・説明・段階を読む（meta は純粋なリテラルと決まっている）。 */
export function paradisParseWorkflowScriptMeta(script: string): { readonly name?: string; readonly description?: string; readonly phases?: IParadisAgentWorkflowPhase[] } | undefined {
	const head = script.slice(0, PARADIS_WORKFLOW_LIMITS.scriptScanLength);
	const at = /\bexport\s+const\s+meta\s*=\s*\{/.exec(head);
	if (at === null) {
		return undefined;
	}
	const start = at.index + at[0].length - 1;
	const end = matchingBracket(head, start);
	if (end < 0) {
		return undefined;
	}
	const block = head.slice(start, end + 1);
	const name = clip(literalProperty(block, 'name'), PARADIS_WORKFLOW_LIMITS.nameLength);
	const description = clip(literalProperty(block, 'description'), PARADIS_WORKFLOW_LIMITS.summaryLength);
	let phases: IParadisAgentWorkflowPhase[] | undefined;
	const phasesAt = /\bphases\s*:\s*\[/.exec(block);
	if (phasesAt !== null) {
		const listStart = phasesAt.index + phasesAt[0].length - 1;
		const listEnd = matchingBracket(block, listStart);
		if (listEnd > 0) {
			phases = [];
			const list = block.slice(listStart, listEnd + 1);
			for (let i = 1; i < list.length && phases.length < PARADIS_WORKFLOW_LIMITS.phases; i++) {
				if (list[i] === '\'' || list[i] === '"' || list[i] === '`') {
					i = skipString(list, i);
					if (i < 0) {
						break;
					}
					continue;
				}
				if (list[i] !== '{') {
					continue;
				}
				const itemEnd = matchingBracket(list, i);
				if (itemEnd < 0) {
					break;
				}
				const item = list.slice(i, itemEnd + 1);
				const title = clip(literalProperty(item, 'title'), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
				const detail = clip(literalProperty(item, 'detail'), PARADIS_WORKFLOW_LIMITS.phaseDetailLength);
				if (title !== undefined) {
					phases.push({ title, ...(detail !== undefined ? { detail } : {}) });
				}
				i = itemEnd;
			}
		}
	}
	return { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(phases !== undefined ? { phases } : {}) };
}

/** Workflow の tool_use の input から手がかりを作る（台本を渡したとき・resume のとき）。 */
export function paradisWorkflowScriptSignal(input: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisWorkflowSignal | undefined {
	if (toolUseId === undefined || input === undefined) {
		return undefined;
	}
	const script = str(input.script);
	const meta = script !== undefined ? paradisParseWorkflowScriptMeta(script) : undefined;
	const resume = str(input.resumeFromRunId);
	const resumeFromRunId = resume !== undefined && RUN_ID.test(resume) ? resume : undefined;
	if (meta === undefined && resumeFromRunId === undefined) {
		return undefined;
	}
	return { type: 'script', toolUseId, at, ...meta, ...(resumeFromRunId !== undefined ? { resumeFromRunId } : {}) };
}

/** 起動の結果（toolUseResult）から手がかりを作る。Workflow の起動でなければ undefined。 */
export function paradisWorkflowLaunchSignal(toolUseResult: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisWorkflowSignal | undefined {
	if (str(toolUseResult?.status) !== 'async_launched' || str(toolUseResult?.taskType) !== 'local_workflow') {
		return undefined;
	}
	const taskId = str(toolUseResult?.taskId);
	const runId = str(toolUseResult?.runId);
	if (taskId === undefined || !TASK_ID.test(taskId) || runId === undefined || !RUN_ID.test(runId)) {
		return undefined;
	}
	const name = clip(str(toolUseResult?.workflowName), PARADIS_WORKFLOW_LIMITS.nameLength);
	const summary = clip(str(toolUseResult?.summary), PARADIS_WORKFLOW_LIMITS.summaryLength);
	return {
		type: 'launched', taskId, runId, at,
		...(toolUseId !== undefined ? { toolUseId } : {}),
		...(name !== undefined ? { name } : {}),
		...(summary !== undefined ? { summary } : {}),
	};
}

// ---- ファイルの形 -----------------------------------------------------------------------------------

const JOURNAL_HEAD = /^\{"type":"(?<type>started|result|failed)","key":"[^"]{0,200}","agentId":"(?<agentId>[A-Za-z0-9._:-]{1,200})"/;
/** 頭だけで読めない行を JSON として読む上限（`result` の行は子の返り値の全文で、MB になる）。 */
const JOURNAL_PARSE_LIMIT = 64 * 1024;

/** journal.jsonl の 1 行。started は label・phase を読むため JSON として読み、result は頭だけで読む。 */
export function paradisParseWorkflowJournalLine(line: string): IParadisWorkflowJournalEntry | undefined {
	const head = JOURNAL_HEAD.exec(line);
	if (head?.groups !== undefined && head.groups.type !== 'started') {
		return { type: head.groups.type as 'result' | 'failed', agentId: head.groups.agentId };
	}
	if (line.length > JOURNAL_PARSE_LIMIT) {
		return undefined;
	}
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return undefined;
	}
	const type = str(obj?.type);
	const agentId = str(obj?.agentId);
	if ((type !== 'started' && type !== 'result' && type !== 'failed') || agentId === undefined || !AGENT_ID.test(agentId)) {
		return undefined;
	}
	const label = clip(str(obj?.label), PARADIS_WORKFLOW_LIMITS.labelLength);
	const phase = clip(str(obj?.phase), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
	return { type, agentId, ...(label !== undefined ? { label } : {}), ...(phase !== undefined ? { phase } : {}) };
}

/** 子の meta.json（2.1.284 から description = ラベル・workflowPhase）。 */
export function paradisParseWorkflowChildMeta(agentId: string, text: string): IParadisWorkflowChildFile | undefined {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(text));
	} catch {
		return undefined;
	}
	if (obj === undefined || !AGENT_ID.test(agentId)) {
		return undefined;
	}
	const label = clip(str(obj.description), PARADIS_WORKFLOW_LIMITS.labelLength);
	const phase = clip(str(obj.workflowPhase), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
	return { agentId, ...(label !== undefined ? { label } : {}), ...(phase !== undefined ? { phase } : {}) };
}

/** `<runId>.json` の中身を読む（台本・結果の本文・ログは捨てる）。 */
export function paradisParseWorkflowResultFile(value: unknown): IParadisWorkflowResultFile | undefined {
	const obj = rec(value);
	if (obj === undefined) {
		return undefined;
	}
	const phases: IParadisAgentWorkflowPhase[] = [];
	const rawPhases = Array.isArray(obj.phases) ? obj.phases : [];
	for (const raw of rawPhases.slice(0, PARADIS_WORKFLOW_LIMITS.phases)) {
		const title = clip(str(rec(raw)?.title), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
		const detail = clip(str(rec(raw)?.detail), PARADIS_WORKFLOW_LIMITS.phaseDetailLength);
		if (title !== undefined) {
			phases.push({ title, ...(detail !== undefined ? { detail } : {}) });
		}
	}
	const agents: IParadisWorkflowResultAgent[] = [];
	const progress = Array.isArray(obj.workflowProgress) ? obj.workflowProgress : [];
	for (const raw of progress) {
		const item = rec(raw);
		if (item === undefined) {
			continue;
		}
		if (item.type === 'workflow_phase') {
			const title = clip(str(item.title), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
			// meta.phases に無い段階（phase() の呼び出しだけのもの）も段階として残す
			if (title !== undefined && !phases.some(phase => phase.title === title) && phases.length < PARADIS_WORKFLOW_LIMITS.phases) {
				phases.push({ title });
			}
			continue;
		}
		if (item.type !== 'workflow_agent' || agents.length >= PARADIS_WORKFLOW_LIMITS.agents) {
			continue;
		}
		const agentId = str(item.agentId);
		if (agentId === undefined || !AGENT_ID.test(agentId)) {
			continue;
		}
		const label = clip(str(item.label), PARADIS_WORKFLOW_LIMITS.labelLength);
		const phaseTitle = clip(str(item.phaseTitle), PARADIS_WORKFLOW_LIMITS.phaseTitleLength);
		const lastToolName = clip(str(item.lastToolName), PARADIS_WORKFLOW_LIMITS.toolNameLength);
		const phaseIndex = num(item.phaseIndex);
		const startedAt = num(item.startedAt);
		const durationMs = num(item.durationMs);
		const tokens = num(item.tokens);
		const toolCalls = num(item.toolCalls);
		agents.push({
			agentId,
			...(label !== undefined ? { label } : {}),
			...(phaseIndex !== undefined ? { phaseIndex } : {}),
			...(phaseTitle !== undefined ? { phaseTitle } : {}),
			...(str(item.state) !== undefined ? { state: str(item.state) } : {}),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			...(tokens !== undefined ? { tokens } : {}),
			...(toolCalls !== undefined ? { toolCalls } : {}),
			...(lastToolName !== undefined ? { lastToolName } : {}),
			...(item.cached === true ? { cached: true } : {}),
		});
	}
	const startTime = num(obj.startTime);
	const durationMs = num(obj.durationMs);
	const ended = Date.parse(str(obj.timestamp) ?? '');
	const endTime = Number.isFinite(ended) ? ended : startTime !== undefined && durationMs !== undefined ? startTime + durationMs : undefined;
	const name = clip(str(obj.workflowName), PARADIS_WORKFLOW_LIMITS.nameLength);
	const summary = clip(str(obj.summary), PARADIS_WORKFLOW_LIMITS.summaryLength);
	const error = clip(typeof obj.error === 'string' ? obj.error : str(rec(obj.error)?.message), PARADIS_WORKFLOW_LIMITS.errorLength);
	const agentCount = num(obj.agentCount);
	const totalTokens = num(obj.totalTokens);
	const totalToolCalls = num(obj.totalToolCalls);
	return {
		phases, agents,
		...(str(obj.status) !== undefined ? { status: str(obj.status) } : {}),
		...(name !== undefined ? { name } : {}),
		...(summary !== undefined ? { summary } : {}),
		...(startTime !== undefined ? { startTime } : {}),
		...(endTime !== undefined ? { endTime } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(agentCount !== undefined ? { agentCount } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(totalToolCalls !== undefined ? { totalToolCalls } : {}),
		...(error !== undefined ? { error } : {}),
	};
}

// ---- 追跡 --------------------------------------------------------------------------------------

interface IMutableAgent {
	readonly id: string;
	label?: string;
	phaseTitle?: string;
	phaseIndex?: number;
	state: ParadisAgentWorkflowAgentState;
	startedAt?: number;
	durationMs?: number;
	tokens?: number;
	toolCalls?: number;
	lastTool?: string;
	cached?: boolean;
	/** 一覧に入った順（並びを保つ）。 */
	readonly order: number;
}

interface IMutableRun {
	readonly runId: string;
	taskId?: string;
	toolUseId?: string;
	name?: string;
	summary?: string;
	status: ParadisAgentWorkflowStatus;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	phases: IParadisAgentWorkflowPhase[];
	readonly agents: Map<string, IMutableAgent>;
	agentCount?: number;
	totalTokens?: number;
	totalToolCalls?: number;
	error?: string;
	/** `<runId>.json` を、今の起動（resume を含む）の後に書かれたものとして当てた。 */
	resultApplied: boolean;
}

/** 読む側（node）が実行のフォルダを読み直すときの手がかり。 */
export interface IParadisWorkflowRunToRefresh {
	readonly runId: string;
	/** 動いている（journal と子の追記を見る）。 */
	readonly running: boolean;
	/** 今の起動の時刻（これより前に書かれた `<runId>.json` は前の起動のもの）。 */
	readonly launchedAt: number;
}

/**
 * 1 つの会話（tailer の epoch）の Workflow の実行。transcript の手がかりと、実行のフォルダから読んだものを当てる。
 * 当てる関数は、モバイルへ送る形が変わったら true を返す。
 */
export class ParadisAgentWorkflowTracker {

	/** 挿入順 = 起動を見つけた順。 */
	private readonly runs = new Map<string, IMutableRun>();
	private readonly runByTask = new Map<string, string>();
	/** 起動の結果より先に見た台本（tool_use の ID → 中身）。 */
	private readonly scripts = new Map<string, Extract<IParadisWorkflowSignal, { type: 'script' }>>();
	private nextOrder = 0;
	private revisionCount = 0;

	get size(): number {
		return this.runs.size;
	}

	/** 送る形が変わるたびに増える版（送り手は中身を比べずにこれで変化を知る）。 */
	get revision(): number {
		return this.revisionCount;
	}

	private bump(changed: boolean): boolean {
		if (changed) {
			this.revisionCount++;
		}
		return changed;
	}

	clear(): boolean {
		const changed = this.runs.size > 0;
		this.runs.clear();
		this.runByTask.clear();
		this.scripts.clear();
		return this.bump(changed);
	}

	/** transcript の手がかり（Workflow の起動と、終わりの通知を含むシェルの手がかり）を順に当てる。 */
	apply(signals: readonly IParadisWorkflowSignal[], shellSignals: readonly IParadisShellSignal[] = []): boolean {
		let changed = false;
		for (const signal of signals) {
			if (signal.type === 'script') {
				this.scripts.set(signal.toolUseId, signal);
				while (this.scripts.size > PARADIS_WORKFLOW_LIMITS.runs * 2) {
					const oldest = this.scripts.keys().next();
					if (oldest.done === true) {
						break;
					}
					this.scripts.delete(oldest.value);
				}
				continue;
			}
			changed = this.launch(signal) || changed;
		}
		for (const signal of shellSignals) {
			if (signal.type !== 'ended') {
				continue;
			}
			const runId = this.runByTask.get(signal.taskId);
			const run = runId !== undefined ? this.runs.get(runId) : undefined;
			if (run === undefined || run.taskId !== signal.taskId || run.status !== 'running') {
				continue;
			}
			run.status = signal.status;
			run.endedAt = Math.max(signal.at, run.startedAt);
			this.settleAgents(run);
			changed = true;
		}
		return this.bump(changed);
	}

	private launch(signal: Extract<IParadisWorkflowSignal, { type: 'launched' }>): boolean {
		const script = signal.toolUseId !== undefined ? this.scripts.get(signal.toolUseId) : undefined;
		const existing = this.runs.get(signal.runId);
		if (existing !== undefined && existing.taskId === signal.taskId) {
			return false;
		}
		const run: IMutableRun = existing ?? { runId: signal.runId, status: 'running', startedAt: signal.at, phases: [], agents: new Map(), resultApplied: false };
		if (existing !== undefined) {
			// resume（同じ runId・新しいタスク ID）。前の起動の結果は当て直さない。前の起動の子は、新しい結果を当てるときに入れ替わる
			if (existing.taskId !== undefined) {
				this.runByTask.delete(existing.taskId);
			}
			run.status = 'running';
			run.startedAt = signal.at;
			run.endedAt = undefined;
			run.durationMs = undefined;
			run.totalTokens = undefined;
			run.totalToolCalls = undefined;
			run.error = undefined;
			run.resultApplied = false;
			// 並びの最後へ（新しい起動）
			this.runs.delete(run.runId);
		}
		run.taskId = signal.taskId;
		run.toolUseId = signal.toolUseId ?? run.toolUseId;
		run.name = signal.name ?? script?.name ?? run.name;
		run.summary = signal.summary ?? script?.description ?? run.summary;
		if (script?.phases !== undefined && script.phases.length > 0) {
			run.phases = [...script.phases];
		}
		this.runs.set(run.runId, run);
		this.runByTask.set(signal.taskId, run.runId);
		this.enforceLimit();
		return true;
	}

	/** journal の追記を当てる。 */
	applyJournal(runId: string, entries: readonly IParadisWorkflowJournalEntry[]): boolean {
		const run = this.runs.get(runId);
		if (run === undefined || run.resultApplied) {
			return false;
		}
		let changed = false;
		for (const entry of entries) {
			const agent = this.agent(run, entry.agentId);
			if (agent === undefined) {
				continue;
			}
			const before = JSON.stringify(agent);
			if (entry.label !== undefined) {
				agent.label = entry.label;
			}
			if (entry.phase !== undefined) {
				this.placeInPhase(run, agent, entry.phase);
			}
			if (entry.type === 'result') {
				agent.state = 'done';
			} else if (entry.type === 'failed') {
				agent.state = 'failed';
			} else if (agent.state !== 'done' && agent.state !== 'failed') {
				agent.state = run.status === 'running' ? 'running' : 'stopped';
			}
			changed = changed || before !== JSON.stringify(agent);
		}
		return this.bump(changed);
	}

	/** 実行のフォルダで見つけた子（meta.json のラベル・段階、transcript を作った時刻）を当てる。 */
	applyChildren(runId: string, children: readonly IParadisWorkflowChildFile[]): boolean {
		const run = this.runs.get(runId);
		if (run === undefined || run.resultApplied) {
			return false;
		}
		let changed = false;
		for (const child of children) {
			const known = run.agents.has(child.agentId);
			const agent = this.agent(run, child.agentId);
			if (agent === undefined) {
				continue;
			}
			const before = known ? JSON.stringify(agent) : '';
			if (agent.label === undefined && child.label !== undefined) {
				agent.label = child.label;
			}
			if (agent.phaseTitle === undefined && child.phase !== undefined) {
				this.placeInPhase(run, agent, child.phase);
			}
			if (agent.startedAt === undefined && child.startedAt !== undefined) {
				agent.startedAt = child.startedAt;
			}
			changed = changed || before !== JSON.stringify(agent);
		}
		return this.bump(changed);
	}

	/** 子の SubagentStop（hook）。SSH 先のように journal を読めない構成で、終わった子を数えるため。 */
	noteChildStopped(runId: string, agentId: string): boolean {
		const run = this.runs.get(runId);
		if (run === undefined || run.resultApplied) {
			return false;
		}
		const agent = this.agent(run, agentId);
		if (agent === undefined || agent.state === 'done' || agent.state === 'failed') {
			return false;
		}
		agent.state = 'done';
		return this.bump(true);
	}

	/** `<runId>.json` を当てる（`writtenAt` はファイルの時刻。今の起動より前のものは前の起動の結果なので当てない）。 */
	applyResult(runId: string, result: IParadisWorkflowResultFile, writtenAt: number): boolean {
		const run = this.runs.get(runId);
		if (run === undefined || run.resultApplied || writtenAt + 1_000 < run.startedAt) {
			return false;
		}
		run.resultApplied = true;
		if (run.status === 'running') {
			run.status = result.status === 'failed' ? 'failed' : result.status === 'killed' ? 'stopped' : 'completed';
		}
		run.name = result.name ?? run.name;
		run.summary = run.summary ?? result.summary;
		if (result.phases.length > 0) {
			run.phases = [...result.phases];
		}
		if (result.endTime !== undefined) {
			run.endedAt = run.endedAt ?? result.endTime;
		}
		run.durationMs = result.durationMs;
		run.agentCount = result.agentCount;
		run.totalTokens = result.totalTokens;
		run.totalToolCalls = result.totalToolCalls;
		run.error = result.error;
		// resume の後の結果は、キャッシュから返った子を含めて全部の子を持つ。結果に無い子は前の起動の子なので落とす
		if (result.agents.length > 0) {
			const kept = new Set(result.agents.map(item => item.agentId));
			for (const agentId of [...run.agents.keys()]) {
				if (!kept.has(agentId)) {
					run.agents.delete(agentId);
				}
			}
		}
		for (const item of result.agents) {
			const agent = this.agent(run, item.agentId);
			if (agent === undefined) {
				continue;
			}
			agent.label = item.label ?? agent.label;
			if (item.phaseIndex !== undefined && item.phaseIndex >= 1 && item.phaseIndex <= run.phases.length) {
				agent.phaseIndex = item.phaseIndex - 1;
				agent.phaseTitle = run.phases[item.phaseIndex - 1].title;
			} else if (item.phaseTitle !== undefined) {
				this.placeInPhase(run, agent, item.phaseTitle);
			}
			agent.state = item.state === 'done' ? 'done' : item.state === 'error' || item.state === 'failed' ? 'failed' : agent.state === 'running' ? 'stopped' : agent.state;
			agent.startedAt = item.startedAt ?? agent.startedAt;
			agent.durationMs = item.durationMs;
			agent.tokens = item.tokens;
			agent.toolCalls = item.toolCalls;
			agent.lastTool = item.lastToolName;
			agent.cached = item.cached === true ? true : undefined;
		}
		this.settleAgents(run);
		return this.bump(true);
	}

	/** 読み直しが要る実行（動いているもの・終わったが `<runId>.json` をまだ当てていないもの）。 */
	runsToRefresh(): IParadisWorkflowRunToRefresh[] {
		return [...this.runs.values()]
			.filter(run => run.status === 'running' || !run.resultApplied)
			.map(run => ({ runId: run.runId, running: run.status === 'running', launchedAt: run.startedAt }));
	}

	/** 子の ID → 実行の ID（シェルの持ち主を Workflow へ寄せるため）。 */
	runOfAgent(agentId: string): string | undefined {
		for (const run of this.runs.values()) {
			if (run.agents.has(agentId)) {
				return run.runId;
			}
		}
		return undefined;
	}

	hasRunning(): boolean {
		return [...this.runs.values()].some(run => run.status === 'running');
	}

	/** モバイルへ送る形（起動の古い順）。 */
	snapshot(): IParadisAgentWorkflow[] {
		return [...this.runs.values()].map(run => toWire(run));
	}

	private agent(run: IMutableRun, agentId: string): IMutableAgent | undefined {
		if (!AGENT_ID.test(agentId)) {
			return undefined;
		}
		let agent = run.agents.get(agentId);
		if (agent === undefined) {
			if (run.agents.size >= PARADIS_WORKFLOW_LIMITS.agents) {
				return undefined;
			}
			agent = { id: agentId, state: run.status === 'running' ? 'running' : 'stopped', order: this.nextOrder++ };
			run.agents.set(agentId, agent);
		}
		return agent;
	}

	private placeInPhase(run: IMutableRun, agent: IMutableAgent, title: string): void {
		let index = run.phases.findIndex(phase => phase.title === title);
		if (index < 0 && run.phases.length < PARADIS_WORKFLOW_LIMITS.phases) {
			run.phases = [...run.phases, { title }];
			index = run.phases.length - 1;
		}
		if (index >= 0) {
			agent.phaseTitle = title;
			agent.phaseIndex = index;
		}
	}

	/** 終わった実行で、結果の無いまま動いていた子を「中断」にする。 */
	private settleAgents(run: IMutableRun): void {
		if (run.status === 'running') {
			return;
		}
		for (const agent of run.agents.values()) {
			if (agent.state === 'running') {
				agent.state = 'stopped';
			}
		}
	}

	private enforceLimit(): void {
		while (this.runs.size > PARADIS_WORKFLOW_LIMITS.runs) {
			const victim = [...this.runs.values()].find(run => run.status !== 'running') ?? this.runs.values().next().value;
			if (victim === undefined) {
				break;
			}
			this.runs.delete(victim.runId);
			if (victim.taskId !== undefined) {
				this.runByTask.delete(victim.taskId);
			}
		}
	}
}

const AGENT_RANK: Record<ParadisAgentWorkflowAgentState, number> = { failed: 0, running: 1, stopped: 2, done: 3 };

function toWire(run: IMutableRun): IParadisAgentWorkflow {
	const all = [...run.agents.values()];
	const counts = { running: 0, done: 0, failed: 0, stopped: 0 };
	for (const agent of all) {
		counts[agent.state]++;
	}
	// 送る子は、失敗・動いている子を先に選び、選んだものを元の並びに戻す
	const picked = all.length <= PARADIS_WORKFLOW_LIMITS.agentsSent ? all
		: [...all].sort((a, b) => AGENT_RANK[a.state] - AGENT_RANK[b.state] || b.order - a.order).slice(0, PARADIS_WORKFLOW_LIMITS.agentsSent).sort((a, b) => a.order - b.order);
	const name = run.name ?? run.runId;
	return {
		runId: run.runId,
		...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
		...(run.toolUseId !== undefined ? { toolUseId: run.toolUseId } : {}),
		name,
		...(run.summary !== undefined ? { summary: run.summary } : {}),
		status: run.status,
		startedAt: run.startedAt,
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		phases: run.phases,
		agents: picked.map(agent => ({
			id: agent.id,
			...(agent.label !== undefined ? { label: agent.label } : {}),
			...(agent.phaseIndex !== undefined ? { phase: agent.phaseIndex } : {}),
			state: agent.state,
			...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
			...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
			...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
			...(agent.toolCalls !== undefined ? { toolCalls: agent.toolCalls } : {}),
			...(agent.lastTool !== undefined ? { lastTool: agent.lastTool } : {}),
			...(agent.cached === true ? { cached: true as const } : {}),
		})),
		agentCount: Math.max(all.length, run.agentCount ?? 0),
		counts,
		...(run.totalTokens !== undefined ? { totalTokens: run.totalTokens } : {}),
		...(run.totalToolCalls !== undefined ? { totalToolCalls: run.totalToolCalls } : {}),
		...(run.error !== undefined ? { error: run.error } : {}),
	};
}

/** ペインでエージェントが動いていないときに送る形（動いている実行と子を「中断（推定）」にする）。 */
export function paradisWorkflowsForStoppedPane(workflows: readonly IParadisAgentWorkflow[], endedAt: number | undefined): IParadisAgentWorkflow[] {
	return workflows.map(workflow => workflow.status !== 'running' ? workflow : {
		...workflow,
		status: 'stopped' as const,
		estimated: true as const,
		...(endedAt !== undefined ? { endedAt: Math.max(endedAt, workflow.startedAt) } : {}),
		agents: workflow.agents.map(agent => agent.state === 'running' ? { ...agent, state: 'stopped' as const } : agent),
		counts: { ...workflow.counts, running: 0, stopped: workflow.counts.stopped + workflow.counts.running },
	});
}
