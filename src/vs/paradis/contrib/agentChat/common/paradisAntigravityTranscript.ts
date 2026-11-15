/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Antigravity CLI（`agy`）の会話の記録 `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
// の 1 行を、Claude Code・Codex の transcript と同じ発言（IRawMessage）にする。
//
// 行は 1 ステップ 1 行で、キーは step_index・source・type・status・created_at・content・model・thinking・tool_calls・error・media
// （agy 1.5.9 の手元の記録の構造、2026-11-16）。種類は次のとおり:
//   - USER_EXPLICIT / USER_INPUT: 利用者の発言。本文は `<USER_REQUEST>` で包まれ、`<ADDITIONAL_METADATA>` などが続く
//   - MODEL / PLANNER_RESPONSE: モデルの応答。`thinking`・`content`・`tool_calls`（`{ name, args }`。id は無い）・`model`
//   - MODEL / GENERIC: ツールの結果。直前の PLANNER_RESPONSE の `tool_calls` と同じ数だけ、同じ順に続く
//   - SYSTEM / ERROR_MESSAGE: 失敗の知らせ（`error`）
//   - SYSTEM / SYSTEM_MESSAGE・CHECKPOINT: 子の会話の指示・圧縮の区切り（出さない）
// `transcript.jsonl`（`_full` の無い方）は引数が二重に文字列化されているので読まない。

import { PARADIS_ANTIGRAVITY_QUESTION_TOOL } from '../../agentBrowser/common/paradisAntigravityHooks.js';
import { paradisRedactToolInputSecrets } from '../../agentBrowser/common/paradisBrowserPageOps.js';
import { IParseSignals, IRawMessage, num, parseAskUserQuestions, rec, str, TEXT_LIMIT, TOOL_TEXT_LIMIT, truncateText, withTruncation } from './paradisAgentTranscriptParser.js';

/** 覚えておく結果待ちの呼び出しの上限（壊れた記録で伸び続けないように）。 */
const PENDING_CALL_LIMIT = 64;

/**
 * 行をまたいで持つ解釈の状態。agy の記録は呼び出しに id を持たないので、PLANNER_RESPONSE の呼び出しに
 * 合成の id を振り、続く GENERIC の結果へ順に渡す。続けて読む側（tailer）は 1 つを作って渡し続ける。
 */
export interface IParadisAntigravityParseState {
	/** 結果がまだ来ていない呼び出しの合成の id（古い順）。 */
	pendingCalls: string[];
}

export function newParadisAntigravityParseState(): IParadisAntigravityParseState {
	return { pendingCalls: [] };
}

function lineTimestamp(obj: Record<string, unknown>): number | undefined {
	const createdAt = str(obj.created_at);
	const parsed = createdAt !== undefined ? Date.parse(createdAt) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 利用者の発言の本文。agy は入力を `<USER_REQUEST>` で包み、その後ろに `<ADDITIONAL_METADATA>` などの
 * 付け足しを書くので、包みの中だけを返す。包みが無ければ、付け足しの塊を外した残り。
 */
export function paradisAntigravityUserRequestText(content: string): string {
	const request = /<USER_REQUEST>\r?\n?(?<body>[\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(content);
	if (request?.groups?.body !== undefined) {
		return request.groups.body.trim();
	}
	return content.replace(/<(?<tag>ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\k<tag>>/g, '').trim();
}

/**
 * agy の ask_question の引数（`{ questions: [{ question, options: string[], is_multi_select }] }`）を、
 * Claude Code の AskUserQuestion の入力の形（`{ questions: [{ question, options: [{ label }], multiSelect }] }`）にする。
 * 質問のカード・回答待ちの印・通知は AskUserQuestion の形だけを読むため。形が違えば undefined。
 */
export function paradisAntigravityQuestionInput(args: unknown): { readonly questions: readonly Record<string, unknown>[] } | undefined {
	const questions = rec(args)?.questions;
	if (!Array.isArray(questions)) {
		return undefined;
	}
	const converted: Record<string, unknown>[] = [];
	for (const raw of questions) {
		const question = rec(raw);
		const text = str(question?.question);
		if (question === undefined || text === undefined) {
			continue;
		}
		const options = Array.isArray(question.options)
			? question.options.flatMap(option => {
				const label = typeof option === 'string' ? option : str(rec(option)?.label);
				return label !== undefined && label.trim().length > 0 ? [{ label }] : [];
			})
			: [];
		converted.push({ question: text, options, ...(question.is_multi_select === true || question.multiSelect === true ? { multiSelect: true } : {}) });
	}
	return converted.length > 0 ? { questions: converted } : undefined;
}

function toolInputText(tool: string, args: unknown): string {
	try {
		return JSON.stringify(paradisRedactToolInputSecrets(tool, args)) ?? '';
	} catch {
		return '';
	}
}

/** transcript_full.jsonl の 1 行を発言にする。 */
export function parseAntigravityLine(obj: Record<string, unknown>, signals: IParseSignals, state: IParadisAntigravityParseState): IRawMessage[] {
	const type = str(obj.type);
	const ts = lineTimestamp(obj);
	if (type === 'USER_INPUT') {
		// 新しいターン。前のターンで結果の来なかった呼び出しは持ち越さない
		state.pendingCalls = [];
		const text = paradisAntigravityUserRequestText(str(obj.content) ?? '');
		if (text.length === 0) {
			return [];
		}
		signals.userText = true;
		return [{ role: 'user', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts }];
	}
	if (type === 'PLANNER_RESPONSE') {
		const out: IRawMessage[] = [];
		const model = str(obj.model);
		if (model !== undefined && model.length > 0) {
			signals.model = model;
		}
		const thinking = str(obj.thinking);
		if (thinking !== undefined && thinking.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'thinking', ...withTruncation(thinking, TOOL_TEXT_LIMIT), ts });
		}
		const content = str(obj.content);
		if (content !== undefined && content.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'text', ...withTruncation(content, TEXT_LIMIT), ts });
		}
		const step = num(obj.step_index);
		const calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
		const pending: string[] = [];
		calls.forEach((rawCall, index) => {
			const call = rec(rawCall);
			const tool = str(call?.name) ?? 'tool';
			// 同じ記録の中で一意になればよい（行の番号と呼び出しの順番）。行の番号が無い行は結び付けない
			const toolUseId = step !== undefined ? `agy-${step}-${index}` : undefined;
			if (toolUseId !== undefined) {
				pending.push(toolUseId);
			}
			const questionInput = tool === PARADIS_ANTIGRAVITY_QUESTION_TOOL ? paradisAntigravityQuestionInput(call?.args) : undefined;
			if (questionInput !== undefined) {
				// Claude Code の AskUserQuestion と同じく、回答待ちの印を付ける（hook より先に記録を読んだとき、
				// hook の質問をこの質問と同じものと見分けて 2 枚にしないため。読み直し・再起動の後も回答待ちを保つため）
				const questions = parseAskUserQuestions(questionInput, toolUseId, ts);
				if (questions.length > 0 && toolUseId !== undefined) {
					signals.askedQuestionIds.push(toolUseId);
				}
				out.push(...questions);
				return;
			}
			out.push({ role: 'assistant', kind: 'tool_use', tool, ...withTruncation(toolInputText(tool, call?.args), TOOL_TEXT_LIMIT), ts, ...(toolUseId !== undefined ? { toolUseId } : {}) });
		});
		state.pendingCalls = pending.slice(-PENDING_CALL_LIMIT);
		return out;
	}
	if (type === 'GENERIC') {
		const toolUseId = state.pendingCalls.shift();
		// 質問の回答も結果として届く（本文が空でも回答は成立する）。Claude Code の tool_result と同じ印
		if (toolUseId !== undefined) {
			signals.answeredIds.push(toolUseId);
		}
		const error = str(obj.error);
		const content = str(obj.content) ?? '';
		const text = content.trim().length > 0 ? content : error ?? '';
		if (text.trim().length === 0) {
			return [];
		}
		const failed = str(obj.status) === 'ERROR' || (error !== undefined && error.length > 0);
		return [{ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(toolUseId !== undefined ? { toolUseId } : {}), ...(failed ? { isError: true } : {}) }];
	}
	if (type === 'ERROR_MESSAGE') {
		const message = str(obj.error) ?? str(obj.content);
		if (message === undefined || message.trim().length === 0) {
			return [];
		}
		return [{ role: 'assistant', kind: 'text', text: truncateText(message.trim(), TEXT_LIMIT), ts, isError: true }];
	}
	return [];
}
