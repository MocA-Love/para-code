/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Antigravity CLI（`agy`）の会話の記録の置き場所と、会話の一覧（`conversation_summaries.db`）の読み取り。
//
// - 会話の中身: `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`
//   （1 行 1 ステップ。解釈は agentChat/common/paradisAntigravityTranscript.ts）
// - 会話の一覧: `~/.gemini/antigravity-cli/conversation_summaries.db`（SQLite。表 conversation_summaries の
//   conversation_id・parent_conversation_id・nesting_depth ほか）。agy が書くので、読み取り専用で開き、何も書かない。
//   親子の判定（{@link paradisReadAntigravityConversationLineage}）は本文の列を読まない。セッション履歴の一覧
//   （{@link paradisListAntigravityConversations}）だけが、行の見出しに title・preview を読む（raw_summary は読まない）。
// - `conversations/<id>.db` は書き込み中の WAL を持つので開かない。

import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);

/** 会話の id の形（agy は UUID を使う）。これ以外の文字列で表を引かない。 */
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一度に引く会話の数の上限。 */
const LINEAGE_QUERY_LIMIT = 64;

/** agy の CLI のフォルダ（`~/.gemini/antigravity-cli`）。 */
export function paradisAntigravityCliHome(home: string = homedir()): string {
	return join(home, '.gemini', 'antigravity-cli');
}

/** 会話の記録の置き場（`~/.gemini/antigravity-cli/brain`）。この下の transcript だけを読んでよい。 */
export function paradisAntigravityBrainRoot(home: string = homedir()): string {
	return join(paradisAntigravityCliHome(home), 'brain');
}

/** 会話の一覧の SQLite（`~/.gemini/antigravity-cli/conversation_summaries.db`）。 */
export function paradisAntigravitySummariesDatabasePath(home: string = homedir()): string {
	return join(paradisAntigravityCliHome(home), 'conversation_summaries.db');
}

/** transcript のパスから会話の id を取り出す（`…/brain/<id>/.system_generated/logs/transcript_full.jsonl`）。 */
export function paradisAntigravityConversationIdFromTranscriptPath(transcriptPath: string): string | undefined {
	const id = /[\\/]brain[\\/](?<id>[^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript_full\.jsonl$/.exec(transcriptPath)?.groups?.id;
	return id !== undefined && CONVERSATION_ID_PATTERN.test(id) ? id : undefined;
}

/** 会話の親子の情報（一覧の 1 行のうち、親子の列だけ）。 */
export interface IParadisAntigravityConversationLineage {
	/** 子の会話（agy の invoke_subagent が起こしたもの）の親の会話の id。上位の会話では undefined。 */
	readonly parentId: string | undefined;
	/** 入れ子の深さ。上位の会話は 0。 */
	readonly nestingDepth: number;
}

/** 子の会話か（親を持つか、入れ子が 1 段以上）。 */
export function paradisIsAntigravityChildConversation(lineage: IParadisAntigravityConversationLineage): boolean {
	return lineage.parentId !== undefined || lineage.nestingDepth > 0;
}

function openSummariesDatabase(databasePath: string): DatabaseSync {
	if (!isAbsolute(databasePath)) {
		throw new Error('The Antigravity CLI conversation list must be an absolute path.');
	}
	const { DatabaseSync: Ctor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
	return new Ctor(databasePath, { readOnly: true });
}

/**
 * 会話の親子の情報を一覧から引く。一覧に行がまだ無い会話（作られた直後）は結果に入らない。
 * 一覧を開けない・表の形が違うときは throw する（呼び出し側は「分からない」として扱う）。
 */
export function paradisReadAntigravityConversationLineage(conversationIds: readonly string[], databasePath: string = paradisAntigravitySummariesDatabasePath()): Map<string, IParadisAntigravityConversationLineage> {
	const ids = [...new Set(conversationIds.filter(id => CONVERSATION_ID_PATTERN.test(id)))].slice(0, LINEAGE_QUERY_LIMIT);
	const result = new Map<string, IParadisAntigravityConversationLineage>();
	if (ids.length === 0) {
		return result;
	}
	const database = openSummariesDatabase(databasePath);
	try {
		const placeholders = ids.map(() => '?').join(', ');
		const rows = database.prepare(`SELECT conversation_id, parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id IN (${placeholders})`).all(...ids);
		for (const row of rows) {
			const id = row.conversation_id;
			if (typeof id !== 'string') {
				continue;
			}
			const parent = row.parent_conversation_id;
			const depth = row.nesting_depth;
			result.set(id, {
				parentId: typeof parent === 'string' && parent.length > 0 ? parent : undefined,
				nestingDepth: typeof depth === 'number' && Number.isFinite(depth) ? depth : typeof depth === 'bigint' ? Number(depth) : 0,
			});
		}
		return result;
	} finally {
		database.close();
	}
}

/** 先頭の行の頭から読む量。子の会話の指示の行（SYSTEM_MESSAGE）は、種類のキーが行の頭の近くにある。 */
const FIRST_LINE_PROBE_BYTES = 1024;

/**
 * transcript の先頭の行が、子の会話の始まり（親から渡された指示の SYSTEM_MESSAGE）か。一覧にまだ行が無い会話の予備の判定。
 * 上位の会話は利用者の発言（USER_INPUT）から始まる。読めない・まだ何も無いときは undefined。
 */
export async function paradisAntigravityTranscriptStartsAsChild(transcriptPath: string): Promise<boolean | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(transcriptPath, 'r');
		const buffer = Buffer.alloc(FIRST_LINE_PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const head = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
		const type = /"type"\s*:\s*"(?<type>[A-Z_]+)"/.exec(head)?.groups?.type;
		return type === undefined ? undefined : type === 'SYSTEM_MESSAGE';
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** セッション履歴の一覧に出す会話 1 件（一覧の SQLite の 1 行のうち、使う列だけ）。 */
export interface IParadisAntigravityConversationSummary {
	readonly id: string;
	/** agy が付けた題（まだ付いていなければ空）。 */
	readonly title: string;
	/** 最初の依頼の頭（agy が切り詰めたもの。無ければ空）。 */
	readonly preview: string;
	/** 最後に動いた時刻 (epoch ms)。読めなければ undefined。 */
	readonly updatedAt: number | undefined;
	/** 会話を始めたフォルダ（`workspace_uris` の `file://` を、このマシンのパスに直したもの）。 */
	readonly workspaces: readonly string[];
}

/** 一覧の時刻の列（`2026-11-11 16:44:35.408190414+00:00`）を epoch ms にする。 */
function summaryTime(value: unknown): number | undefined {
	if (typeof value !== 'string' || value.length === 0) {
		return undefined;
	}
	const parsed = Date.parse(value.replace(' ', 'T'));
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** `workspace_uris`（`file://` の URI の JSON の配列）を、このマシンのパスにする。`file` 以外と読めない値は捨てる。 */
function workspacePaths(value: unknown): string[] {
	if (typeof value !== 'string') {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap(item => {
		if (typeof item !== 'string' || !item.startsWith('file:')) {
			return [];
		}
		try {
			return [URI.parse(item).fsPath];
		} catch {
			return [];
		}
	});
}

/**
 * セッション履歴に出す会話の一覧（新しい順に `limit` 件まで）。子の会話（invoke_subagent が起こしたもの）は除く。
 * 一覧を開けない・表の形が違うときは throw する（呼び出し側は Antigravity CLI の分だけ出さない）。
 */
export function paradisListAntigravityConversations(databasePath: string, limit: number): readonly IParadisAntigravityConversationSummary[] {
	const database = openSummariesDatabase(databasePath);
	try {
		const rows = database.prepare('SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries WHERE parent_conversation_id = \'\' AND nesting_depth = 0 ORDER BY last_modified_time DESC LIMIT ?').all(Math.max(1, limit));
		return rows.flatMap(row => {
			const id = row.conversation_id;
			if (typeof id !== 'string' || !CONVERSATION_ID_PATTERN.test(id)) {
				return [];
			}
			return [{
				id,
				title: typeof row.title === 'string' ? row.title.trim() : '',
				preview: typeof row.preview === 'string' ? row.preview.trim() : '',
				updatedAt: summaryTime(row.last_modified_time),
				workspaces: workspacePaths(row.workspace_uris),
			}];
		});
	} finally {
		database.close();
	}
}

/** 会話の記録（`brain/<id>/.system_generated/logs/transcript_full.jsonl`）のパス。 */
export function paradisAntigravityTranscriptPath(brainRoot: string, conversationId: string): string {
	return join(brainRoot, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}
