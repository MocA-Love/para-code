/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の記録（transcript）の行から、資料（html・md）への書き込みを拾う。hook が届かなかった書き込み（Para Code が
// 止まっていた間・hook の取りこぼし・REPL の中から呼んだ Write）も、記録には残るので、台帳の正本にする。
//
// 記録は「呼び出しの行」と「結果の行」に分かれている。呼び出しの行は実行の前（許可を聞く前）に書かれるので、
// 結果の行が成功で来たときにだけ書き込みとして返す。形は手元の記録で確かめたもの:
//  - Claude Code 2.1.329: `type: "assistant"` の `message.content[]` に `{ type: "tool_use", id, name, input }`、
//    `type: "user"` の `message.content[]` に `{ type: "tool_result", tool_use_id, is_error }`。REPL の中から呼んだ
//    ツールの行（`isVirtual: true`）も同じ形
//  - Codex 0.169.1: `response_item` の `payload` が `{ type: "custom_tool_call", name: "apply_patch", call_id, input }`、
//    結果は `{ type: "custom_tool_call_output", call_id, output }`（`Exit code: 0 … Success. Updated the following files:`）。
//    コードを書いて実行する形（`name: "exec"`）では、`input` のスクリプトの中の `tools.apply_patch("…")` がパッチ。
//    パッチのパスは作業ディレクトリ（`session_meta`・`turn_context` の `cwd`）からの相対パス
//  - Antigravity CLI 1.5.12: `PLANNER_RESPONSE` の `tool_calls[]` が `{ name: "write_file" | "edit_file", args: { Path } }`、
//    結果は続く `GENERIC` の行（呼び出しと同じ数・同じ順。id は無い）

import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { paradisDocKind, paradisDocPatchWrites, paradisNormalizeDocPath } from './paradisAgentDocs.js';

/** 記録から拾った書き込み 1 回。 */
export interface IParadisDocTranscriptWrite {
	/** 正規化した絶対パス（html・md）。 */
	readonly path: string;
	readonly tool: string;
	/** 呼び出しの ID（Claude Code の tool_use_id、Codex の call_id）。Antigravity CLI には無い。 */
	readonly toolUseId?: string;
	/** 結果の行の時刻（その記録を書いた機械の時計、epoch ms）。行に時刻が無ければ無い。 */
	readonly at?: number;
	/** その行の作業ディレクトリ。 */
	readonly cwd?: string;
}

/** 覚えておく結果待ちの呼び出しの上限（壊れた記録で伸び続けないように）。 */
const PENDING_LIMIT = 256;
/** Claude Code の書き込みのツールと、パスの欄。 */
const CLAUDE_WRITE_TOOLS: ReadonlyMap<string, string> = new Map([['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]);
/** Antigravity CLI の書き込みのツール（パスの欄は `Path`）。 */
const ANTIGRAVITY_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);
/** Codex の `exec` のスクリプトの中の `tools.apply_patch("…")`（文字列は JSON と同じエスケープ）。 */
const CODEX_EXEC_PATCH = /tools\.apply_patch\(\s*(?<literal>"(?:[^"\\]|\\.)*")/g;

interface IPendingCall {
	readonly tool: string;
	/** Claude Code・Antigravity CLI: 書いた資料のパス。 */
	readonly path?: string;
	/** Codex: パッチ本文。 */
	readonly patches?: readonly string[];
	/** Codex: `exec` のスクリプトの中のパッチか。 */
	readonly exec?: true;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function docPath(value: unknown): string | undefined {
	const path = paradisNormalizeDocPath(value);
	return path !== undefined && paradisDocKind(path) !== undefined ? path : undefined;
}

function timeOf(value: unknown): number | undefined {
	const at = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(at) ? at : undefined;
}

/** Codex のツールの結果（文字列、または `{ text }` の配列）を 1 つの文にする。 */
function codexOutputText(output: unknown): string {
	if (typeof output === 'string') {
		return output;
	}
	return Array.isArray(output) ? output.map(part => text(record(part)?.text) ?? '').join('') : '';
}

/**
 * 1 つの記録を頭から順に読んで、書き込みを返す。行をまたぐ状態（結果待ちの呼び出し・Codex の作業ディレクトリ）を
 * 持つので、記録 1 つ（読み始め 1 回）につき 1 つ作り、読み直すときは作り直す。
 */
export class ParadisDocTranscriptWriteReader {

	private readonly _pending = new Map<string, IPendingCall>();
	/** Antigravity CLI: 結果待ちの呼び出し（古い順。資料への書き込みでないものは undefined）。 */
	private _queue: (IPendingCall | undefined)[] = [];
	private _cwd: string | undefined;

	constructor(private readonly _agent: ParadisAgentKind) { }

	read(entry: Readonly<Record<string, unknown>>): IParadisDocTranscriptWrite[] {
		switch (this._agent) {
			case 'claude': return this._readClaude(entry);
			case 'codex': return this._readCodex(entry);
			case 'antigravity': return this._readAntigravity(entry);
			default: return [];
		}
	}

	private _remember(id: string, call: IPendingCall): void {
		this._pending.delete(id);
		this._pending.set(id, call);
		if (this._pending.size > PENDING_LIMIT) {
			const oldest = this._pending.keys().next();
			if (oldest.done !== true) {
				this._pending.delete(oldest.value);
			}
		}
	}

	private _readClaude(entry: Readonly<Record<string, unknown>>): IParadisDocTranscriptWrite[] {
		const type = entry.type;
		const content = type === 'assistant' || type === 'user' ? record(entry.message)?.content : undefined;
		if (!Array.isArray(content)) {
			return [];
		}
		const writes: IParadisDocTranscriptWrite[] = [];
		for (const rawBlock of content) {
			const block = record(rawBlock);
			if (type === 'assistant' && block?.type === 'tool_use') {
				const tool = text(block.name);
				const field = tool !== undefined ? CLAUDE_WRITE_TOOLS.get(tool) : undefined;
				const id = text(block.id);
				const path = field !== undefined ? docPath(record(block.input)?.[field]) : undefined;
				if (tool !== undefined && id !== undefined && path !== undefined) {
					this._remember(id, { tool, path });
				}
			} else if (type === 'user' && block?.type === 'tool_result') {
				const id = text(block.tool_use_id);
				const call = id !== undefined ? this._pending.get(id) : undefined;
				if (id === undefined || call?.path === undefined) {
					continue;
				}
				this._pending.delete(id);
				if (block.is_error !== true) {
					const at = timeOf(entry.timestamp);
					const cwd = text(entry.cwd);
					writes.push({ path: call.path, tool: call.tool, toolUseId: id, ...(at !== undefined ? { at } : {}), ...(cwd !== undefined ? { cwd } : {}) });
				}
			}
		}
		return writes;
	}

	private _readCodex(entry: Readonly<Record<string, unknown>>): IParadisDocTranscriptWrite[] {
		const payload = record(entry.payload);
		if (payload === undefined) {
			return [];
		}
		if (entry.type === 'session_meta' || entry.type === 'turn_context') {
			this._cwd = text(payload.cwd) ?? this._cwd;
			return [];
		}
		if (entry.type !== 'response_item') {
			return [];
		}
		const id = text(payload.call_id);
		if (id === undefined) {
			return [];
		}
		if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
			const name = text(payload.name);
			const input = text(payload.input) ?? text(payload.arguments) ?? '';
			if (name === 'apply_patch') {
				this._remember(id, { tool: 'apply_patch', patches: [input] });
			} else if (name === 'exec' && input.includes('tools.apply_patch(')) {
				const patches: string[] = [];
				for (const match of input.matchAll(CODEX_EXEC_PATCH)) {
					try {
						const patch: unknown = JSON.parse(match.groups?.literal ?? '');
						if (typeof patch === 'string') {
							patches.push(patch);
						}
					} catch {
						// JSON の文字列として読めない書き方（テンプレートなど）は拾わない
					}
				}
				if (patches.length > 0) {
					this._remember(id, { tool: 'apply_patch', patches, exec: true });
				}
			}
			return [];
		}
		if (payload.type !== 'custom_tool_call_output' && payload.type !== 'function_call_output') {
			return [];
		}
		const call = this._pending.get(id);
		if (call?.patches === undefined) {
			return [];
		}
		this._pending.delete(id);
		const output = codexOutputText(payload.output);
		// `exec` の結果は、終わりまで走れば「Script completed」で始まる（失敗は「Script failed」、中断は「aborted by user」、
		// 裏へ回ると「Script running with cell ID」）。終わりまで走ったときだけ拾う
		if (call.exec === true && !output.startsWith('Script completed')) {
			return [];
		}
		const at = timeOf(entry.timestamp);
		const paths = new Set(call.patches.flatMap(patch => {
			// パッチの形でない入力（function_call の `{"input": "…"}`）は、欄から取り出してもらう
			let input: unknown = patch;
			if (!patch.trimStart().startsWith('*** Begin Patch')) {
				try {
					input = JSON.parse(patch);
				} catch {
					input = patch;
				}
			}
			return paradisDocPatchWrites(input, output, this._cwd);
		}));
		return [...paths].map(path => ({ path, tool: call.tool, toolUseId: id, ...(at !== undefined ? { at } : {}), ...(this._cwd !== undefined ? { cwd: this._cwd } : {}) }));
	}

	private _readAntigravity(entry: Readonly<Record<string, unknown>>): IParadisDocTranscriptWrite[] {
		const type = entry.type;
		if (type === 'USER_INPUT' || type === 'USER_EXPLICIT') {
			// 新しいターン。前のターンで結果の来なかった呼び出しは持ち越さない
			this._queue = [];
			return [];
		}
		if (type === 'PLANNER_RESPONSE') {
			const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
			this._queue = calls.slice(-PENDING_LIMIT).map(rawCall => {
				const call = record(rawCall);
				const tool = text(call?.name);
				const path = tool !== undefined && ANTIGRAVITY_WRITE_TOOLS.has(tool) ? docPath(record(call?.args)?.Path) : undefined;
				return tool !== undefined && path !== undefined ? { tool, path } : undefined;
			});
			return [];
		}
		if (type !== 'GENERIC') {
			return [];
		}
		const call = this._queue.shift();
		const error = text(entry.error);
		if (call?.path === undefined || entry.status === 'ERROR' || (error !== undefined && error.length > 0)) {
			return [];
		}
		const at = timeOf(entry.created_at);
		return [{ path: call.path, tool: call.tool, ...(at !== undefined ? { at } : {}) }];
	}
}
