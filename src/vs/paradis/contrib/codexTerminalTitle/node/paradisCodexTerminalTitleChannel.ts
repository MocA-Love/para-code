/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
// eslint-disable-next-line local/code-import-patterns
import { createRequire } from 'module';
import { createInterface } from 'readline';
import { Event } from '../../../../base/common/event.js';
import { isAbsolute, relative, resolve } from '../../../../base/common/path.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexThreadPromptRequest,
	IParadisCodexThreadPromptResult,
	PARADIS_CODEX_TERMINAL_TITLE_CHANNEL,
} from '../common/paradisCodexTerminalTitle.js';

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_ROLLOUT_BYTES = 2 * 1024 * 1024;
const nodeRequire = createRequire(import.meta.url);

interface ICodexThreadRow {
	readonly source?: unknown;
	readonly cwd?: unknown;
	readonly rollout_path?: unknown;
	readonly first_user_message?: unknown;
	readonly title?: unknown;
	readonly preview?: unknown;
}

/** Accepts only canonical UUIDs emitted by Codex's `thread-title` terminal title item. */
export function isCanonicalCodexThreadId(value: string): boolean {
	return CANONICAL_UUID_PATTERN.test(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_PROMPT_LENGTH) : undefined;
}

function isPathInside(parent: string, candidate: string): boolean {
	const path = relative(parent, candidate);
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function extractUserText(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.type === 'event_msg') {
		const payload = record.payload as Record<string, unknown> | undefined;
		return payload?.type === 'user_message' ? nonEmptyString(payload.message) : undefined;
	}
	if (record.type !== 'response_item') {
		return undefined;
	}
	const payload = record.payload as Record<string, unknown> | undefined;
	if (payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
		return undefined;
	}
	const text = payload.content
		.map(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'input_text'
			? nonEmptyString((item as Record<string, unknown>).text)
			: undefined)
		.filter((item): item is string => item !== undefined)
		.join('\n')
		.trim();
	if (!text || text.startsWith('<environment_context>') || text.startsWith('# AGENTS.md instructions for ')) {
		return undefined;
	}
	return text.slice(0, MAX_PROMPT_LENGTH);
}

async function readFirstUserPrompt(codexHome: string, rolloutPath: string): Promise<string | undefined> {
	if (!isAbsolute(rolloutPath) || !rolloutPath.endsWith('.jsonl')) {
		return undefined;
	}
	const [realHome, realRollout] = await Promise.all([fs.realpath(codexHome), fs.realpath(rolloutPath)]);
	if (!isPathInside(realHome, realRollout)) {
		return undefined;
	}
	const input = createReadStream(realRollout, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let bytes = 0;
	try {
		for await (const line of lines) {
			bytes += Buffer.byteLength(line, 'utf8') + 1;
			if (bytes > MAX_ROLLOUT_BYTES) {
				break;
			}
			try {
				const prompt = extractUserText(JSON.parse(line));
				if (prompt) {
					return prompt;
				}
			} catch {
				// Ignore an incomplete/corrupt line and keep scanning within the bounded prefix.
			}
		}
		return undefined;
	} finally {
		lines.close();
		input.destroy();
	}
}

/** Reads Codex thread metadata without starting or mutating Codex. */
export class ParadisCodexTerminalTitleService {

	constructor(
		private readonly logService: ILogService,
		private readonly codexHome: string = paradisCodexHome(),
	) { }

	/** Returns a prompt only after UUID, source, invocation, cwd, and schema validation. */
	async findThreadPrompt(request: IParadisCodexThreadPromptRequest): Promise<IParadisCodexThreadPromptResult> {
		if (!request || !isCanonicalCodexThreadId(request.threadId) || !isAbsolute(request.cwd)
			|| (request.invocation !== 'start' && request.invocation !== 'resume')) {
			return {};
		}
		let database: import('node:sqlite').DatabaseSync | undefined;
		try {
			const databasePath = await this.findLatestStateDatabase();
			if (!databasePath) {
				return {};
			}
			const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
			database = new DatabaseSyncCtor(databasePath, { readOnly: true });
			const columns = new Set((database.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>)
				.map(column => typeof column.name === 'string' ? column.name : undefined)
				.filter((column): column is string => column !== undefined));
			if (!columns.has('id') || !columns.has('source') || !columns.has('cwd')) {
				return {};
			}
			const optionalColumns = ['rollout_path', 'first_user_message', 'title', 'preview'].filter(column => columns.has(column));
			const archivedClause = columns.has('archived') ? ' AND archived = 0' : '';
			const realCwd = await fs.realpath(request.cwd).catch(() => request.cwd);
			const selectedColumns = ['source', 'cwd', ...optionalColumns].join(', ');
			const cwdClause = request.invocation === 'start' ? ' AND (cwd = ? OR cwd = ?)' : '';
			const statement = database.prepare(`SELECT ${selectedColumns} FROM threads WHERE id = ? AND source = 'cli'${cwdClause}${archivedClause} LIMIT 1`);
			const row = (request.invocation === 'start'
				? statement.get(request.threadId, request.cwd, realCwd)
				: statement.get(request.threadId)) as ICodexThreadRow | undefined;
			if (!row || row.source !== 'cli' || (request.invocation === 'start' && row.cwd !== request.cwd && row.cwd !== realCwd)) {
				return {};
			}
			const prompt = nonEmptyString(row.title) ?? nonEmptyString(row.first_user_message) ?? nonEmptyString(row.preview);
			if (prompt) {
				return { prompt };
			}
			const rolloutPath = nonEmptyString(row.rollout_path);
			return rolloutPath ? { prompt: await readFirstUserPrompt(this.codexHome, rolloutPath) } : {};
		} catch (error) {
			this.logService.debug('[ParadisCodexTerminalTitle] unable to read Codex thread metadata', error);
			return {};
		} finally {
			database?.close();
		}
	}

	private async findLatestStateDatabase(): Promise<string | undefined> {
		const names = await fs.readdir(this.codexHome);
		const name = names
			.map(name => ({ name, version: /^state_(\d+)\.sqlite$/.exec(name)?.[1] }))
			.filter((entry): entry is { name: string; version: string } => entry.version !== undefined)
			.sort((a, b) => Number(b.version) - Number(a.version))[0]?.name;
		if (!name) {
			return undefined;
		}
		const [realHome, realDatabase] = await Promise.all([
			fs.realpath(this.codexHome),
			fs.realpath(resolve(this.codexHome, name)),
		]);
		return isPathInside(realHome, realDatabase) ? realDatabase : undefined;
	}
}

/** Shared-process IPC boundary for the read-only Codex metadata service. */
export class ParadisCodexTerminalTitleChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisCodexTerminalTitleService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		if (command !== 'findThreadPrompt') {
			throw new Error(`Method not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		return this.service.findThreadPrompt(args[0] as IParadisCodexThreadPromptRequest) as Promise<T>;
	}
}

/** Registers the read-only Codex title metadata channel in the shared process. */
export function registerParadisCodexTerminalTitle(server: IPCServer<string>, logService: ILogService): IDisposable {
	server.registerChannel(PARADIS_CODEX_TERMINAL_TITLE_CHANNEL, new ParadisCodexTerminalTitleChannel(new ParadisCodexTerminalTitleService(logService)));
	return { dispose: () => { } };
}
