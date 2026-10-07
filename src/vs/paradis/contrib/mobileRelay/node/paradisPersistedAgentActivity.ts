/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisCodexUserAuthoredContent, paradisIsCodexEncryptedPayload } from '../../agentChat/common/paradisCodexInjectedContext.js';
import { ADVISOR_TEXT_LIMIT, IParadisAgentAdvisorUpdate } from './paradisAgentActivity.js';

export type ParadisRecoveredAgentStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export interface IParadisRecoveredAgentActivity {
	readonly id: string;
	readonly label: string;
	readonly provider: 'claude' | 'codex';
	readonly detail?: string;
	readonly parentId?: string;
	readonly depth?: number;
	readonly status: ParadisRecoveredAgentStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
	/**
	 * 名前付きで起動したエージェント（Agent ツールの `name`、チームメイト）の名前。親の会話は
	 * この名前（`agent_id: <name>@<team>`）で呼び、子 transcript のファイルは `a<name>-<16桁>`
	 * という別の ID を持つので、同じエージェントを1つにまとめるための鍵になる。
	 */
	readonly name?: string;
	/**
	 * 子 transcript の最後の行に書かれた時刻（ファイルの更新時刻ではない。SSH の写しでは更新時刻が
	 * 写した時刻になるため）。親の会話の「完了」が、子のこれより後の作業を打ち消さないための基準。
	 */
	readonly lastLineAt?: number;
	/** この子を起動した Agent / Task の呼び出しの toolUseId（会話のカードと一覧の項目を結ぶ）。 */
	readonly toolUseIds?: readonly string[];
	/** エージェントチームのメンバー（`.meta.json` の `taskKind: "in_process_teammate"`）。 */
	readonly teammate?: true;
}

export interface IParadisClaudePersistedActivity {
	readonly owner?: IParadisRecoveredAgentActivity;
	readonly spawned: readonly IParadisRecoveredAgentActivity[];
	/**
	 * 起動の記録を読めなかった（読み込み範囲の外にある等）が、完了通知だけは届いた ID と、その状態。
	 * バックグラウンドの Bash や Monitor の通知も同じ形で届くので、ここではエージェントと決めつけず、
	 * 子 transcript が実在する ID にだけ呼び出し側が当てる。
	 */
	readonly notifications: ReadonlyMap<string, { readonly status: ParadisRecoveredAgentStatus; readonly at: number }>;
	/**
	 * SendMessage で子を再開した呼び出し: 子の ID → 呼び出しの toolUseId。再開した子の起動は読み込み範囲の外に
	 * あることが多いので、spawned とは別に返し、呼び出し側が一覧にある子へ当てる。
	 */
	readonly resumeToolUseIds: ReadonlyMap<string, readonly string[]>;
}

/** `agent-<id>.meta.json`（Claude Codeが子transcriptの隣に書く素性メタ）。 */
export interface IParadisClaudeSubagentMeta {
	readonly agentType?: string;
	readonly description?: string;
	readonly spawnDepth?: number;
	readonly name?: string;
	/** `taskKind: "in_process_teammate"`（エージェントチームのメンバー）。 */
	readonly teammate?: true;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,500}$/;
const TEXT_LIMIT = 1_000;
const STALE_ACTIVITY_MS = 15 * 60 * 1_000;
/**
 * `stop_reason` の無い、文章だけの assistant 行を「応答を返し切った」とみなすまでの猶予。
 * Claude Code は1つの応答をブロックごとに別の行として書くので、文章の行の直後に同じ応答の
 * tool_use の行が続くことがある（実データで、子 transcript 300本に1,345か所）。書かれた直後に
 * 読むと、まだ作業中の子を完了と取り違える。
 */
const PARTIAL_ASSISTANT_LINE_GRACE_MS = 2 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, TEXT_LIMIT) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
	const raw = text(value);
	if (raw === undefined) { return undefined; }
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function flattenContent(value: unknown): string {
	if (typeof value === 'string') { return value; }
	if (!Array.isArray(value)) { return ''; }
	return value.map(item => {
		if (typeof item === 'string') { return item; }
		const entry = record(item);
		return text(entry?.text) ?? text(entry?.thinking) ?? flattenContent(entry?.content);
	}).filter(Boolean).join('\n');
}

function normalizedStatus(value: string | undefined): ParadisRecoveredAgentStatus {
	switch (value?.toLowerCase()) {
		case 'completed': case 'complete': case 'success': return 'completed';
		case 'failed': case 'error': case 'errored': return 'failed';
		case 'interrupted': case 'aborted': case 'stopped': case 'cancelled': return 'interrupted';
		default: return 'unknown';
	}
}

/**
 * 終端イベントを確認できていない活動の扱い。まだ書き込みが続いている間は実行中、
 * しばらく書き込みが無いものは状態不明にする。長いビルドやテストを待っている子は何分も
 * 書かないので、ここで「中断」と決めると、動いている子を終わったことにしてしまう
 * （終わった扱いは後から戻りにくい）。終わったことは SubagentStop と完了通知で知る。
 */
function activeOrEnded(mtime: number, now: number): ParadisRecoveredAgentStatus {
	return now - mtime <= STALE_ACTIVITY_MS ? 'running' : 'unknown';
}

function hasBlock(content: unknown, type: string): boolean {
	return Array.isArray(content) && content.some(item => record(item)?.type === type);
}

/**
 * assistant 1行から親の終端状態を推定する。`stop_reason` は正本だが、ストリーミング中に
 * 書かれた行では欠落することがある（実データで確認済み）。その場合はブロック構成で補う:
 * tool_use を含むならまだ作業中。text だけの行は、同じ応答の tool_use の行がまだ続くかも
 * しれないので、書き込みが {@link PARTIAL_ASSISTANT_LINE_GRACE_MS} 止まるまでは作業中とみなす。
 */
function assistantTurnStatus(stopReason: string | undefined, content: unknown, mtime: number, now: number): ParadisRecoveredAgentStatus | undefined {
	if (stopReason === 'end_turn') { return 'completed'; }
	if (stopReason === 'tool_use') { return activeOrEnded(mtime, now); }
	if (stopReason !== undefined) { return undefined; }
	if (hasBlock(content, 'tool_use')) { return activeOrEnded(mtime, now); }
	if (!hasBlock(content, 'text')) { return undefined; }
	return now - mtime > PARTIAL_ASSISTANT_LINE_GRACE_MS ? 'completed' : 'running';
}

/**
 * Agent ツールの結果から子の ID を読む。名前付きの起動（チームメイト）は `agent_id: <name>@<team>`
 * と返り、この `<name>` は子 transcript のファイル ID とは別物なので、名前として返す。
 */
function agentIdFromToolResult(value: string): { readonly id: string; readonly name?: string } | undefined {
	// フォアグラウンドの結果は子の最終応答そのもので、本文に ID 風の文字列が混ざりうる。
	// Claude Code が付ける ID は末尾にあるので、最後に現れたものを採る。
	const last = (pattern: RegExp) => [...value.matchAll(pattern)].at(-1)?.groups?.id;
	// 名前付きの形はチームメイトの起動応答にしか出ない。子の最終応答（フォアグラウンドの結果）の本文に
	// 同じ形が書かれていても、末尾の本物の agentId より優先させない
	const named = isAsyncLaunchResult(value) ? last(/\bagent_id:\s*(?<id>[A-Za-z0-9._:-]+)@[A-Za-z0-9._:-]+/gi) : undefined;
	if (named !== undefined && ID_PATTERN.test(named)) {
		return { id: named, name: named };
	}
	const id = last(/\bagentId:\s*(?<id>[A-Za-z0-9._:-]+)/gi) ?? last(/\bagent[_ -]?id["']?\s*[:=]\s*["']?(?<id>[A-Za-z0-9._:-]+)/gi);
	return id !== undefined && ID_PATTERN.test(id) ? { id } : undefined;
}

/**
 * 行の中の、ハーネスが会話へ差し込んだ完了通知。ユーザーの発言（作業中に打った文を含む）の途中に
 * 通知の文字列が貼られていても拾わないよう、通知で始まる文だけを見る。ツールの結果の中も見ない。
 */
function harnessNotifications(content: unknown): string[] {
	const texts = typeof content === 'string' ? [content]
		: Array.isArray(content) ? content.map(item => record(item)).filter(item => item?.type === 'text').map(item => text(item?.text) ?? '') : [];
	return texts.filter(value => value.trimStart().startsWith('<task-notification>'));
}

/**
 * 行の `toolUseResult`（Claude Code が tool_result の行に添える構造化した結果）から子の ID を読む。同期の結果は
 * 本文の末尾にしか ID が無く、本文の中の ID 風の文字列と見分けにくいので、こちらを先に使う。
 */
function agentIdFromStructuredResult(entry: Record<string, unknown>, key: 'agentId' | 'resumedAgentId'): string | undefined {
	const id = text(record(entry.toolUseResult)?.[key]);
	return id !== undefined && ID_PATTERN.test(id) ? id : undefined;
}

/** SendMessage の結果（`{"success":true,"message":"Resuming agent …","resumedAgentId":"…"}`）から再開した子の ID を読む。 */
function resumedAgentIdFromToolResult(value: string): string | undefined {
	const id = /"resumedAgentId"\s*:\s*"(?<id>[A-Za-z0-9._:-]+)"/.exec(value)?.groups?.id;
	return id !== undefined && ID_PATTERN.test(id) ? id : undefined;
}

/** 子がまだ動いている（すぐ返る起動）ことを示す Agent ツールの結果か。それ以外は子が返し終えた結果。 */
function isAsyncLaunchResult(value: string): boolean {
	return /Async agent launched|async_launched|spawned successfully|is now running/i.test(value);
}

/** Claude root／子transcriptから、所有Agent自身と直接生成した子Agentを復元する。 */
export function paradisParseClaudePersistedActivity(ownerId: string | undefined, lines: readonly string[], mtime: number, now: number, meta?: IParadisClaudeSubagentMeta): IParadisClaudePersistedActivity {
	const pendingTools = new Map<string, { readonly label: string; readonly detail?: string; readonly at: number }>();
	const spawned = new Map<string, IParadisRecoveredAgentActivity>();
	const notifications = new Map<string, { readonly status: ParadisRecoveredAgentStatus; readonly at: number }>();
	const pendingResumes = new Set<string>();
	const resumeToolUseIds = new Map<string, string[]>();
	let ownerDetail: string | undefined;
	let ownerLabel = text(meta?.agentType) ?? 'SubAgent';
	let ownerStartedAt = mtime;
	let ownerUpdatedAt = mtime;
	let ownerStatus: ParadisRecoveredAgentStatus = activeOrEnded(mtime, now);
	let sawOwnerLine = false;
	let lastLineAt: number | undefined;

	for (const line of lines) {
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; }
		if (entry === undefined) { continue; }
		const lineAt = timestamp(entry.timestamp);
		if (lineAt !== undefined) { lastLineAt = Math.max(lastLineAt ?? lineAt, lineAt); }
		const at = lineAt ?? mtime;
		ownerStartedAt = sawOwnerLine ? Math.min(ownerStartedAt, at) : at;
		ownerUpdatedAt = Math.max(ownerUpdatedAt, at);
		sawOwnerLine = true;
		ownerLabel = text(entry.agentType) ?? text(entry.agent_type) ?? ownerLabel;
		const type = text(entry.type);
		const message = record(entry.message);
		// 作業中に届いた完了通知は `queued_command` の attachment として書かれる（通知の約4分の1）
		const attachment = type === 'attachment' ? record(entry.attachment) : undefined;
		const content = attachment?.type === 'queued_command' ? attachment.prompt : message?.content;

		if (ownerId !== undefined && type === 'user' && ownerDetail === undefined) {
			const candidate = flattenContent(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
			if (candidate.length > 0 && !candidate.startsWith('<task-notification>')) { ownerDetail = candidate.slice(0, TEXT_LIMIT); }
		}
		if (ownerId !== undefined && type === 'assistant') {
			ownerStatus = assistantTurnStatus(text(message?.stop_reason), content, mtime, now) ?? ownerStatus;
		} else if (ownerId !== undefined && type === 'user' && hasBlock(content, 'tool_result')) {
			// ツール結果が返っている＝直前の応答は終端ではない。暫定completedを取り消す。
			ownerStatus = activeOrEnded(mtime, now);
		} else if (ownerId !== undefined && (type === 'user' || attachment?.type === 'queued_command') && flattenContent(content).trim().length > 0) {
			// 終わった後に届いた新しい指示（SendMessage での再開）。子はこれから応答を書く
			ownerStatus = activeOrEnded(mtime, now);
		}
		// 完了通知はサブエージェントだけでなく、バックグラウンドの Bash や Monitor でも届く。
		// 起動を見届けた Agent の ID だけを更新し、それ以外は notifications へ回す
		// （子 transcript が実在するかは呼び出し側にしか分からない）。
		for (const rawText of harnessNotifications(content)) {
			for (const notice of rawText.split('<task-notification>').slice(1)) {
				const id = /<task-id>([^<\n]+)<\/task-id>/.exec(notice)?.[1]?.trim();
				if (id === undefined || !ID_PATTERN.test(id)) { continue; }
				const rawStatus = /<status>([^<\n]+)<\/status>/.exec(notice)?.[1];
				const status = rawStatus !== undefined ? normalizedStatus(rawStatus) : 'completed';
				const previous = spawned.get(id);
				if (previous === undefined) {
					notifications.set(id, { status, at });
					continue;
				}
				spawned.set(id, { ...previous, status, updatedAt: at });
			}
		}
		if (!Array.isArray(content)) { continue; }
		// 構造化した結果は行に 1 つなので、tool_result が 1 つだけの行でしか使わない
		const singleResult = content.filter(item => record(item)?.type === 'tool_result').length === 1;
		for (const rawBlock of content) {
			const block = record(rawBlock);
			if (block === undefined) { continue; }
			if (block.type === 'tool_use') {
				const tool = text(block.name);
				const toolUseId = text(block.id);
				if ((tool === 'Agent' || tool === 'Task') && toolUseId !== undefined) {
					const input = record(block.input);
					const detail = text(input?.description) ?? text(input?.prompt);
					const label = text(input?.subagent_type) ?? text(input?.agent_type) ?? 'SubAgent';
					pendingTools.set(toolUseId, { label, ...(detail !== undefined ? { detail } : {}), at });
				} else if (tool === 'SendMessage' && toolUseId !== undefined) {
					pendingResumes.add(toolUseId);
				}
			} else if (block.type === 'tool_result') {
				const resultText = flattenContent(block.content);
				const resultToolUseId = text(block.tool_use_id) ?? '';
				if (pendingResumes.delete(resultToolUseId)) {
					const resumed = (singleResult ? agentIdFromStructuredResult(entry, 'resumedAgentId') : undefined) ?? resumedAgentIdFromToolResult(resultText);
					if (resumed !== undefined) {
						resumeToolUseIds.set(resumed, [...(resumeToolUseIds.get(resumed) ?? []), resultToolUseId]);
					}
					continue;
				}
				const textAgent = agentIdFromToolResult(resultText);
				const structuredId = singleResult && textAgent?.name === undefined ? agentIdFromStructuredResult(entry, 'agentId') : undefined;
				const agent: { readonly id: string; readonly name?: string } | undefined = structuredId !== undefined ? { id: structuredId } : textAgent;
				const tool = pendingTools.get(resultToolUseId);
				// 起動の tool_use を読めた結果だけを数える。Bash などの出力にも起動応答そっくりの文字列は
				// 現れる（transcript を grep した結果など）。読み込み範囲の外で起動した子は、子 transcript と
				// 完了通知から拾う。
				if (agent !== undefined && tool !== undefined) {
					const isAsyncLaunch = isAsyncLaunchResult(resultText);
					spawned.set(agent.id, {
						id: agent.id, label: tool.label, provider: 'claude', ...(tool.detail !== undefined ? { detail: tool.detail } : {}),
						...(ownerId !== undefined ? { parentId: ownerId } : {}),
						...(agent.name !== undefined ? { name: agent.name } : {}),
						toolUseIds: [resultToolUseId],
						// フォアグラウンドの Agent は、子が返し終えてから結果が書かれる
						status: isAsyncLaunch ? activeOrEnded(mtime, now) : 'completed', startedAt: tool.at, updatedAt: at,
					});
				}
			}
		}
	}

	const ownerDepth = typeof meta?.spawnDepth === 'number' && Number.isFinite(meta.spawnDepth) ? Math.min(5, Math.max(1, Math.trunc(meta.spawnDepth))) : undefined;
	const detail = ownerDetail ?? text(meta?.description);
	const name = text(meta?.name);
	const owner = ownerId !== undefined && ID_PATTERN.test(ownerId) ? {
		id: ownerId, label: ownerLabel, provider: 'claude' as const, ...(detail !== undefined ? { detail } : {}),
		...(ownerDepth !== undefined ? { depth: ownerDepth } : {}),
		...(name !== undefined ? { name } : {}),
		...(meta?.teammate === true ? { teammate: true as const } : {}),
		...(lastLineAt !== undefined ? { lastLineAt } : {}),
		status: ownerStatus, startedAt: ownerStartedAt, updatedAt: ownerUpdatedAt,
	} : undefined;
	return { ...(owner !== undefined ? { owner } : {}), spawned: [...spawned.values()], notifications, resumeToolUseIds };
}

const ADVISOR_MODEL_PATTERN = /^[A-Za-z0-9._:@-]{1,100}$/;

/**
 * transcript の行から Advisor（サーバー側ツール）への相談を拾う。`server_tool_use`（name:"advisor"）が開始、
 * `advisor_tool_result` が結果で、モデル名は行のトップの `advisorModel`。`ownerId` はサブエージェントの transcript を
 * 読むときのその子の ID（親の会話では undefined）。結果の無い相談は、古ければ中断とみなす。
 */
export function paradisParseClaudeAdvisors(ownerId: string | undefined, lines: readonly string[], now: number): IParadisAgentAdvisorUpdate[] {
	const advisors = new Map<string, IParadisAgentAdvisorUpdate>();
	for (const line of lines) {
		if (!line.includes('advisor')) {
			continue;
		}
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; }
		const content = record(entry?.message)?.content;
		// 親の transcript に混ざる sidechain の行（古い版のサブエージェント）は、その子の相談なので親の分に数えない
		if (entry === undefined || entry.type !== 'assistant' || entry.isSidechain === true || !Array.isArray(content)) {
			continue;
		}
		const at = timestamp(entry.timestamp);
		if (at === undefined) {
			continue;
		}
		const rawModel = text(entry.advisorModel);
		const model = rawModel !== undefined && ADVISOR_MODEL_PATTERN.test(rawModel) ? rawModel : undefined;
		for (const rawBlock of content) {
			const block = record(rawBlock);
			if (block?.type === 'server_tool_use' && block.name === 'advisor') {
				const id = text(block.id);
				if (id !== undefined && ID_PATTERN.test(id) && !advisors.has(id)) {
					advisors.set(id, {
						id, ...(model !== undefined ? { model } : {}), ...(ownerId !== undefined ? { ownerId } : {}),
						status: now - at <= STALE_ACTIVITY_MS ? 'running' : 'interrupted', startedAt: at, updatedAt: at,
					});
				}
			} else if (block?.type === 'advisor_tool_result') {
				const id = text(block.tool_use_id);
				if (id === undefined || !ID_PATTERN.test(id)) {
					continue;
				}
				const previous = advisors.get(id);
				const result = record(block.content);
				const type = text(result?.type);
				const errorCode = type === 'advisor_tool_result_error' ? text(result?.error_code) : undefined;
				const plain = type === 'advisor_result' ? text(result?.text) : undefined;
				advisors.set(id, {
					id, ...((model ?? previous?.model) !== undefined ? { model: model ?? previous?.model } : {}), ...(ownerId !== undefined ? { ownerId } : {}),
					status: type === 'advisor_tool_result_error' ? 'failed' : 'completed',
					outcome: type === 'advisor_tool_result_error' ? 'error' : type === 'advisor_result' ? 'text' : 'redacted',
					...(errorCode !== undefined && /^[A-Za-z0-9._:-]{1,100}$/.test(errorCode) ? { errorCode } : type === 'advisor_tool_result_error' ? { errorCode: 'unknown_error' } : {}),
					...(plain !== undefined ? { text: plain.slice(0, ADVISOR_TEXT_LIMIT), ...(plain.length > ADVISOR_TEXT_LIMIT ? { textTruncated: true } : {}) } : {}),
					startedAt: previous?.startedAt ?? at, updatedAt: at,
				});
			}
		}
	}
	return [...advisors.values()];
}

function parseCodexSource(source: string): { readonly parentId?: string; readonly depth?: number; readonly label?: string } {
	try {
		const root = record(JSON.parse(source));
		const spawn = record(record(root?.subagent)?.thread_spawn);
		const parentId = text(spawn?.parent_thread_id);
		const rawDepth = number(spawn?.depth);
		const depth = rawDepth !== undefined ? Math.min(5, Math.max(1, Math.trunc(rawDepth))) : undefined;
		const label = text(spawn?.agent_nickname) ?? text(spawn?.agent_role);
		return { ...(parentId !== undefined ? { parentId } : {}), ...(depth !== undefined ? { depth } : {}), ...(label !== undefined ? { label } : {}) };
	} catch { return {}; }
}

/** Codex child threadのsourceとrolloutから、親子関係・指示・終端状態を復元する。 */
export function paradisParseCodexPersistedActivity(id: string, source: string, lines: readonly string[], mtime: number, now: number): IParadisRecoveredAgentActivity | undefined {
	if (!ID_PATTERN.test(id)) { return undefined; }
	const sourceInfo = parseCodexSource(source);
	let label = sourceInfo.label ?? 'SubAgent';
	let detail: string | undefined;
	// 親からの指示（agent_message の NEW_TASK）を見たら、それより前の user メッセージは指示ではない
	// （fork_turns で引き継いだ親の会話）。今の Codex は指示を暗号化して書くので、読めなければ空のままにする
	let sawTask = false;
	let startedAt = mtime;
	let updatedAt = mtime;
	let sawLine = false;
	let status: ParadisRecoveredAgentStatus = activeOrEnded(mtime, now);
	for (const line of lines) {
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; }
		if (entry === undefined) { continue; }
		const at = timestamp(entry.timestamp) ?? mtime;
		startedAt = sawLine ? Math.min(startedAt, at) : at;
		updatedAt = Math.max(updatedAt, at);
		sawLine = true;
		if (entry.type === 'session_meta') {
			const payload = record(entry.payload);
			label = text(payload?.agent_nickname) ?? text(payload?.agent_path) ?? label;
		} else if (entry.type === 'response_item') {
			const payload = record(entry.payload);
			if (payload?.type === 'message' && payload.role === 'user' && detail === undefined && !sawTask) {
				// AGENTS.md・環境情報・plugin の案内などの差し込みは指示ではない
				const authored = paradisCodexUserAuthoredContent(payload);
				detail = authored !== undefined ? text(flattenContent(authored)) : undefined;
			} else if (payload?.type === 'agent_message' && !sawTask) {
				const body = flattenContent(payload.content);
				if (/^Message Type: NEW_TASK\n/.test(body)) {
					sawTask = true;
					const instruction = body.replace(/^Message Type: NEW_TASK\n(?:[^\n]*\n)*?Payload:\n?/, '').trim();
					detail = instruction.length > 0 && !paradisIsCodexEncryptedPayload(instruction) ? text(instruction) : undefined;
				}
			}
		} else if (entry.type === 'event_msg') {
			const payload = record(entry.payload);
			switch (text(payload?.type)) {
				case 'task_started': status = activeOrEnded(mtime, now); break;
				// usage limit などで終わったターンは `error` の event_msg ではなく、task_complete の `error` に残る
				case 'task_complete': status = record(payload?.error) !== undefined ? 'failed' : 'completed'; break;
				case 'error': status = 'failed'; break;
				case 'turn_aborted': status = 'interrupted'; break;
			}
		}
	}
	return {
		id, label, provider: 'codex', ...(detail !== undefined ? { detail } : {}),
		...(sourceInfo.parentId !== undefined && sourceInfo.parentId !== id ? { parentId: sourceInfo.parentId } : {}),
		...(sourceInfo.depth !== undefined ? { depth: sourceInfo.depth } : {}), status, startedAt, updatedAt,
	};
}
