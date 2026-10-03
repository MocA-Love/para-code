/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisAgentHookEvent, onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { NotifyKind } from '../common/paradisMobileProtocol.js';
import { ParadisNotifyCategory, paradisNormalizeNotifyErrorCode } from '../common/paradisNotifyCompose.js';

/**
 * 通知の中身（最後の発言・失敗の理由・承認の中身・質問文）の出どころ（shared process）。
 *
 * 完了と承認待ちの通知は renderer の状態遷移から作られるが、renderer は発言を持っていない。そこで通知の出口
 * （`paradisMobileRelayService.ts` の `dispatchNotifyNow`）で、エージェントのトークンからここを引いて本文を決める。
 * 第一の出どころは hook（Stop の `last_assistant_message`、StopFailure の理由、PermissionRequest の中身）。hook は
 * 状態遷移より先に shared process へ届く（renderer を往復する分だけ遅れて通知が来る）。hook が取れなかったときは
 * transcript の tailer（`ParadisMobileAgentChat.notifyPaneContent`）を使う。
 */

/** hook の記録を信用する長さ。これより古いものは別のターンの話とみなす。 */
const HOOK_FRESH_MS = 2 * 60_000;
/** 承認の hook は、承認待ちが長く続いてから通知が出ることもあるので長めに持つ。 */
const APPROVAL_FRESH_MS = 30 * 60_000;
/** ペインの数の上限（外から来るトークンで台帳が伸び続けないように）。 */
const MAX_TOKENS = 500;

/** ターンの終わりの hook の記録。 */
export interface IParadisNotifyHookTurnEnd {
	readonly failed: boolean;
	readonly lastMessage?: string;
	readonly errorCode?: string;
	readonly errorMessage?: string;
	readonly at: number;
}

/** 承認の hook の記録。 */
export interface IParadisNotifyHookApproval {
	readonly toolName?: string;
	readonly toolInput?: unknown;
	/** hook の `tool_use_id`。tailer の承認の ID と一致したときだけ、この中身を通知に使う。 */
	readonly toolUseId?: string;
	readonly at: number;
}

/** tailer から引けるペインの様子（`ParadisMobileAgentChat.notifyPaneContent`）。 */
export interface IParadisNotifyPaneContent {
	readonly agent?: 'claude' | 'codex';
	/** 最後のエージェントの発言（思考は除く）。 */
	readonly lastAssistant?: { readonly text: string; readonly isError: boolean; readonly at?: number };
	/** transcript で見たターンの終わり（Codex の usage limit などは hook が無く、ここだけが知っている）。 */
	readonly turnEnd?: { readonly reason: 'completed' | 'failed' | 'interrupted'; readonly errorCode?: string; readonly at: number };
	/** いま答えを待っている承認・質問。 */
	readonly interaction?: { readonly kind: 'approval' | 'question'; readonly id: string; readonly text?: string };
}

/** 通知の中身の決定。 */
export interface IParadisNotifyContentResolution {
	readonly kind: NotifyKind;
	readonly category: ParadisNotifyCategory;
	/** 本文・詳細に使う Markdown（無ければ定型文）。 */
	readonly content?: string;
	readonly errorCode?: string;
	readonly interactionId?: string;
}

/** hook の記録（トークンごとに最後の 1 件）。 */
export class ParadisNotifyHookLedger extends Disposable {

	private readonly turnEnds = new Map<string, IParadisNotifyHookTurnEnd>();
	private readonly approvals = new Map<string, IParadisNotifyHookApproval>();

	constructor(subscribe = true) {
		super();
		if (subscribe) {
			this._register(onParadisAgentHookEvent(event => this.record(event)));
		}
	}

	record(event: IParadisAgentHookEvent): void {
		switch (event.event) {
			case 'UserPromptSubmit':
				// 新しいターン。前のターンの終わりと承認は、もう通知の中身ではない。
				this.turnEnds.delete(event.token);
				this.approvals.delete(event.token);
				return;
			case 'Stop':
			case 'agent-turn-complete':
			case 'task_complete': {
				const payload = event.payload;
				const lastMessage = str(payload?.last_assistant_message) ?? str(payload?.['last-assistant-message']) ?? str(payload?.last_agent_message);
				this.remember(this.turnEnds, event.token, { failed: false, ...(lastMessage !== undefined ? { lastMessage } : {}), at: event.at });
				this.approvals.delete(event.token);
				return;
			}
			case 'StopFailure': {
				const payload = event.payload;
				const error = payload?.error;
				const errorRecord = typeof error === 'object' && error !== null && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
				const errorCode = paradisNormalizeNotifyErrorCode(str(error) ?? str(errorRecord?.type) ?? str(errorRecord?.code) ?? str(payload?.error_type));
				const errorMessage = str(payload?.error_details) ?? str(errorRecord?.message) ?? str(payload?.last_assistant_message);
				this.remember(this.turnEnds, event.token, { failed: true, ...(errorCode !== undefined ? { errorCode } : {}), ...(errorMessage !== undefined ? { errorMessage } : {}), at: event.at });
				this.approvals.delete(event.token);
				return;
			}
			case 'PermissionRequest':
				if (event.toolName !== 'AskUserQuestion') {
					this.remember(this.approvals, event.token, {
						...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
						...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
						...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
						at: event.at,
					});
				}
				return;
			case 'PostToolUse':
			case 'PostToolUseFailure':
			case 'PermissionDenied':
				this.approvals.delete(event.token);
				return;
			default:
				return;
		}
	}

	turnEnd(token: string, now: number): IParadisNotifyHookTurnEnd | undefined {
		const entry = this.turnEnds.get(token);
		return entry !== undefined && now - entry.at <= HOOK_FRESH_MS ? entry : undefined;
	}

	approval(token: string, now: number): IParadisNotifyHookApproval | undefined {
		const entry = this.approvals.get(token);
		return entry !== undefined && now - entry.at <= APPROVAL_FRESH_MS ? entry : undefined;
	}

	private remember<T>(map: Map<string, T>, token: string, entry: T): void {
		map.delete(token);
		map.set(token, entry);
		while (map.size > MAX_TOKENS) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			map.delete(oldest);
		}
	}
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 承認の中身を Markdown にする（本文では「Bash: npm run test」、長押しではコードの枠）。
 * コマンドを説明より優先する（何が実行されるかが判断の材料なので）。
 */
export function paradisApprovalNotifyContent(toolName: string | undefined, toolInput: unknown): string | undefined {
	const input = typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : undefined;
	const subject = str(input?.command) ?? str(input?.file_path) ?? str(input?.path) ?? str(input?.url) ?? str(input?.description)
		?? (input !== undefined && Object.keys(input).length > 0 ? JSON.stringify(input).slice(0, 2000) : undefined);
	if (subject === undefined) {
		return toolName;
	}
	const body = subject.trim();
	const label = toolName ?? '操作';
	// コマンドの見た目は変えない（バッククォートを別の文字へ置き換えない）。短い 1 行でバッククォートを含まなければ
	// インラインコード、それ以外はコードブロックにする。囲いは中身のいちばん長いバッククォートの並びより長くする。
	if (!body.includes('\n') && body.length <= 120 && !body.includes('`')) {
		return `${label}: \`${body}\``;
	}
	const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${label}\n\n${fence}\n${body}\n${fence}`;
}

/**
 * 通知の中身を決める（純関数）。
 *
 * - 完了（agent-done）: hook の Stop の発言 → hook の StopFailure（エラーへ） → transcript の失敗（エラーへ） →
 *   transcript の最後の発言（エラーの発言ならエラーへ）の順に見る
 * - 要対応（agent-question）: `presetCategory` が質問（transcript の質問。本文は質問文）ならそのまま。そうでなければ、
 *   いま待っているのが質問なら質問、それ以外は承認として hook の中身（無ければ tailer の承認の中身）を使う
 * - それ以外の種類（切断など）は対象外（undefined）
 */
export function paradisResolveNotifyContent(input: {
	readonly kind: NotifyKind;
	readonly presetCategory?: ParadisNotifyCategory;
	readonly presetContent?: string;
	readonly hookTurnEnd?: IParadisNotifyHookTurnEnd;
	readonly hookApproval?: IParadisNotifyHookApproval;
	readonly pane?: IParadisNotifyPaneContent;
	readonly now: number;
}): IParadisNotifyContentResolution | undefined {
	const { pane, now } = input;
	if (input.kind === 'agent-done' || input.kind === 'agent-error') {
		const turnEnd = pane?.turnEnd !== undefined && now - pane.turnEnd.at <= HOOK_FRESH_MS ? pane.turnEnd : undefined;
		// hook と transcript のターンの終わりが両方あれば、新しいほうを採る（古いほうは前のターンの話）。
		const hook = input.hookTurnEnd !== undefined && (turnEnd === undefined || input.hookTurnEnd.at >= turnEnd.at) ? input.hookTurnEnd : undefined;
		if (hook?.failed) {
			return { kind: 'agent-error', category: 'error', ...(hook.errorMessage !== undefined ? { content: hook.errorMessage } : {}), ...(hook.errorCode !== undefined ? { errorCode: hook.errorCode } : {}) };
		}
		if (hook?.lastMessage !== undefined) {
			return { kind: 'agent-done', category: 'done', content: hook.lastMessage };
		}
		const last = pane?.lastAssistant;
		if (hook === undefined && turnEnd?.reason === 'failed') {
			return { kind: 'agent-error', category: 'error', ...(last?.isError ? { content: last.text } : {}), ...(turnEnd.errorCode !== undefined ? { errorCode: turnEnd.errorCode } : {}) };
		}
		if (last !== undefined) {
			return last.isError
				? { kind: 'agent-error', category: 'error', content: last.text }
				: { kind: 'agent-done', category: 'done', content: last.text };
		}
		return { kind: input.kind, category: input.kind === 'agent-error' ? 'error' : 'done' };
	}
	if (input.kind === 'agent-question') {
		if (input.presetCategory === 'question') {
			return { kind: 'agent-question', category: 'question', ...(input.presetContent !== undefined ? { content: input.presetContent } : {}), ...(pane?.interaction?.kind === 'question' ? { interactionId: pane.interaction.id } : {}) };
		}
		const interaction = pane?.interaction;
		if (interaction?.kind === 'question') {
			return { kind: 'agent-question', category: 'question', ...(interaction.text !== undefined ? { content: interaction.text } : {}), interactionId: interaction.id };
		}
		// 中身と ID は必ず同じ承認から採る。待っている承認があれば、その ID と hook の `tool_use_id` が一致したときだけ
		// hook の中身（コマンドを優先した形）を使い、一致しなければその承認自身の中身を使う。待っている承認が無いときは
		// hook の中身だけを使い、ID は付けない（通知から答えさせない）。
		const hookApproval = input.hookApproval;
		const hookMatches = hookApproval !== undefined && (interaction?.kind !== 'approval' || (hookApproval.toolUseId !== undefined && hookApproval.toolUseId === interaction.id));
		const fromHook = hookMatches ? paradisApprovalNotifyContent(hookApproval.toolName, hookApproval.toolInput) : undefined;
		const content = fromHook ?? (interaction?.kind === 'approval' ? interaction.text : undefined);
		return {
			kind: 'agent-question', category: 'approval',
			...(content !== undefined ? { content } : {}),
			...(interaction?.kind === 'approval' ? { interactionId: interaction.id } : {}),
		};
	}
	return undefined;
}
