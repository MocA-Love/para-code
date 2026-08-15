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
import { DeferredPromise } from '../../../../../base/common/async.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisResumeListRequest, IParadisResumeSpace } from '../../common/paradisSessionResume.js';
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
		searchCacheMaxBytes?: number,
	): ParadisSessionResumeService {
		const dependencies = {
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, matchCwd: cwd }),
			readBoundedFile,
			beforeSummaryRead,
			beforeTranscriptRead,
			searchCacheMaxBytes,
		};
		return new ParadisSessionResumeService(dependencies, new NullLogService());
	}

	function createListRequest(space: Partial<IParadisResumeSpace> = {}, includeArchived = false): IParadisResumeListRequest {
		return {
			spaces: [{ stateKey: 'workspace-state', name: 'Fixture Workspace', cwd: workspace, current: true, ...space }],
			includeArchived,
		};
	}

	function listSessions(service: ParadisSessionResumeService, includeArchived = false) {
		return service.list(createListRequest({}, includeArchived));
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

	test('shares one active scan for identical normalized list requests', async () => {
		const transcriptPath = join(claudeProject, 'shared-active-scan.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Shared active scan')]);
		const firstSummaryRead = new DeferredPromise<void>();
		const summaryGate = new DeferredPromise<void>();
		let summaryReadCount = 0;
		const service = createService(undefined, async () => {
			summaryReadCount++;
			firstSummaryRead.complete();
			await summaryGate.p;
		});

		const first = service.list(createListRequest());
		await firstSummaryRead.p;
		const second = service.list(createListRequest());
		summaryGate.complete();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		assert.strictEqual(summaryReadCount, 1);
		assert.strictEqual(firstResult, secondResult);
	});

	test('keeps raw cwd results independent when equivalent cwd requests overlap in either order', async () => {
		const transcriptPath = join(claudeProject, 'raw-cwd-active-scan.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Raw cwd active scan')]);
		const alternateCwd = `${workspace}/../workspace`;
		for (const [firstCwd, secondCwd] of [[workspace, alternateCwd], [alternateCwd, workspace]]) {
			const firstSummaryRead = new DeferredPromise<void>();
			const summaryGate = new DeferredPromise<void>();
			let summaryReadCount = 0;
			const service = createService(undefined, async () => {
				summaryReadCount++;
				firstSummaryRead.complete();
				await summaryGate.p;
			});

			const first = service.list(createListRequest({ cwd: firstCwd }));
			await firstSummaryRead.p;
			const second = service.list(createListRequest({ cwd: secondCwd }));
			summaryGate.complete();
			const [[firstSession], [secondSession]] = await Promise.all([first, second]);

			assert.strictEqual(summaryReadCount, 2);
			assert.strictEqual(firstSession?.cwd, firstCwd);
			assert.strictEqual(secondSession?.cwd, secondCwd);
		}
	});

	test('snapshots valid list spaces before caller mutation', async () => {
		const transcriptPath = join(claudeProject, 'snapshot-list-space.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Snapshot list space')]);
		const firstSummaryRead = new DeferredPromise<void>();
		const summaryGate = new DeferredPromise<void>();
		const service = createService(undefined, async () => {
			firstSummaryRead.complete();
			await summaryGate.p;
		});
		const request = {
			spaces: [{ stateKey: 'workspace-state', name: 'Fixture Workspace', cwd: workspace, current: true }],
			includeArchived: false,
		};

		const list = service.list(request);
		request.spaces[0].stateKey = 'mutated-state';
		request.spaces[0].name = 'Mutated Workspace';
		request.spaces[0].current = false;
		await firstSummaryRead.p;
		summaryGate.complete();
		const [session] = await list;

		assert.deepStrictEqual({
			stateKey: session?.spaceStateKey,
			name: session?.spaceName,
			cwd: session?.cwd,
			current: session?.currentSpace,
		}, {
			stateKey: 'workspace-state',
			name: 'Fixture Workspace',
			cwd: workspace,
			current: true,
		});
	});

	test('does not share active scans for distinct observable list requests', async () => {
		const primaryTranscriptPath = join(claudeProject, 'distinct-active-scan-primary.jsonl');
		const secondaryWorkspace = join(root, 'secondary-workspace');
		await fs.mkdir(secondaryWorkspace, { recursive: true });
		const secondaryRealWorkspace = await fs.realpath(secondaryWorkspace);
		const secondaryProject = join(claudeHome, 'projects', secondaryRealWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
		const secondaryTranscriptPath = join(secondaryProject, 'distinct-active-scan-secondary.jsonl');
		await Promise.all([
			writeLines(primaryTranscriptPath, [claudeMessage('user', 'Primary distinct active scan')]),
			fs.mkdir(secondaryProject, { recursive: true }).then(() => writeLines(secondaryTranscriptPath, [claudeMessage('user', 'Secondary distinct active scan')])),
		]);

		const primarySpace: IParadisResumeSpace = { stateKey: 'workspace-state', name: 'Fixture Workspace', cwd: workspace, current: true };
		const secondarySpace: IParadisResumeSpace = { stateKey: 'secondary-state', name: 'Secondary Workspace', cwd: secondaryWorkspace, current: false };
		const cases: readonly { readonly name: string; readonly first: IParadisResumeListRequest; readonly second: IParadisResumeListRequest; readonly expectedSummaryReads: number }[] = [
			{ name: 'state key', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, stateKey: 'other-state' }], includeArchived: false }, expectedSummaryReads: 2 },
			{ name: 'name', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, name: 'Other Workspace' }], includeArchived: false }, expectedSummaryReads: 2 },
			{ name: 'cwd', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [secondarySpace], includeArchived: false }, expectedSummaryReads: 2 },
			{ name: 'current', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, current: false }], includeArchived: false }, expectedSummaryReads: 2 },
			{ name: 'includeArchived', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [primarySpace], includeArchived: true }, expectedSummaryReads: 2 },
			{ name: 'space order', first: { spaces: [primarySpace, secondarySpace], includeArchived: false }, second: { spaces: [secondarySpace, primarySpace], includeArchived: false }, expectedSummaryReads: 4 },
		];

		for (const testCase of cases) {
			const firstSummaryRead = new DeferredPromise<void>();
			const summaryGate = new DeferredPromise<void>();
			let summaryReadCount = 0;
			const service = createService(undefined, async () => {
				summaryReadCount++;
				firstSummaryRead.complete();
				await summaryGate.p;
			});

			const first = service.list(testCase.first);
			await firstSummaryRead.p;
			const second = service.list(testCase.second);
			summaryGate.complete();
			await Promise.all([first, second]);

			assert.strictEqual(summaryReadCount, testCase.expectedSummaryReads, testCase.name);
		}
	});

	test('rescans after an active list request settles', async () => {
		const transcriptPath = join(claudeProject, 'rescan-after-settle.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Rescan after settle')]);
		let summaryReadCount = 0;
		const service = createService(undefined, async () => summaryReadCount++);

		await service.list(createListRequest());
		await service.list(createListRequest());

		assert.strictEqual(summaryReadCount, 2);
	});

	test('cleans a rejected active list request so a later request retries', async () => {
		const transcriptPath = join(claudeProject, 'retry-after-rejection.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Retry after rejection')]);
		let resolveHomesCount = 0;
		let summaryReadCount = 0;
		const service = new ParadisSessionResumeService({
			resolveAgentHomes: cwd => {
				resolveHomesCount++;
				if (resolveHomesCount === 1) {
					throw new Error('agent homes unavailable');
				}
				return { claude: claudeHome, codex: codexHome, matchCwd: cwd };
			},
			beforeSummaryRead: async () => summaryReadCount++,
		}, new NullLogService());

		const [first, second] = await Promise.allSettled([service.list(createListRequest()), service.list(createListRequest())]);
		const retried = await service.list(createListRequest());

		assert.strictEqual(first.status, 'rejected');
		assert.strictEqual(second.status, 'rejected');
		assert.strictEqual(summaryReadCount, 1);
		assert.deepStrictEqual(retried.map(session => session.id), ['retry-after-rejection']);
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

	test('limits cold transcript searches across clients while only superseding the older client search', async () => {
		const transcriptPaths = Array.from({ length: 8 }, (_, index) => join(claudeProject, `limited-search-${index}.jsonl`));
		await Promise.all(transcriptPaths.map((transcriptPath, index) => writeLines(transcriptPath, [
			claudeMessage('user', `Limited search ${index}`),
			claudeMessage('assistant', `shared-cold-token-${index}`),
		])));
		const fourReadsStarted = new DeferredPromise<void>();
		const releaseReads = new DeferredPromise<void>();
		let activeReads = 0;
		let maxActiveReads = 0;
		const service = createService(async filePath => {
			activeReads++;
			maxActiveReads = Math.max(maxActiveReads, activeReads);
			if (activeReads >= 4) {
				fourReadsStarted.complete();
			}
			try {
				await releaseReads.p;
				return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
			} finally {
				activeReads--;
			}
		});
		const sessions = await listSessions(service);
		const firstClientCatalogIds = sessions.filter(session => /^limited-search-[0-3]$/.test(session.id)).map(session => session.catalogId);
		const secondClientCatalogIds = sessions.filter(session => /^limited-search-[4-7]$/.test(session.id)).map(session => session.catalogId);
		assert.strictEqual(firstClientCatalogIds.length, 4);
		assert.strictEqual(secondClientCatalogIds.length, 4);

		const olderFirstClientSearch = service.search('first-client', 'shared-cold-token', firstClientCatalogIds);
		const secondClientSearch = service.search('second-client', 'shared-cold-token', secondClientCatalogIds);
		await fourReadsStarted.p;
		const newestFirstClientSearch = service.search('first-client', '', firstClientCatalogIds);
		releaseReads.complete();
		const [olderFirstClientResult, newestFirstClientResult, secondClientResult] = await Promise.all([
			olderFirstClientSearch,
			newestFirstClientSearch,
			secondClientSearch,
		]);

		assert.deepStrictEqual({
			maxActiveReads,
			olderFirstClientResult,
			newestFirstClientResult: newestFirstClientResult.map(result => result.catalogId),
			secondClientResult: secondClientResult.map(result => ({ catalogId: result.catalogId, source: result.source })).sort((a, b) => a.catalogId.localeCompare(b.catalogId)),
		}, {
			maxActiveReads: 4,
			olderFirstClientResult: [],
			newestFirstClientResult: firstClientCatalogIds,
			secondClientResult: secondClientCatalogIds.map(catalogId => ({ catalogId, source: 'conversation' })).sort((a, b) => a.catalogId.localeCompare(b.catalogId)),
		});
	});

	test('preserves search source snippet and match count for metadata and conversation terms', async () => {
		const transcriptPath = join(claudeProject, 'search-golden.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Metadata phrase'),
			claudeMessage('assistant', 'Conversation-only phrase'),
		]);
		const service = createService();
		const [session] = await listSessions(service);

		const metadata = await service.search('golden-metadata', 'metadata phrase', [session.catalogId]);
		const conversation = await service.search('golden-conversation', 'conversation-only', [session.catalogId]);
		const mixed = await service.search('golden-mixed', 'metadata conversation-only', [session.catalogId]);
		const duplicate = await service.search('golden-duplicate', 'conversation-only conversation-only', [session.catalogId]);

		assert.deepStrictEqual({ metadata, conversation, mixed, duplicate }, {
			metadata: [{
				catalogId: session.catalogId,
				matchCount: 4,
				snippet: `${session.title} ${session.preview} ${session.cwd} ${session.id} ${session.spaceName}`,
				source: 'metadata',
			}],
			conversation: [{
				catalogId: session.catalogId,
				matchCount: 1,
				snippet: 'Metadata phrase Conversation-only phrase',
				source: 'conversation',
			}],
			mixed: [{
				catalogId: session.catalogId,
				matchCount: 4,
				snippet: 'Metadata phrase Conversation-only phrase',
				source: 'conversation',
			}],
			duplicate: [{
				catalogId: session.catalogId,
				matchCount: 2,
				snippet: 'Metadata phrase Conversation-only phrase',
				source: 'conversation',
			}],
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

	test('evicts only the least recently used search text and keeps preview available', async () => {
		const firstPath = join(claudeProject, 'search-cache-first.jsonl');
		const secondPath = join(claudeProject, 'search-cache-second.jsonl');
		const thirdPath = join(claudeProject, 'search-cache-third.jsonl');
		await Promise.all([
			writeLines(firstPath, [claudeMessage('user', 'First prompt'), claudeMessage('assistant', 'conversation-a')]),
			writeLines(secondPath, [claudeMessage('user', 'Second prompt'), claudeMessage('assistant', 'conversation-b')]),
			writeLines(thirdPath, [claudeMessage('user', 'Third prompt'), claudeMessage('assistant', 'conversation-c')]),
		]);
		const transcriptReads = new Map<string, number>();
		const service = createService(undefined, undefined, async filePath => {
			transcriptReads.set(filePath, (transcriptReads.get(filePath) ?? 0) + 1);
		}, 120);
		const sessions = await listSessions(service);
		const first = sessions.find(session => session.id === 'search-cache-first');
		const second = sessions.find(session => session.id === 'search-cache-second');
		const third = sessions.find(session => session.id === 'search-cache-third');
		assert.ok(first);
		assert.ok(second);
		assert.ok(third);

		await service.search('cache-a', 'conversation-a', [first.catalogId]);
		await service.search('cache-b', 'conversation-b', [second.catalogId]);
		await service.search('cache-a-hit', 'conversation-a', [first.catalogId]);
		await service.search('cache-c', 'conversation-c', [third.catalogId]);
		const preview = await service.preview(second.catalogId);
		await service.search('cache-b-reread', 'conversation-b', [second.catalogId]);

		assert.deepStrictEqual({
			first: transcriptReads.get(firstPath),
			second: transcriptReads.get(secondPath),
			third: transcriptReads.get(thirdPath),
			preview: preview.messages.map(message => message.text),
		}, {
			first: 1,
			second: 3,
			third: 1,
			preview: ['Second prompt', 'conversation-b'],
		});
	});

	test('retries a transient transcript read failure on the next search', async () => {
		const transcriptPath = join(claudeProject, 'search-retry.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Retry prompt'),
			claudeMessage('assistant', 'retry-token appears only in the conversation'),
		]);
		let reads = 0;
		const service = createService(async filePath => {
			reads++;
			if (reads === 1) {
				throw new Error('temporary read failure');
			}
			return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
		});
		const [session] = await listSessions(service);

		const failed = await service.search('retry-client', 'retry-token', [session.catalogId]);
		const retried = await service.search('retry-client', 'retry-token', [session.catalogId]);

		assert.deepStrictEqual({ failed, retried: retried.map(result => ({ catalogId: result.catalogId, source: result.source })), reads }, {
			failed: [],
			retried: [{ catalogId: session.catalogId, source: 'conversation' }],
			reads: 2,
		});
	});

	test('does not publish an old revision search read after the catalog entry is refreshed', async () => {
		const transcriptPath = join(claudeProject, 'search-revision-race.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Revision prompt'),
			claudeMessage('assistant', 'old-revision-token'),
		]);
		const readStarted = new DeferredPromise<void>();
		const releaseRead = new DeferredPromise<void>();
		let blocked = true;
		let reads = 0;
		const service = createService(undefined, undefined, async () => {
			reads++;
			if (blocked) {
				readStarted.complete();
				await releaseRead.p;
			}
		});
		const [oldSession] = await listSessions(service);
		const oldSearch = service.search('old-revision', 'old-revision-token', [oldSession.catalogId]);
		await readStarted.p;
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Revision prompt'),
			claudeMessage('assistant', 'new-revision-token'),
		]);
		const nextTimestamp = new Date(oldSession.updatedAt + 2_000);
		await fs.utimes(transcriptPath, nextTimestamp, nextTimestamp);
		const [newSession] = await listSessions(service);
		assert.strictEqual(newSession.catalogId, oldSession.catalogId);
		assert.notStrictEqual(newSession.updatedAt, oldSession.updatedAt);

		releaseRead.complete();
		await oldSearch;
		blocked = false;
		const refreshed = await service.search('new-revision', 'new-revision-token', [newSession.catalogId]);

		assert.deepStrictEqual({
			refreshed: refreshed.map(result => ({ catalogId: result.catalogId, source: result.source })),
			reads,
		}, {
			refreshed: [{ catalogId: newSession.catalogId, source: 'conversation' }],
			reads: 2,
		});
	});

	test('does not publish a removed entry read into a replacement with the same revision', async () => {
		const transcriptPath = join(claudeProject, 'search-catalog-replacement-race.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Catalog replacement prompt')]);
		const staleText = [
			claudeMessage('user', 'Catalog replacement prompt'),
			claudeMessage('assistant', 'stale-catalog-token'),
		].join('\n');
		const freshText = [
			claudeMessage('user', 'Catalog replacement prompt'),
			claudeMessage('assistant', 'fresh-catalog-token'),
		].join('\n');
		const readStarted = new DeferredPromise<void>();
		const releaseRead = new DeferredPromise<void>();
		let transcriptReads = 0;
		const service = createService(async () => {
			transcriptReads++;
			if (transcriptReads === 1) {
				readStarted.complete();
				await releaseRead.p;
				return { text: staleText, truncated: false };
			}
			return { text: freshText, truncated: false };
		});
		const [oldSession] = await listSessions(service);
		const oldSearch = service.search('old-catalog-entry', 'stale-catalog-token', [oldSession.catalogId]);
		await readStarted.p;

		const internals = service as unknown as {
			readonly catalog: Map<string, { readonly touchedAt: number }>;
			trimCatalog(protectedCatalogIds: ReadonlySet<string>): void;
		};
		for (let index = 0; index < 2400; index++) {
			internals.catalog.set(`replacement-filler-${index}`, { touchedAt: Number.MAX_SAFE_INTEGER });
		}
		internals.trimCatalog(new Set());
		assert.strictEqual(internals.catalog.has(oldSession.catalogId), false);
		const [replacement] = await listSessions(service);
		assert.strictEqual(replacement.catalogId, oldSession.catalogId);
		assert.strictEqual(replacement.updatedAt, oldSession.updatedAt);

		releaseRead.complete();
		await oldSearch;
		const fresh = await service.search('replacement-catalog-entry', 'fresh-catalog-token', [replacement.catalogId]);

		assert.deepStrictEqual({
			fresh: fresh.map(result => ({ catalogId: result.catalogId, source: result.source })),
			transcriptReads,
		}, {
			fresh: [{ catalogId: replacement.catalogId, source: 'conversation' }],
			transcriptReads: 2,
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
