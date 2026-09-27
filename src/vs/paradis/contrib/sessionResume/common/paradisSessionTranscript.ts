/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の transcript と Codex の rollout を1行ずつ読むための共通部品。
//
// セッション履歴（shared process）と、使用量・作業実績・全文索引を作る worker の両方が同じ規則で
// 会話を拾えるよう、もとはセッション履歴のチャネルにあった関数をここへ移した。Node の API に
// 依存しないので common に置く。

import { ParadisResumeAgent } from './paradisSessionResume.js';

/** 1メッセージの本文を切り詰める既定の上限（一覧・プレビュー用）。 */
export const PARADIS_TRANSCRIPT_MAX_MESSAGE_CHARS = 12_000;

export interface IParadisTranscriptMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly timestamp?: number;
}

export function paradisTranscriptRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function paradisTranscriptString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function paradisTranscriptNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function paradisTranscriptClipped(value: string, limit = PARADIS_TRANSCRIPT_MAX_MESSAGE_CHARS): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function paradisTranscriptTimestamp(value: unknown): number | undefined {
	const raw = paradisTranscriptString(value);
	if (!raw) {
		return undefined;
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** content（文字列、またはテキストブロックの配列）から本文だけをつなぐ。ツール呼び出しや思考は含めない。 */
export function paradisTranscriptFlattenText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	const parts: string[] = [];
	for (const item of value) {
		const block = paradisTranscriptRecord(item);
		if (!block) {
			continue;
		}
		const type = paradisTranscriptString(block.type);
		if (type === 'text' || type === 'input_text' || type === 'output_text') {
			const text = paradisTranscriptString(block.text);
			if (text) {
				parts.push(text);
			}
		}
	}
	return parts.join('\n');
}

/** Codex が会話の先頭へ自動で差し込む環境情報・指示（ユーザーの依頼ではない）。 */
export function paradisIsInjectedCodexContext(text: string): boolean {
	const value = text.trim();
	return /^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS)/.test(value)
		|| value.startsWith('# AGENTS.md instructions for');
}

/** Codex の state DB の `source` 列が、サブエージェントではない（ユーザーが起動した）スレッドを指すか。 */
export function paradisIsCodexRootSource(source: string | undefined): boolean {
	if (!source) {
		return true;
	}
	try {
		const parsed = paradisTranscriptRecord(JSON.parse(source));
		return paradisTranscriptRecord(paradisTranscriptRecord(parsed?.subagent)?.thread_spawn) === undefined;
	} catch {
		return true;
	}
}

export interface IParadisCodexSessionMeta {
	readonly id: string;
	readonly cwd: string;
	/** サブエージェント（親スレッドから起動されたもの）なら true。 */
	readonly subagent: boolean;
}

/** rollout の先頭行（`session_meta`）を読む。読めなければ undefined。 */
export function paradisParseCodexSessionMetaItem(item: Record<string, unknown> | undefined): IParadisCodexSessionMeta | undefined {
	const payload = paradisTranscriptRecord(item?.payload);
	if (item?.type !== 'session_meta' || !payload) {
		return undefined;
	}
	const id = paradisTranscriptString(payload.id) ?? paradisTranscriptString(payload.session_id);
	const cwd = paradisTranscriptString(payload.cwd);
	const sourceSpawn = paradisTranscriptRecord(paradisTranscriptRecord(paradisTranscriptRecord(payload.source)?.subagent)?.thread_spawn);
	const parentThreadId = paradisTranscriptString(payload.parent_thread_id) ?? paradisTranscriptString(sourceSpawn?.parent_thread_id);
	const ownThreadId = paradisTranscriptString(payload.id) ?? id;
	const subagent = sourceSpawn !== undefined || paradisTranscriptString(payload.thread_source) === 'subagent'
		|| (parentThreadId !== undefined && parentThreadId !== ownThreadId);
	return id && cwd ? { id, cwd, subagent } : undefined;
}

export function paradisParseCodexSessionMeta(line: string): IParadisCodexSessionMeta | undefined {
	try {
		return paradisParseCodexSessionMetaItem(paradisTranscriptRecord(JSON.parse(line)));
	} catch {
		return undefined;
	}
}

/**
 * 解析済みの1行から、ユーザーまたはアシスタントの発言を取り出す。発言でない行（ツール結果、
 * メタ情報、サブエージェントの発言、Codex が差し込む環境情報）は undefined。
 */
export function paradisTranscriptMessageFromItem(item: Record<string, unknown> | undefined, agent: ParadisResumeAgent, maxChars = PARADIS_TRANSCRIPT_MAX_MESSAGE_CHARS): IParadisTranscriptMessage | undefined {
	if (!item) {
		return undefined;
	}
	if (agent === 'claude') {
		if (item.isSidechain === true || item.isMeta === true) {
			return undefined;
		}
		const type = paradisTranscriptString(item.type);
		if (type !== 'user' && type !== 'assistant') {
			return undefined;
		}
		const message = paradisTranscriptRecord(item.message);
		const text = paradisTranscriptFlattenText(message?.content);
		if (!text.trim()) {
			return undefined;
		}
		return { role: type, text: paradisTranscriptClipped(text, maxChars), timestamp: paradisTranscriptTimestamp(item.timestamp) };
	}
	if (item.type !== 'response_item') {
		return undefined;
	}
	const payload = paradisTranscriptRecord(item.payload);
	if (payload?.type !== 'message') {
		return undefined;
	}
	const role = paradisTranscriptString(payload.role);
	if (role !== 'user' && role !== 'assistant') {
		return undefined;
	}
	const text = paradisTranscriptFlattenText(payload.content);
	if (!text.trim() || (role === 'user' && paradisIsInjectedCodexContext(text))) {
		return undefined;
	}
	return { role, text: paradisTranscriptClipped(text, maxChars), timestamp: paradisTranscriptTimestamp(item.timestamp) };
}

/** 1行（JSON 文字列）から発言を取り出す。{@link paradisTranscriptMessageFromItem} の文字列版。 */
export function paradisParseTranscriptLine(line: string, agent: ParadisResumeAgent, maxChars = PARADIS_TRANSCRIPT_MAX_MESSAGE_CHARS): IParadisTranscriptMessage | undefined {
	let item: Record<string, unknown> | undefined;
	try {
		item = paradisTranscriptRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
	return paradisTranscriptMessageFromItem(item, agent, maxChars);
}

/**
 * ツールの出力（コマンドの結果など）の本文を取り出す。全文索引で「ツール出力も索引する」を
 * 選んだときだけ使う。発言ではないので {@link paradisTranscriptMessageFromItem} とは分けている。
 */
export function paradisTranscriptToolOutputFromItem(item: Record<string, unknown> | undefined, agent: ParadisResumeAgent, maxChars = PARADIS_TRANSCRIPT_MAX_MESSAGE_CHARS): string | undefined {
	if (!item) {
		return undefined;
	}
	const parts: string[] = [];
	if (agent === 'claude') {
		if (item.isSidechain === true || item.type !== 'user') {
			return undefined;
		}
		const content = paradisTranscriptRecord(item.message)?.content;
		for (const block of Array.isArray(content) ? content : []) {
			const record = paradisTranscriptRecord(block);
			if (record?.type === 'tool_result') {
				const text = paradisTranscriptFlattenText(record.content);
				if (text.trim()) {
					parts.push(text);
				}
			}
		}
	} else {
		const payload = paradisTranscriptRecord(item.payload);
		if (item.type !== 'response_item' || (payload?.type !== 'function_call_output' && payload?.type !== 'custom_tool_call_output')) {
			return undefined;
		}
		const output = payload.output;
		const text = typeof output === 'string' ? output : paradisTranscriptFlattenText(output);
		if (text.trim()) {
			parts.push(text);
		}
	}
	const joined = parts.join('\n');
	return joined.trim() ? paradisTranscriptClipped(joined, maxChars) : undefined;
}

/**
 * 利用者が自分で打ったシェルコマンド（Claude Code の `!` モードやローカルコマンド）の出力の区間。
 * 発言（`type: user` の行）として記録されるが、中身はコマンドの出力なので、ツールの出力と同じく
 * 「ツール出力を索引しない」ときは除く。切り詰めで閉じタグが落ちた区間も末尾まで除く。
 */
const USER_SHELL_OUTPUT_PATTERN = /<(?<tag>bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>[\s\S]*?(?:<\/\k<tag>>|$)/g;

/** 発言の本文から、利用者のシェルコマンドの出力の区間を取り除く。 */
export function paradisStripUserShellOutput(text: string): string {
	return text.replace(USER_SHELL_OUTPUT_PATTERN, '');
}
