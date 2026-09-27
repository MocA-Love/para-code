/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 本体と、会話ログを読む worker（別スレッド）の間でやりとりする電文。

import { ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';
import { IParadisActivityFileSummary } from './paradisAgentActivity.js';

export interface IParadisActivityParseFile {
	readonly path: string;
	readonly agent: ParadisResumeAgent;
	/** Claude Code のサブエージェント用ファイル（`subagents/` の下）なら true。 */
	readonly subagentFile: boolean;
}

export interface IParadisWorkerIndexFile {
	readonly path: string;
	readonly agent: ParadisResumeAgent;
	readonly catalogId: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

export type ParadisActivityWorkerRequest =
	| { readonly op: 'parse'; readonly files: readonly IParadisActivityParseFile[] }
	| { readonly op: 'indexUpdate'; readonly dbPath: string; readonly files: readonly IParadisWorkerIndexFile[]; readonly includeToolOutput: boolean }
	/** 会話ログを読まずに、保存日数とツール出力の設定を今ある索引へ反映する。 */
	| { readonly op: 'indexPrune'; readonly dbPath: string; readonly retentionThresholdMs: number; readonly includeToolOutput: boolean }
	/** 更新の列に並ばず、すぐに読む（検索用の別接続）。 */
	| { readonly op: 'indexSearch'; readonly dbPath: string; readonly query: string; readonly catalogIds: readonly string[] }
	| { readonly op: 'indexStats'; readonly dbPath: string }
	/** 実行中の更新を、行の切れ目で打ち切らせる（列に並ばずすぐ効く）。 */
	| { readonly op: 'indexAbort' }
	/** 接続を閉じて索引のファイル一式を消す（更新の列に並ぶので、書きかけのまま消すことはない）。 */
	| { readonly op: 'indexDelete'; readonly dbPath: string }
	| { readonly op: 'indexClose' };

export interface IParadisActivityWorkerEnvelope {
	readonly id: number;
	readonly request: ParadisActivityWorkerRequest;
}

export type ParadisActivityWorkerReply =
	| { readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly id: number; readonly ok: false; readonly error: string };

/** `parse` の返り値。読めなかったファイルは null。 */
export type ParadisActivityParseReply = readonly (IParadisActivityFileSummary | null)[];
