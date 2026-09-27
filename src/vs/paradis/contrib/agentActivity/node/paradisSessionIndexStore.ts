/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引（SQLite FTS5）。worker の中だけで使う（同期 API なので shared process 本体では開かない）。
//
// - 1メッセージを1行として FTS5 の表へ入れる。トークナイザは trigram にして、日本語のように
//   単語の区切りが無い文でも部分一致で探せるようにする（3文字未満の語は LIKE で全件をなめる）
// - 会話ログは追記で伸びるので、ファイルごとに「どこまで読んだか」を覚えて続きだけを足す。
//   ファイルが差し替えられた・縮んだときは、そのファイルの分を消して読み直す
// - 渡された一覧に無いファイル（消された会話、保存日数を過ぎた会話）の分は消す

import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';
import {
	paradisTranscriptMessageFromItem,
	paradisTranscriptRecord,
	paradisTranscriptToolOutputFromItem,
	paradisParseCodexSessionMetaItem,
} from '../../sessionResume/common/paradisSessionTranscript.js';
import { paradisReadTranscriptLines } from './paradisTranscriptLineReader.js';

const nodeRequire = createRequire(import.meta.url);

const SCHEMA_VERSION = '1';
/** 1メッセージとして索引へ入れる本文の上限。これを超える分は捨てる（巨大な貼り付けで索引が膨らまないように）。 */
const MAX_INDEXED_MESSAGE_CHARS = 32 * 1024;
const INSERT_BATCH = 500;
const MAX_SEARCH_RESULTS = 600;

export interface IParadisIndexFile {
	readonly path: string;
	readonly agent: ParadisResumeAgent;
	readonly catalogId: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface IParadisIndexUpdateOptions {
	readonly includeToolOutput: boolean;
}

export interface IParadisIndexUpdateResult {
	readonly files: number;
	readonly updatedFiles: number;
	readonly removedFiles: number;
	readonly failedFiles: number;
}

export interface IParadisIndexSearchMatch {
	readonly catalogId: string;
	readonly matchCount: number;
	readonly snippet: string;
}

export interface IParadisIndexSearchResult {
	/** 索引に入っている会話（ここに無い会話は、呼び出し側が従来の方法で探す）。 */
	readonly covered: readonly string[];
	readonly matches: readonly IParadisIndexSearchMatch[];
}

export interface IParadisIndexStats {
	readonly files: number;
	readonly messages: number;
}

interface IFileRow {
	readonly id: number;
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtime: number;
	readonly offset: number;
	readonly skipped: number;
}

/** 検索語を空白で分ける。重複は除く。 */
export function paradisIndexSearchTerms(query: string): string[] {
	return [...new Set(query.trim().toLocaleLowerCase().slice(0, 200).split(/\s+/).filter(Boolean))];
}

function ftsPhrase(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function snippetOf(body: string, terms: readonly string[]): string {
	const normalized = body.replace(/\s+/g, ' ').trim();
	const lower = normalized.toLocaleLowerCase();
	let first = Number.POSITIVE_INFINITY;
	for (const term of terms) {
		const index = lower.indexOf(term);
		if (index !== -1) {
			first = Math.min(first, index);
		}
	}
	if (!Number.isFinite(first)) {
		return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
	}
	const start = Math.max(0, first - 70);
	const end = Math.min(normalized.length, first + 170);
	return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

export class ParadisSessionIndexStore {

	private readonly db: DatabaseSync;
	private readonly statements: {
		readonly selectFiles: StatementSync;
		readonly insertFile: StatementSync;
		readonly updateFile: StatementSync;
		readonly deleteFile: StatementSync;
		readonly insertMessage: StatementSync;
		readonly insertMessageFile: StatementSync;
		readonly deleteMessages: StatementSync;
		readonly deleteMessageFiles: StatementSync;
	};

	constructor(dbPath: string) {
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		this.db = new DatabaseSyncCtor(dbPath);
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS files(
				id INTEGER PRIMARY KEY,
				path TEXT NOT NULL UNIQUE,
				agent TEXT NOT NULL,
				catalog_id TEXT NOT NULL,
				dev INTEGER NOT NULL,
				ino INTEGER NOT NULL,
				size INTEGER NOT NULL,
				mtime REAL NOT NULL,
				offset INTEGER NOT NULL,
				skipped INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS message_files(rowid INTEGER PRIMARY KEY, file_id INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS message_files_file ON message_files(file_id);
			CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(body, tokenize = 'trigram');
		`);
		const version = (this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string } | undefined)?.value;
		if (version !== undefined && version !== SCHEMA_VERSION) {
			this.clearAll();
		}
		this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)`).run(SCHEMA_VERSION);
		this.statements = {
			selectFiles: this.db.prepare('SELECT id, path, dev, ino, size, mtime, offset, skipped FROM files'),
			insertFile: this.db.prepare('INSERT INTO files(path, agent, catalog_id, dev, ino, size, mtime, offset, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'),
			updateFile: this.db.prepare('UPDATE files SET dev = ?, ino = ?, size = ?, mtime = ?, offset = ?, skipped = ?, catalog_id = ? WHERE id = ?'),
			deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
			insertMessage: this.db.prepare('INSERT INTO messages(rowid, body) VALUES (?, ?)'),
			insertMessageFile: this.db.prepare('INSERT INTO message_files(file_id) VALUES (?)'),
			deleteMessages: this.db.prepare('DELETE FROM messages WHERE rowid IN (SELECT rowid FROM message_files WHERE file_id = ?)'),
			deleteMessageFiles: this.db.prepare('DELETE FROM message_files WHERE file_id = ?'),
		};
	}

	close(): void {
		this.db.close();
	}

	stats(): IParadisIndexStats {
		const files = (this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
		const messages = (this.db.prepare('SELECT count(*) AS n FROM message_files').get() as { n: number }).n;
		return { files, messages };
	}

	/**
	 * 渡された一覧に合わせて索引を更新する。一覧に無いファイルの分は消し、伸びたファイルは続きだけ足す。
	 * `shouldContinue` が false を返したら、ファイルの切れ目で打ち切る（次回の更新で続きから読む）。
	 */
	async update(files: readonly IParadisIndexFile[], options: IParadisIndexUpdateOptions, shouldContinue: () => boolean = () => true): Promise<IParadisIndexUpdateResult> {
		const toolOutput = options.includeToolOutput ? '1' : '0';
		const previousToolOutput = (this.db.prepare(`SELECT value FROM meta WHERE key = 'toolOutput'`).get() as { value?: string } | undefined)?.value;
		if (previousToolOutput !== undefined && previousToolOutput !== toolOutput) {
			// 何を索引するかが変わったので、全部読み直す。
			this.clearAll();
		}
		this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('toolOutput', ?)`).run(toolOutput);

		const existing = new Map<string, IFileRow>();
		for (const row of this.statements.selectFiles.all() as unknown as IFileRow[]) {
			existing.set(row.path, row);
		}
		const wanted = new Set(files.map(file => file.path));
		let removedFiles = 0;
		for (const row of existing.values()) {
			if (!wanted.has(row.path)) {
				this.removeFile(row.id);
				removedFiles++;
			}
		}
		let updatedFiles = 0;
		let failedFiles = 0;
		for (const file of files) {
			if (!shouldContinue()) {
				break;
			}
			const row = existing.get(file.path);
			if (row && row.dev === file.dev && row.ino === file.ino && row.size === file.size && row.mtime === file.mtimeMs) {
				continue;
			}
			try {
				await this.indexFile(file, row, options.includeToolOutput);
				updatedFiles++;
			} catch {
				failedFiles++;
			}
		}
		return { files: files.length, updatedFiles, removedFiles, failedFiles };
	}

	private removeFile(fileId: number): void {
		this.transaction(() => {
			this.statements.deleteMessages.run(fileId);
			this.statements.deleteMessageFiles.run(fileId);
			this.statements.deleteFile.run(fileId);
		});
	}

	private async indexFile(file: IParadisIndexFile, row: IFileRow | undefined, includeToolOutput: boolean): Promise<void> {
		let fileId: number;
		let start = 0;
		let skipped = 0;
		if (row && row.dev === file.dev && row.ino === file.ino && file.size >= row.offset) {
			// 同じファイルが伸びただけ。続きから読む。
			fileId = row.id;
			start = row.offset;
			skipped = row.skipped;
		} else if (row) {
			// 差し替えられた、または縮んだ。そのファイルの分を消して最初から読む。
			fileId = row.id;
			this.transaction(() => {
				this.statements.deleteMessages.run(fileId);
				this.statements.deleteMessageFiles.run(fileId);
			});
		} else {
			fileId = Number(this.statements.insertFile.run(file.path, file.agent, file.catalogId, file.dev, file.ino, 0, 0).lastInsertRowid);
		}
		if (skipped === 1) {
			// サブエージェントの記録など、一覧に出ない会話。読んだ位置だけ進める。
			this.statements.updateFile.run(file.dev, file.ino, file.size, file.mtimeMs, file.size, 1, file.catalogId, fileId);
			return;
		}
		let batch: string[] = [];
		let skip = false;
		let first = start === 0;
		const flush = () => {
			if (batch.length === 0) {
				return;
			}
			const bodies = batch;
			batch = [];
			this.transaction(() => {
				for (const body of bodies) {
					const rowid = Number(this.statements.insertMessageFile.run(fileId).lastInsertRowid);
					this.statements.insertMessage.run(rowid, body);
				}
			});
		};
		const result = await paradisReadTranscriptLines(file.path, start, line => {
			let item: Record<string, unknown> | undefined;
			try {
				item = paradisTranscriptRecord(JSON.parse(line));
			} catch {
				return;
			}
			if (first && file.agent === 'codex') {
				first = false;
				if (paradisParseCodexSessionMetaItem(item)?.subagent) {
					skip = true;
					return false;
				}
			}
			first = false;
			const message = paradisTranscriptMessageFromItem(item, file.agent, MAX_INDEXED_MESSAGE_CHARS);
			if (message) {
				batch.push(message.text);
			} else if (includeToolOutput) {
				const output = paradisTranscriptToolOutputFromItem(item, file.agent, MAX_INDEXED_MESSAGE_CHARS);
				if (output) {
					batch.push(output);
				}
			}
			if (batch.length >= INSERT_BATCH) {
				flush();
			}
			return undefined;
		});
		flush();
		if (result.dev !== file.dev || result.ino !== file.ino) {
			// 読んでいる間に差し替えられた。次の更新で読み直させるため、位置を 0 に戻しておく。
			this.statements.updateFile.run(result.dev, result.ino, -1, -1, 0, 0, file.catalogId, fileId);
			return;
		}
		// 書きかけの最終行が残っているときは、覚えるサイズを実際に読んだ所までにして、次回の更新で続きを読ませる。
		const offset = skip ? file.size : result.endOffset;
		this.statements.updateFile.run(file.dev, file.ino, skip ? file.size : Math.min(file.size, result.endOffset), file.mtimeMs, offset, skip ? 1 : 0, file.catalogId, fileId);
	}

	search(query: string): IParadisIndexSearchResult {
		const covered = (this.db.prepare('SELECT catalog_id FROM files WHERE skipped = 0').all() as { catalog_id: string }[]).map(row => row.catalog_id);
		const terms = paradisIndexSearchTerms(query);
		if (terms.length === 0) {
			return { covered, matches: [] };
		}
		let candidates: Map<number, number> | undefined;
		for (const term of terms) {
			const rows = ([...term].length >= 3
				? this.db.prepare('SELECT mf.file_id AS file_id, count(*) AS n FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages MATCH ? GROUP BY mf.file_id').all(ftsPhrase(term))
				: this.db.prepare(`SELECT mf.file_id AS file_id, count(*) AS n FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages.body LIKE ? ESCAPE '\\' GROUP BY mf.file_id`).all(likePattern(term))
			) as { file_id: number; n: number }[];
			const next = new Map<number, number>();
			for (const row of rows) {
				if (candidates === undefined || candidates.has(row.file_id)) {
					next.set(row.file_id, (candidates?.get(row.file_id) ?? 0) + row.n);
				}
			}
			candidates = next;
			if (candidates.size === 0) {
				break;
			}
		}
		const matches: IParadisIndexSearchMatch[] = [];
		const firstTerm = [...terms].sort((a, b) => b.length - a.length)[0];
		const catalogStatement = this.db.prepare('SELECT catalog_id FROM files WHERE id = ? AND skipped = 0');
		const bodyStatement = [...firstTerm].length >= 3
			? this.db.prepare('SELECT messages.body AS body FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages MATCH ? AND mf.file_id = ? LIMIT 1')
			: this.db.prepare(`SELECT messages.body AS body FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages.body LIKE ? ESCAPE '\\' AND mf.file_id = ? LIMIT 1`);
		const firstPattern = [...firstTerm].length >= 3 ? ftsPhrase(firstTerm) : likePattern(firstTerm);
		for (const [fileId, count] of [...(candidates ?? new Map<number, number>())].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEARCH_RESULTS)) {
			const catalog = catalogStatement.get(fileId) as { catalog_id?: string } | undefined;
			if (!catalog?.catalog_id) {
				continue;
			}
			const body = (bodyStatement.get(firstPattern, fileId) as { body?: string } | undefined)?.body ?? '';
			matches.push({ catalogId: catalog.catalog_id, matchCount: count, snippet: snippetOf(body, terms) });
		}
		return { covered, matches };
	}

	private clearAll(): void {
		this.transaction(() => {
			this.db.exec('DELETE FROM messages; DELETE FROM message_files; DELETE FROM files;');
		});
	}

	private transaction(run: () => void): void {
		this.db.exec('BEGIN');
		try {
			run();
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
}
