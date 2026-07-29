/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の「スペースのメモ」ツール群で使う、プロセス間で共有する型と純粋関数。
// ツール引数の検証は shared process 側（node）で、結果の組み立ては workbench ウィンドウ側
// （electron-browser）で行うため、両者が同じ定義を読めるこの common に置く。

import {
	IParadisSpaceNoteLine,
	ParadisSpaceNoteLineKind,
	PARADIS_SPACE_NOTE_MAX_LENGTH,
	PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH,
	paradisParseSpaceNote,
} from '../../workspaceSwitch/common/paradisSpaceNotes.js';

/**
 * workbenchウィンドウが shared process の IPCServer へ登録する、スペースのメモ操作用
 * IPCチャネル名。{@link PARADIS_AGENT_PREVIEW_CHANNEL} と同じく、shared process 側が
 * 「呼び出し元ペインのウィンドウ」だけへctxフィルタでルーティングして呼ぶ。
 */
export const PARADIS_AGENT_NOTES_CHANNEL = 'paradisAgentNotes';

/** {@link PARADIS_AGENT_NOTES_CHANNEL} の呼び出しメソッド名。 */
export const PARADIS_AGENT_NOTES_METHOD = 'spaceNote';

export type ParadisAgentNoteOperation = 'list' | 'read' | 'write' | 'addTask' | 'checkTask' | 'deleteTask';

/**
 * MCPツール名 → メモ操作。tools/list の定義とディスパッチがこの表を唯一の出典にする
 * （名前を足すときはここと TOOLS / シムの LOCAL_TOOLS を揃える）。
 */
export const PARADIS_AGENT_NOTE_TOOL_OPERATIONS: ReadonlyMap<string, ParadisAgentNoteOperation> = new Map<string, ParadisAgentNoteOperation>([
	['list_space_notes', 'list'],
	['read_space_note', 'read'],
	['write_space_note', 'write'],
	['add_space_note_task', 'addTask'],
	['check_space_note_task', 'checkTask'],
	['delete_space_note_task', 'deleteTask'],
]);

/** 1回の呼び出しで受け付けるチェックリスト1件の最大長（本文上限と同じ土俵で弾く）。 */
const MAX_TASK_LENGTH = PARADIS_SPACE_NOTE_MAX_LENGTH;

/**
 * 改行を LF へ揃える。メモのパーサは行末に `\r` が残るとチェックリストとしても見出しとしても
 * 認識しないため、CRLF のまま保存するとチェックボックスが丸ごと消えてしまう。PC のメモ欄は
 * textarea が LF へ正規化するので、CRLF が入りうるのはこのMCP経路だけ。
 */
function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

export interface IParadisAgentNoteRequest {
	readonly op: ParadisAgentNoteOperation;
	/** 未指定なら呼び出し元ペインが属するスペース。 */
	readonly space?: string;
	/** op === 'write' の本文（空文字列でメモごと削除）。 */
	readonly text?: string;
	/** op === 'addTask' で追加するチェックリストの文言。 */
	readonly task?: string;
	/** op === 'checkTask' / 'deleteTask' の対象行（0-based）。 */
	readonly line?: number;
	/** op === 'checkTask' の明示指定（未指定はトグル）。 */
	readonly done?: boolean;
}

export interface IParadisAgentNoteSpace {
	/** 状態キー（リポジトリID または `worktree:<uri>`）。他ツールの `space` に渡す値。 */
	readonly space: string;
	readonly name: string;
	readonly kind: 'repository' | 'worktree';
	/** 呼び出し元ペインが属するスペース（`space` 省略時の既定）。 */
	readonly current?: boolean;
	readonly open: number;
	readonly done: number;
}

export interface IParadisAgentNoteLine {
	/** 0-based の行番号。check/delete ツールの `line` に渡す値。 */
	readonly line: number;
	readonly kind: ParadisSpaceNoteLineKind;
	readonly text: string;
	/** kind === 'task' のときだけ載せる。 */
	readonly done?: boolean;
}

export interface IParadisAgentNoteView {
	readonly space: string;
	readonly name: string;
	readonly text: string;
	readonly lines: readonly IParadisAgentNoteLine[];
	readonly open: number;
	readonly done: number;
}

export type IParadisAgentNoteResult =
	| { readonly ok: true; readonly kind: 'spaces'; readonly spaces: readonly IParadisAgentNoteSpace[] }
	| {
		readonly ok: true;
		readonly kind: 'note';
		readonly note: IParadisAgentNoteView;
		/** 全文置換で消えた本文（メモには履歴もundoも無いので、復元できるよう返す）。 */
		readonly replaced?: string;
	}
	| { readonly ok: false; readonly error: string };

/** ツール引数の検証結果。 */
export type IParadisAgentNoteRequestParse =
	| { readonly ok: true; readonly request: IParadisAgentNoteRequest }
	| { readonly ok: false; readonly error: string };

/** メモ本文を、行番号付きのLLM向け表現へ変換する（空行も落とさず index を本文と一致させる）。 */
export function paradisAgentNoteLines(text: string): IParadisAgentNoteLine[] {
	return paradisParseSpaceNote(text).map((line: IParadisSpaceNoteLine): IParadisAgentNoteLine => (
		line.kind === 'task'
			? { line: line.index, kind: line.kind, text: line.text, done: line.done }
			: { line: line.index, kind: line.kind, text: line.text }
	));
}

type SpaceParse = { readonly ok: true; readonly space?: string } | { readonly ok: false; readonly error: string };
type LineParse = { readonly ok: true; readonly line: number } | { readonly ok: false; readonly error: string };

function optionalSpace(args: Record<string, unknown>): SpaceParse {
	const space = args['space'];
	if (space === undefined || space === null) {
		return { ok: true };
	}
	if (typeof space !== 'string' || space.length === 0) {
		return { ok: false, error: 'The "space" argument must be a non-empty space key from list_space_notes.' };
	}
	if (space.length > PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH) {
		return { ok: false, error: `The "space" argument is too long (limit: ${PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH} characters).` };
	}
	return { ok: true, space };
}

function requiredLine(args: Record<string, unknown>): LineParse {
	const line = args['line'];
	if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
		return { ok: false, error: 'The "line" argument must be a 0-based line number from read_space_note.' };
	}
	return { ok: true, line };
}

/**
 * MCPツール呼び出しの `arguments` を検証して {@link IParadisAgentNoteRequest} に正規化する。
 * 失敗時は LLM がそのまま読める英語メッセージを返す（shared process 側で isError にして返す）。
 */
export function paradisParseAgentNoteToolArgs(name: string, args: unknown): IParadisAgentNoteRequestParse {
	const op = PARADIS_AGENT_NOTE_TOOL_OPERATIONS.get(name);
	if (op === undefined) {
		return { ok: false, error: `Unknown tool: ${name}` };
	}
	if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
		return { ok: false, error: 'The tool arguments must be an object.' };
	}
	const record = (args ?? {}) as Record<string, unknown>;

	const parsedSpace = optionalSpace(record);
	if (!parsedSpace.ok) {
		return parsedSpace;
	}
	const space = parsedSpace.space === undefined ? {} : { space: parsedSpace.space };

	switch (op) {
		case 'list':
			// 一覧は特定のスペースに紐づかないので space は捨てる
			return { ok: true, request: { op } };
		case 'read':
			return { ok: true, request: { op, ...space } };
		case 'write': {
			const text = record['text'];
			if (typeof text !== 'string') {
				return { ok: false, error: 'The "text" argument is required and must be a string (pass an empty string to clear the note).' };
			}
			if (text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
				return { ok: false, error: `The note text is too long (limit: ${PARADIS_SPACE_NOTE_MAX_LENGTH} characters, got: ${text.length}).` };
			}
			return { ok: true, request: { op, ...space, text: normalizeNewlines(text) } };
		}
		case 'addTask': {
			const task = record['task'];
			if (typeof task !== 'string' || task.trim().length === 0) {
				return { ok: false, error: 'The "task" argument is required and must be a non-empty string.' };
			}
			if (task.length > MAX_TASK_LENGTH) {
				return { ok: false, error: `The checklist item is too long (limit: ${MAX_TASK_LENGTH} characters, got: ${task.length}).` };
			}
			return { ok: true, request: { op, ...space, task: normalizeNewlines(task) } };
		}
		case 'checkTask': {
			const parsedLine = requiredLine(record);
			if (!parsedLine.ok) {
				return parsedLine;
			}
			const done = record['done'];
			if (done !== undefined && done !== null && typeof done !== 'boolean') {
				return { ok: false, error: 'The "done" argument must be a boolean (omit it to toggle the item).' };
			}
			return { ok: true, request: { op, ...space, line: parsedLine.line, ...(typeof done === 'boolean' ? { done } : {}) } };
		}
		case 'deleteTask': {
			const parsedLine = requiredLine(record);
			if (!parsedLine.ok) {
				return parsedLine;
			}
			return { ok: true, request: { op, ...space, line: parsedLine.line } };
		}
	}
}
