/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs, type Dirent, type Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import type { DatabaseSync } from 'node:sqlite';
import { Limiter } from '../../../../base/common/async.js';
import { basename, isAbsolute, join, resolve } from '../../../../base/common/path.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisLocalAgentPath, paradisResolveAgentHomes } from '../../agentBrowser/node/paradisAgentHome.js';
import { ParadisSessionSearchTextCache } from './paradisSessionSearchTextCache.js';
import {
	IParadisResumeListRequest,
	IParadisResumeMessage,
	IParadisResumePreview,
	IParadisResumeSearchResult,
	IParadisResumeSession,
	IParadisResumeSpace,
	PARADIS_RESUME_SESSION_ID_PATTERN,
	PARADIS_SESSION_RESUME_CHANNEL,
} from '../common/paradisSessionResume.js';

const nodeRequire = createRequire(import.meta.url);
const MAX_SESSIONS = 600;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_CLAUDE_SESSIONS_PER_SPACE = 200;
const SUMMARY_HEAD_BYTES = 512 * 1024;
const MAX_SEARCH_TEXT_CHARS = 64 * 1024;
const MAX_CATALOG_ENTRIES = 2400;
const DEFAULT_SEARCH_TEXT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_SEARCH_TEXT_READS = 4;

interface ICatalogEntry {
	readonly session: IParadisResumeSession;
	readonly transcriptPath: string;
	readonly allowedRoot: string;
	searchTextPromise?: Promise<string>;
	touchedAt: number;
}

interface INormalizedParadisResumeListRequest extends IParadisResumeListRequest {
	readonly includeArchived: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clipped(value: string, limit = MAX_MESSAGE_CHARS): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function countSearchTermOccurrences(lowercaseValue: string, terms: readonly string[]): number {
	let count = 0;
	for (const term of terms) {
		let offset = 0;
		while ((offset = lowercaseValue.indexOf(term, offset)) !== -1) {
			count++;
			offset += term.length;
		}
	}
	return count;
}

function createSearchSnippet(value: string, terms: readonly string[]): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	const lower = normalized.toLocaleLowerCase();
	const firstMatch = terms.reduce((nearest, term) => {
		const index = lower.indexOf(term);
		return index === -1 ? nearest : Math.min(nearest, index);
	}, Number.POSITIVE_INFINITY);
	if (!Number.isFinite(firstMatch)) {
		return clipped(normalized, 240);
	}
	const start = Math.max(0, firstMatch - 70);
	const end = Math.min(normalized.length, firstMatch + 170);
	return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

function parseTimestamp(value: unknown): number | undefined {
	const raw = string(value);
	if (!raw) {
		return undefined;
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function flattenText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	const parts: string[] = [];
	for (const item of value) {
		const block = record(item);
		if (!block) {
			continue;
		}
		const type = string(block['type']);
		if (type === 'text' || type === 'input_text' || type === 'output_text') {
			const text = string(block['text']);
			if (text) {
				parts.push(text);
			}
		}
	}
	return parts.join('\n');
}

function isInjectedCodexContext(text: string): boolean {
	const value = text.trim();
	return /^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS)/.test(value)
		|| value.startsWith('# AGENTS.md instructions for');
}

function isCodexRootSource(source: string | undefined): boolean {
	if (!source) {
		return true;
	}
	try {
		const parsed = record(JSON.parse(source));
		return record(record(parsed?.['subagent'])?.['thread_spawn']) === undefined;
	} catch {
		return true;
	}
}

function parseCodexSessionMeta(line: string): { id: string; cwd: string } | undefined {
	try {
		const item = record(JSON.parse(line));
		const payload = record(item?.['payload']);
		if (item?.['type'] !== 'session_meta' || !payload) {
			return undefined;
		}
		const id = string(payload['id']) ?? string(payload['session_id']);
		const cwd = string(payload['cwd']);
		const sourceSpawn = record(record(record(payload['source'])?.['subagent'])?.['thread_spawn']);
		const parentThreadId = string(payload['parent_thread_id']) ?? string(sourceSpawn?.['parent_thread_id']);
		const ownThreadId = string(payload['id']) ?? id;
		const subagent = sourceSpawn !== undefined || string(payload['thread_source']) === 'subagent'
			|| (parentThreadId !== undefined && parentThreadId !== ownThreadId);
		return id && cwd && !subagent ? { id, cwd } : undefined;
	} catch {
		return undefined;
	}
}

function parseLine(line: string, agent: 'claude' | 'codex'): IParadisResumeMessage | undefined {
	let item: Record<string, unknown> | undefined;
	try {
		item = record(JSON.parse(line));
	} catch {
		return undefined;
	}
	if (!item) {
		return undefined;
	}
	if (agent === 'claude') {
		if (item['isSidechain'] === true || item['isMeta'] === true) {
			return undefined;
		}
		const type = string(item['type']);
		if (type !== 'user' && type !== 'assistant') {
			return undefined;
		}
		const message = record(item['message']);
		const text = flattenText(message?.['content']);
		if (!text.trim()) {
			return undefined;
		}
		return { role: type, text: clipped(text), timestamp: parseTimestamp(item['timestamp']) };
	}
	if (item['type'] !== 'response_item') {
		return undefined;
	}
	const payload = record(item['payload']);
	if (payload?.['type'] !== 'message') {
		return undefined;
	}
	const role = string(payload['role']);
	if (role !== 'user' && role !== 'assistant') {
		return undefined;
	}
	const text = flattenText(payload['content']);
	if (!text.trim() || (role === 'user' && isInjectedCodexContext(text))) {
		return undefined;
	}
	return { role, text: clipped(text), timestamp: parseTimestamp(item['timestamp']) };
}

interface IFileIdentity {
	readonly dev: number;
	readonly ino: number;
}

interface IVerifiedFile {
	readonly handle: FileHandle;
	readonly stat: Stats;
}

async function openVerifiedFile(filePath: string, allowedRoot: string, expected?: IFileIdentity, beforeOpen?: (filePath: string) => Promise<void>): Promise<IVerifiedFile> {
	const [realRoot, initialRealFile] = await Promise.all([fs.realpath(allowedRoot), fs.realpath(filePath)]);
	if (!pathInside(realRoot, initialRealFile)) {
		throw new Error('Session transcript is outside the allowed history directory.');
	}
	await beforeOpen?.(filePath);
	const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
	const handle = await fs.open(filePath, flags);
	try {
		const [opened, realFile, current] = await Promise.all([handle.stat(), fs.realpath(filePath), fs.stat(filePath)]);
		if (!opened.isFile() || (expected !== undefined && (opened.dev !== expected.dev || opened.ino !== expected.ino))
			|| opened.dev !== current.dev || opened.ino !== current.ino || !pathInside(realRoot, realFile)) {
			throw new Error('Session transcript changed while opening.');
		}
		return { handle, stat: opened };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function readBoundedFile(filePath: string, allowedRoot: string, beforeOpen?: (filePath: string) => Promise<void>): Promise<{ text: string; truncated: boolean }> {
	const { handle, stat } = await openVerifiedFile(filePath, allowedRoot, undefined, beforeOpen);
	try {
		if (stat.size <= MAX_PREVIEW_BYTES) {
			const buffer = Buffer.alloc(stat.size);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: false };
		}
		// 概要用の先頭と、実際に再開する直前の会話がある末尾を残す。境界の途中行は捨てる。
		const headLength = 512 * 1024;
		const tailLength = MAX_PREVIEW_BYTES - headLength;
		const head = Buffer.alloc(headLength);
		const tail = Buffer.alloc(tailLength);
		const [headRead, tailRead] = await Promise.all([
			handle.read(head, 0, head.length, 0),
			handle.read(tail, 0, tail.length, stat.size - tail.length),
		]);
		const headText = head.subarray(0, headRead.bytesRead).toString('utf8').split('\n');
		headText.pop();
		const tailText = tail.subarray(0, tailRead.bytesRead).toString('utf8').split('\n');
		tailText.shift();
		return { text: `${headText.join('\n')}\n${tailText.join('\n')}`, truncated: true };
	} finally {
		await handle.close();
	}
}
async function readFileHead(filePath: string, allowedRoot: string, expected: IFileIdentity, limit: number, beforeOpen?: (filePath: string) => Promise<void>): Promise<string> {
	const { handle, stat } = await openVerifiedFile(filePath, allowedRoot, expected, beforeOpen);
	try {
		const buffer = Buffer.alloc(Math.min(stat.size, limit));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

function normalizePath(value: string): string {
	const normalized = resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
	return isWindows ? normalized.toLowerCase() : normalized;
}

function pathInside(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePath(root);
	const normalizedCandidate = normalizePath(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export class ParadisSessionResumeService {
	private readonly catalog = new Map<string, ICatalogEntry>();
	private readonly searchTextCache: ParadisSessionSearchTextCache;
	private readonly searchTextReadLimiter = new Limiter<string>(MAX_CONCURRENT_SEARCH_TEXT_READS);
	private readonly activeListRequests = new Map<string, Promise<readonly IParadisResumeSession[]>>();
	private readonly searchRevisions = new Map<string, number>();
	private searchRevision = 0;
	private readonly resolveAgentHomes: typeof paradisResolveAgentHomes;
	private readonly readBoundedFile: typeof readBoundedFile;
	private readonly beforeSummaryRead: ((filePath: string) => Promise<void>) | undefined;
	private readonly beforeTranscriptRead: ((filePath: string) => Promise<void>) | undefined;

	constructor(
		dependencies: {
			readonly resolveAgentHomes?: typeof paradisResolveAgentHomes;
			readonly readBoundedFile?: typeof readBoundedFile;
			readonly beforeSummaryRead?: (filePath: string) => Promise<void>;
			readonly beforeTranscriptRead?: (filePath: string) => Promise<void>;
			readonly searchCacheMaxBytes?: number;
		} | undefined,
		@ILogService private readonly logService: ILogService,
	) {
		this.resolveAgentHomes = dependencies?.resolveAgentHomes ?? paradisResolveAgentHomes;
		this.readBoundedFile = dependencies?.readBoundedFile ?? readBoundedFile;
		this.beforeSummaryRead = dependencies?.beforeSummaryRead;
		this.beforeTranscriptRead = dependencies?.beforeTranscriptRead;
		this.searchTextCache = new ParadisSessionSearchTextCache(dependencies?.searchCacheMaxBytes ?? DEFAULT_SEARCH_TEXT_CACHE_BYTES);
	}

	async list(request: IParadisResumeListRequest): Promise<readonly IParadisResumeSession[]> {
		const normalizedRequest = this.normalizeListRequest(request);
		const requestKey = this.createListRequestKey(normalizedRequest);
		const activeRequest = this.activeListRequests.get(requestKey);
		if (activeRequest) {
			return activeRequest;
		}

		const listRequest = this.collectList(normalizedRequest).finally(() => {
			if (this.activeListRequests.get(requestKey) === listRequest) {
				this.activeListRequests.delete(requestKey);
			}
		});
		this.activeListRequests.set(requestKey, listRequest);
		return listRequest;
	}

	private normalizeListRequest(request: IParadisResumeListRequest): INormalizedParadisResumeListRequest {
		const seenStateKeys = new Set<string>();
		const seenCwds = new Set<string>();
		const spaces = Array.isArray(request?.spaces) ? request.spaces.filter(space => {
			if (typeof space?.stateKey !== 'string' || space.stateKey.length === 0 || space.stateKey.length > 1000
				|| typeof space?.name !== 'string' || space.name.length === 0 || space.name.length > 500
				|| typeof space?.cwd !== 'string' || space.cwd.length > 32_768 || !isAbsolute(space.cwd)
				|| typeof space?.current !== 'boolean') {
				return false;
			}
			const cwdKey = normalizePath(space.cwd);
			if (seenStateKeys.has(space.stateKey) || seenCwds.has(cwdKey)) {
				return false;
			}
			seenStateKeys.add(space.stateKey);
			seenCwds.add(cwdKey);
			return true;
		}).slice(0, 200).map(space => ({
			stateKey: space.stateKey,
			name: space.name,
			cwd: space.cwd,
			current: space.current,
		})) : [];
		return { spaces, includeArchived: request.includeArchived === true };
	}

	private createListRequestKey(request: INormalizedParadisResumeListRequest): string {
		return JSON.stringify({
			includeArchived: request.includeArchived,
			spaces: request.spaces.map(space => ({
				stateKey: space.stateKey,
				name: space.name,
				cwd: space.cwd,
				current: space.current,
			})),
		});
	}

	private async collectList(request: INormalizedParadisResumeListRequest): Promise<readonly IParadisResumeSession[]> {
		const sessions: IParadisResumeSession[] = [];
		const homesSeen = new Set<string>();
		for (const space of request.spaces) {
			const homes = this.resolveAgentHomes(space.cwd);
			await this.collectClaude(space, homes.claude, homes.matchCwd, sessions);
			if (!homesSeen.has(homes.codex)) {
				homesSeen.add(homes.codex);
				const indexed = await this.collectCodex(request.spaces, homes.codex, sessions, request.includeArchived);
				if (!indexed) {
					await this.collectCodexRollouts(request.spaces, homes.codex, sessions);
				}
			}
		}
		const visible = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
		this.trimCatalog(new Set(visible.map(session => session.catalogId)));
		return visible;
	}

	async preview(catalogId: string, rawQuery?: string): Promise<IParadisResumePreview> {
		const entry = this.catalog.get(catalogId);
		if (!entry || !pathInside(entry.allowedRoot, entry.transcriptPath)) {
			throw new Error('Session is no longer available.');
		}
		entry.touchedAt = Date.now();
		const data = await this.readBoundedFile(entry.transcriptPath, entry.allowedRoot, this.beforeTranscriptRead);
		const messages: IParadisResumeMessage[] = [];
		for (const line of data.text.split('\n')) {
			const message = parseLine(line, entry.session.agent);
			if (message) {
				messages.push(message);
			}
		}
		const terms = rawQuery?.trim().toLocaleLowerCase().slice(0, 200).split(/\s+/).filter(Boolean) ?? [];
		let visible: readonly IParadisResumeMessage[];
		if (terms.length === 0) {
			visible = messages.slice(-MAX_PREVIEW_MESSAGES);
		} else {
			const visibleIndices = new Set<number>();
			const matchingIndices = new Set<number>();
			for (let index = 0; index < messages.length; index++) {
				const text = messages[index].text.toLocaleLowerCase();
				if (terms.some(term => text.includes(term))) {
					matchingIndices.add(index);
					visibleIndices.add(Math.max(0, index - 1));
					visibleIndices.add(index);
					visibleIndices.add(Math.min(messages.length - 1, index + 1));
				}
			}
			visible = visibleIndices.size > 0
				? [...visibleIndices].sort((a, b) => a - b).slice(0, MAX_PREVIEW_MESSAGES).map(index => ({ ...messages[index], rawSearchMatch: matchingIndices.has(index) }))
				: messages.slice(-MAX_PREVIEW_MESSAGES);
		}
		return { messages: visible, truncated: data.truncated || messages.length > visible.length };
	}

	async search(clientId: string, rawQuery: string, requestedCatalogIds: readonly string[]): Promise<readonly IParadisResumeSearchResult[]> {
		const revision = ++this.searchRevision;
		this.searchRevisions.set(clientId, revision);
		const terms = rawQuery.trim().toLocaleLowerCase().slice(0, 200).split(/\s+/).filter(Boolean);
		if (terms.length === 0) {
			const result = requestedCatalogIds.slice(0, MAX_SESSIONS).filter(catalogId => this.catalog.has(catalogId)).map(catalogId => ({
				catalogId, matchCount: 0, snippet: '', source: 'metadata' as const,
			}));
			if (this.searchRevisions.get(clientId) === revision) {
				this.searchRevisions.delete(clientId);
			}
			return result;
		}
		const matches: IParadisResumeSearchResult[] = [];
		// 全文走査は検索時だけ。各検索の並列数を抑えつつ、service全体でもreadを制限する。
		const entries = [...new Set(requestedCatalogIds)].slice(0, MAX_SESSIONS)
			.map(catalogId => [catalogId, this.catalog.get(catalogId)] as const)
			.filter((entry): entry is readonly [string, ICatalogEntry] => entry[1] !== undefined);
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < entries.length && this.searchRevisions.get(clientId) === revision) {
				const [catalogId, entry] = entries[cursor++];
				entry.touchedAt = Date.now();
				const metadata = `${entry.session.title}\n${entry.session.preview}\n${entry.session.cwd}\n${entry.session.id}\n${entry.session.spaceName}`;
				let searchable = metadata;
				let searchableLower = metadata.toLocaleLowerCase();
				let source: IParadisResumeSearchResult['source'] = 'metadata';
				if (!terms.every(term => searchableLower.includes(term))) {
					try {
						const searchText = await this.getSearchText(entry);
						searchable += `\n${searchText}`;
						searchableLower += `\n${searchText.toLocaleLowerCase()}`;
						source = 'conversation';
					} catch { /* 一時的なread失敗は次の検索で再試行する */ }
				}
				if (terms.every(term => searchableLower.includes(term))) {
					const snippetSource = source === 'conversation' ? searchable.slice(metadata.length + 1) : metadata;
					matches.push({
						catalogId,
						matchCount: countSearchTermOccurrences(searchableLower, terms),
						snippet: createSearchSnippet(snippetSource, terms),
						source,
					});
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
		const isLatestRevision = this.searchRevisions.get(clientId) === revision;
		if (isLatestRevision) {
			this.searchRevisions.delete(clientId);
		}
		return isLatestRevision ? matches : [];
	}

	private getSearchText(entry: ICatalogEntry): Promise<string> {
		const catalogId = entry.session.catalogId;
		const revision = entry.session.updatedAt;
		const cached = this.searchTextCache.get(catalogId, revision);
		if (cached !== undefined) {
			return Promise.resolve(cached);
		}
		if (entry.searchTextPromise !== undefined) {
			return entry.searchTextPromise;
		}
		const searchTextPromise = this.searchTextReadLimiter.queue(async () => {
			const cachedAfterWait = this.searchTextCache.get(catalogId, revision);
			if (cachedAfterWait !== undefined) {
				return cachedAfterWait;
			}
			const data = await this.readBoundedFile(entry.transcriptPath, entry.allowedRoot, this.beforeTranscriptRead);
			const parts: string[] = [];
			for (const line of data.text.split('\n')) {
				const message = parseLine(line, entry.session.agent);
				if (message) {
					parts.push(message.text);
				}
			}
			const fullText = parts.join('\n');
			const searchable = fullText.length <= MAX_SEARCH_TEXT_CHARS
				? fullText
				: `${fullText.slice(0, 16 * 1024)}\n${fullText.slice(-(MAX_SEARCH_TEXT_CHARS - 16 * 1024))}`;
			return searchable;
		});
		entry.searchTextPromise = searchTextPromise;
		void searchTextPromise.then(searchable => {
			const current = this.catalog.get(catalogId);
			if (current?.session.updatedAt === revision && current.searchTextPromise === searchTextPromise) {
				this.searchTextCache.set(catalogId, revision, searchable);
			}
		}, () => undefined).finally(() => {
			if (entry.searchTextPromise === searchTextPromise) {
				entry.searchTextPromise = undefined;
			}
			const current = this.catalog.get(catalogId);
			if (current?.session.updatedAt === revision && current.searchTextPromise === searchTextPromise) {
				current.searchTextPromise = undefined;
			}
		});
		return searchTextPromise;
	}

	private addSession(session: Omit<IParadisResumeSession, 'catalogId'>, transcriptPath: string, allowedRoot: string, target: IParadisResumeSession[]): void {
		if (!PARADIS_RESUME_SESSION_ID_PATTERN.test(session.id) || !isAbsolute(transcriptPath) || !pathInside(allowedRoot, transcriptPath)) {
			return;
		}
		const catalogId = `session-${createHash('sha256').update(`${session.agent}\0${normalizePath(transcriptPath)}`).digest('hex').slice(0, 32)}`;
		const complete: IParadisResumeSession = { ...session, catalogId };
		const previous = this.catalog.get(catalogId);
		if (previous?.session.updatedAt !== complete.updatedAt) {
			this.searchTextCache.delete(catalogId);
		}
		const searchTextPromise = previous?.session.updatedAt === complete.updatedAt ? previous.searchTextPromise : undefined;
		this.catalog.set(catalogId, { session: complete, transcriptPath, allowedRoot, searchTextPromise, touchedAt: Date.now() });
		target.push(complete);
	}

	private trimCatalog(protectedCatalogIds: ReadonlySet<string>): void {
		if (this.catalog.size <= MAX_CATALOG_ENTRIES) {
			return;
		}
		const oldest = [...this.catalog.entries()]
			.filter(([catalogId]) => !protectedCatalogIds.has(catalogId))
			.sort((a, b) => a[1].touchedAt - b[1].touchedAt)
			.slice(0, this.catalog.size - MAX_CATALOG_ENTRIES);
		for (const [catalogId] of oldest) {
			this.catalog.delete(catalogId);
			this.searchTextCache.delete(catalogId);
		}
	}

	private async collectClaude(space: IParadisResumeSpace, claudeHome: string, matchCwd: string, target: IParadisResumeSession[]): Promise<void> {
		const resolvedCwd = await fs.realpath(space.cwd).catch(() => matchCwd);
		const slug = (matchCwd === space.cwd ? resolvedCwd : matchCwd).replace(/[^a-zA-Z0-9]/g, '-');
		const directory = join(claudeHome, 'projects', slug);
		let names: string[];
		try {
			names = await fs.readdir(directory);
			const [realHome, realDirectory] = await Promise.all([fs.realpath(claudeHome), fs.realpath(directory)]);
			if (!pathInside(realHome, realDirectory)) {
				return;
			}
		} catch {
			return;
		}
		const transcriptNames = names.filter(name => name.endsWith('.jsonl'));
		const discovered: { id: string; transcriptPath: string; updatedAt: number; identity: IFileIdentity }[] = [];
		let statCursor = 0;
		const statWorker = async (): Promise<void> => {
			while (statCursor < transcriptNames.length) {
				const name = transcriptNames[statCursor++];
				const id = basename(name, '.jsonl');
				if (!PARADIS_RESUME_SESSION_ID_PATTERN.test(id)) {
					continue;
				}
				const transcriptPath = join(directory, name);
				try {
					const stat = await fs.lstat(transcriptPath);
					if (stat.isFile()) {
						discovered.push({ id, transcriptPath, updatedAt: stat.mtimeMs, identity: { dev: stat.dev, ino: stat.ino } });
					}
				} catch { /* ファイルが走査中に消えた場合は無視する */ }
			}
		};
		await Promise.all(Array.from({ length: Math.min(8, transcriptNames.length) }, () => statWorker()));
		const candidates = discovered
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_CLAUDE_SESSIONS_PER_SPACE);
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < candidates.length) {
				const candidate = candidates[cursor++];
				try {
					const data = await readFileHead(candidate.transcriptPath, claudeHome, candidate.identity, SUMMARY_HEAD_BYTES, this.beforeSummaryRead);
					let title: string | undefined;
					let firstPrompt: string | undefined;
					let createdAt: number | undefined;
					for (const line of data.split('\n')) {
						let item: Record<string, unknown> | undefined;
						try { item = record(JSON.parse(line)); } catch { continue; }
						if (!item) { continue; }
						title = string(item['customTitle']) ?? string(item['aiTitle']) ?? title;
						const message = parseLine(line, 'claude');
						if (message?.role === 'user' && !firstPrompt) {
							firstPrompt = message.text;
							createdAt = message.timestamp;
						}
					}
					const display = title ?? firstPrompt ?? candidate.id;
					this.addSession({
						id: candidate.id, agent: 'claude', title: clipped(display, 160), preview: clipped(firstPrompt ?? display, 260),
						cwd: space.cwd, spaceStateKey: space.stateKey, spaceName: space.name, currentSpace: space.current,
						createdAt, updatedAt: candidate.updatedAt, archived: false,
					}, candidate.transcriptPath, claudeHome, target);
				} catch (error) {
					this.logService.debug('[ParadisSessionResume] unable to read Claude session', error);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
	}

	private async createSpaceAliases(spaces: readonly IParadisResumeSpace[]): Promise<readonly { root: string; space: IParadisResumeSpace }[]> {
		const aliases: { root: string; space: IParadisResumeSpace }[] = [];
		for (const space of spaces) {
			const homes = this.resolveAgentHomes(space.cwd);
			const realCwd = await fs.realpath(space.cwd).catch(() => space.cwd);
			for (const root of new Set([space.cwd, homes.matchCwd, realCwd])) {
				aliases.push({ root: normalizePath(root), space });
			}
		}
		return aliases.sort((a, b) => b.root.length - a.root.length);
	}

	private matchSpace(aliases: readonly { root: string; space: IParadisResumeSpace }[], cwd: string): IParadisResumeSpace | undefined {
		const normalizedCwd = normalizePath(cwd);
		return aliases.find(alias => pathInside(alias.root, normalizedCwd))?.space;
	}

	private async collectCodex(spaces: readonly IParadisResumeSpace[], codexHome: string, target: IParadisResumeSession[], includeArchived: boolean): Promise<boolean> {
		let database: DatabaseSync | undefined;
		try {
			const spaceAliases = await this.createSpaceAliases(spaces);
			const names = await fs.readdir(codexHome);
			const databaseName = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
			if (!databaseName) {
				return false;
			}
			const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
			database = new DatabaseSyncCtor(join(codexHome, databaseName), { readOnly: true });
			const columns = new Set((database.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>).map(column => string(column.name)).filter((column): column is string => !!column));
			if (!columns.has('id') || !columns.has('cwd') || !columns.has('rollout_path')) {
				return false;
			}
			const createdAtExpression = columns.has('created_at_ms') && columns.has('created_at')
				? 'COALESCE(created_at_ms, created_at * 1000) AS created_at_value'
				: columns.has('created_at_ms') ? 'created_at_ms AS created_at_value'
					: columns.has('created_at') ? 'created_at * 1000 AS created_at_value' : '0 AS created_at_value';
			const updatedAtExpression = columns.has('updated_at_ms') && columns.has('updated_at')
				? 'COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_value'
				: columns.has('updated_at_ms') ? 'updated_at_ms AS updated_at_value'
					: columns.has('updated_at') ? 'updated_at * 1000 AS updated_at_value' : '0 AS updated_at_value';
			const select = [
				'id', 'cwd', 'rollout_path',
				columns.has('title') ? 'title' : `'' AS title`,
				columns.has('name') ? 'name' : 'NULL AS name',
				columns.has('first_user_message') ? 'first_user_message' : `'' AS first_user_message`,
				columns.has('preview') ? 'preview' : `'' AS preview`,
				createdAtExpression,
				updatedAtExpression,
				columns.has('archived') ? 'archived' : '0 AS archived',
				columns.has('git_branch') ? 'git_branch' : 'NULL AS git_branch',
				columns.has('source') ? 'source' : `'' AS source`,
			].join(', ');
			const archivedClause = !includeArchived && columns.has('archived') ? 'WHERE archived = 0' : '';
			const rows = database.prepare(`SELECT ${select} FROM threads ${archivedClause} ORDER BY updated_at_value DESC`).all() as unknown[];
			let accepted = 0;
			for (const value of rows) {
				const row = record(value);
				const id = string(row?.['id']);
				const cwd = string(row?.['cwd']);
				const rollout = string(row?.['rollout_path']);
				const space = cwd ? this.matchSpace(spaceAliases, cwd) : undefined;
				if (!id || !cwd || !rollout || !space || !isCodexRootSource(string(row?.['source']))) {
					continue;
				}
				const homes = this.resolveAgentHomes(space.cwd);
				const transcriptPath = paradisLocalAgentPath(homes, rollout);
				const title = string(row?.['name']) ?? string(row?.['title']) ?? string(row?.['first_user_message']) ?? string(row?.['preview']) ?? id;
				const preview = string(row?.['preview']) ?? string(row?.['first_user_message']) ?? title;
				this.addSession({
					id, agent: 'codex', title: clipped(title, 160), preview: clipped(preview, 260), cwd: space.cwd,
					spaceStateKey: space.stateKey, spaceName: space.name, currentSpace: space.current,
					createdAt: number(row?.['created_at_value']), updatedAt: number(row?.['updated_at_value']) || Date.now(),
					archived: number(row?.['archived']) === 1, gitBranch: string(row?.['git_branch']),
				}, transcriptPath, codexHome, target);
				accepted++;
				if (accepted >= MAX_SESSIONS) {
					break;
				}
			}
			return true;
		} catch (error) {
			this.logService.debug('[ParadisSessionResume] unable to read Codex session index', error);
			return false;
		} finally {
			database?.close();
		}
	}

	private async collectCodexRollouts(spaces: readonly IParadisResumeSpace[], codexHome: string, target: IParadisResumeSession[]): Promise<void> {
		const sessionsRoot = join(codexHome, 'sessions');
		try {
			const [realHome, realSessionsRoot] = await Promise.all([fs.realpath(codexHome), fs.realpath(sessionsRoot)]);
			if (!pathInside(realHome, realSessionsRoot)) {
				return;
			}
		} catch {
			return;
		}
		const paths: string[] = [];
		const collect = async (directory: string, depth: number): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory() && depth < 3) {
					await collect(path, depth + 1);
				} else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
					paths.push(path);
				}
			}
		};
		await collect(sessionsRoot, 0);
		const candidates: { path: string; updatedAt: number; identity: IFileIdentity }[] = [];
		let statCursor = 0;
		const statWorker = async (): Promise<void> => {
			while (statCursor < paths.length) {
				const path = paths[statCursor++];
				try {
					const stat = await fs.lstat(path);
					if (stat.isFile()) {
						candidates.push({ path, updatedAt: stat.mtimeMs, identity: { dev: stat.dev, ino: stat.ino } });
					}
				} catch { /* 走査中に消えたrolloutは無視する */ }
			}
		};
		await Promise.all(Array.from({ length: Math.min(8, paths.length) }, () => statWorker()));
		candidates.sort((a, b) => b.updatedAt - a.updatedAt);
		candidates.splice(MAX_SESSIONS);
		const spaceAliases = await this.createSpaceAliases(spaces);
		let readCursor = 0;
		const readWorker = async (): Promise<void> => {
			while (readCursor < candidates.length) {
				const candidate = candidates[readCursor++];
				try {
					const data = await readFileHead(candidate.path, codexHome, candidate.identity, SUMMARY_HEAD_BYTES, this.beforeSummaryRead);
					const lines = data.split('\n');
					const meta = parseCodexSessionMeta(lines[0] ?? '');
					const space = meta ? this.matchSpace(spaceAliases, meta.cwd) : undefined;
					if (!meta || !space || !PARADIS_RESUME_SESSION_ID_PATTERN.test(meta.id)) {
						continue;
					}
					const firstPrompt = lines.map(line => parseLine(line, 'codex')).find(message => message?.role === 'user');
					const display = firstPrompt?.text ?? meta.id;
					this.addSession({
						id: meta.id, agent: 'codex', title: clipped(display, 160), preview: clipped(display, 260), cwd: space.cwd,
						spaceStateKey: space.stateKey, spaceName: space.name, currentSpace: space.current,
						createdAt: firstPrompt?.timestamp, updatedAt: candidate.updatedAt, archived: false,
					}, candidate.path, codexHome, target);
				} catch (error) {
					this.logService.debug('[ParadisSessionResume] unable to read Codex rollout', error);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => readWorker()));
	}
}

/**
 * `search` の revision 追跡に使うクライアント識別子。shared process の ctx は string、REH の ctx は
 * `{clientId}` を持つ接続情報。想定外の形の ctx では、失効の的にならない一意な値を都度作る
 * （`String(ctx)` に倒すと全クライアントが同じキーへ落ちて、無関係な検索同士が誤って
 * 打ち切り合うため、"検索が失効しない"側へ倒す方が安全）。
 */
function clientIdFrom(ctx: unknown): string {
	if (typeof ctx === 'string') {
		return ctx;
	}
	const clientId = (ctx as { clientId?: unknown } | undefined)?.clientId;
	return typeof clientId === 'string' ? clientId : generateUuid();
}

export class ParadisSessionResumeChannel<TContext = string> implements IServerChannel<TContext> {
	constructor(private readonly service: ParadisSessionResumeService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'list': return this.service.list((args[0] ?? {}) as IParadisResumeListRequest) as Promise<T>;
			case 'preview': return this.service.preview(typeof args[0] === 'string' ? args[0] : '', typeof args[1] === 'string' ? args[1] : undefined) as Promise<T>;
			case 'search': return this.service.search(clientIdFrom(ctx), typeof args[0] === 'string' ? args[0] : '', Array.isArray(args[1]) ? args[1].filter((value): value is string => typeof value === 'string') : []) as Promise<T>;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

export function registerParadisSessionResume(server: IPCServer<string>, logService: ILogService): IDisposable {
	const service = new ParadisSessionResumeService(undefined, logService);
	server.registerChannel(PARADIS_SESSION_RESUME_CHANNEL, new ParadisSessionResumeChannel(service));
	return { dispose() { } };
}

/**
 * serverServices.ts（REH）の登録点から1行で呼べるファクトリ。
 *
 * SSH 接続先の ~/.claude・~/.codex が実際に transcript を持つ側。shared process 版は常に手元の
 * マシンで動き、接続先のホームには一切到達できないため、同じチャネルを接続先にも生やす。
 */
export function registerParadisSessionResumeForServer<TContext>(server: IPCServer<TContext>, logService: ILogService): IDisposable {
	const service = new ParadisSessionResumeService(undefined, logService);
	server.registerChannel(PARADIS_SESSION_RESUME_CHANNEL, new ParadisSessionResumeChannel<TContext>(service));
	// service は取り置きの Map しか持たず（開いた handle は都度 close される）、解放すべき資源が無い。
	return { dispose() { } };
}
