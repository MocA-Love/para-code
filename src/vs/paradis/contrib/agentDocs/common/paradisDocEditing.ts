/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料の「編集中」の印（Q663-5・6・14）。Claude Code の hook から、どの資料のどこをいま書き換えようとしているかを決める純関数と、
// shared process ⇄ ウィンドウのチャネルの名前。
//
//  - 出す: Claude Code の PreToolUse（Edit は `old_string` から場所を推定して枠と札、Write は場所を出さず札だけ）。
//    hook の payload は文字列が 10,000 字で切れる（paradisAgentHookBus.ts）ので、`old_string` は先頭の行だけを使い、
//    切れているかもしれない最後の行は捨てる。全文の比較は、描き直しのときにプレビューがファイルを読んで行う（差分の色）。
//  - 消す: そのツールの PostToolUse・PostToolUseFailure・PermissionDenied、同じペインの次の UserPromptSubmit・Stop・
//    StopFailure・SessionEnd・ペインの終了、ターンの終わり（会話の記録から）、時間切れ。拒否されたときは hook が
//    1 つも来ないことがあるため、区切りと時間切れでも必ず消す。
//  - Bash 経由の書き込みと Codex のパッチは、書く前の印を出さない（描き直しで変わったブロックに差分の色だけ）。

import { paradisReadDocCommentTarget } from './paradisDocComments.js';

/** shared process のチャネル（ウィンドウが印を読む）。 */
export const PARADIS_DOC_EDITING_CHANNEL = 'paradisDocEditing';
/** いまの印（引数: 接続先の印・パス）。 */
export const PARADIS_DOC_EDITING_GET_METHOD = 'get';
/** 印が変わった（{@link IParadisDocEditingChange}）。 */
export const PARADIS_DOC_EDITING_CHANGED_EVENT = 'onDidChange';

/** 印を出したままにする上限。許可待ちのまま拒否された・hook が届かなかったときに消す。 */
export const PARADIS_DOC_EDITING_TIMEOUT_MS = 120_000;
/** ページへ渡す `old_string` の上限（行の切れ目で切る）。 */
export const PARADIS_DOC_EDITING_SOURCE_MAX = 4_000;
/** hook の payload の文字列の上限（paradisAgentHookBus.ts の HOOK_PAYLOAD_MAX_STRING と同じ）。これ以上は切れている。 */
const HOOK_STRING_MAX = 10_000;

/** 資料の、いま書き換えようとしているところ。 */
export interface IParadisDocEditingMark {
	/** 印ごとの番号（ページは同じ番号の間だけ場所を覚える）。 */
	readonly id: string;
	/** `edit`: 場所を推定できる書き換え。`write`: ファイル全体の書き直し（場所は出さない）。 */
	readonly tool: 'edit' | 'write';
	/** 書き換え前の文字列の先頭（Edit の `old_string`）。無ければ札だけ出す。 */
	readonly source?: string;
	/** 受けた時刻（epoch ms）。 */
	readonly at: number;
}

/** ウィンドウへ知らせる、印の変化。`mark` が無ければ消えた。 */
export interface IParadisDocEditingChange {
	readonly hostId: string;
	readonly path: string;
	readonly mark?: IParadisDocEditingMark;
}

/** hook の中身のうち、印に使うもの（IParadisAgentHookEvent の一部）。 */
export interface IParadisDocEditingHook {
	readonly token: string;
	readonly event: string;
	readonly agentKind?: string;
	readonly toolName?: string;
	readonly toolInput?: unknown;
	readonly toolUseId?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
	readonly remoteHostId?: string;
	readonly ownerUnverified?: true;
}

/** hook から決まる印の操作。 */
export type ParadisDocEditingAction =
	| { readonly type: 'start'; readonly hostId: string; readonly path: string; readonly tool: 'edit' | 'write'; readonly source?: string; readonly toolUseId?: string }
	/** そのツールの書き換えが終わった（成功・失敗・拒否）。`toolUseId` が無ければペインとパスで探す。 */
	| { readonly type: 'end'; readonly hostId?: string; readonly path?: string; readonly toolUseId?: string }
	/** そのペインの印をすべて消す（区切り・終了）。 */
	| { readonly type: 'endPane' };

/** そのペインの印をすべて消す hook。 */
const PANE_END_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'TerminalExit', 'Interrupt']);
/** そのツールの印を消す hook。 */
const TOOL_END_EVENTS: ReadonlySet<string> = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
/** 書き換えのツール（Claude Code）。 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write']);

/**
 * `old_string` を、ページで探す先頭の部分にする。hook で切れている（10,000 字ちょうど）かもしれない最後の行と、
 * {@link PARADIS_DOC_EDITING_SOURCE_MAX} を超える分は、行の切れ目で捨てる。1 行も残らなければ undefined（札だけ）。
 */
export function paradisDocEditingHead(oldString: unknown): string | undefined {
	if (typeof oldString !== 'string' || oldString.trim().length === 0) {
		return undefined;
	}
	let text = oldString;
	const cut = text.length >= HOOK_STRING_MAX || text.length > PARADIS_DOC_EDITING_SOURCE_MAX;
	if (cut) {
		text = text.slice(0, PARADIS_DOC_EDITING_SOURCE_MAX + 1);
		const lastBreak = text.lastIndexOf('\n');
		text = lastBreak > 0 ? text.slice(0, lastBreak) : '';
	}
	return text.trim().length > 0 ? text : undefined;
}

function toolInputOf(hook: IParadisDocEditingHook): Record<string, unknown> | undefined {
	const input = hook.payload?.tool_input ?? hook.toolInput;
	return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

/** Edit の `old_string`（MultiEdit は最初の書き換え）。 */
function oldStringOf(tool: string, input: Record<string, unknown>): unknown {
	if (tool === 'MultiEdit') {
		const edits = input.edits;
		const first = Array.isArray(edits) ? edits[0] : undefined;
		return typeof first === 'object' && first !== null ? (first as Record<string, unknown>).old_string : undefined;
	}
	return input.old_string;
}

/**
 * hook を印の操作にする。Claude Code の hook だけを見る（Codex のパッチは書く前の印を出さない）。ペインの持ち主と
 * 確かめられなかった hook も使わない（台帳と同じ。paradisAgentDocsService.ts）。
 */
export function paradisDocEditingActionOf(hook: IParadisDocEditingHook, agentKind: string | undefined): ParadisDocEditingAction | undefined {
	if (PANE_END_EVENTS.has(hook.event)) {
		return { type: 'endPane' };
	}
	if (hook.ownerUnverified || agentKind !== 'claude') {
		return undefined;
	}
	const isEdit = hook.toolName !== undefined && EDIT_TOOLS.has(hook.toolName);
	const isWrite = hook.toolName !== undefined && WRITE_TOOLS.has(hook.toolName);
	const input = toolInputOf(hook);
	const target = input !== undefined ? paradisReadDocCommentTarget(hook.remoteHostId ?? '', input.file_path) : undefined;
	const toolUseId = typeof hook.toolUseId === 'string' && hook.toolUseId.length > 0 ? hook.toolUseId : undefined;
	if (TOOL_END_EVENTS.has(hook.event)) {
		// 拒否の hook はツールの名前を載せないことがあるので、名前が無ければ ID とパスで探す
		if ((hook.toolName !== undefined && !isEdit && !isWrite) || (toolUseId === undefined && target === undefined)) {
			return undefined;
		}
		return { type: 'end', ...(target !== undefined ? { hostId: target.hostId, path: target.path } : {}), ...(toolUseId !== undefined ? { toolUseId } : {}) };
	}
	if (hook.event !== 'PreToolUse' || (!isEdit && !isWrite) || target === undefined || input === undefined) {
		return undefined;
	}
	const source = isEdit ? paradisDocEditingHead(oldStringOf(hook.toolName ?? '', input)) : undefined;
	return {
		type: 'start', hostId: target.hostId, path: target.path, tool: isEdit ? 'edit' : 'write',
		...(source !== undefined ? { source } : {}),
		...(toolUseId !== undefined ? { toolUseId } : {}),
	};
}

/** チャネルから届いた印を確かめる。形の違うものは undefined。 */
export function paradisReadDocEditingMark(value: unknown): IParadisDocEditingMark | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const mark = value as Record<string, unknown>;
	if (typeof mark.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(mark.id) || (mark.tool !== 'edit' && mark.tool !== 'write') || typeof mark.at !== 'number' || !Number.isFinite(mark.at)) {
		return undefined;
	}
	const source = typeof mark.source === 'string' && mark.source.length <= PARADIS_DOC_EDITING_SOURCE_MAX && mark.source.trim().length > 0 ? mark.source : undefined;
	return { id: mark.id, tool: mark.tool, ...(source !== undefined ? { source } : {}), at: mark.at };
}
