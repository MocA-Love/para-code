/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のエージェントチーム（Agent Teams）を、チーム 1 つを単位として追う。モバイルのトークに 1 枚のカードを出し、
// 押すとメンバー・やりとり・計画を並べたチームの画面を開く（agent.teams.v1。team-card-mock の案 T1）。
//
// 材料（Claude Code 2.1.290〜2.1.292 の実物で確認。team-verify の記録）:
//  - リーダーの transcript: 名前付きの Agent の tool_use（description・prompt）と、その結果の toolUseResult
//    （`status: "teammate_spawned"`・team_name・name・agent_id・color・model・agent_type・tmux_pane_id・plan_mode_required）
//  - リーダーの SendMessage の tool_use（to・summary・message。message は文字列か `{ type: "shutdown_request" … }`）
//  - リーダーが受けた `<teammate-message teammate_id color summary>本文</teammate-message>`。1 つの user 行に複数入る。
//    本文が JSON のものは配送の印（idle_notification・plan_approval_request・shutdown_response など）
//  - メンバーの記録 `<session>/subagents/agent-<id>.jsonl`（in-process だけ）: 最後のツールと、メンバーが送った SendMessage
//  - `~/.claude/teams/<チーム>/config.json`: メンバーの backendType（in-process・tmux・iterm2）と色・モデル。チームは片付けられずに
//    残るので、config があることを「活動中」とは読まない（状態は記録の伸び・idle・hook で決める）
//  - hook: agent_id 付きの PreToolUse など（作業中）、TeammateIdle（待機）
//
// 共有のタスク（TaskCreate 等）は今のモデルでは道具が出ないので扱わない（Q264 の決定）。Node の API は使わない
// （ファイルを読むのは mobileRelay/node/paradisClaudeTeamFiles.ts）。

/** メンバーの状態。waiting は許可待ち、plan は計画の承認待ち、stopped はペインが止まって推定したもの。 */
export type ParadisAgentTeamMemberState = 'running' | 'idle' | 'waiting' | 'plan' | 'completed' | 'failed' | 'stopped';
/** メンバーが動く場所。in-process 以外は別のペイン（別のプロセス）で動き、記録も hook も Para Code の手元に無い。 */
export type ParadisAgentTeamBackend = 'in-process' | 'tmux' | 'iterm2' | 'other';
/** やりとりの種類。instruction はリーダーが起動時に渡した頼みごと。 */
export type ParadisAgentTeamMessageKind = 'instruction' | 'message' | 'plan' | 'shutdown';

/** モバイルへ送るメンバー 1 人。 */
export interface IParadisAgentTeamMember {
	readonly name: string;
	/** 子の記録の ID（in-process だけ。サブエージェントの詳細・許可のカードと同じ ID）。 */
	readonly agentId?: string;
	/** 起動した Agent の tool_use の ID。 */
	readonly toolUseId?: string;
	/** Claude Code の色の名前（`blue` など）。 */
	readonly color?: string;
	readonly model?: string;
	/** 種類（`Explore`・`Plan` など）。 */
	readonly agentType?: string;
	/** 起動の説明（Agent の description）。 */
	readonly description?: string;
	readonly backend: ParadisAgentTeamBackend;
	readonly state: ParadisAgentTeamMemberState;
	/** 状態を印ではなく推定で決めた（ペインが止まった）。 */
	readonly estimated?: true;
	/** 今やっていること（最後のツール。例 `Read README.md`）。 */
	readonly activity?: string;
	/** 許可待ちの承認の ID（トークの許可カードと同じ ID）と、そのツール名。 */
	readonly approvalId?: string;
	readonly approvalTool?: string;
	/** 失敗したときの理由（idle_notification の failureReason）。 */
	readonly failure?: string;
	readonly startedAt: number;
	readonly updatedAt: number;
}

/** メンバー間のやりとり 1 件。 */
export interface IParadisAgentTeamMessage {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	readonly kind: ParadisAgentTeamMessageKind;
	readonly summary?: string;
	readonly text: string;
	/** 本文を上限で切った。 */
	readonly truncated?: true;
	readonly at: number;
}

/** メンバーの計画（plan_approval_request。リーダーが答える。Q262 A で読むだけ）。 */
export interface IParadisAgentTeamPlan {
	readonly from: string;
	readonly text: string;
	readonly truncated?: true;
	readonly at: number;
	/** リーダーの答え（plan_approval_response）。まだなら無い。 */
	readonly approved?: boolean;
	readonly feedback?: string;
}

/** モバイルへ送るチーム 1 つ（agent の snapshot / delta の任意項目 `teams`）。 */
export interface IParadisAgentTeam {
	readonly name: string;
	/** リーダーの名前（やりとりの宛先に出る。既定は `team-lead`）。 */
	readonly leadName: string;
	/** メンバーを起動した Agent の tool_use の ID（トークの行とカードを結ぶ。最初のものにカードを置く）。 */
	readonly toolUseIds: readonly string[];
	readonly members: readonly IParadisAgentTeamMember[];
	/** やりとり（新しい方から {@link PARADIS_TEAM_LIMITS.messages} 件。古い順に並べる）。 */
	readonly messages: readonly IParadisAgentTeamMessage[];
	/** やりとりの総数（送らなかった古いものも含む）。 */
	readonly messageCount: number;
	readonly plans?: readonly IParadisAgentTeamPlan[];
	readonly startedAt: number;
	readonly updatedAt: number;
}

export const PARADIS_TEAM_LIMITS = {
	/** 1 つの会話で持つチームの数（新しい順）。 */
	teams: 5,
	/** 1 つのチームで持つメンバーの数。 */
	members: 30,
	/** 1 つのチームで持つやりとりの数（新しい順）。 */
	messages: 60,
	/** 結果を待っている名前付きの Agent の呼び出しの数。 */
	pendingCalls: 50,
	nameLength: 100,
	summaryLength: 200,
	textLength: 2_000,
	planLength: 6_000,
	activityLength: 100,
	failureLength: 300,
	descriptionLength: 200,
} as const;

/** 作業の印がこれより短い間に idle の後に来ても、待機のままとみなす（idle の直後に書かれる行で作業中に戻さない）。 */
const IDLE_SETTLE_MS = 2_000;
const NAME_PATTERN = /^[A-Za-z0-9._@:-]{1,100}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const COLOR_PATTERN = /^[a-z]{1,20}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:\[\]/-]{1,100}$/;

/** transcript から読むチームの手がかり（リーダーの記録）。 */
export type IParadisTeamSignal =
	/** 名前付きの Agent の tool_use（チームの起動か普通の名前付きの子かは結果で分かる）。 */
	| { readonly type: 'call'; readonly toolUseId: string; readonly name: string; readonly description?: string; readonly prompt?: string; readonly at: number }
	/** メンバーの起動の結果（toolUseResult の `status: "teammate_spawned"`）。 */
	| { readonly type: 'spawned'; readonly toolUseId?: string; readonly team: string; readonly name: string; readonly agentId?: string; readonly color?: string; readonly model?: string; readonly agentType?: string; readonly backend: ParadisAgentTeamBackend; readonly at: number }
	/** リーダーの SendMessage。`protocol` は構造化した message の type。 */
	| { readonly type: 'sent'; readonly to: string; readonly summary?: string; readonly text: string; readonly protocol?: string; readonly approved?: boolean; readonly at: number }
	/** リーダーが受けた `<teammate-message>`。`protocol` は本文が JSON のときの type。 */
	| { readonly type: 'received'; readonly from: string; readonly color?: string; readonly summary?: string; readonly text: string; readonly protocol?: IParadisTeammateProtocol; readonly at: number };

/** `<teammate-message>` の本文が配送の印（JSON）だったときの中身（要るものだけ）。 */
export interface IParadisTeammateProtocol {
	readonly type: string;
	readonly idleReason?: string;
	readonly failureReason?: string;
	readonly planContent?: string;
	readonly approve?: boolean;
	readonly approved?: boolean;
	readonly feedback?: string;
}

/** `<teammate-message>`・`<agent-message>` 1 つ（属性と本文）。 */
export interface IParadisTeammateTag {
	readonly name?: string;
	readonly color?: string;
	readonly summary?: string;
	readonly body: string;
	readonly protocol?: IParadisTeammateProtocol;
}

/** メンバーの記録から読んだもの（paradisTeamMemberLineSignals を行ごとにまとめたもの）。 */
export interface IParadisTeamMemberRead {
	/** 最後のツール（`Read README.md` など）。 */
	readonly activity?: string;
	/** 最後の会話の行の時刻。 */
	readonly lastLineAt?: number;
	/** メンバーが送った SendMessage。 */
	readonly sends: readonly { readonly to: string; readonly summary?: string; readonly text: string; readonly protocol?: string; readonly at: number }[];
}

/** `config.json` から読んだもの。 */
export interface IParadisTeamConfig {
	readonly leadName?: string;
	readonly members: readonly { readonly name: string; readonly agentType?: string; readonly model?: string; readonly color?: string; readonly backend: ParadisAgentTeamBackend; readonly joinedAt?: number }[];
}

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown, limit = 1_000): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, limit) : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function matching(value: string | undefined, pattern: RegExp): string | undefined {
	return value !== undefined && pattern.test(value) ? value : undefined;
}

function decodeAttribute(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function clip(text: string, limit: number): { readonly text: string; readonly truncated?: true } {
	return text.length > limit ? { text: `${text.slice(0, limit)}…`, truncated: true } : { text };
}

/** 本文が配送の印（JSON の type 付き）なら、その中身。 */
function teammateProtocol(body: string): IParadisTeammateProtocol | undefined {
	if (!body.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed = rec(JSON.parse(body));
		const type = str(parsed?.type, 60);
		if (parsed === undefined || type === undefined) {
			return undefined;
		}
		return {
			type,
			...(str(parsed.idleReason, 60) !== undefined ? { idleReason: str(parsed.idleReason, 60) } : {}),
			...(str(parsed.failureReason, PARADIS_TEAM_LIMITS.failureLength) !== undefined ? { failureReason: str(parsed.failureReason, PARADIS_TEAM_LIMITS.failureLength) } : {}),
			...(typeof parsed.planContent === 'string' ? { planContent: parsed.planContent } : {}),
			...(typeof parsed.approve === 'boolean' ? { approve: parsed.approve } : {}),
			...(typeof parsed.approved === 'boolean' ? { approved: parsed.approved } : {}),
			...(str(parsed.feedback, PARADIS_TEAM_LIMITS.textLength) !== undefined ? { feedback: str(parsed.feedback, PARADIS_TEAM_LIMITS.textLength) } : {}),
		};
	} catch {
		return undefined; // 自然言語の報告は JSON ではない
	}
}

/**
 * user 行の本文から `<teammate-message>`・`<agent-message>` を全部取り出す。1 つの行に報告と idle_notification が
 * まとめて入ることがある（2.1.292 で実測。報告 1 + idle 2）ので、先頭の 1 つだけを見ない。
 */
export function paradisParseTeammateTags(rawText: string): IParadisTeammateTag[] {
	const tags: IParadisTeammateTag[] = [];
	for (const match of rawText.matchAll(/<(?<tag>teammate-message|agent-message)\b(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/\k<tag>>/g)) {
		const attributes = match.groups?.attributes ?? '';
		const body = (match.groups?.body ?? '').trim();
		const name = /\b(?:teammate_id|from)="(?<value>[^"]+)"/.exec(attributes)?.groups?.value;
		const color = /\bcolor="(?<value>[^"]+)"/.exec(attributes)?.groups?.value;
		const summary = /\bsummary="(?<value>[^"]+)"/.exec(attributes)?.groups?.value;
		const protocol = teammateProtocol(body);
		tags.push({
			body,
			...(name !== undefined ? { name: decodeAttribute(name) } : {}),
			...(color !== undefined ? { color: decodeAttribute(color) } : {}),
			...(summary !== undefined ? { summary: decodeAttribute(summary) } : {}),
			...(protocol !== undefined ? { protocol } : {}),
		});
	}
	return tags;
}

/** リーダーの名前付きの Agent / SendMessage の tool_use からチームの手がかりを作る。 */
export function paradisTeamCallSignal(tool: string, input: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisTeamSignal | undefined {
	if (tool === 'Agent' || tool === 'Task') {
		const name = matching(str(input?.name, PARADIS_TEAM_LIMITS.nameLength), NAME_PATTERN);
		if (name === undefined || toolUseId === undefined || !TOOL_USE_ID_PATTERN.test(toolUseId)) {
			return undefined;
		}
		const description = str(input?.description, PARADIS_TEAM_LIMITS.descriptionLength);
		const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined;
		return { type: 'call', toolUseId, name, ...(description !== undefined ? { description } : {}), ...(prompt !== undefined ? { prompt } : {}), at };
	}
	if (tool === 'SendMessage') {
		const to = matching(str(input?.to, PARADIS_TEAM_LIMITS.nameLength) ?? str(input?.recipient, PARADIS_TEAM_LIMITS.nameLength), /^(?:\*|[A-Za-z0-9._@:-]{1,100})$/);
		if (to === undefined) {
			return undefined;
		}
		const structured = rec(input?.message);
		const text = typeof input?.message === 'string' ? input.message : typeof input?.content === 'string' ? input.content : undefined;
		const protocol = str(structured?.type, 60);
		const summary = str(input?.summary, PARADIS_TEAM_LIMITS.summaryLength);
		if (protocol !== undefined) {
			return {
				type: 'sent', to, text: str(structured?.reason, PARADIS_TEAM_LIMITS.textLength) ?? str(structured?.feedback, PARADIS_TEAM_LIMITS.textLength) ?? '', protocol,
				...(typeof structured?.approve === 'boolean' ? { approved: structured.approve } : typeof structured?.approved === 'boolean' ? { approved: structured.approved } : {}),
				...(summary !== undefined ? { summary } : {}), at,
			};
		}
		return text !== undefined && text.trim().length > 0 ? { type: 'sent', to, text, ...(summary !== undefined ? { summary } : {}), at } : undefined;
	}
	return undefined;
}

/** メンバーの起動の結果（toolUseResult の `status: "teammate_spawned"`）。 */
export function paradisTeamSpawnSignal(toolUseResult: Record<string, unknown> | undefined, toolUseId: string | undefined, at: number): IParadisTeamSignal | undefined {
	if (toolUseResult?.status !== 'teammate_spawned') {
		return undefined;
	}
	const team = matching(str(toolUseResult.team_name, PARADIS_TEAM_LIMITS.nameLength), NAME_PATTERN);
	const name = matching(str(toolUseResult.name, PARADIS_TEAM_LIMITS.nameLength), NAME_PATTERN);
	if (team === undefined || name === undefined) {
		return undefined;
	}
	const agentId = matching(str(toolUseResult.agent_id) ?? str(toolUseResult.agentId), AGENT_ID_PATTERN);
	const color = matching(str(toolUseResult.color, 20), COLOR_PATTERN);
	const model = matching(str(toolUseResult.resolvedModel, 100) ?? str(toolUseResult.model, 100), MODEL_PATTERN);
	const agentType = str(toolUseResult.agent_type, 60);
	const pane = str(toolUseResult.tmux_pane_id, 60);
	const backend: ParadisAgentTeamBackend = pane === 'in-process' ? 'in-process' : pane !== undefined && pane.startsWith('%') || toolUseResult.is_splitpane === true ? 'tmux' : 'other';
	return {
		type: 'spawned', team, name, backend, at,
		...(toolUseId !== undefined && TOOL_USE_ID_PATTERN.test(toolUseId) ? { toolUseId } : {}),
		// 別のペインのメンバーは子の記録が手元に無いので、ID を結ばない
		...(agentId !== undefined && backend === 'in-process' ? { agentId } : {}),
		...(color !== undefined ? { color } : {}),
		...(model !== undefined ? { model } : {}),
		...(agentType !== undefined ? { agentType } : {}),
	};
}

/** リーダーが受けた user 行の本文から、チームの手がかりを作る（配送の前置きがあるものだけ）。 */
export function paradisTeamReceivedSignals(rawText: string, at: number): IParadisTeamSignal[] {
	if (!rawText.startsWith('Another Claude session sent a message')) {
		return [];
	}
	const signals: IParadisTeamSignal[] = [];
	for (const tag of paradisParseTeammateTags(rawText)) {
		const from = matching(tag.name, NAME_PATTERN);
		if (from === undefined) {
			continue;
		}
		const color = matching(tag.color, COLOR_PATTERN);
		signals.push({
			type: 'received', from, text: tag.body, at,
			...(color !== undefined ? { color } : {}),
			...(tag.summary !== undefined ? { summary: tag.summary.slice(0, PARADIS_TEAM_LIMITS.summaryLength) } : {}),
			...(tag.protocol !== undefined ? { protocol: tag.protocol } : {}),
		});
	}
	return signals;
}

/** ツールの呼び出しを「今やっていること」の 1 行にする（`Read README.md`・`Bash npm test`）。 */
export function paradisTeamActivityText(tool: string, input: Record<string, unknown> | undefined): string {
	const path = str(input?.file_path) ?? str(input?.path) ?? str(input?.notebook_path);
	const argument = tool === 'SendMessage' ? (str(input?.to) !== undefined ? `→ ${str(input?.to)}` : undefined)
		: str(input?.description) ?? (path !== undefined ? path.split(/[\\/]/).filter(part => part.length > 0).at(-1) : undefined)
		?? str(input?.pattern) ?? str(input?.query) ?? str(input?.url) ?? str(input?.command)?.split('\n')[0] ?? str(input?.prompt)?.split('\n')[0];
	const textValue = argument !== undefined ? `${tool} ${argument}` : tool;
	return textValue.length > PARADIS_TEAM_LIMITS.activityLength ? `${textValue.slice(0, PARADIS_TEAM_LIMITS.activityLength - 1)}…` : textValue;
}

/**
 * メンバーの記録の行（JSON を読んだもの）をまとめる。最後のツールと最後の行の時刻、メンバーが送った SendMessage を取る。
 * `attachment` などの付属の行は作業の印に数えない。
 */
export function paradisTeamMemberRead(lines: readonly Record<string, unknown>[]): IParadisTeamMemberRead {
	let activity: string | undefined;
	let lastLineAt: number | undefined;
	const sends: { to: string; summary?: string; text: string; protocol?: string; at: number }[] = [];
	for (const line of lines) {
		if (line.type !== 'assistant' && line.type !== 'user') {
			continue;
		}
		const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
		if (!Number.isFinite(at)) {
			continue;
		}
		lastLineAt = Math.max(lastLineAt ?? 0, at);
		const content = rec(line.message)?.content;
		if (line.type !== 'assistant' || !Array.isArray(content)) {
			continue;
		}
		for (const raw of content) {
			const block = rec(raw);
			if (block?.type !== 'tool_use') {
				continue;
			}
			const tool = str(block.name, 80) ?? 'tool';
			const input = rec(block.input);
			activity = paradisTeamActivityText(tool, input);
			const signal = tool === 'SendMessage' ? paradisTeamCallSignal(tool, input, undefined, at) : undefined;
			if (signal?.type === 'sent') {
				sends.push({ to: signal.to, text: signal.text, at, ...(signal.summary !== undefined ? { summary: signal.summary } : {}), ...(signal.protocol !== undefined ? { protocol: signal.protocol } : {}) });
			}
		}
	}
	return { sends, ...(activity !== undefined ? { activity } : {}), ...(lastLineAt !== undefined ? { lastLineAt } : {}) };
}

/** `config.json` を読む（形の違うものは undefined）。 */
export function paradisParseTeamConfig(value: unknown): IParadisTeamConfig | undefined {
	const config = rec(value);
	if (config === undefined || !Array.isArray(config.members)) {
		return undefined;
	}
	const leadId = str(config.leadAgentId, 200);
	let leadName: string | undefined;
	const members: IParadisTeamConfig['members'][number][] = [];
	for (const raw of config.members.slice(0, PARADIS_TEAM_LIMITS.members + 1)) {
		const member = rec(raw);
		const name = matching(str(member?.name, PARADIS_TEAM_LIMITS.nameLength), NAME_PATTERN);
		if (member === undefined || name === undefined) {
			continue;
		}
		if (str(member.agentType) === 'team-lead' || (leadId !== undefined && str(member.agentId, 200) === leadId)) {
			leadName = name;
			continue;
		}
		const backendType = str(member.backendType, 40);
		const backend: ParadisAgentTeamBackend = backendType === 'in-process' || backendType === 'tmux' || backendType === 'iterm2' ? backendType : 'other';
		const color = matching(str(member.color, 20), COLOR_PATTERN);
		const model = matching(str(member.model, 100), MODEL_PATTERN);
		const agentType = str(member.agentType, 60);
		const joinedAt = finite(member.joinedAt);
		members.push({ name, backend, ...(color !== undefined ? { color } : {}), ...(model !== undefined ? { model } : {}), ...(agentType !== undefined ? { agentType } : {}), ...(joinedAt !== undefined ? { joinedAt } : {}) });
	}
	return { members, ...(leadName !== undefined ? { leadName } : {}) };
}

interface IMemberRecord {
	readonly name: string;
	agentId?: string;
	toolUseId?: string;
	color?: string;
	model?: string;
	agentType?: string;
	description?: string;
	backend: ParadisAgentTeamBackend;
	startedAt: number;
	updatedAt: number;
	/** 作業の印の最後の時刻。 */
	activeAt: number;
	idleAt?: number;
	idleFailed?: boolean;
	failure?: string;
	activity?: string;
	endedAt?: number;
}

interface ITeamRecord {
	readonly name: string;
	leadName: string;
	readonly members: Map<string, IMemberRecord>;
	readonly toolUseIds: string[];
	readonly messages: IParadisAgentTeamMessage[];
	readonly messageKeys: Set<string>;
	messageCount: number;
	readonly plans: Map<string, IParadisAgentTeamPlan>;
	startedAt: number;
	updatedAt: number;
}

/** やりとりを二重に数えないための鍵（送った側の記録と、受けた側の記録の両方に同じものがある）。 */
function messageKey(from: string, to: string, text: string): string {
	return `${from}\0${to}\0${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
}

/** 承認の待ち（メンバーの子の ID → 承認の ID とツール名）。 */
export type ParadisTeamApprovals = ReadonlyMap<string, { readonly id: string; readonly tool?: string }>;

/** チームを追う（会話 1 つ = tailer の epoch ごと）。 */
export class ParadisAgentTeamTracker {
	private readonly teams = new Map<string, ITeamRecord>();
	private readonly pendingCalls = new Map<string, Extract<IParadisTeamSignal, { type: 'call' }>>();
	private revisionValue = 0;

	/** 中身が変わった回数（送る側の変化の判定に使う）。 */
	get revision(): number {
		return this.revisionValue;
	}

	get size(): number {
		return this.teams.size;
	}

	clear(): void {
		if (this.teams.size > 0 || this.pendingCalls.size > 0) {
			this.teams.clear();
			this.pendingCalls.clear();
			this.revisionValue++;
		}
	}

	/** リーダーの記録の手がかりを当てる。変わったら true。 */
	apply(signals: readonly IParadisTeamSignal[]): boolean {
		let changed = false;
		for (const signal of signals) {
			switch (signal.type) {
				case 'call':
					this.pendingCalls.delete(signal.toolUseId);
					this.pendingCalls.set(signal.toolUseId, signal);
					for (const oldest of [...this.pendingCalls.keys()].slice(0, Math.max(0, this.pendingCalls.size - PARADIS_TEAM_LIMITS.pendingCalls))) {
						this.pendingCalls.delete(oldest);
					}
					break;
				case 'spawned':
					changed = this.applySpawn(signal) || changed;
					break;
				case 'sent':
					changed = this.applySent(signal) || changed;
					break;
				case 'received':
					changed = this.applyReceived(signal) || changed;
					break;
			}
		}
		if (changed) {
			this.revisionValue++;
		}
		return changed;
	}

	private applySpawn(signal: Extract<IParadisTeamSignal, { type: 'spawned' }>): boolean {
		let team = this.teams.get(signal.team);
		if (team === undefined) {
			team = { name: signal.team, leadName: 'team-lead', members: new Map(), toolUseIds: [], messages: [], messageKeys: new Set(), messageCount: 0, plans: new Map(), startedAt: signal.at, updatedAt: signal.at };
			this.teams.set(signal.team, team);
			for (const oldest of [...this.teams.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, Math.max(0, this.teams.size - PARADIS_TEAM_LIMITS.teams))) {
				this.teams.delete(oldest.name);
			}
		}
		const call = signal.toolUseId !== undefined ? this.pendingCalls.get(signal.toolUseId) : undefined;
		if (signal.toolUseId !== undefined) {
			this.pendingCalls.delete(signal.toolUseId);
			if (team.toolUseIds.includes(signal.toolUseId)) {
				return false; // 読み直しで同じ起動をもう一度読んだ
			}
			team.toolUseIds.push(signal.toolUseId);
		}
		const previous = team.members.get(signal.name);
		if (previous === undefined && team.members.size >= PARADIS_TEAM_LIMITS.members) {
			return true;
		}
		const member: IMemberRecord = previous ?? { name: signal.name, backend: signal.backend, startedAt: signal.at, updatedAt: signal.at, activeAt: signal.at };
		// 同じ名前で起こし直した（前のメンバーは終わっている）。終わりの印を外して作業中から数え直す
		member.endedAt = undefined;
		member.idleAt = undefined;
		member.idleFailed = undefined;
		member.failure = undefined;
		member.activeAt = Math.max(member.activeAt, signal.at);
		member.updatedAt = Math.max(member.updatedAt, signal.at);
		member.backend = signal.backend;
		member.agentId = signal.agentId ?? member.agentId;
		member.toolUseId = signal.toolUseId ?? member.toolUseId;
		member.color = signal.color ?? member.color;
		member.model = signal.model ?? member.model;
		member.agentType = signal.agentType ?? member.agentType;
		member.description = call?.description ?? member.description;
		team.members.set(signal.name, member);
		team.updatedAt = Math.max(team.updatedAt, signal.at);
		if (call?.prompt !== undefined && call.prompt.trim().length > 0) {
			this.pushMessage(team, { from: team.leadName, to: signal.name, kind: 'instruction', text: call.prompt, at: call.at, ...(call.description !== undefined ? { summary: call.description } : {}) });
		}
		return true;
	}

	/** 名前でメンバーのいるチームを探す（新しいチームから）。 */
	private teamOf(name: string): ITeamRecord | undefined {
		return [...this.teams.values()].sort((a, b) => b.startedAt - a.startedAt).find(team => team.members.has(name));
	}

	private latestTeam(): ITeamRecord | undefined {
		return [...this.teams.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
	}

	private applySent(signal: Extract<IParadisTeamSignal, { type: 'sent' }>): boolean {
		// SendMessage はバックグラウンドの子の再開にも使う。宛先がメンバー（か全員）のものだけを数える
		const team = signal.to === '*' ? this.latestTeam() : this.teamOf(signal.to);
		if (team === undefined) {
			return false;
		}
		return this.applyOutgoing(team, team.leadName, signal);
	}

	/** あるメンバー（かリーダー）が送ったもの。 */
	private applyOutgoing(team: ITeamRecord, from: string, signal: { readonly to: string; readonly summary?: string; readonly text: string; readonly protocol?: string; readonly approved?: boolean; readonly at: number }): boolean {
		if (signal.protocol === 'plan_approval_response') {
			const plan = team.plans.get(signal.to);
			if (plan !== undefined && plan.approved === undefined && signal.approved !== undefined) {
				team.plans.set(signal.to, { ...plan, approved: signal.approved, ...(signal.text.length > 0 ? { feedback: signal.text.slice(0, PARADIS_TEAM_LIMITS.textLength) } : {}) });
			}
			return this.pushMessage(team, { from, to: signal.to, kind: 'plan', text: signal.text, at: signal.at, ...(signal.summary !== undefined ? { summary: signal.summary } : {}) }) || plan !== undefined;
		}
		if (signal.protocol !== undefined && signal.protocol !== 'shutdown_request' && signal.protocol !== 'shutdown_response') {
			return false;
		}
		if (signal.protocol === 'shutdown_response' && signal.approved === true) {
			this.endMember(team, from, signal.at);
		}
		return this.pushMessage(team, { from, to: signal.to, kind: signal.protocol !== undefined ? 'shutdown' : 'message', text: signal.text, at: signal.at, ...(signal.summary !== undefined ? { summary: signal.summary } : {}) });
	}

	private applyReceived(signal: Extract<IParadisTeamSignal, { type: 'received' }>): boolean {
		const team = this.teamOf(signal.from);
		const member = team?.members.get(signal.from);
		if (team === undefined || member === undefined) {
			return false; // チームの外からの知らせ（別のセッション）
		}
		const protocol = signal.protocol;
		if (protocol !== undefined) {
			switch (protocol.type) {
				case 'idle_notification':
					if (member.idleAt !== undefined && member.idleAt >= signal.at) {
						return false;
					}
					member.idleAt = signal.at;
					member.idleFailed = protocol.idleReason === 'failed';
					member.failure = protocol.idleReason === 'failed' ? protocol.failureReason : undefined;
					member.updatedAt = Math.max(member.updatedAt, signal.at);
					team.updatedAt = Math.max(team.updatedAt, signal.at);
					return true;
				case 'plan_approval_request': {
					const previous = team.plans.get(signal.from);
					if (previous !== undefined && previous.at >= signal.at) {
						return false;
					}
					const plan = clip(protocol.planContent ?? '', PARADIS_TEAM_LIMITS.planLength);
					team.plans.set(signal.from, { from: signal.from, text: plan.text, at: signal.at, ...(plan.truncated ? { truncated: true } : {}) });
					member.updatedAt = Math.max(member.updatedAt, signal.at);
					this.pushMessage(team, { from: signal.from, to: team.leadName, kind: 'plan', text: protocol.planContent ?? '', at: signal.at, ...(signal.summary !== undefined ? { summary: signal.summary } : {}) });
					return true;
				}
				case 'shutdown_response':
					if (protocol.approve === true || protocol.approved === true) {
						this.endMember(team, signal.from, signal.at);
					}
					return this.pushMessage(team, { from: signal.from, to: team.leadName, kind: 'shutdown', text: '', at: signal.at }) || true;
				case 'teammate_terminated':
					this.endMember(team, signal.from, signal.at);
					return true;
				default:
					return false;
			}
		}
		if (signal.text.length === 0) {
			return false;
		}
		return this.pushMessage(team, { from: signal.from, to: team.leadName, kind: 'message', text: signal.text, at: signal.at, ...(signal.summary !== undefined ? { summary: signal.summary } : {}) });
	}

	private endMember(team: ITeamRecord, name: string, at: number): void {
		const member = team.members.get(name);
		if (member !== undefined && (member.endedAt === undefined || member.endedAt < at)) {
			member.endedAt = at;
			member.updatedAt = Math.max(member.updatedAt, at);
			team.updatedAt = Math.max(team.updatedAt, at);
		}
	}

	private pushMessage(team: ITeamRecord, message: Omit<IParadisAgentTeamMessage, 'id' | 'truncated'>): boolean {
		const key = messageKey(message.from, message.to, message.kind === 'shutdown' ? '\0shutdown' : message.text);
		if (team.messageKeys.has(key)) {
			return false;
		}
		team.messageKeys.add(key);
		team.messageCount++;
		const body = clip(message.text, PARADIS_TEAM_LIMITS.textLength);
		const entry: IParadisAgentTeamMessage = {
			...message, id: `m${team.messageCount}`, text: body.text,
			...(message.summary !== undefined ? { summary: message.summary.slice(0, PARADIS_TEAM_LIMITS.summaryLength) } : {}),
			...(body.truncated ? { truncated: true } : {}),
		};
		// 受けた側の記録（リーダーの受信）と送った側の記録（メンバーの記録）は読む時期がずれるので、時刻の順に差し込む
		let index = team.messages.length;
		while (index > 0 && team.messages[index - 1].at > entry.at) {
			index--;
		}
		team.messages.splice(index, 0, entry);
		if (team.messages.length > PARADIS_TEAM_LIMITS.messages) {
			team.messages.splice(0, team.messages.length - PARADIS_TEAM_LIMITS.messages);
		}
		team.updatedAt = Math.max(team.updatedAt, message.at);
		return true;
	}

	/** `config.json` を当てる（メンバーの動く場所・色・モデルと、起動を読めなかったメンバー）。 */
	applyConfig(teamName: string, config: IParadisTeamConfig): boolean {
		const team = this.teams.get(teamName);
		if (team === undefined) {
			return false; // 会話の中で起動を見たチームだけを追う（残っているだけの config は読まない）
		}
		let changed = false;
		if (config.leadName !== undefined && config.leadName !== team.leadName) {
			team.leadName = config.leadName;
			changed = true;
		}
		for (const entry of config.members) {
			const member = team.members.get(entry.name);
			if (member === undefined) {
				if (team.members.size >= PARADIS_TEAM_LIMITS.members) {
					continue;
				}
				const at = entry.joinedAt ?? team.startedAt;
				team.members.set(entry.name, {
					name: entry.name, backend: entry.backend, startedAt: at, updatedAt: at, activeAt: at,
					...(entry.color !== undefined ? { color: entry.color } : {}),
					...(entry.model !== undefined ? { model: entry.model } : {}),
					...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
				});
				changed = true;
				continue;
			}
			const before = `${member.backend}\0${member.color}\0${member.model}\0${member.agentType}`;
			member.backend = entry.backend;
			if (entry.backend !== 'in-process') {
				member.agentId = undefined;
			}
			member.color ??= entry.color;
			member.model ??= entry.model;
			member.agentType ??= entry.agentType;
			changed = changed || before !== `${member.backend}\0${member.color}\0${member.model}\0${member.agentType}`;
		}
		if (changed) {
			this.revisionValue++;
		}
		return changed;
	}

	/** メンバーの記録から読んだものを当てる。 */
	applyMember(agentId: string, read: IParadisTeamMemberRead): boolean {
		const found = this.memberByAgentId(agentId);
		if (found === undefined) {
			return false;
		}
		const { team, member } = found;
		let changed = false;
		if (read.lastLineAt !== undefined && read.lastLineAt > member.activeAt) {
			member.activeAt = read.lastLineAt;
			member.updatedAt = Math.max(member.updatedAt, read.lastLineAt);
			changed = true;
		}
		if (read.activity !== undefined && read.activity !== member.activity) {
			member.activity = read.activity;
			changed = true;
		}
		for (const send of read.sends) {
			changed = this.applyOutgoing(team, member.name, send) || changed;
		}
		if (changed) {
			this.revisionValue++;
		}
		return changed;
	}

	/**
	 * hook の印。`active` は agent_id 付きの PreToolUse など（作業中）、`idle` は TeammateIdle（名前で来る）。
	 */
	noteHook(kind: 'active' | 'idle', key: { readonly agentId?: string; readonly name?: string }, at: number, tool?: string): boolean {
		const found = key.agentId !== undefined ? this.memberByAgentId(key.agentId) : key.name !== undefined ? this.memberByName(key.name) : undefined;
		if (found === undefined) {
			return false;
		}
		const { team, member } = found;
		if (kind === 'active') {
			if (at <= member.activeAt && (tool === undefined || member.activity === tool)) {
				return false;
			}
			member.activeAt = Math.max(member.activeAt, at);
			if (tool !== undefined) {
				member.activity = tool.slice(0, PARADIS_TEAM_LIMITS.activityLength);
			}
		} else {
			if (member.idleAt !== undefined && member.idleAt >= at) {
				return false;
			}
			member.idleAt = at;
			member.idleFailed = false;
		}
		member.updatedAt = Math.max(member.updatedAt, at);
		team.updatedAt = Math.max(team.updatedAt, at);
		this.revisionValue++;
		return true;
	}

	private memberByAgentId(agentId: string): { readonly team: ITeamRecord; readonly member: IMemberRecord } | undefined {
		for (const team of this.teams.values()) {
			for (const member of team.members.values()) {
				if (member.agentId === agentId) {
					return { team, member };
				}
			}
		}
		return undefined;
	}

	private memberByName(name: string): { readonly team: ITeamRecord; readonly member: IMemberRecord } | undefined {
		const team = this.teamOf(name);
		const member = team?.members.get(name);
		return team !== undefined && member !== undefined ? { team, member } : undefined;
	}

	/** メンバーの子の ID か（hook の印をチームへ回すか決める）。 */
	hasMember(agentId: string): boolean {
		return this.memberByAgentId(agentId) !== undefined;
	}

	/** 読み直しが要るもの: チームの名前と、記録を読む in-process のメンバーの子の ID（終わっていないもの）。 */
	toRefresh(): { readonly teams: readonly string[]; readonly agentIds: readonly string[] } {
		const agentIds: string[] = [];
		for (const team of this.teams.values()) {
			for (const member of team.members.values()) {
				if (member.agentId !== undefined && member.endedAt === undefined) {
					agentIds.push(member.agentId);
				}
			}
		}
		return { teams: [...this.teams.keys()], agentIds };
	}

	/** 作業中・許可待ち・計画の承認待ちのメンバーがいるか（読み直しを続けるか決める）。 */
	hasActive(approvals?: ParadisTeamApprovals): boolean {
		// 別のペインのメンバーは手元に記録が無く、読み直しても変わらないので数えない
		return this.snapshot(approvals).some(team => team.members.some(member => member.backend === 'in-process' && (member.state === 'running' || member.state === 'waiting' || member.state === 'plan')));
	}

	/** モバイルへ送る形。`approvals` はメンバーの子の ID → 答えていない承認。 */
	snapshot(approvals?: ParadisTeamApprovals): IParadisAgentTeam[] {
		return [...this.teams.values()].sort((a, b) => a.startedAt - b.startedAt).map(team => {
			const members = [...team.members.values()].map(member => {
				const approval = member.agentId !== undefined ? approvals?.get(member.agentId) : undefined;
				const plan = team.plans.get(member.name);
				const idle = member.idleAt !== undefined && member.idleAt + IDLE_SETTLE_MS >= member.activeAt;
				const state: ParadisAgentTeamMemberState = member.endedAt !== undefined ? 'completed'
					: approval !== undefined ? 'waiting'
						: plan !== undefined && plan.approved === undefined ? 'plan'
							: idle ? (member.idleFailed === true ? 'failed' : 'idle')
								: 'running';
				const result: IParadisAgentTeamMember = {
					name: member.name, backend: member.backend, state, startedAt: member.startedAt, updatedAt: member.updatedAt,
					...(member.agentId !== undefined ? { agentId: member.agentId } : {}),
					...(member.toolUseId !== undefined ? { toolUseId: member.toolUseId } : {}),
					...(member.color !== undefined ? { color: member.color } : {}),
					...(member.model !== undefined ? { model: member.model } : {}),
					...(member.agentType !== undefined ? { agentType: member.agentType } : {}),
					...(member.description !== undefined ? { description: member.description } : {}),
					...(member.activity !== undefined ? { activity: member.activity } : {}),
					...(approval !== undefined ? { approvalId: approval.id, ...(approval.tool !== undefined ? { approvalTool: approval.tool.slice(0, 100) } : {}) } : {}),
					...(state === 'failed' && member.failure !== undefined ? { failure: member.failure } : {}),
				};
				return result;
			}).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
			const plans = [...team.plans.values()].sort((a, b) => a.at - b.at);
			return {
				name: team.name, leadName: team.leadName, toolUseIds: [...team.toolUseIds], members,
				messages: team.messages.map(message => ({ ...message })), messageCount: team.messageCount,
				...(plans.length > 0 ? { plans } : {}),
				startedAt: team.startedAt, updatedAt: team.updatedAt,
			};
		});
	}
}

/** ペインが止まった（エージェントが終わった）ときに送る形。動いていたメンバーを「止まった（推定）」にする。 */
export function paradisTeamsForStoppedPane(teams: readonly IParadisAgentTeam[]): IParadisAgentTeam[] {
	return teams.map(team => ({
		...team,
		members: team.members.map(member => {
			if (member.state !== 'running' && member.state !== 'waiting' && member.state !== 'plan') {
				return member;
			}
			const { approvalId: _approvalId, approvalTool: _approvalTool, ...rest } = member;
			return { ...rest, state: 'stopped' as const, estimated: true as const };
		}),
	}));
}
