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

/**
 * 一覧行のプレビュー用に、transcript の末尾から採取した最新の会話メッセージ。
 * 読み取りに失敗した場合などは付かないため、受ける側は {@link IParadisResumeSession.preview} へフォールバックする。
 */
export interface IParadisResumeLatestMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export interface IParadisResumeSession {
	/** shared process 内の検証済み transcript を指す、不透明な一時キー。 */
	readonly catalogId: string;
	readonly id: string;
	readonly agent: ParadisResumeAgent;
	readonly title: string;
	readonly preview: string;
	readonly latestMessage?: IParadisResumeLatestMessage;
	readonly cwd: string;
	readonly spaceStateKey: string;
	readonly spaceName: string;
	readonly currentSpace: boolean;
	readonly createdAt?: number;
	readonly updatedAt: number;
	readonly archived: boolean;
	readonly gitBranch?: string;
	/** ユーザーの依頼が1つも無い会話（起動しただけで閉じたもの）。「空を隠す」で隠す。 */
	readonly empty?: boolean;
}

/** 「…」メニューのコピー・開く操作に使う詳細。 */
export interface IParadisResumeSessionDetails {
	/** 会話ログの絶対パス（その会話があるマシンの上のもの）。 */
	readonly transcriptPath: string;
	/** 最初の依頼の全文（読めなければ undefined）。 */
	readonly firstPrompt?: string;
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
	details(catalogId: string): Promise<IParadisResumeSessionDetails>;
	search(query: string, catalogIds: readonly string[]): Promise<readonly IParadisResumeSearchResult[]>;
}

/** 先頭の `-` を拒否し、CLIオプションとして解釈されない単一引数だけを許す。 */
export const PARADIS_RESUME_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/;

/**
 * 会話を続ける（`resume`）／CLI の fork で会話ごと複製して始める（`fork`）コマンド。
 * ID はホワイトリスト（先頭に `-` を許さない）を通ったものだけを使い、シェルの特殊文字を含まない。
 * 通らなければ undefined。
 */
export function paradisAgentResumeCommandLine(agent: ParadisResumeAgent, sessionId: string, mode: 'resume' | 'fork', options?: { readonly dangerouslyBypassPermissions?: boolean }): string | undefined {
	if (!PARADIS_RESUME_SESSION_ID_PATTERN.test(sessionId)) {
		return undefined;
	}
	const bypass = options?.dangerouslyBypassPermissions === true;
	if (agent === 'claude') {
		return `claude ${bypass ? '--dangerously-skip-permissions ' : ''}--resume ${sessionId}${mode === 'fork' ? ' --fork-session' : ''}`;
	}
	return `codex ${bypass ? '--dangerously-bypass-approvals-and-sandbox ' : ''}${mode === 'fork' ? 'fork' : 'resume'} ${sessionId}`;
}
