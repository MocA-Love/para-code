/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisHostPath } from '../../../common/paradisHostPath.js';

export const PARADIS_SESSION_RESUME_CHANNEL = 'paradisSessionResume';

export type ParadisResumeAgent = 'claude' | 'codex';

/**
 * transcript を探す対象の空間。
 *
 * 既定の `TPath` は {@link ParadisHostPath}。**送る側（renderer）は何も書き足さなくてよく**、
 * `cwd` を `paradisResolveHostPath` 経由で作らない限り型エラーになる。
 * 電文を受け取る側（node）だけが `IParadisResumeSpace<string>` と明示して素の文字列を扱う。
 */
export interface IParadisResumeSpace<TPath extends string = ParadisHostPath> {
	readonly stateKey: string;
	readonly name: string;
	readonly cwd: TPath;
	readonly current: boolean;
}

export interface IParadisResumeListRequest<TPath extends string = ParadisHostPath> {
	readonly spaces: readonly IParadisResumeSpace<TPath>[];
	readonly includeArchived?: boolean;
}

export interface IParadisResumeSession {
	/** shared process 内の検証済み transcript を指す、不透明な一時キー。 */
	readonly catalogId: string;
	readonly id: string;
	readonly agent: ParadisResumeAgent;
	readonly title: string;
	readonly preview: string;
	readonly cwd: string;
	readonly spaceStateKey: string;
	readonly spaceName: string;
	readonly currentSpace: boolean;
	readonly createdAt?: number;
	readonly updatedAt: number;
	readonly archived: boolean;
	readonly gitBranch?: string;
}

export interface IParadisResumeMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly timestamp?: number;
	readonly rawSearchMatch?: boolean;
}

export interface IParadisResumePreview {
	readonly messages: readonly IParadisResumeMessage[];
	readonly truncated: boolean;
}

export interface IParadisResumeSearchResult {
	readonly catalogId: string;
	readonly matchCount: number;
	readonly snippet: string;
	readonly source: 'metadata' | 'conversation';
}

export interface IParadisSessionResumeService {
	list(request: IParadisResumeListRequest): Promise<readonly IParadisResumeSession[]>;
	preview(catalogId: string, query?: string): Promise<IParadisResumePreview>;
	search(query: string, catalogIds: readonly string[]): Promise<readonly IParadisResumeSearchResult[]>;
}

/** 先頭の `-` を拒否し、CLIオプションとして解釈されない単一引数だけを許す。 */
export const PARADIS_RESUME_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/;
