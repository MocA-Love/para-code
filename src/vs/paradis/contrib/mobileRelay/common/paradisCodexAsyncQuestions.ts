/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * Codex の非同期の質問（`request_user_input_async`、codex-cli 0.153.0 から）の読み書き。PC（shared process・チャット表示）と
 * モバイルアプリ（app/mobile）の両方が読むので、ほかのモジュールに頼らない純粋な関数だけを置く。
 *
 * - 質問は rollout の `event_msg` の `item_completed` の `AgentMessage`（`delivery: "async"`、`questions` 付き。`id` は呼び出しの
 *   call_id）にだけ書かれる。PreToolUse hook の `tool_input.questions` と `tool_use_id`（= call_id）は早く知るための補助。
 * - 答えは利用者の発言として、Codex が決めた形（`<send_user_message_question_reply>` で JSON の配列を包む）で送る。作業中なら
 *   同じターンに入り、終わっていれば新しい依頼になる。形を作るのは codex-rs/context-fragments/src/answered_question.rs、
 *   読むのは tui/src/async_question_reply.rs（前後の印を外して JSON として読むだけ）。
 * - どの質問への答えかは `questionItemId`（`JSON.stringify(["request_user_input_async", call_id, 番号])` の文字列）で決まる。
 */

/** Codex の非同期の質問のツール名（`questionItemId` の先頭にも入る）。 */
export const PARADIS_CODEX_ASYNC_QUESTION_TOOL = 'request_user_input_async';

const REPLY_OPEN = '<send_user_message_question_reply>';
const REPLY_CLOSE = '</send_user_message_question_reply>';

/** 1 回の呼び出しで受け取る質問の上限（相手を信用しない）。 */
const MAX_QUESTIONS_PER_CALL = 20;
/** 1 問の選択肢の上限。 */
const MAX_OPTIONS = 20;
/** 質問文・選択肢を持つ長さの上限（文字数）。 */
const TITLE_LIMIT = 4_000;
const OPTION_LIMIT = 500;
/** 返信に入れる質問文の上限（UTF-8 のバイト数。Codex の AnsweredQuestion::new と同じ）。 */
const REPLY_QUESTION_BYTES = 512;
/** 1 問の答えの上限（文字数）。モバイルの送信は全体で 100,000 文字まで。 */
export const PARADIS_CODEX_ASYNC_ANSWER_LIMIT = 10_000;

/** 未回答の非同期の質問 1 問（PC がモバイルとチャット表示へ渡す形）。 */
export interface IParadisCodexAsyncQuestion {
	/** `questionItemId`（返信に入れる ID。カードの鍵にも使う）。 */
	readonly id: string;
	/** 呼び出しの call_id（同じ呼び出しの質問は 1 枚のカードにまとめる）。 */
	readonly callId: string;
	/** 呼び出しの中の番号（0 起点）。 */
	readonly index: number;
	/** 呼び出しの質問の数。 */
	readonly count: number;
	readonly title: string;
	/** 候補の答え（表示順）。無ければ自由入力だけの質問。 */
	readonly options?: readonly string[];
	/** 質問が出た時刻（PC の記録の時計。分かれば）。 */
	readonly at?: number;
}

/** 返信の 1 件（答えた質問と答え）。 */
export interface IParadisCodexAsyncReply {
	readonly question: string;
	readonly answer: string;
	/** 返信の `questionItemId`。 */
	readonly itemId: string;
	/** `itemId` が非同期の質問の形なら、その call_id と番号。 */
	readonly callId?: string;
	readonly index?: number;
}

/** 返信の `questionItemId` を作る（Codex の TUI と同じ）。 */
export function paradisCodexAsyncQuestionItemId(callId: string, index: number): string {
	return JSON.stringify([PARADIS_CODEX_ASYNC_QUESTION_TOOL, callId, index]);
}

/** `questionItemId` を読む。非同期の質問の形でなければ undefined。 */
export function paradisParseCodexAsyncQuestionItemId(itemId: string): { readonly callId: string; readonly index: number } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(itemId);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) {
		return undefined;
	}
	const [tool, callId, index] = parsed as unknown[];
	return tool === PARADIS_CODEX_ASYNC_QUESTION_TOOL && typeof callId === 'string' && callId.length > 0 && callId.length <= 200
		&& typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 1000 ? { callId, index } : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * ツールの引数（`{ questions: [{ title, options? }] }`）から質問を作る。PreToolUse hook の `tool_input` と、rollout の
 * `AgentMessage` の `questions` の両方に使う。形が合わなければ undefined。
 */
export function paradisCodexAsyncQuestionsFromArguments(callId: string | undefined, input: unknown, at?: number): IParadisCodexAsyncQuestion[] | undefined {
	const questions = record(input)?.questions;
	if (callId === undefined || callId.length === 0 || callId.length > 200 || !Array.isArray(questions) || questions.length === 0) {
		return undefined;
	}
	const list = questions.slice(0, MAX_QUESTIONS_PER_CALL);
	const result: IParadisCodexAsyncQuestion[] = [];
	for (const [index, candidate] of list.entries()) {
		const question = record(candidate);
		const title = typeof question?.title === 'string' ? question.title.trim() : '';
		if (title.length === 0) {
			return undefined; // Codex も空の質問は断る（呼び出し自体が失敗している）
		}
		// options は null のこともある（自由入力だけの質問。実データで確認）
		const options = Array.isArray(question?.options)
			? question.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).slice(0, MAX_OPTIONS).map(option => option.slice(0, OPTION_LIMIT))
			: [];
		result.push({
			id: paradisCodexAsyncQuestionItemId(callId, index),
			callId,
			index,
			count: list.length,
			title: title.slice(0, TITLE_LIMIT),
			...(options.length > 0 ? { options } : {}),
			...(at !== undefined && Number.isFinite(at) ? { at } : {}),
		});
	}
	return result;
}

/** rollout の `item_completed` の item が非同期の質問なら、その質問。 */
export function paradisCodexAsyncQuestionsFromItem(item: unknown, at?: number): IParadisCodexAsyncQuestion[] | undefined {
	const value = record(item);
	if (value?.type !== 'AgentMessage' || value.delivery !== 'async' || !Array.isArray(value.questions)) {
		return undefined;
	}
	return paradisCodexAsyncQuestionsFromArguments(typeof value.id === 'string' ? value.id : undefined, { questions: value.questions }, at);
}

/**
 * 答え・質問文から、エージェントへ渡してはいけない文字を落とす。制御文字（改行とタブは残す）、ゼロ幅の文字・向きの制御、
 * BOM、対になっていないサロゲート（JSON としては書けても Codex の serde_json が読めない）。
 */
export function paradisSanitizeCodexAsyncText(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xDC00 && next <= 0xDFFF) {
				out += text.charAt(i) + text.charAt(i + 1);
				i++;
			}
			continue;
		}
		if (code >= 0xDC00 && code <= 0xDFFF) {
			continue;
		}
		if (code === 0x0D) {
			// CRLF と CR は改行にそろえる
			if (text.charCodeAt(i + 1) !== 0x0A) {
				out += '\n';
			}
			continue;
		}
		if ((code < 0x20 && code !== 0x09 && code !== 0x0A) || (code >= 0x7F && code <= 0x9F)
			|| (code >= 0x200B && code <= 0x200F) || (code >= 0x2028 && code <= 0x202E) || (code >= 0x2060 && code <= 0x206F)
			|| code === 0xFEFF || (code >= 0xFFF9 && code <= 0xFFFB)) {
			continue;
		}
		out += text.charAt(i);
	}
	return out;
}

/** 返信に入れる質問文（改行を空白にして 512 バイトまで。Codex の AnsweredQuestion::new と同じ）。 */
function replyQuestionText(title: string): string {
	const oneLine = paradisSanitizeCodexAsyncText(title).replace(/\n/g, ' ');
	let bytes = 0;
	let out = '';
	for (const char of oneLine) {
		const code = char.codePointAt(0) ?? 0;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > REPLY_QUESTION_BYTES) {
			break;
		}
		bytes += size;
		out += char;
	}
	return out;
}

/**
 * 答えから返信の発言を作る。答えが空のもの・同じ質問への 2 つ目の答えは入れない。入れる答えが 1 つも無ければ undefined。
 *
 * JSON は `JSON.stringify` で作り、さらに `<` `>` `&` を `<` などに書き換える（JSON としては同じ値で、答えに
 * タグのような文字列があっても発言の中に生の XML が現れない）。制御文字は {@link paradisSanitizeCodexAsyncText} で落とす。
 */
export function paradisBuildCodexAsyncReply(answers: readonly { readonly question: Pick<IParadisCodexAsyncQuestion, 'id' | 'title'>; readonly answer: string }[]): string | undefined {
	const seen = new Set<string>();
	const replies: { answer: string; question: string; questionItemId: string }[] = [];
	for (const { question, answer } of answers) {
		const text = paradisSanitizeCodexAsyncText(answer).trim().slice(0, PARADIS_CODEX_ASYNC_ANSWER_LIMIT);
		if (text.length === 0 || seen.has(question.id) || paradisParseCodexAsyncQuestionItemId(question.id) === undefined) {
			continue;
		}
		seen.add(question.id);
		// 鍵の順は Codex が書く形と同じ（answer・question・questionItemId）
		replies.push({ answer: text, question: replyQuestionText(question.title), questionItemId: question.id });
	}
	if (replies.length === 0) {
		return undefined;
	}
	const json = JSON.stringify(replies).replace(/[<>&]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
	return `${REPLY_OPEN}\n${json}\n${REPLY_CLOSE}`;
}

/**
 * 発言が返信の形なら、その中身（Codex の TUI と同じく、前後の印で包まれた JSON の配列か 1 件だけ）。形が違えば undefined。
 */
export function paradisParseCodexAsyncReply(text: string): IParadisCodexAsyncReply[] | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith(REPLY_OPEN) || !trimmed.endsWith(REPLY_CLOSE)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed.slice(REPLY_OPEN.length, trimmed.length - REPLY_CLOSE.length));
	} catch {
		return undefined;
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const replies: IParadisCodexAsyncReply[] = [];
	for (const entry of entries) {
		const value = record(entry);
		if (value === undefined || typeof value.answer !== 'string' || typeof value.question !== 'string' || typeof value.questionItemId !== 'string') {
			return undefined; // Codex も 1 件でも形が違えば返信として読まない
		}
		const id = paradisParseCodexAsyncQuestionItemId(value.questionItemId);
		replies.push({
			question: value.question,
			answer: value.answer,
			itemId: value.questionItemId,
			...(id !== undefined ? { callId: id.callId, index: id.index } : {}),
		});
	}
	return replies.length > 0 ? replies : undefined;
}
