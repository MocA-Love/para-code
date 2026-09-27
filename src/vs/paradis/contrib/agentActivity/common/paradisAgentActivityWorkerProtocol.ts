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
	| { readonly op: 'indexSearch'; readonly dbPath: string; readonly query: string }
	| { readonly op: 'indexStats'; readonly dbPath: string }
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
