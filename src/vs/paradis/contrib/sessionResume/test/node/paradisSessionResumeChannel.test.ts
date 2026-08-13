/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisSessionResumeService } from '../../node/paradisSessionResumeChannel.js';

const nodeRequire = createRequire(import.meta.url);

suite('ParadisSessionResume', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let workspace: string;
	let claudeHome: string;
	let claudeProject: string;
	let codexHome: string;
	let codexSessions: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-session-resume-'));
		workspace = join(root, 'workspace');
		claudeHome = join(root, 'claude-home');
		codexHome = join(root, 'codex-home');
		codexSessions = join(codexHome, 'sessions', '2026', '08', '13');
		await Promise.all([
			fs.mkdir(workspace, { recursive: true }),
			fs.mkdir(claudeHome, { recursive: true }),
			fs.mkdir(codexSessions, { recursive: true }),
		]);
		const realWorkspace = await fs.realpath(workspace);
		claudeProject = join(claudeHome, 'projects', realWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
		await fs.mkdir(claudeProject, { recursive: true });
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function createService(
		readBoundedFile?: (filePath: string) => Promise<{ text: string; truncated: boolean }>,
		beforeSummaryRead?: (filePath: string) => Promise<void>,
		beforeTranscriptRead?: (filePath: string) => Promise<void>,
	): ParadisSessionResumeService {
		return new ParadisSessionResumeService({
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, matchCwd: cwd }),
			readBoundedFile,
			beforeSummaryRead,
			beforeTranscriptRead,
		}, new NullLogService());
	}

	function listSessions(service: ParadisSessionResumeService, includeArchived = false) {
		return service.list({
			spaces: [{ stateKey: 'workspace-state', name: 'Fixture Workspace', cwd: workspace, current: true }],
			includeArchived,
		});
	}

	function claudeMessage(role: 'user' | 'assistant', text: string, timestamp = '2026-08-13T01:00:00.000Z'): string {
		return JSON.stringify({ type: role, timestamp, message: { content: [{ type: 'text', text }] } });
	}

	function codexMessage(role: 'user' | 'assistant', text: string, timestamp = '2026-08-13T01:00:00.000Z'): string {
		return JSON.stringify({
			type: 'response_item',
			timestamp,
			payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
		});
	}

	async function writeLines(filePath: string, lines: readonly string[]): Promise<void> {
		await fs.writeFile(filePath, `${lines.join('\n')}\n`);
	}

	function createCodexDatabase(schema: string, populate?: (database: import('node:sqlite').DatabaseSync) => void): void {
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(join(codexHome, 'state_1.sqlite'));
		try {
			database.exec(schema);
			populate?.(database);
		} finally {
			database.close();
		}
	}

	test('lists Claude and Codex transcripts with workspace metadata, agent, mtime, and opaque catalog ids', async () => {
		const claudePath = join(claudeProject, 'claude-session.jsonl');
		const codexPath = join(codexSessions, 'rollout-codex-session.jsonl');
		await Promise.all([
			writeLines(claudePath, [claudeMessage('user', 'Claude fixture prompt', '2026-08-13T01:00:00.000Z')]),
			writeLines(codexPath, [
				JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
				codexMessage('user', 'Codex fixture prompt', '2026-08-13T02:00:00.000Z'),
			]),
		]);
		const claudeMtime = new Date('2026-08-13T03:00:00.000Z');
		const codexMtime = new Date('2026-08-13T04:00:00.000Z');
		await Promise.all([
			fs.utimes(claudePath, claudeMtime, claudeMtime),
			fs.utimes(codexPath, codexMtime, codexMtime),
		]);

		const sessions = await listSessions(createService());

		assert.deepStrictEqual(sessions.map(session => ({
			id: session.id,
			agent: session.agent,
			cwd: session.cwd,
			spaceStateKey: session.spaceStateKey,
			spaceName: session.spaceName,
			currentSpace: session.currentSpace,
			updatedAt: session.updatedAt,
		})), [
			{
				id: 'codex-session', agent: 'codex', cwd: workspace, spaceStateKey: 'workspace-state',
				spaceName: 'Fixture Workspace', currentSpace: true, updatedAt: codexMtime.getTime(),
			},
			{
				id: 'claude-session', agent: 'claude', cwd: workspace, spaceStateKey: 'workspace-state',
				spaceName: 'Fixture Workspace', currentSpace: true, updatedAt: claudeMtime.getTime(),
			},
		]);
		assert.strictEqual(new Set(sessions.map(session => session.catalogId)).size, 2);
		for (const session of sessions) {
			assert.match(session.catalogId, /^session-[a-f0-9]{32}$/);
		}
	});

	test('uses the Codex SQLite index and excludes archived threads unless requested', async () => {
		const visiblePath = join(codexSessions, 'rollout-visible-db-session.jsonl');
		const archivedPath = join(codexSessions, 'rollout-archived-db-session.jsonl');
		await Promise.all([
			writeLines(visiblePath, [codexMessage('user', 'Visible database prompt')]),
			writeLines(archivedPath, [codexMessage('user', 'Archived database prompt')]),
		]);
		createCodexDatabase(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				rollout_path TEXT NOT NULL,
				title TEXT NOT NULL,
				name TEXT,
				first_user_message TEXT NOT NULL,
				preview TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				archived INTEGER NOT NULL,
				git_branch TEXT,
				source TEXT NOT NULL
			)
		`, database => {
			const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
			insert.run('visible-db-session', workspace, visiblePath, 'Visible database title', null, 'Visible database prompt', 'Visible preview', 1_000, 2_000, 0, 'main', '');
			insert.run('archived-db-session', workspace, archivedPath, 'Archived database title', null, 'Archived database prompt', 'Archived preview', 3_000, 4_000, 1, 'archive', '');
		});
		const service = createService();

		const visible = await listSessions(service);
		const includingArchived = await listSessions(service, true);

		assert.deepStrictEqual({
			visible: visible.map(session => ({ id: session.id, archived: session.archived, title: session.title })),
			includingArchived: includingArchived.map(session => ({ id: session.id, archived: session.archived, branch: session.gitBranch })),
		}, {
			visible: [{ id: 'visible-db-session', archived: false, title: 'Visible database title' }],
			includingArchived: [
				{ id: 'archived-db-session', archived: true, branch: 'archive' },
				{ id: 'visible-db-session', archived: false, branch: 'main' },
			],
		});
	});

	test('does not expose an archived Codex rollout when the usable SQLite index has no visible rows', async () => {
		const archivedPath = join(codexSessions, 'rollout-only-archived-db-session.jsonl');
		await writeLines(archivedPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'only-archived-db-session', cwd: workspace } }),
			codexMessage('user', 'Archived rollout must stay hidden'),
		]);
		createCodexDatabase(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				rollout_path TEXT NOT NULL,
				title TEXT NOT NULL,
				archived INTEGER NOT NULL
			)
		`, database => {
			database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
				.run('only-archived-db-session', workspace, archivedPath, 'Archived database title', 1);
		});
		const service = createService();

		const visible = await listSessions(service);
		const includingArchived = await listSessions(service, true);

		assert.deepStrictEqual({
			visible,
			includingArchived: includingArchived.map(session => ({ id: session.id, archived: session.archived })),
		}, {
			visible: [],
			includingArchived: [{ id: 'only-archived-db-session', archived: true }],
		});
	});

	test('falls back to Codex rollouts when the SQLite index lacks required columns', async () => {
		const rolloutPath = join(codexSessions, 'rollout-missing-columns-fallback.jsonl');
		await writeLines(rolloutPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'missing-columns-fallback', cwd: workspace } }),
			codexMessage('user', 'Fallback from incomplete database'),
		]);
		createCodexDatabase('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)');

		const sessions = await listSessions(createService());

		assert.deepStrictEqual(sessions.map(session => ({ id: session.id, agent: session.agent, title: session.title })), [
			{ id: 'missing-columns-fallback', agent: 'codex', title: 'Fallback from incomplete database' },
		]);
	});

	test('falls back to Codex rollouts when the SQLite index is corrupt', async () => {
		const rolloutPath = join(codexSessions, 'rollout-corrupt-database-fallback.jsonl');
		await Promise.all([
			writeLines(rolloutPath, [
				JSON.stringify({ type: 'session_meta', payload: { id: 'corrupt-database-fallback', cwd: workspace } }),
				codexMessage('user', 'Fallback from corrupt database'),
			]),
			fs.writeFile(join(codexHome, 'state_9.sqlite'), 'not a sqlite database'),
		]);

		const sessions = await listSessions(createService());

		assert.deepStrictEqual(sessions.map(session => ({ id: session.id, agent: session.agent, title: session.title })), [
			{ id: 'corrupt-database-fallback', agent: 'codex', title: 'Fallback from corrupt database' },
		]);
	});

	test('list does not read a Claude summary swapped to an outside symlink after lstat', async () => {
		const transcriptPath = join(claudeProject, 'summary-swap-session.jsonl');
		const outsidePath = join(root, 'outside-summary.jsonl');
		await Promise.all([
			writeLines(transcriptPath, [claudeMessage('user', 'Safe in-root summary')]),
			writeLines(outsidePath, [claudeMessage('user', 'Outside secret summary')]),
		]);
		let swapped = false;
		const service = createService(undefined, async filePath => {
			if (!swapped && filePath === transcriptPath) {
				swapped = true;
				await fs.unlink(transcriptPath);
				await fs.symlink(outsidePath, transcriptPath);
			}
		});

		const sessions = await listSessions(service);

		assert.strictEqual(swapped, true);
		assert.deepStrictEqual(sessions, []);
	});

	test('preview rejects ids outside the catalog and transcripts replaced by an escaping symlink', async () => {
		const service = createService();
		await assert.rejects(service.preview('session-00000000000000000000000000000000'), /no longer available/);

		const transcriptPath = join(claudeProject, 'symlink-session.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Original in-root message')]);
		const [session] = await listSessions(service);
		assert.ok(session);

		const outsidePath = join(root, 'outside-transcript.jsonl');
		await writeLines(outsidePath, [claudeMessage('user', 'Outside secret')]);
		await fs.unlink(transcriptPath);
		await fs.symlink(outsidePath, transcriptPath);

		await assert.rejects(service.preview(session.catalogId), /outside the allowed history directory/);
	});

	test('preview does not read an outside symlink swapped in after its boundary check', async () => {
		const transcriptPath = join(claudeProject, 'preview-race-session.jsonl');
		const outsidePath = join(root, 'outside-preview-race.jsonl');
		await Promise.all([
			writeLines(transcriptPath, [claudeMessage('user', 'Safe preview message')]),
			writeLines(outsidePath, [claudeMessage('user', 'Outside preview secret')]),
		]);
		let swapped = false;
		const service = createService(undefined, undefined, async filePath => {
			if (!swapped && filePath === transcriptPath) {
				swapped = true;
				await fs.unlink(transcriptPath);
				await fs.symlink(outsidePath, transcriptPath);
			}
		});
		const [session] = await listSessions(service);

		await assert.rejects(service.preview(session.catalogId));
		assert.strictEqual(swapped, true);
	});

	test('preview enforces message count and per-message character limits', async () => {
		const transcriptPath = join(claudeProject, 'bounded-messages.jsonl');
		const lines = Array.from({ length: 202 }, (_, index) => claudeMessage(
			index % 2 === 0 ? 'user' : 'assistant',
			index === 2 ? 'x'.repeat(12_050) : `message-${index}`,
		));
		await writeLines(transcriptPath, lines);
		const service = createService();
		const [session] = await listSessions(service);

		const preview = await service.preview(session.catalogId);

		assert.deepStrictEqual({
			messageCount: preview.messages.length,
			firstMessageLength: preview.messages[0]?.text.length,
			firstMessageEndsWithEllipsis: preview.messages[0]?.text.endsWith('…'),
			lastMessage: preview.messages.at(-1)?.text,
			truncated: preview.truncated,
		}, {
			messageCount: 200,
			firstMessageLength: 12_001,
			firstMessageEndsWithEllipsis: true,
			lastMessage: 'message-201',
			truncated: true,
		});
	});

	test('preview bounds transcript bytes while preserving complete messages at both ends', async () => {
		const transcriptPath = join(claudeProject, 'bounded-bytes.jsonl');
		await fs.writeFile(transcriptPath, [
			claudeMessage('user', 'head-message'),
			'x'.repeat(8 * 1024 * 1024),
			claudeMessage('assistant', 'tail-message'),
			'',
		].join('\n'));
		const service = createService();
		const [session] = await listSessions(service);

		const preview = await service.preview(session.catalogId);

		assert.deepStrictEqual({
			messages: preview.messages.map(message => message.text),
			truncated: preview.truncated,
		}, {
			messages: ['head-message', 'tail-message'],
			truncated: true,
		});
	});

	test('search publishes only the newest revision when an older search finishes later', async () => {
		const oldPath = join(claudeProject, 'old-search-session.jsonl');
		const intermediatePath = join(claudeProject, 'intermediate-search-session.jsonl');
		const newPath = join(claudeProject, 'new-search-session.jsonl');
		await Promise.all([
			writeLines(oldPath, [
				claudeMessage('user', 'First fixture prompt'),
				claudeMessage('assistant', 'obsolete-token appears only in the conversation'),
			]),
			writeLines(intermediatePath, [
				claudeMessage('user', 'Intermediate fixture prompt'),
				claudeMessage('assistant', 'intermediate-token appears only in the conversation'),
			]),
			writeLines(newPath, [
				claudeMessage('user', 'Second fixture prompt'),
				claudeMessage('assistant', 'current-token appears only in the conversation'),
			]),
		]);
		let markOldReadStarted!: () => void;
		const oldReadStarted = new Promise<void>(resolve => markOldReadStarted = resolve);
		let releaseOldRead!: () => void;
		const oldReadGate = new Promise<void>(resolve => releaseOldRead = resolve);
		let markNewReadStarted!: () => void;
		const newReadStarted = new Promise<void>(resolve => markNewReadStarted = resolve);
		let releaseNewRead!: () => void;
		const newReadGate = new Promise<void>(resolve => releaseNewRead = resolve);
		const service = createService(undefined, undefined, async filePath => {
			if (filePath === oldPath) {
				markOldReadStarted();
				await oldReadGate;
			} else if (filePath === newPath) {
				markNewReadStarted();
				await newReadGate;
			}
		});
		const sessions = await listSessions(service);
		const oldCatalogId = sessions.find(session => session.id === 'old-search-session')?.catalogId;
		const intermediateCatalogId = sessions.find(session => session.id === 'intermediate-search-session')?.catalogId;
		const newCatalogId = sessions.find(session => session.id === 'new-search-session')?.catalogId;
		assert.ok(oldCatalogId);
		assert.ok(intermediateCatalogId);
		assert.ok(newCatalogId);

		const oldSearch = service.search('client-1', 'obsolete-token', [oldCatalogId]);
		await oldReadStarted;
		const intermediateResult = await service.search('client-1', 'intermediate-token', [intermediateCatalogId]);
		const newestSearch = service.search('client-1', 'current-token', [newCatalogId]);
		await newReadStarted;
		releaseOldRead();
		const staleResult = await oldSearch;
		releaseNewRead();
		const newestResult = await newestSearch;

		assert.deepStrictEqual({
			intermediate: intermediateResult.map(result => ({ catalogId: result.catalogId, source: result.source })),
			newest: newestResult.map(result => ({ catalogId: result.catalogId, source: result.source })),
			stale: staleResult,
		}, {
			intermediate: [{ catalogId: intermediateCatalogId, source: 'conversation' }],
			newest: [{ catalogId: newCatalogId, source: 'conversation' }],
			stale: [],
		});
	});

	test('search does not index an outside symlink swapped in after its boundary check', async () => {
		const transcriptPath = join(claudeProject, 'search-race-session.jsonl');
		const outsidePath = join(root, 'outside-search-race.jsonl');
		await Promise.all([
			writeLines(transcriptPath, [claudeMessage('user', 'Safe searchable message')]),
			writeLines(outsidePath, [claudeMessage('user', 'outside-search-secret')]),
		]);
		let swapped = false;
		const service = createService(undefined, undefined, async filePath => {
			if (!swapped && filePath === transcriptPath) {
				swapped = true;
				await fs.unlink(transcriptPath);
				await fs.symlink(outsidePath, transcriptPath);
			}
		});
		const [session] = await listSessions(service);

		const results = await service.search('client-race', 'outside-search-secret', [session.catalogId]);

		assert.strictEqual(swapped, true);
		assert.deepStrictEqual(results, []);
	});
});
