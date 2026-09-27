/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// セッション履歴の一覧上部のツールバー（並び順・グループ・空を隠す）の設定と、その並べ替え・分け方。

import { localize } from '../../../../nls.js';
import { IParadisResumeSearchResult, IParadisResumeSession } from './paradisSessionResume.js';

export type ParadisResumeSortOrder = 'updated' | 'created' | 'title';
export type ParadisResumeGrouping = 'space' | 'folder' | 'agent';

export interface IParadisResumeListOptions {
	readonly sort: ParadisResumeSortOrder;
	readonly group: ParadisResumeGrouping;
	readonly hideEmpty: boolean;
}

/** 表示設定の保存先（アプリ全体で1つ）。 */
export const PARADIS_RESUME_LIST_OPTIONS_STORAGE_KEY = 'paradis.sessionResume.listOptions';

export const PARADIS_RESUME_DEFAULT_LIST_OPTIONS: IParadisResumeListOptions = { sort: 'updated', group: 'space', hideEmpty: false };

/** 保存してあった値を読む。形が崩れていれば既定値に戻す。 */
export function paradisParseResumeListOptions(raw: string | undefined): IParadisResumeListOptions {
	let value: Partial<Record<keyof IParadisResumeListOptions, unknown>> | undefined;
	try {
		value = raw ? JSON.parse(raw) : undefined;
	} catch {
		value = undefined;
	}
	const sort = value?.sort === 'created' || value?.sort === 'title' ? value.sort : 'updated';
	const group = value?.group === 'folder' || value?.group === 'agent' ? value.group : 'space';
	return { sort, group, hideEmpty: value?.hideEmpty === true };
}

/** 並べ替える（元の配列は変えない）。 */
export function paradisSortResumeSessions(sessions: readonly IParadisResumeSession[], sort: ParadisResumeSortOrder): IParadisResumeSession[] {
	const sorted = [...sessions];
	if (sort === 'created') {
		sorted.sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt) || b.updatedAt - a.updatedAt);
	} else if (sort === 'title') {
		sorted.sort((a, b) => a.title.localeCompare(b.title) || b.updatedAt - a.updatedAt);
	} else {
		sorted.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	return sorted;
}

export interface IParadisResumeSessionGroup {
	readonly key: string;
	readonly title: string;
	/** 見出しにマウスを乗せたときに出す補足（フォルダのフルパスなど）。 */
	readonly tooltip?: string;
	readonly sessions: readonly IParadisResumeSession[];
}

function folderName(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, '');
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

/**
 * フォルダ別・エージェント別に分ける。グループの順は、並び順で先頭に来るセッションの順。
 * スペース別（現在のスペース + 他のスペース）は一覧側の既存の描き方をそのまま使うので、ここでは扱わない。
 */
export function paradisGroupResumeSessions(sessions: readonly IParadisResumeSession[], grouping: Exclude<ParadisResumeGrouping, 'space'>): IParadisResumeSessionGroup[] {
	const groups = new Map<string, { title: string; tooltip?: string; sessions: IParadisResumeSession[] }>();
	for (const session of sessions) {
		const key = grouping === 'folder' ? session.cwd : session.agent;
		let group = groups.get(key);
		if (!group) {
			group = grouping === 'folder'
				? { title: folderName(session.cwd), tooltip: session.cwd, sessions: [] }
				: { title: session.agent === 'claude' ? 'Claude Code' : 'Codex', sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	}
	return [...groups].map(([key, group]) => ({ key, ...group }));
}

/** ツールバーの選択肢の表示名。 */
export function paradisResumeSortLabel(sort: ParadisResumeSortOrder): string {
	switch (sort) {
		case 'created': return localize('paradis.sessionResume.sortCreated', "作成順");
		case 'title': return localize('paradis.sessionResume.sortTitle', "名前順");
		default: return localize('paradis.sessionResume.sortUpdated', "更新順");
	}
}

export function paradisResumeGroupLabel(group: ParadisResumeGrouping): string {
	switch (group) {
		case 'folder': return localize('paradis.sessionResume.groupFolder', "フォルダ");
		case 'agent': return localize('paradis.sessionResume.groupAgent', "エージェント");
		default: return localize('paradis.sessionResume.groupSpace', "スペース");
	}
}

/**
 * 「再開コマンドをコピー」で写すコマンド。作業フォルダへ移ってから再開する形にする。
 *
 * パスは貼り付け先のシェルで展開されない形で囲む。Windows は既定のターミナルの PowerShell 向けに
 * `Set-Location -LiteralPath '...'` とする（二重引用符だと `$(...)` が実行され、cmd の `cd "..."` では
 * `%VAR%` が展開されるため）。単一引用符の中は `''` だけが特別。
 */
export function paradisResumeCommandLine(session: Pick<IParadisResumeSession, 'agent' | 'id' | 'cwd'>, windows: boolean): string {
	const resume = session.agent === 'claude' ? `claude --resume ${session.id}` : `codex resume ${session.id}`;
	return windows
		? `Set-Location -LiteralPath '${session.cwd.replace(/'/g, `''`)}'; ${resume}`
		: `cd '${session.cwd.replace(/'/g, `'\\''`)}' && ${resume}`;
}

/** 全文索引が返した、1つの会話の本文での一致。 */
export interface IParadisIndexedBodyMatch {
	/** 本文に含まれていた検索語の位置。 */
	readonly terms: readonly number[];
	readonly matchCount: number;
	readonly snippet: string;
}

/**
 * 索引に入っている会話が検索語に一致するかを決める。従来の検索（セッション情報と本文をつないだ文字列に
 * すべての語が含まれるか）と同じ意味になるよう、語ごとに「セッション情報に含まれる」か「本文に含まれる」かを
 * 見て、すべての語がどちらかを満たせば一致とする。
 */
export function paradisCombineIndexedSearch(session: IParadisResumeSession, terms: readonly string[], body: IParadisIndexedBodyMatch | undefined): IParadisResumeSearchResult | undefined {
	if (terms.length === 0) {
		return undefined;
	}
	const metadata = `${session.title}\n${session.preview}\n${session.cwd}\n${session.id}\n${session.spaceName}`.toLocaleLowerCase();
	const inBody = new Set(body?.terms ?? []);
	let usedBody = false;
	for (let index = 0; index < terms.length; index++) {
		if (metadata.includes(terms[index])) {
			continue;
		}
		if (!inBody.has(index)) {
			return undefined;
		}
		usedBody = true;
	}
	return usedBody && body
		? { catalogId: session.catalogId, matchCount: body.matchCount, snippet: body.snippet, source: 'conversation' }
		: { catalogId: session.catalogId, matchCount: 0, snippet: '', source: 'metadata' };
}
