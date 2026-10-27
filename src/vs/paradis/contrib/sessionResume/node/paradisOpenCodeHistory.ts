/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from '../../../../base/common/path.js';
import { paradisRedactToolInputSecrets } from '../../agentBrowser/common/paradisBrowserPageOps.js';
import { IParadisOpenCodeCliDatabase, paradisOpenCodeCliRegistry, paradisOpenCodeXdgDataRoot, paradisValidateOpenCodeDatabasePath } from '../../agentBrowser/node/paradisOpenCodeCliRegistry.js';
import { PARADIS_OPENCODE_COMMAND } from '../../../../platform/terminal/common/paradisOpenCodeCompatibleCli.js';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
/** The command that resumes an OpenCode session (`opencode`, or a compatible CLI's declared command). */
export type ParadisOpenCodeCli = string;
export interface IParadisOpenCodeMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly kind: 'message' | 'thinking' | 'tool';
	readonly text: string;
	readonly tool?: { readonly name: string; readonly input?: unknown; readonly output?: string; readonly status?: string };
	readonly ts?: number;
}
export interface IParadisOpenCodeSession {
	readonly id: string;
	readonly title: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly archived: boolean;
	readonly cli: ParadisOpenCodeCli;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function decode(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string') { return {}; }
	try { return record(JSON.parse(value)); } catch { return {}; }
}
function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}
function timestamp(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function openDatabase(dbPath: string): DatabaseSync {
	if (!isAbsolute(dbPath)) { throw new Error('OpenCode database path must be absolute.'); }
	const { DatabaseSync: Ctor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
	return new Ctor(dbPath, { readOnly: true });
}
function hasTable(database: DatabaseSync, name: string): boolean {
	return database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !== undefined;
}

/** An OpenCode database and the command that resumes the conversations in it. */
export interface IParadisOpenCodeDatabase {
	readonly path: string;
	readonly cli: ParadisOpenCodeCli;
	/** The display name a compatible CLI declared, if any. */
	readonly label?: string;
}

/**
 * Discover only OpenCode database files; never create or migrate a database.
 *
 * - The databases that bridge-capable OpenCode-compatible CLIs declared when they registered a session (remembered in
 *   the user's profile by `paradisOpenCodeCliRegistry`), resumed with the command they declared. They come first, so a
 *   conversation copied into one of them and into OpenCode's own database is resumed with the compatible CLI.
 * - Every file in OpenCode's own data folder (any release or channel build) and `OPENCODE_DB`, resumed with `opencode`.
 *
 * A remembered database must still be a regular file whose real path stays inside the home folder or the XDG data folder.
 */
export async function paradisOpenCodeDatabasePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), remembered: readonly IParadisOpenCodeCliDatabase[] = paradisOpenCodeCliRegistry.databases()): Promise<readonly IParadisOpenCodeDatabase[]> {
	const result: IParadisOpenCodeDatabase[] = [];
	const seen = new Set<string>();
	const add = (path: string, cli: ParadisOpenCodeCli, label?: string) => {
		if (!seen.has(path)) {
			seen.add(path);
			result.push({ path, cli, ...(label !== undefined ? { label } : {}) });
		}
	};
	const realHome = await fs.realpath(home).catch(() => home);
	const xdg = paradisOpenCodeXdgDataRoot(env);
	const realData = xdg !== undefined ? await fs.realpath(xdg).catch(() => xdg) : undefined;
	for (const database of remembered) {
		if (paradisValidateOpenCodeDatabasePath(database.path, env, home) === undefined) {
			continue;
		}
		const real = await fs.realpath(database.path).catch(() => undefined);
		const isFile = real !== undefined && await fs.stat(real).then(stat => stat.isFile(), () => false);
		if (isFile && [realHome, realData].some(root => root !== undefined && paradisValidateOpenCodeDatabasePath(real, { XDG_DATA_HOME: root }, realHome) !== undefined)) {
			// 確かめた実体のパスで開く（確かめた後で symlink を差し替えられても、確かめていない場所は読まない）
			add(real, database.cli, database.label);
		}
	}
	const roots = [...new Set([join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'), join(home, '.local', 'share', 'opencode')])];
	for (const root of roots) {
		const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.filter(entry => entry.isFile() && /^opencode(?:-[\w.-]+)?\.db$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
			add(join(root, entry.name), PARADIS_OPENCODE_COMMAND);
		}
	}
	const configured = env.OPENCODE_DB;
	if (configured && configured !== ':memory:') {
		add(isAbsolute(configured) ? configured : resolve(roots[0], configured), PARADIS_OPENCODE_COMMAND);
	}
	return result;
}

/** Open an OpenCode database read-only for `use`, and close it afterwards (one handle for a whole listing). */
export async function paradisWithOpenCodeDatabase<T>(dbPath: string, use: (database: DatabaseSync) => T): Promise<T> {
	const database = openDatabase(dbPath);
	try { return use(database); } finally { database.close(); }
}

/**
 * The working directories as OpenCode may have stored them. On Windows OpenCode keeps directories with `/` instead of `\`,
 * so both forms are matched.
 */
function directoryForms(directories: readonly string[]): readonly string[] {
	return [...new Set(directories.flatMap(directory => [directory, directory.replace(/\\/g, '/')]))];
}

/** Read top-level sessions in the requested working directories from either SQLite schema. */
export function listOpenCodeSessionsIn(database: DatabaseSync, directories: readonly string[], includeArchived = false, limit = 600, cli: ParadisOpenCodeCli = PARADIS_OPENCODE_COMMAND): readonly IParadisOpenCodeSession[] {
	if (directories.length === 0) { return []; }
	const table = hasTable(database, 'session_v2') ? 'session_v2' : hasTable(database, 'session') ? 'session' : undefined;
	if (table === undefined) { return []; }
	const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => text(row.name)));
	const archived = columns.has('time_archived') ? 'time_archived' : 'NULL';
	const forms = directoryForms(directories);
	const rows = database.prepare(`SELECT id, title, directory, time_created, time_updated, ${archived} AS archived FROM ${table} WHERE parent_id IS NULL AND directory IN (${forms.map(() => '?').join(',')}) ${includeArchived || !columns.has('time_archived') ? '' : 'AND time_archived IS NULL'} ORDER BY time_updated DESC LIMIT ?`).all(...forms, Math.max(1, Math.min(600, limit)));
	return rows.flatMap(row => {
		const id = text(row.id);
		if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) { return []; }
		return [{ id, title: text(row.title), cwd: text(row.directory), createdAt: timestamp(row.time_created) ?? 0, updatedAt: timestamp(row.time_updated) ?? 0, archived: row.archived !== null, cli } satisfies IParadisOpenCodeSession];
	});
}

/** {@link listOpenCodeSessionsIn} on a database file. */
export function listOpenCodeSessions(dbPath: string, directories: readonly string[], includeArchived = false, limit = 600, cli: ParadisOpenCodeCli = PARADIS_OPENCODE_COMMAND): Promise<readonly IParadisOpenCodeSession[]> {
	return directories.length === 0 ? Promise.resolve([]) : paradisWithOpenCodeDatabase(dbPath, database => listOpenCodeSessionsIn(database, directories, includeArchived, limit, cli));
}

function messageParts(id: string, role: 'user' | 'assistant', parts: readonly unknown[], ts?: number): IParadisOpenCodeMessage[] {
	return parts.flatMap((value, index): IParadisOpenCodeMessage[] => {
		const part = record(value);
		const type = text(part.type);
		if ((type === 'text' || type === 'reasoning') && typeof part.text === 'string' && part.text.length > 0) {
			return [{ id: `${id}:${type}:${text(part.id) || index}`, role, kind: type === 'reasoning' ? 'thinking' : 'message', text: part.text.slice(0, 256 * 1024), ts }];
		}
		if (type === 'tool') {
			const state = record(part.state);
			const content = Array.isArray(state.content) ? state.content.map(item => text(record(item).text)).filter(Boolean).join('\n') : text(state.output) || text(state.error);
			const name = text(part.name) || text(part.tool);
			return [{ id: `${id}:tool:${text(part.id) || text(part.callID) || index}`, role: 'assistant', kind: 'tool', text: name, tool: { name, input: paradisRedactToolInputSecrets(name, state.input), output: content.slice(0, 256 * 1024), status: text(state.status) }, ts }];
		}
		return [];
	});
}

/** Stable message/part IDs allow the mobile tailer to reconcile polling without duplicating text. */
export function readOpenCodeMessagesIn(database: DatabaseSync, sessionId: string, limit = 400, direction: 'asc' | 'desc' = 'desc'): readonly IParadisOpenCodeMessage[] {
	if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) { throw new Error('Invalid OpenCode session id.'); }
	const count = Math.max(1, Math.min(2000, limit));
	const order = direction === 'asc' ? 'ASC' : 'DESC';
	// 本家 1.19 の DB は `session_message` の表を持つが行は無く、会話は `message`/`part` にある。表の有無ではなく
	// そのセッションの行の有無で読む表を決める（両方の表を持つ DB で、セッションごとに置き場所が違うことがある）。
	const inSessionMessages = hasTable(database, 'session_message')
		&& database.prepare('SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1').get(sessionId) !== undefined;
	if (inSessionMessages) {
		const rows = database.prepare(`SELECT id, type, data, time_created FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq ${order} LIMIT ?`).all(sessionId, count);
		if (direction === 'desc') { rows.reverse(); }
		return rows.flatMap((row): IParadisOpenCodeMessage[] => {
			const data = decode(row.data);
			const ts = timestamp(row.time_created);
			if (row.type === 'user') { return text(data.text) ? [{ id: text(row.id), role: 'user', kind: 'message', text: text(data.text).slice(0, 256 * 1024), ts }] : []; }
			return row.type === 'assistant' && Array.isArray(data.content) ? messageParts(text(row.id), 'assistant', data.content, ts) : [];
		});
	}
	if (!hasTable(database, 'message') || !hasTable(database, 'part')) { return []; }
	const rows = database.prepare(`SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ${order}, id ${order} LIMIT ?`).all(sessionId, count);
	if (direction === 'desc') { rows.reverse(); }
	// 選んだ発言の部品をまとめて 1 回で引く（発言ごとに引かない）
	const parts = new Map<string, Record<string, unknown>[]>();
	for (const part of database.prepare(`SELECT id, message_id, data FROM part WHERE session_id = ? AND message_id IN (SELECT id FROM message WHERE session_id = ? ORDER BY time_created ${order}, id ${order} LIMIT ?) ORDER BY time_created, id`).all(sessionId, sessionId, count)) {
		const messageId = text(part.message_id);
		const list = parts.get(messageId) ?? [];
		list.push({ ...decode(part.data), id: text(part.id) });
		parts.set(messageId, list);
	}
	return rows.flatMap((row): IParadisOpenCodeMessage[] => {
		const role = decode(row.data).role;
		if (role !== 'user' && role !== 'assistant') { return []; }
		return messageParts(text(row.id), role, parts.get(text(row.id)) ?? [], timestamp(row.time_created));
	});
}

/** {@link readOpenCodeMessagesIn} on a database file. */
export async function readOpenCodeMessages(dbPath: string, sessionId: string, limit = 400, direction: 'asc' | 'desc' = 'desc'): Promise<readonly IParadisOpenCodeMessage[]> {
	if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) { throw new Error('Invalid OpenCode session id.'); }
	return paradisWithOpenCodeDatabase(dbPath, database => readOpenCodeMessagesIn(database, sessionId, limit, direction));
}
