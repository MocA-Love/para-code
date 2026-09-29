/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の全文索引（SQLite FTS5）。worker の中だけで使う（同期 API なので shared process 本体では開かない）。
//
// - 1メッセージを1行として FTS5 の表へ入れる。トークナイザは trigram にして、日本語のように
//   単語の区切りが無い文でも部分一致で探せるようにする。3文字未満の語は索引では探さない
//   （trigram に掛からず表全体をなめることになるので、呼び出し側が従来の検索に回す）
// - 会話ログは追記で伸びるので、ファイルごとに「どこまで読んだか」と先頭の指紋を覚えて続きだけを足す。
//   ファイルが差し替えられた・縮んだ・先頭が書き変わったときは、そのファイルの分を消して読み直す
// - 渡された一覧に無いファイル（消された会話、保存日数を過ぎた会話）の分は消す
// - 索引は会話のコピーなので、消した本文がファイルに残らないようにする: `secure_delete` を有効にし、
//   消したあとは FTS5 のセグメントをまとめ直して WAL を切り詰める。中身を全部入れ替えるときは
//   DB ファイル一式を消して作り直す。ファイルの権限は所有者だけ（0600）にする

import { createHash } from 'crypto';
import { chmodSync, constants as fsConstants, promises as fs, rmSync } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ParadisResumeAgent } from '../../sessionResume/common/paradisSessionResume.js';
import { IParadisSessionIndexSearchMatch, IParadisSessionIndexSearchResult, PARADIS_SESSION_INDEX_MIN_TERM_LENGTH } from '../common/paradisSessionIndex.js';
import {
	paradisParseCodexSessionMetaItem,
	paradisStripUserShellOutput,
	paradisTranscriptMessageFromItem,
	paradisTranscriptRecord,
	paradisTranscriptToolOutputFromItem,
} from '../../sessionResume/common/paradisSessionTranscript.js';
import { paradisReadTranscriptLines } from './paradisTranscriptLineReader.js';

const nodeRequire = createRequire(import.meta.url);

const SCHEMA_VERSION = '3';
/** 1メッセージとして索引へ入れる本文の上限。これを超える分は捨てる（巨大な貼り付けで索引が膨らまないように）。 */
const MAX_INDEXED_MESSAGE_CHARS = 32 * 1024;
const INSERT_BATCH = 500;
const MAX_SEARCH_RESULTS = 2000;
/** 差し替え検知のために指紋を取る、ファイル先頭のバイト数。 */
const HEAD_FINGERPRINT_BYTES = 4096;

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
	/** 途中で打ち切った（索引の削除などで）なら true。 */
	readonly aborted: boolean;
}

export type IParadisIndexSearchResult = IParadisSessionIndexSearchResult;

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
	readonly head_len: number;
	readonly head_hash: string;
}

/** 検索語を空白で分ける。重複は除く。 */
export function paradisIndexSearchTerms(query: string): string[] {
	return [...new Set(query.trim().toLocaleLowerCase().slice(0, 200).split(/\s+/).filter(Boolean))];
}

function ftsPhrase(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
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

/** ファイル先頭 `length` バイトの指紋。読めなければ undefined。 */
async function headFingerprint(path: string, length: number): Promise<string | undefined> {
	if (length <= 0) {
		return '';
	}
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return bytesRead === length ? createHash('sha256').update(buffer).digest('hex') : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

/** DB と、SQLite がその隣に作るファイル。 */
function databaseFiles(dbPath: string): string[] {
	return ['', '-wal', '-shm', '-journal'].map(suffix => `${dbPath}${suffix}`);
}

/** 索引のファイル一式を消す（開いている接続は先に閉じること）。 */
export function paradisRemoveIndexFiles(dbPath: string): void {
	for (const file of databaseFiles(dbPath)) {
		rmSync(file, { force: true });
	}
}

interface IStatements {
	readonly selectFiles: StatementSync;
	readonly insertFile: StatementSync;
	readonly updateFile: StatementSync;
	readonly deleteFile: StatementSync;
	readonly insertMessage: StatementSync;
	readonly insertMessageFile: StatementSync;
	readonly deleteMessages: StatementSync;
	readonly deleteMessageFiles: StatementSync;
	readonly setComplete: StatementSync;
	readonly setOffset: StatementSync;
}

export class ParadisSessionIndexStore {

	private db!: DatabaseSync;
	private statements!: IStatements;
	/** 検索用の読み取り専用の接続。書き込み（更新）の途中でも待たずに読めるよう分けている（WAL）。 */
	private reader: DatabaseSync | undefined;

	constructor(private readonly dbPath: string) {
		try {
			this.open();
		} catch {
			// 壊れた DB（途中で落ちた、別の版が書いた等）は開けない。索引は会話ログから作り直せるので、
			// 消して作り直す。
			this.closeConnections();
			paradisRemoveIndexFiles(this.dbPath);
			this.open();
		}
	}

	private open(): void {
		const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		this.db = new DatabaseSyncCtor(this.dbPath);
		this.restrictPermissions();
		// 消した行の中身を 0 で上書きさせる（空きページに本文が残らないように）。
		this.db.exec('PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
		this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
		const schema = (this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string } | undefined)?.value;
		if (schema !== undefined && schema !== SCHEMA_VERSION) {
			throw new Error('Outdated index schema.');
		}
		this.db.exec(`
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
				skipped INTEGER NOT NULL DEFAULT 0,
				head_len INTEGER NOT NULL DEFAULT 0,
				head_hash TEXT NOT NULL DEFAULT '',
				complete INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS message_files(rowid INTEGER PRIMARY KEY, file_id INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS message_files_file ON message_files(file_id);
			CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(body, tokenize = 'trigram');
		`);
		// 行を消したとき、FTS5 の索引（語のセグメント）からもその場で語を消させる。これが無いと、消した語は
		// セグメントがまとめ直されるまで残る。索引全体を書き直す optimize を消すたびに走らせずに済む。
		this.db.exec(`INSERT INTO messages(messages, rank) VALUES('secure-delete', 1)`);
		this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)`).run(SCHEMA_VERSION);
		this.statements = {
			selectFiles: this.db.prepare('SELECT id, path, dev, ino, size, mtime, offset, skipped, head_len, head_hash FROM files'),
			insertFile: this.db.prepare('INSERT INTO files(path, agent, catalog_id, dev, ino, size, mtime, offset, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'),
			updateFile: this.db.prepare('UPDATE files SET dev = ?, ino = ?, size = ?, mtime = ?, offset = ?, skipped = ?, catalog_id = ?, head_len = ?, head_hash = ? WHERE id = ?'),
			deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
			insertMessage: this.db.prepare('INSERT INTO messages(rowid, body) VALUES (?, ?)'),
			insertMessageFile: this.db.prepare('INSERT INTO message_files(file_id) VALUES (?)'),
			deleteMessages: this.db.prepare('DELETE FROM messages WHERE rowid IN (SELECT rowid FROM message_files WHERE file_id = ?)'),
			deleteMessageFiles: this.db.prepare('DELETE FROM message_files WHERE file_id = ?'),
			setComplete: this.db.prepare('UPDATE files SET complete = ? WHERE id = ?'),
			setOffset: this.db.prepare('UPDATE files SET offset = ? WHERE id = ?'),
		};
	}

	/** 索引のファイルを所有者だけが読み書きできるようにする（Windows では何もしない）。 */
	private restrictPermissions(): void {
		if (process.platform === 'win32') {
			return;
		}
		for (const file of databaseFiles(this.dbPath)) {
			try {
				chmodSync(file, 0o600);
			} catch { /* まだ無いファイル */ }
		}
	}

	private closeConnections(): void {
		try { this.reader?.close(); } catch { /* 既に閉じている */ }
		this.reader = undefined;
		try { this.db?.close(); } catch { /* 開けなかった・既に閉じている */ }
	}

	close(): void {
		this.closeConnections();
	}

	/** 中身を全部捨てる。行を消すのではなくファイル一式を消して作り直す（消した本文をファイルに残さない）。 */
	private recreate(): void {
		this.closeConnections();
		paradisRemoveIndexFiles(this.dbPath);
		this.open();
	}

	/**
	 * 行を消したあと、WAL を本体へ書き戻して切り詰める（WAL に残った消す前のページを消す）。本体側の本文は
	 * `secure_delete` が、語のセグメントは FTS5 の secure-delete が、消したその場で消している。
	 * 書く量は WAL の大きさだけで、索引の大きさには比例しない。
	 */
	private compact(): void {
		this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		this.restrictPermissions();
	}

	stats(): IParadisIndexStats {
		const files = (this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
		const messages = (this.db.prepare('SELECT count(*) AS n FROM message_files').get() as { n: number }).n;
		return { files, messages };
	}

	/** 今の索引が「ツールの出力を入れた」ものか。 */
	private indexedToolOutput(): string | undefined {
		return (this.db.prepare(`SELECT value FROM meta WHERE key = 'toolOutput'`).get() as { value?: string } | undefined)?.value;
	}

	private setIndexedToolOutput(includeToolOutput: boolean): void {
		this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('toolOutput', ?)`).run(includeToolOutput ? '1' : '0');
	}

	/**
	 * 会話ログを読まずに、設定の変更を今ある索引へ反映する。ツールの出力を入れない設定に変わったら
	 * 作り直し、最後の更新が `retentionThresholdMs` より前の会話の分を消す。
	 */
	prune(retentionThresholdMs: number, includeToolOutput: boolean): number {
		if (!includeToolOutput && this.indexedToolOutput() === '1') {
			this.recreate();
			this.setIndexedToolOutput(false);
			return 0;
		}
		const expired = this.db.prepare('SELECT id FROM files WHERE mtime < ?').all(retentionThresholdMs) as { id: number }[];
		for (const row of expired) {
			this.removeFile(row.id);
		}
		if (expired.length > 0) {
			this.compact();
		}
		return expired.length;
	}

	/**
	 * 渡された一覧に合わせて索引を更新する。一覧に無いファイルの分は消し、伸びたファイルは続きだけ足す。
	 * `shouldContinue` が false を返したら、行の切れ目で打ち切る（次回の更新で続きから読む）。
	 */
	async update(files: readonly IParadisIndexFile[], options: IParadisIndexUpdateOptions, shouldContinue: () => boolean = () => true): Promise<IParadisIndexUpdateResult> {
		const previousToolOutput = this.indexedToolOutput();
		if (previousToolOutput !== undefined && previousToolOutput !== (options.includeToolOutput ? '1' : '0')) {
			// 何を索引するかが変わったので、全部読み直す。
			this.recreate();
		}
		this.setIndexedToolOutput(options.includeToolOutput);

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
		let replacedFiles = 0;
		let aborted = false;
		for (const file of files) {
			if (!shouldContinue()) {
				aborted = true;
				break;
			}
			const row = existing.get(file.path);
			if (row && row.dev === file.dev && row.ino === file.ino && row.size === file.size && row.mtime === file.mtimeMs) {
				continue;
			}
			try {
				const outcome = await this.indexFile(file, row, options.includeToolOutput, shouldContinue);
				updatedFiles++;
				if (outcome === 'replaced') {
					replacedFiles++;
				}
			} catch {
				failedFiles++;
			}
		}
		if (removedFiles > 0 || replacedFiles > 0) {
			this.compact();
		}
		this.restrictPermissions();
		return { files: files.length, updatedFiles, removedFiles, failedFiles, aborted: aborted || !shouldContinue() };
	}

	private removeFile(fileId: number): void {
		this.transaction(() => {
			this.statements.deleteMessages.run(fileId);
			this.statements.deleteMessageFiles.run(fileId);
			this.statements.deleteFile.run(fileId);
		});
	}

	private clearFileMessages(fileId: number): void {
		this.transaction(() => {
			this.statements.deleteMessages.run(fileId);
			this.statements.deleteMessageFiles.run(fileId);
		});
	}

	private async indexFile(file: IParadisIndexFile, row: IFileRow | undefined, includeToolOutput: boolean, shouldContinue: () => boolean): Promise<'appended' | 'replaced' | 'new'> {
		let fileId: number;
		let start = 0;
		let outcome: 'appended' | 'replaced' | 'new';
		// 同じ inode のまま切り詰めて書き直され、元の位置より伸びた場合は追記と区別できないので、
		// 先頭の指紋も照合する。
		const sameFile = row !== undefined && row.dev === file.dev && row.ino === file.ino && file.size >= row.offset
			&& (row.head_len === 0 || await headFingerprint(file.path, row.head_len) === row.head_hash);
		if (row && sameFile) {
			fileId = row.id;
			start = row.offset;
			outcome = 'appended';
			if (row.skipped === 1) {
				// サブエージェントの記録など、一覧に出ない会話。読んだ位置だけ進める。
				this.statements.updateFile.run(file.dev, file.ino, file.size, file.mtimeMs, file.size, 1, file.catalogId, row.head_len, row.head_hash, fileId);
				return outcome;
			}
		} else if (row) {
			// 差し替えられた、縮んだ、または先頭が書き変わった。そのファイルの分を消して最初から読む。
			fileId = row.id;
			this.clearFileMessages(fileId);
			this.statements.setComplete.run(0, fileId);
			// 消した分を「読んだ」ままにしない（最初の書き込みの前に止まっても、次は先頭から読む）。
			this.statements.setOffset.run(0, fileId);
			outcome = 'replaced';
		} else {
			fileId = Number(this.statements.insertFile.run(file.path, file.agent, file.catalogId, file.dev, file.ino, 0, 0).lastInsertRowid);
			outcome = 'new';
		}
		let batch: string[] = [];
		let skip = false;
		let first = start === 0;
		/** 読み終えた最後の行の直後のバイト位置。 */
		let lineEnd = start;
		const flush = () => {
			if (batch.length === 0) {
				return;
			}
			const bodies = batch;
			batch = [];
			// 入れた本文と「どこまで読んだか」を同じトランザクションで進める。途中で例外が出たり worker が
			// 落ちたりしても、次の更新はここから続きを読むので、入れ済みの本文を二重に入れない。
			const offset = lineEnd;
			this.transaction(() => {
				for (const body of bodies) {
					const rowid = Number(this.statements.insertMessageFile.run(fileId).lastInsertRowid);
					this.statements.insertMessage.run(rowid, body);
				}
				this.statements.setOffset.run(offset, fileId);
			});
		};
		const result = await paradisReadTranscriptLines(file.path, start, (line, endOffset) => {
			lineEnd = endOffset;
			let item: Record<string, unknown> | undefined;
			try {
				item = paradisTranscriptRecord(JSON.parse(line));
			} catch {
				return shouldContinue();
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
				// 利用者が打ったシェルコマンドの出力も、ツールの出力と同じ扱いにする。
				const body = includeToolOutput ? message.text : paradisStripUserShellOutput(message.text);
				if (body.trim()) {
					batch.push(body);
				}
			} else if (includeToolOutput) {
				const output = paradisTranscriptToolOutputFromItem(item, file.agent, MAX_INDEXED_MESSAGE_CHARS);
				if (output) {
					batch.push(output);
				}
			}
			if (batch.length >= INSERT_BATCH) {
				flush();
			}
			// 打ち切りは、この行を入れ終えてから（次回はこの行の次から読む）。
			return shouldContinue();
		});
		flush();
		if (result.dev !== file.dev || result.ino !== file.ino) {
			// 列挙から開くまでの間に差し替えられ、別のファイルを途中から読んでしまった。入れた分を消し、
			// 次の更新で「差し替え」として最初から読み直させる。
			this.clearFileMessages(fileId);
			this.statements.updateFile.run(-1, -1, -1, -1, 0, 0, file.catalogId, 0, '', fileId);
			this.statements.setComplete.run(0, fileId);
			return 'replaced';
		}
		const headLength = Math.min(HEAD_FINGERPRINT_BYTES, result.endOffset);
		// 指紋が無いまま続きから読んだ（前回が途中で終わった新しいファイルなど）ときも、ここで取る。
		const takeHead = start === 0 || !row || row.head_len === 0;
		const headHash = takeHead ? await headFingerprint(file.path, headLength) ?? '' : row.head_hash;
		const storedHeadLength = takeHead ? (headHash ? headLength : 0) : row.head_len;
		// 書きかけの最終行が残っているときは、覚えるサイズを実際に読んだ所までにして、次回の更新で続きを読ませる。
		const offset = skip ? file.size : result.endOffset;
		this.statements.updateFile.run(file.dev, file.ino, skip ? file.size : Math.min(file.size, result.endOffset), file.mtimeMs, offset, skip ? 1 : 0, file.catalogId, storedHeadLength, headHash, fileId);
		// 最後まで読めたときだけ「読み終えた」にする。読みかけ（初回の作成中・打ち切り後）の会話は検索で
		// 索引に入っていない扱いにし、呼び出し側が従来の方法で探す。
		if (shouldContinue()) {
			this.statements.setComplete.run(1, fileId);
		}
		return outcome;
	}

	/**
	 * 索引で探す。3文字以上の語だけを本文に当て、語ごとにどの会話に含まれるかを返す（語の AND は、
	 * タイトルなどのセッション情報と合わせて呼び出し側で取る）。`catalogIds` は探したい会話で、
	 * そのうち索引に入っていないものを `uncovered` で返す。
	 */
	search(query: string, catalogIds: readonly string[]): IParadisIndexSearchResult {
		const reader = this.readerConnection();
		const terms = paradisIndexSearchTerms(query);
		const coveredRows = reader.prepare('SELECT id, catalog_id FROM files WHERE skipped = 0 AND complete = 1').all() as { id: number; catalog_id: string }[];
		const covered = new Set(coveredRows.map(row => row.catalog_id));
		const catalogById = new Map(coveredRows.map(row => [row.id, row.catalog_id]));
		const uncovered = catalogIds.filter(catalogId => !covered.has(catalogId));
		const perFile = new Map<number, { terms: Set<number>; count: number }>();
		terms.forEach((term, index) => {
			if ([...term].length < PARADIS_SESSION_INDEX_MIN_TERM_LENGTH) {
				return;
			}
			const rows = reader.prepare('SELECT mf.file_id AS file_id, count(*) AS n FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages MATCH ? GROUP BY mf.file_id').all(ftsPhrase(term)) as { file_id: number; n: number }[];
			for (const row of rows) {
				const entry = perFile.get(row.file_id) ?? { terms: new Set<number>(), count: 0 };
				entry.terms.add(index);
				entry.count += row.n;
				perFile.set(row.file_id, entry);
			}
		});
		const wanted = new Set(catalogIds);
		const searchable = terms.filter(term => [...term].length >= PARADIS_SESSION_INDEX_MIN_TERM_LENGTH);
		const bodyStatement = reader.prepare('SELECT messages.body AS body FROM messages JOIN message_files mf ON mf.rowid = messages.rowid WHERE messages MATCH ? AND mf.file_id = ? LIMIT 1');
		const matches: IParadisSessionIndexSearchMatch[] = [];
		for (const [fileId, entry] of [...perFile].sort((a, b) => b[1].terms.size - a[1].terms.size || b[1].count - a[1].count)) {
			const catalogId = catalogById.get(fileId);
			if (!catalogId || (wanted.size > 0 && !wanted.has(catalogId))) {
				continue;
			}
			const snippetTerm = terms[[...entry.terms].sort((a, b) => terms[b].length - terms[a].length)[0]];
			const body = (bodyStatement.get(ftsPhrase(snippetTerm), fileId) as { body?: string } | undefined)?.body ?? '';
			matches.push({ catalogId, terms: [...entry.terms].sort((a, b) => a - b), matchCount: entry.count, snippet: snippetOf(body, searchable) });
			if (matches.length >= MAX_SEARCH_RESULTS) {
				break;
			}
		}
		return { terms, uncovered, matches };
	}

	private readerConnection(): DatabaseSync {
		if (!this.reader) {
			const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
			this.reader = new DatabaseSyncCtor(this.dbPath, { readOnly: true });
		}
		return this.reader;
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
