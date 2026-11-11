/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Antigravity CLI（`agy`）の hook を、Claude Code・Codex と同じ受け口に載せるための定義。
//
// agy の hook は `hooks.json` の最上位に「名前付きの hook」を並べる形で、イベントごとに次の 2 通りの書き方がある
// （agy 1.5.6 の内蔵の説明書と、試験用のプロジェクトでの実測、2026-11-12）:
//   - SessionStart・PreInvocation・PostInvocation・Stop は、ハンドラ（`{ type, command }`）をそのまま並べる
//   - PreToolUse・PostToolUse は、`{ matcher, hooks: [ハンドラ] }` で包む
// stdin の JSON のキーは camelCase（`hookEventName`・`conversationId`・`transcriptPath`・`toolCall.{id,name,args}`）。
// 受け口はこれを Claude Code の形（snake_case）の別名に写してから読む（{@link paradisWithAntigravityHookAliases}）。
//
// PreToolUse の hook が `{}` を出力すると、agy はツールの実行を拒否する（実測）。notify スクリプトは stdout に何も
// 書かない（curl は `-o /dev/null`）ので安全だが、出力を足すと全ツールが止まる。
//
// agy には承認待ちを知らせる hook が無い。承認待ちは OSC 7501 の `state=blocked:kind=permission:app=antigravity`
// で拾う（paradisProgramStatus.ts）。

/** Para Code が `hooks.json` に置く名前付きの hook の名前。これ以外の名前の hook には触らない。 */
export const PARADIS_ANTIGRAVITY_HOOK_NAME = 'para-code';

/** agy の全体の設定の置き場所（ホーム相対）。agy は初めて起動したときにこのフォルダを作る。 */
export const PARADIS_ANTIGRAVITY_CONFIG_RELATIVE_DIR = '.gemini/config';

/** agy の会話の記録（transcript）の置き場所の印。CLI は `~/.gemini/antigravity-cli/brain/<id>/…`。 */
const ANTIGRAVITY_TRANSCRIPT_PATTERN = /[\\/]\.gemini[\\/]antigravity-cli[\\/]brain[\\/]/;

/** Para Code が受ける agy の hook のイベント。`grouped` は matcher で包むイベント。 */
export interface IParadisAntigravityHookEvent {
	readonly eventName: string;
	readonly grouped: boolean;
}

/**
 * Para Code が置くイベント（agy の 6 種すべて）。
 * - SessionStart: 会話の始まり（ペインと会話を結ぶ）
 * - PreInvocation・PostInvocation: モデルを呼ぶ前後。`invocationNum: 0` の PreInvocation がターンの始まり
 * - PreToolUse・PostToolUse: ツールの前後（`ask_question` の PreToolUse は質問の始まり）
 * - Stop: ターンの終わり（`terminationReason`）
 */
export const PARADIS_ANTIGRAVITY_HOOK_EVENTS: readonly IParadisAntigravityHookEvent[] = [
	{ eventName: 'SessionStart', grouped: false },
	{ eventName: 'PreInvocation', grouped: false },
	{ eventName: 'PostInvocation', grouped: false },
	{ eventName: 'PreToolUse', grouped: true },
	{ eventName: 'PostToolUse', grouped: true },
	{ eventName: 'Stop', grouped: false },
];

/** agy の質問のツール（Claude Code の AskUserQuestion に当たる）。 */
export const PARADIS_ANTIGRAVITY_QUESTION_TOOL = 'ask_question';

/** `hooks.json` の Para Code の名前付きの hook の中身を組み立てる。 */
export function paradisAntigravityHookDefinition(command: string): Record<string, unknown> {
	const definition: Record<string, unknown> = {};
	for (const event of PARADIS_ANTIGRAVITY_HOOK_EVENTS) {
		const handler = { type: 'command', command };
		definition[event.eventName] = event.grouped ? [{ matcher: '*', hooks: [handler] }] : [handler];
	}
	return definition;
}

/** transcript のパスが agy の会話の記録か。 */
export function paradisIsAntigravityTranscriptPath(transcriptPath: string): boolean {
	return ANTIGRAVITY_TRANSCRIPT_PATTERN.test(transcriptPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** hook の JSON が agy のもの（camelCase の `hookEventName` と `conversationId` を持つ）か。 */
export function paradisIsAntigravityHookPayload(payload: unknown): boolean {
	return isRecord(payload) && typeof payload.hookEventName === 'string' && typeof payload.conversationId === 'string';
}

/**
 * agy の hook の JSON に、受け口が読む Claude Code の形のキーを足す（元のキーも残す）。agy のものでなければ
 * 受け取ったものを返す。既に snake_case のキーがあれば上書きしない。
 *
 * | agy | 足すキー |
 * |---|---|
 * | `hookEventName` | `hook_event_name` |
 * | `conversationId` | `session_id` |
 * | `transcriptPath` | `transcript_path` |
 * | `toolCall.name`・`toolCall.args`・`toolCall.id` | `tool_name`・`tool_input`・`tool_use_id` |
 */
export function paradisWithAntigravityHookAliases(payload: unknown): unknown {
	if (!isRecord(payload) || !paradisIsAntigravityHookPayload(payload)) {
		return payload;
	}
	const result: Record<string, unknown> = { ...payload };
	const alias = (key: string, value: unknown) => {
		if (value !== undefined && result[key] === undefined) {
			result[key] = value;
		}
	};
	alias('hook_event_name', payload.hookEventName);
	alias('session_id', payload.conversationId);
	alias('transcript_path', typeof payload.transcriptPath === 'string' ? payload.transcriptPath : undefined);
	const toolCall = payload.toolCall;
	if (isRecord(toolCall)) {
		alias('tool_name', typeof toolCall.name === 'string' ? toolCall.name : undefined);
		alias('tool_input', toolCall.args);
		alias('tool_use_id', typeof toolCall.id === 'string' ? toolCall.id : undefined);
	}
	return result;
}

/**
 * agy の hook のイベント名を、Para Code が状態の判定に使う名前へ写す。
 * - Stop: `terminationReason` が `USER_CANCELED` なら利用者が止めた（Codex の Interrupt と同じく待機へ戻す）、
 *   `ERROR` なら失敗で終わった（Claude Code の StopFailure と同じく完了にし、通知は失敗にする）。それ以外は Stop
 * - PreInvocation: `invocationNum` が 0 ならターンの始まり（Claude Code の UserPromptSubmit と同じ）。それ以外はそのまま
 * - ほかはそのまま
 */
export function paradisAntigravityHookEvent(eventType: string, payload: Readonly<Record<string, unknown>> | undefined): string {
	if (eventType === 'Stop') {
		const reason = payload?.terminationReason;
		if (reason === 'USER_CANCELED') {
			return 'Interrupt';
		}
		if (reason === 'ERROR') {
			return 'StopFailure';
		}
		return 'Stop';
	}
	if (eventType === 'PreInvocation' && payload?.invocationNum === 0) {
		return 'UserPromptSubmit';
	}
	return eventType;
}
