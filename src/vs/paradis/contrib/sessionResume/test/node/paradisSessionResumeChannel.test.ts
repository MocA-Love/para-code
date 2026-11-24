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
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisResumeListRequest, IParadisResumeSpace, paradisAgentResumeCommandLine, paradisAntigravityModelParts, paradisResumeModelLabel } from '../../common/paradisSessionResume.js';
import { ParadisSessionResumeChannel, ParadisSessionResumeService } from '../../node/paradisSessionResumeChannel.js';

const nodeRequire = createRequire(import.meta.url);
type IParadisSessionResumeServiceDependencies = NonNullable<ConstructorParameters<typeof ParadisSessionResumeService>[0]>;

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
		const dependencies: IParadisSessionResumeServiceDependencies = {
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, matchCwd: cwd }),
			paraCodeDirectory: join(root, 'para-code'),
			readBoundedFile,
			beforeSummaryRead,
			beforeTranscriptRead,
			searchCacheMaxBytes,
		};
		return new ParadisSessionResumeService(dependencies, new NullLogService());
	}

	function createListRequest(space: Partial<IParadisResumeSpace<string>> = {}, includeArchived = false): IParadisResumeListRequest<string> {
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
			database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
			database.exec(schema);
			populate?.(database);
		} finally {
			database.close();
		}
	}

	test('marks sessions without a prompt as empty and returns the log path and the full first prompt as details', async () => {
		const longPrompt = `First prompt ${'x'.repeat(20_000)}`;
		const withPrompt = join(claudeProject, 'with-prompt.jsonl');
		const emptySession = join(claudeProject, 'empty-session.jsonl');
		await Promise.all([
			writeLines(withPrompt, [claudeMessage('user', longPrompt), claudeMessage('assistant', 'Done')]),
			writeLines(emptySession, [JSON.stringify({ type: 'summary', summary: 'nothing' })]),
		]);
		const service = createService();
		const sessions = await listSessions(service);
		const byId = new Map(sessions.map(session => [session.id, session]));
		const details = await service.details(byId.get('with-prompt')!.catalogId);
		assert.deepStrictEqual({
			empty: { withPrompt: byId.get('with-prompt')?.empty, emptySession: byId.get('empty-session')?.empty },
			details: { transcriptPath: details.transcriptPath, firstPromptLength: details.firstPrompt?.length },
			unknown: await service.details('session-unknown').then(() => 'resolved', (error: Error) => error.message),
		}, {
			empty: { withPrompt: false, emptySession: true },
			details: { transcriptPath: withPrompt, firstPromptLength: longPrompt.length },
			unknown: 'Session is no longer available.',
		});
	});

	test('lists top-level Antigravity CLI conversations of the space from its conversation list, with the model split from its effort', async () => {
		// agy 1.5.9 の conversation_summaries の列のうち使うものと、transcript_full.jsonl の行の種類（中身は自作の偽物）
		const cliHome = join(root, 'agy-home', '.gemini', 'antigravity-cli');
		const brain = join(cliHome, 'brain');
		const top = '11111111-1111-4111-8111-111111111111';
		const child = '22222222-2222-4222-8222-222222222222';
		const elsewhere = '33333333-3333-4333-8333-333333333333';
		const noTranscript = '44444444-4444-4444-8444-444444444444';
		const untitled = '55555555-5555-4555-8555-555555555555';
		const transcriptOf = (id: string) => join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl');
		const step = (index: number, source: string, type: string, extra: Record<string, unknown>) => JSON.stringify({ step_index: index, source, type, status: 'DONE', created_at: `2026-11-16T01:00:0${index}Z`, ...extra });
		await fs.mkdir(cliHome, { recursive: true });
		for (const id of [top, child, elsewhere, untitled]) {
			await fs.mkdir(join(brain, id, '.system_generated', 'logs'), { recursive: true });
		}
		await writeLines(transcriptOf(top), [
			step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nFix the fake parser\n</USER_REQUEST>\n<ADDITIONAL_METADATA>fake</ADDITIONAL_METADATA>' }),
			step(1, 'MODEL', 'PLANNER_RESPONSE', { model: 'gemini-4-hydrogen-medium', thinking: 'fake thinking', tool_calls: [{ name: 'view_file', args: { path: 'a' } }] }),
			step(2, 'MODEL', 'GENERIC', { content: 'fake tool output' }),
			step(3, 'MODEL', 'PLANNER_RESPONSE', { model: 'gemini-3.8-flash-high', content: 'Fixed the fake parser' }),
			step(4, 'SYSTEM', 'ERROR_MESSAGE', { error: 'fake error' }),
		]);
		await writeLines(transcriptOf(child), [step(0, 'SYSTEM', 'SYSTEM_MESSAGE', { content: 'fake child instruction' })]);
		await writeLines(transcriptOf(elsewhere), [step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>other folder</USER_REQUEST>' })]);
		await writeLines(transcriptOf(untitled), [step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>Untitled fake request</USER_REQUEST>' })]);
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(join(cliHome, 'conversation_summaries.db'));
		try {
			database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
			database.exec('CREATE TABLE `conversation_summaries` (`conversation_id` text, `title` text NOT NULL DEFAULT "", `preview` text NOT NULL DEFAULT "", `step_count` integer NOT NULL DEFAULT 0, `last_modified_time` datetime NOT NULL, `workspace_uris` text NOT NULL, `parent_conversation_id` text NOT NULL DEFAULT "", `nesting_depth` integer NOT NULL DEFAULT 0, `raw_summary` blob, PRIMARY KEY (`conversation_id`))');
			const insert = database.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?)');
			const inWorkspace = JSON.stringify([URI.file(join(workspace, 'packages', 'app')).toString()]);
			insert.run(top, 'Fake parser fix', 'Fix the fake', '2026-11-16 01:00:04.123456789+00:00', inWorkspace, '', 0);
			insert.run(child, '', '', '2026-11-16 01:00:05.000000000+00:00', inWorkspace, top, 1);
			insert.run(elsewhere, 'Elsewhere', '', '2026-11-16 01:00:06.000000000+00:00', JSON.stringify([URI.file(join(root, 'other')).toString()]), '', 0);
			insert.run(noTranscript, 'No record', '', '2026-11-16 01:00:07.000000000+00:00', inWorkspace, '', 0);
			insert.run(untitled, '', '', '2026-11-16 00:59:00.000000000+00:00', inWorkspace, '', 0);
		} finally {
			database.close();
		}
		const service = createService();
		const sessions = (await listSessions(service)).filter(session => session.agent === 'antigravity');
		const session = sessions.find(candidate => candidate.id === top)!;
		const preview = await service.preview(session.catalogId);
		const details = await service.details(session.catalogId);
		const search = await service.search('client', 'tool output', [session.catalogId]);
		const found = await service.search('client', 'fixed the fake', [session.catalogId]);
		assert.deepStrictEqual({
			listed: sessions.map(candidate => [candidate.id, candidate.title, candidate.preview, candidate.empty]),
			row: { updatedAt: session.updatedAt, createdAt: session.createdAt, model: session.model, effort: session.effort, label: paradisResumeModelLabel(session), latestMessage: session.latestMessage, spaceStateKey: session.spaceStateKey },
			preview: preview.messages.map(message => [message.role, message.text]),
			firstPrompt: details.firstPrompt,
			search: { toolOutput: search.length, conversation: found.map(match => match.source) },
		}, {
			listed: [[top, 'Fake parser fix', 'Fix the fake parser', false], [untitled, 'Untitled fake request', 'Untitled fake request', false]],
			row: { updatedAt: Date.parse('2026-11-16T01:00:04.123Z'), createdAt: Date.parse('2026-11-16T01:00:00Z'), model: 'gemini-3.8-flash', effort: 'high', label: 'gemini-3.8-flash · high', latestMessage: { role: 'assistant', text: 'Fixed the fake parser' }, spaceStateKey: 'workspace-state' },
			preview: [['user', 'Fix the fake parser'], ['assistant', 'Fixed the fake parser']],
			firstPrompt: 'Fix the fake parser',
			search: { toolOutput: 0, conversation: ['conversation'] },
		});
	});

	test('hides archived Antigravity CLI conversations unless archived ones are included, and keeps child conversations out either way', async () => {
		// agy 1.5.9 の conversations_fts の列（会話ごとの見出しの行は chunk_index = -1。中身は自作の偽物）
		const cliHome = join(root, 'agy-home', '.gemini', 'antigravity-cli');
		const brain = join(cliHome, 'brain');
		const active = '11111111-1111-4111-8111-111111111111';
		const archived = '22222222-2222-4222-8222-222222222222';
		const archivedChild = '33333333-3333-4333-8333-333333333333';
		const archivedBodyOnly = '44444444-4444-4444-8444-444444444444';
		const step = (type: string, content: string) => JSON.stringify({ step_index: 0, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'SYSTEM', type, status: 'DONE', created_at: '2026-11-16T01:00:00Z', content });
		for (const id of [active, archived, archivedChild, archivedBodyOnly]) {
			await fs.mkdir(join(brain, id, '.system_generated', 'logs'), { recursive: true });
			await writeLines(join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl'), [id === archivedChild ? step('SYSTEM_MESSAGE', 'fake child instruction') : step('USER_INPUT', `<USER_REQUEST>fake request ${id.slice(0, 1)}</USER_REQUEST>`)]);
		}
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(join(cliHome, 'conversation_summaries.db'));
		try {
			database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
			database.exec('CREATE TABLE `conversation_summaries` (`conversation_id` text, `title` text NOT NULL DEFAULT "", `preview` text NOT NULL DEFAULT "", `last_modified_time` datetime NOT NULL, `workspace_uris` text NOT NULL, `parent_conversation_id` text NOT NULL DEFAULT "", `nesting_depth` integer NOT NULL DEFAULT 0, PRIMARY KEY (`conversation_id`))');
			database.exec('CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, last_modified_time UNINDEXED, archived UNINDEXED, title, user_body, agent_body)');
			const summary = database.prepare('INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)');
			const inWorkspace = JSON.stringify([URI.file(workspace).toString()]);
			summary.run(active, 'Active fake', '2026-11-16 01:00:04.000000000+00:00', inWorkspace, '', 0);
			summary.run(archived, 'Archived fake', '2026-11-16 01:00:05.000000000+00:00', inWorkspace, '', 0);
			summary.run(archivedChild, 'Archived child fake', '2026-11-16 01:00:06.000000000+00:00', inWorkspace, archived, 1);
			summary.run(archivedBodyOnly, 'Body chunk fake', '2026-11-16 01:00:03.000000000+00:00', inWorkspace, '', 0);
			const chunk = database.prepare('INSERT INTO conversations_fts (conversation_id, chunk_index, last_modified_time, archived, title, user_body, agent_body) VALUES (?, ?, ?, ?, ?, ?, ?)');
			chunk.run(active, -1, '', 0, 'Active fake', '', '');
			chunk.run(active, 0, '', 0, '', 'fake', 'fake');
			chunk.run(archived, -1, '', 1, 'Archived fake', '', '');
			chunk.run(archived, 0, '', 1, '', 'fake', 'fake');
			chunk.run(archivedChild, -1, '', 1, 'Archived child fake', '', '');
			// 見出しの行ではアーカイブしていない会話（本文の区切りの印は見ない。agy の一覧と同じ）
			chunk.run(archivedBodyOnly, -1, '', 0, 'Body chunk fake', '', '');
			chunk.run(archivedBodyOnly, 0, '', 1, '', 'fake', 'fake');
		} finally {
			database.close();
		}
		const listed = async (includeArchived: boolean) => (await listSessions(createService(), includeArchived)).filter(session => session.agent === 'antigravity').map(session => [session.id, session.archived]);
		assert.deepStrictEqual({ hidden: await listed(false), included: await listed(true) }, {
			hidden: [[active, false], [archivedBodyOnly, false]],
			included: [[archived, true], [active, false], [archivedBodyOnly, false]],
		});
	});

	test('splits the effort off Antigravity CLI model ids and resumes with --conversation only', () => {
		assert.deepStrictEqual({
			flash: paradisAntigravityModelParts('gemini-3.8-flash-high'),
			oss: paradisAntigravityModelParts('gpt-oss-120b-medium'),
			thinking: paradisAntigravityModelParts('claude-opus-4-6-thinking'),
			resume: paradisAgentResumeCommandLine('antigravity', '11111111-1111-4111-8111-111111111111', 'resume'),
			fork: paradisAgentResumeCommandLine('antigravity', '11111111-1111-4111-8111-111111111111', 'fork'),
			bypass: paradisAgentResumeCommandLine('antigravity', '11111111-1111-4111-8111-111111111111', 'resume', { dangerouslyBypassPermissions: true }),
			option: paradisAgentResumeCommandLine('antigravity', '--help', 'resume'),
		}, {
			flash: { model: 'gemini-3.8-flash', effort: 'high' },
			oss: { model: 'gpt-oss-120b', effort: 'medium' },
			thinking: { model: 'claude-opus-4-6-thinking' },
			resume: 'agy --conversation 11111111-1111-4111-8111-111111111111',
			fork: undefined,
			bypass: undefined,
			option: undefined,
		});
	});

	test('titles Claude sessions by the /rename name over the automatic title, also when the name is past the head', async () => {
		const title = (kind: 'custom' | 'ai', text: string, sessionId: string) => JSON.stringify(kind === 'custom'
			? { type: 'custom-title', customTitle: text, sessionId }
			: { type: 'ai-title', aiTitle: text, sessionId });
		const padding = claudeMessage('assistant', 'x'.repeat(700 * 1024));
		const renamedShort = join(claudeProject, 'renamed-short.jsonl');
		const renamedLong = join(claudeProject, 'renamed-long.jsonl');
		const aiOnly = join(claudeProject, 'ai-only.jsonl');
		await Promise.all([
			writeLines(renamedShort, [title('ai', 'Old topic', 'renamed-short'), claudeMessage('user', 'Short prompt'), title('custom', 'My name', 'renamed-short'), title('ai', 'Newer topic', 'renamed-short')]),
			writeLines(renamedLong, [title('ai', 'Head topic', 'renamed-long'), claudeMessage('user', 'Long prompt'), padding, title('custom', 'Late name', 'renamed-long'), title('ai', 'Tail topic', 'renamed-long')]),
			writeLines(aiOnly, [claudeMessage('user', 'Plain prompt'), padding, title('ai', 'Tail only topic', 'ai-only')]),
		]);
		const sessions = await listSessions(createService());
		const byId = new Map(sessions.map(session => [session.id, { title: session.title, preview: session.preview }]));
		assert.deepStrictEqual(Object.fromEntries(['renamed-short', 'renamed-long', 'ai-only'].map(id => [id, byId.get(id)])), {
			'renamed-short': { title: 'My name', preview: 'Short prompt' },
			'renamed-long': { title: 'Late name', preview: 'Long prompt' },
			'ai-only': { title: 'Tail only topic', preview: 'Plain prompt' },
		});
	});

	test('reads Code Mode from the last repl-mode line of a Claude session, in the list and by id, and writes the resume settings file only on request', async () => {
		const replMode = (value: boolean, sessionId: string) => JSON.stringify({ type: 'repl-mode', replMode: value, sessionId });
		const padding = claudeMessage('assistant', 'x'.repeat(700 * 1024));
		// 別のフォルダで始めた会話（今のスペースのフォルダには無い）
		const otherProject = join(claudeHome, 'projects', '-somewhere-else');
		await fs.mkdir(otherProject, { recursive: true });
		await Promise.all([
			writeLines(join(claudeProject, 'code-mode.jsonl'), [replMode(true, 'code-mode'), claudeMessage('user', 'Prompt')]),
			writeLines(join(claudeProject, 'code-mode-long.jsonl'), [replMode(true, 'code-mode-long'), claudeMessage('user', 'Prompt'), padding, replMode(true, 'code-mode-long')]),
			writeLines(join(claudeProject, 'turned-off.jsonl'), [replMode(true, 'turned-off'), claudeMessage('user', 'Prompt'), padding, replMode(false, 'turned-off')]),
			writeLines(join(claudeProject, 'ordinary.jsonl'), [claudeMessage('user', 'A prompt that mentions "repl-mode" and replMode true')]),
			writeLines(join(otherProject, 'elsewhere.jsonl'), [replMode(true, 'elsewhere'), claudeMessage('user', 'Prompt')]),
		]);
		const service = createService();
		const listed = new Map((await listSessions(service)).map(session => [session.id, session.codeMode]));
		const settingsFile = join(root, 'para-code', 'claude-code-mode-resume.settings.json');
		const beforeRequest = await fs.readFile(settingsFile, 'utf8').catch(() => undefined);
		const profiles = {
			codeMode: await service.claudeResumeProfile('code-mode', workspace, false),
			codeModeLong: await service.claudeResumeProfile('code-mode-long', workspace, false),
			turnedOff: await service.claudeResumeProfile('turned-off', workspace, true),
			ordinary: await service.claudeResumeProfile('ordinary', workspace, true),
			elsewhere: await service.claudeResumeProfile('elsewhere', workspace, false),
			withoutCwd: await service.claudeResumeProfile('elsewhere', undefined, false),
			missing: await service.claudeResumeProfile('missing', workspace, true),
			optionLikeId: await service.claudeResumeProfile('../code-mode', workspace, true),
		};
		const afterPlainRequests = await fs.readFile(settingsFile, 'utf8').catch(() => undefined);
		// renderer と同じ形（IPC のチャネル）で頼む
		const withFile = await new ParadisSessionResumeChannel(service).call('client', 'claudeResumeProfile', ['code-mode', workspace, true]);
		assert.deepStrictEqual({
			listed: Object.fromEntries(['code-mode', 'code-mode-long', 'turned-off', 'ordinary'].map(id => [id, listed.get(id)])),
			profiles, beforeRequest, afterPlainRequests, withFile,
			written: await fs.readFile(settingsFile, 'utf8'),
		}, {
			listed: { 'code-mode': true, 'code-mode-long': true, 'turned-off': undefined, 'ordinary': undefined },
			profiles: {
				codeMode: { codeMode: true },
				codeModeLong: { codeMode: true },
				turnedOff: { codeMode: false },
				ordinary: { codeMode: false },
				elsewhere: { codeMode: true },
				withoutCwd: { codeMode: true },
				missing: { codeMode: false },
				optionLikeId: { codeMode: false },
			},
			beforeRequest: undefined,
			afterPlainRequests: undefined,
			withFile: { codeMode: true, settingsFile },
			written: '{"env":{"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA":"0","ENABLE_BETA_TRACING_DETAILED":"0","CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"1"}}\n',
		});
	});

	test('takes the last model of a Claude session from the lines it already reads, also when the model is only in the tail', async () => {
		const assistant = (model: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'Reply' }] }, ...extra });
		const padding = claudeMessage('user', 'x'.repeat(700 * 1024));
		await Promise.all([
			writeLines(join(claudeProject, 'switched-short.jsonl'), [claudeMessage('user', 'Prompt'), assistant('claude-opus-5-5[1m]'), assistant('claude-fable-5-1'), assistant('<synthetic>')]),
			writeLines(join(claudeProject, 'switched-long.jsonl'), [claudeMessage('user', 'Prompt'), assistant('claude-opus-5-5'), padding, assistant('claude-fable-5-1'), assistant('claude-haiku-5-5', { isSidechain: true })]),
			writeLines(join(claudeProject, 'no-reply.jsonl'), [claudeMessage('user', 'Prompt'), assistant('<synthetic>')]),
		]);
		const sessions = await listSessions(createService());
		const byId = new Map(sessions.map(session => [session.id, { model: session.model, effort: session.effort }]));
		assert.deepStrictEqual(Object.fromEntries(['switched-short', 'switched-long', 'no-reply'].map(id => [id, byId.get(id)])), {
			'switched-short': { model: 'claude-fable-5-1', effort: undefined },
			'switched-long': { model: 'claude-fable-5-1', effort: undefined },
			'no-reply': { model: undefined, effort: undefined },
		});
	});

	test('takes the model and effort of a Codex session from the state DB, or from the rollout turn_context without one', async () => {
		const indexedPath = join(codexSessions, 'rollout-indexed-model.jsonl');
		const rolloutPath = join(codexSessions, 'rollout-rollout-model.jsonl');
		const turnContext = (model: string, effort: string) => JSON.stringify({ type: 'turn_context', payload: { model, effort } });
		await Promise.all([
			writeLines(indexedPath, [codexMessage('user', 'Indexed prompt')]),
			writeLines(rolloutPath, [
				JSON.stringify({ type: 'session_meta', payload: { id: 'rollout-model', cwd: workspace } }),
				turnContext('gpt-6-astra', 'medium'),
				codexMessage('user', 'Rollout prompt'),
				turnContext('gpt-6.1-sol', 'high'),
			]),
		]);
		const rolloutModel = (await listSessions(createService())).map(session => ({ id: session.id, model: session.model, effort: session.effort }));
		createCodexDatabase(`
			CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, rollout_path TEXT NOT NULL, title TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, model TEXT, reasoning_effort TEXT)
		`, database => {
			const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
			insert.run('indexed-model', workspace, indexedPath, 'With model', 2_000, 'gpt-6.1-sol', 'xhigh');
			insert.run('indexed-no-model', workspace, indexedPath.replace('indexed-model', 'indexed-no-model'), 'Without model', 1_000, null, 'high');
		});
		await writeLines(indexedPath.replace('indexed-model', 'indexed-no-model'), [codexMessage('user', 'No model prompt')]);
		const indexedModel = (await listSessions(createService())).map(session => ({ id: session.id, model: session.model, effort: session.effort }));
		assert.deepStrictEqual({ rolloutModel, indexedModel }, {
			rolloutModel: [{ id: 'rollout-model', model: 'gpt-6.1-sol', effort: 'high' }],
			indexedModel: [
				{ id: 'indexed-model', model: 'gpt-6.1-sol', effort: 'xhigh' },
				{ id: 'indexed-no-model', model: undefined, effort: undefined },
			],
		});
	});

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

	test('attaches the newest conversation message to listed sessions', async () => {
		const transcriptPath = join(claudeProject, 'latest-message.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'First prompt', '2026-08-13T01:00:00.000Z'),
			claudeMessage('assistant', 'Newest reply\ntext', '2026-08-13T02:00:00.000Z'),
		]);

		const [session] = await listSessions(createService());

		assert.deepStrictEqual(session.latestMessage, { role: 'assistant', text: 'Newest reply text' });
	});

	test('falls back to the first prompt without latestMessage when the tail read fails', async () => {
		const transcriptPath = join(claudeProject, 'failing-tail.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Fallback prompt'),
			claudeMessage('assistant', 'Unreachable reply'),
		]);
		let summaryReads = 0;
		const service = createService(undefined, async filePath => {
			if (filePath === transcriptPath && ++summaryReads === 2) {
				throw new Error('tail read failed');
			}
		});

		const [session] = await listSessions(service);

		assert.strictEqual(session.latestMessage, undefined);
		assert.strictEqual(session.preview, 'Fallback prompt');
	});

	test('retries a failed tail read on the next refresh instead of caching the failure', async () => {
		const transcriptPath = join(claudeProject, 'recovered-tail.jsonl');
		await writeLines(transcriptPath, [
			claudeMessage('user', 'Recovered prompt'),
			claudeMessage('assistant', 'Recovered reply'),
		]);
		let transcriptReads = 0;
		let failedTailReads = 0;
		const service = createService(undefined, async filePath => {
			if (filePath !== transcriptPath) {
				return;
			}
			transcriptReads++;
			if (transcriptReads === 2) {
				failedTailReads++;
				throw new Error('temporary tail failure');
			}
		});

		const [first] = await listSessions(service);
		assert.strictEqual(first.latestMessage, undefined);
		const [second] = await listSessions(service);

		assert.strictEqual(failedTailReads, 1);
		assert.deepStrictEqual(second.latestMessage, { role: 'assistant', text: 'Recovered reply' });
	});

	test('skips tail rereads while catalogId and updatedAt stay unchanged and rereads after an update', async () => {
		const transcriptPath = join(claudeProject, 'cached-latest.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Cached prompt')]);
		let transcriptReads = 0;
		const service = createService(undefined, async () => {
			transcriptReads++;
		});

		const [first] = await listSessions(service);
		assert.strictEqual(transcriptReads, 2); // 概要(head)と最新メッセージ(tail)
		const unchanged = await listSessions(service);
		assert.strictEqual(transcriptReads, 3); // head だけ再読し、tail はキャッシュで再読しない

		await writeLines(transcriptPath, [
			claudeMessage('user', 'Cached prompt'),
			claudeMessage('assistant', 'Refreshed reply'),
		]);
		const updatedTime = new Date(first.updatedAt + 5_000);
		await fs.utimes(transcriptPath, updatedTime, updatedTime);
		const refreshed = await listSessions(service);

		assert.strictEqual(transcriptReads, 5); // updatedAt が変わったため head と tail を再読する
		assert.deepStrictEqual(unchanged.map(session => session.latestMessage), [{ role: 'user', text: 'Cached prompt' }]);
		assert.deepStrictEqual(refreshed.map(session => session.latestMessage), [{ role: 'assistant', text: 'Refreshed reply' }]);
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

	// Codex 0.171（alpha）の保存したサイドチャットは threads に attached_thread_parent_id 付きの行を持つ（0.171.0-alpha.10 の
	// migrations/0062）。本会話の裏なので、アーカイブを含めても再開の一覧には出さない
	test('does not list a saved Codex side chat attached to a conversation', async () => {
		const mainPath = join(codexSessions, 'rollout-main-with-side-chat.jsonl');
		const sidePath = join(codexSessions, 'rollout-side-chat.jsonl');
		await writeLines(mainPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'main-with-side-chat', cwd: workspace } }),
			codexMessage('user', 'Main conversation'),
		]);
		await writeLines(sidePath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'side-chat', cwd: workspace, forked_from_id: 'main-with-side-chat', attached_thread: true } }),
			codexMessage('user', 'Side question'),
		]);
		createCodexDatabase(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				rollout_path TEXT NOT NULL,
				title TEXT NOT NULL,
				archived INTEGER NOT NULL,
				attached_thread_parent_id TEXT
			)
		`, database => {
			const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)');
			insert.run('main-with-side-chat', workspace, mainPath, 'Main title', 0, null);
			insert.run('side-chat', workspace, sidePath, 'Side title', 0, 'main-with-side-chat');
		});
		const service = createService();

		assert.deepStrictEqual({
			visible: (await listSessions(service)).map(session => session.id),
			includingArchived: (await listSessions(service, true)).map(session => session.id),
		}, {
			visible: ['main-with-side-chat'],
			includingArchived: ['main-with-side-chat'],
		});
	});

	test('reads the Codex index page by page and still finds an older conversation of the space behind many others', async () => {
		const olderPath = join(codexSessions, 'rollout-older-db-session.jsonl');
		await writeLines(olderPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'older-db-session', cwd: workspace } }),
			codexMessage('user', 'Older conversation'),
		]);
		createCodexDatabase(`
			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				rollout_path TEXT NOT NULL,
				title TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL
			)
		`, database => {
			const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
			// ほかのフォルダの新しい会話が 1 ページ（200 行）より多く並ぶ
			database.exec('BEGIN');
			for (let index = 0; index < 450; index++) {
				insert.run(`other-${index}`, join(workspace, '..', 'elsewhere'), join(codexSessions, `rollout-other-${index}.jsonl`), `Other ${index}`, 10_000 + index);
			}
			database.exec('COMMIT');
			insert.run('older-db-session', workspace, olderPath, 'Older database title', 1_000);
		});

		const sessions = await listSessions(createService());

		assert.deepStrictEqual(sessions.map(session => ({ id: session.id, title: session.title })), [{ id: 'older-db-session', title: 'Older database title' }]);
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

		// 共有された1スキャンの概要(head)と最新メッセージ(tail)で計2読。
		assert.strictEqual(summaryReadCount, 2);
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

			// 両スキャンが同一ファイルを指すため、先に走った側の tail だけ読まれ(3読目)、
			// もう片方は catalogId+updatedAt キャッシュで再読を skip する。
			assert.strictEqual(summaryReadCount, 3);
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

		const primarySpace: IParadisResumeSpace<string> = { stateKey: 'workspace-state', name: 'Fixture Workspace', cwd: workspace, current: true };
		const secondarySpace: IParadisResumeSpace<string> = { stateKey: 'secondary-state', name: 'Secondary Workspace', cwd: secondaryWorkspace, current: false };
		// 各スキャンは概要(head)と最新メッセージ(tail)を読む。同一 transcript への2回目の
		// tail は catalogId+updatedAt キャッシュで skip されるため、同一ファイルの組は +1、
		// 異なるファイルの組は +2、両ファイルを跨ぐ space order は (head×4 + tail×2) = 6。
		const cases: readonly { readonly name: string; readonly first: IParadisResumeListRequest<string>; readonly second: IParadisResumeListRequest<string>; readonly expectedSummaryReads: number }[] = [
			{ name: 'state key', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, stateKey: 'other-state' }], includeArchived: false }, expectedSummaryReads: 3 },
			{ name: 'name', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, name: 'Other Workspace' }], includeArchived: false }, expectedSummaryReads: 3 },
			{ name: 'cwd', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [secondarySpace], includeArchived: false }, expectedSummaryReads: 4 },
			{ name: 'current', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [{ ...primarySpace, current: false }], includeArchived: false }, expectedSummaryReads: 3 },
			{ name: 'includeArchived', first: { spaces: [primarySpace], includeArchived: false }, second: { spaces: [primarySpace], includeArchived: true }, expectedSummaryReads: 3 },
			{ name: 'space order', first: { spaces: [primarySpace, secondarySpace], includeArchived: false }, second: { spaces: [secondarySpace, primarySpace], includeArchived: false }, expectedSummaryReads: 6 },
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
		const service = createService(undefined, async () => {
			summaryReadCount++;
		});

		await service.list(createListRequest());
		await service.list(createListRequest());

		// 1回目: head + tail。2回目: head のみ(tail は updatedAt 不変のためキャッシュ再利用)。
		assert.strictEqual(summaryReadCount, 3);
	});

	test('cleans a rejected active list request so a later request retries', async () => {
		const transcriptPath = join(claudeProject, 'retry-after-rejection.jsonl');
		await writeLines(transcriptPath, [claudeMessage('user', 'Retry after rejection')]);
		let resolveHomesCount = 0;
		let summaryReadCount = 0;
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => {
				resolveHomesCount++;
				if (resolveHomesCount === 1) {
					throw new Error('agent homes unavailable');
				}
				return { claude: claudeHome, codex: codexHome, matchCwd: cwd };
			},
			beforeSummaryRead: async () => {
				summaryReadCount++;
			},
		}, new NullLogService());

		const [first, second] = await Promise.allSettled([service.list(createListRequest()), service.list(createListRequest())]);
		const retried = await service.list(createListRequest());

		assert.strictEqual(first.status, 'rejected');
		assert.strictEqual(second.status, 'rejected');
		// 再試行した1スキャンの head + tail。
		assert.strictEqual(summaryReadCount, 2);
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

	test('starts queued transcript reads after a saturated cold read rejects', async () => {
		const transcriptPaths = Array.from({ length: 5 }, (_, index) => join(claudeProject, `rejected-limiter-${index}.jsonl`));
		await Promise.all(transcriptPaths.map((transcriptPath, index) => writeLines(transcriptPath, [
			claudeMessage('user', `Rejected limiter ${index}`),
			claudeMessage('assistant', 'rejected-limiter-token'),
		])));
		const fourReadsStarted = new DeferredPromise<void>();
		const fifthReadStarted = new DeferredPromise<void>();
		const releaseFailingRead = new DeferredPromise<void>();
		const releaseOtherReads = new DeferredPromise<void>();
		const startedPaths: string[] = [];
		const blockingRead = { paths: new Set<string>(), failingPath: undefined as string | undefined };
		let failureReleased = false;
		let activeReads = 0;
		let maxActiveReads = 0;
		const service = createService(async filePath => {
			if (!blockingRead.paths.has(filePath)) {
				assert.strictEqual(failureReleased, true);
				fifthReadStarted.complete();
				return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
			}
			activeReads++;
			maxActiveReads = Math.max(maxActiveReads, activeReads);
			startedPaths.push(filePath);
			if (startedPaths.length === 4) {
				fourReadsStarted.complete();
			}
			try {
				if (filePath === blockingRead.failingPath) {
					await releaseFailingRead.p;
					failureReleased = true;
					throw new Error('expected cold read failure');
				}
				await releaseOtherReads.p;
				return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
			} finally {
				activeReads--;
			}
		});
		const sessions = await listSessions(service);
		const catalogIds = sessions.map(session => session.catalogId);
		blockingRead.paths = new Set(sessions.slice(0, 4).map(session => join(claudeProject, `${session.id}.jsonl`)));
		blockingRead.failingPath = join(claudeProject, `${sessions[0].id}.jsonl`);
		assert.ok(blockingRead.failingPath);

		const search = service.search('rejected-limiter-client', 'rejected-limiter-token', catalogIds);
		await fourReadsStarted.p;
		releaseFailingRead.complete();
		try {
			const fifthStartedBeforeOtherReads = await Promise.race([
				fifthReadStarted.p.then(() => true),
				new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
			]);
			assert.strictEqual(fifthStartedBeforeOtherReads, true);
		} finally {
			releaseOtherReads.complete();
		}
		const results = await search;

		assert.deepStrictEqual({
			maxActiveReads,
			startedReads: startedPaths.length + 1,
			resultCount: results.length,
			resultSources: results.map(result => result.source),
		}, {
			maxActiveReads: 4,
			startedReads: 5,
			resultCount: 4,
			resultSources: ['conversation', 'conversation', 'conversation', 'conversation'],
		});
	});

	test('keeps metadata cache hit preview and list work outside saturated cold reads', async () => {
		const warmPath = join(claudeProject, 'limiter-warm.jsonl');
		const metadataPath = join(claudeProject, 'limiter-metadata.jsonl');
		const coldPaths = Array.from({ length: 4 }, (_, index) => join(claudeProject, `limiter-cold-${index}.jsonl`));
		await Promise.all([
			writeLines(warmPath, [claudeMessage('user', 'Warm title'), claudeMessage('assistant', 'warm-cache-token')]),
			writeLines(metadataPath, [claudeMessage('user', 'Metadata-only title'), claudeMessage('assistant', 'metadata body')]),
			...coldPaths.map((transcriptPath, index) => writeLines(transcriptPath, [
				claudeMessage('user', `Cold title ${index}`),
				claudeMessage('assistant', 'saturated-cold-token'),
			])),
		]);
		const fourColdReadsStarted = new DeferredPromise<void>();
		const releaseColdReads = new DeferredPromise<void>();
		let coldReadStarts = 0;
		const service = createService(async filePath => {
			if (coldPaths.includes(filePath)) {
				coldReadStarts++;
				if (coldReadStarts === 4) {
					fourColdReadsStarted.complete();
				}
				await releaseColdReads.p;
			}
			return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
		});
		const sessions = await listSessions(service);
		const warm = sessions.find(session => session.id === 'limiter-warm');
		const metadata = sessions.find(session => session.id === 'limiter-metadata');
		const coldCatalogIds = sessions.filter(session => /^limiter-cold-\d$/.test(session.id)).map(session => session.catalogId);
		assert.ok(warm);
		assert.ok(metadata);
		assert.strictEqual(coldCatalogIds.length, 4);
		await service.search('warm-cache-prime', 'warm-cache-token', [warm.catalogId]);

		const coldSearch = service.search('saturated-cold', 'saturated-cold-token', coldCatalogIds);
		await fourColdReadsStarted.p;
		try {
			const completedBeforeRelease = await Promise.race([
				Promise.all([
					service.search('metadata-fast-path', 'metadata-only title', [metadata.catalogId]),
					service.search('warm-cache-hit', 'warm-cache-token', [warm.catalogId]),
					service.preview(warm.catalogId),
					listSessions(service),
				]).then(() => true),
				new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
			]);
			assert.deepStrictEqual({ completedBeforeRelease, coldReadStarts }, { completedBeforeRelease: true, coldReadStarts: 4 });
		} finally {
			releaseColdReads.complete();
		}
		const coldResults = await coldSearch;
		assert.strictEqual(coldResults.length, 4);
	});

	test('uses text populated while waiting for a search permit without another physical read', async () => {
		const coldPaths = Array.from({ length: 4 }, (_, index) => join(claudeProject, `recheck-cold-${index}.jsonl`));
		const targetPath = join(claudeProject, 'recheck-target.jsonl');
		await Promise.all([
			...coldPaths.map((transcriptPath, index) => writeLines(transcriptPath, [
				claudeMessage('user', `Recheck cold ${index}`),
				claudeMessage('assistant', 'recheck-cold-token'),
			])),
			writeLines(targetPath, [claudeMessage('user', 'Recheck target'), claudeMessage('assistant', 'physical-read-token')]),
		]);
		const fourColdReadsStarted = new DeferredPromise<void>();
		const releaseColdReads = new DeferredPromise<void>();
		let coldReadStarts = 0;
		let targetReadStarts = 0;
		const service = createService(async filePath => {
			if (coldPaths.includes(filePath)) {
				coldReadStarts++;
				if (coldReadStarts === 4) {
					fourColdReadsStarted.complete();
				}
				await releaseColdReads.p;
			}
			if (filePath === targetPath) {
				targetReadStarts++;
			}
			return { text: await fs.readFile(filePath, 'utf8'), truncated: false };
		});
		const sessions = await listSessions(service);
		const coldCatalogIds = sessions.filter(session => /^recheck-cold-\d$/.test(session.id)).map(session => session.catalogId);
		const target = sessions.find(session => session.id === 'recheck-target');
		assert.strictEqual(coldCatalogIds.length, 4);
		assert.ok(target);

		const coldSearch = service.search('recheck-cold-client', 'recheck-cold-token', coldCatalogIds);
		await fourColdReadsStarted.p;
		const targetSearch = service.search('recheck-target-client', 'recheck-cache-token', [target.catalogId]);
		const internals = service as unknown as {
			readonly searchTextCache: { set(catalogId: string, revision: number, text: string): void };
		};
		// The public service shares same-entry reads; populate the cache as the valid prior owner seam while this entry waits.
		internals.searchTextCache.set(target.catalogId, target.updatedAt, 'recheck-cache-token');
		releaseColdReads.complete();
		const [coldResults, targetResults] = await Promise.all([coldSearch, targetSearch]);

		assert.deepStrictEqual({
			coldResults: coldResults.length,
			targetReadStarts,
			targetResults: targetResults.map(result => ({ catalogId: result.catalogId, source: result.source })),
		}, {
			coldResults: 4,
			targetReadStarts: 0,
			targetResults: [{ catalogId: target.catalogId, source: 'conversation' }],
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

	test('lists a conversation hard-linked into another Codex home only once', async () => {
		const secondHome = join(root, 'codex-home-2');
		const secondSessions = join(secondHome, 'sessions', '2026', '08', '13');
		await fs.mkdir(secondSessions, { recursive: true });
		const codexPath = join(codexSessions, 'rollout-codex-session.jsonl');
		await writeLines(codexPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		await fs.link(codexPath, join(secondSessions, 'rollout-codex-session.jsonl'));
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());

		const sessions = await service.list(createListRequest());

		assert.deepStrictEqual(sessions.map(session => [session.agent, session.id, session.codexHome]), [['codex', 'codex-session', codexHome]]);
	});

	test('keeps the hard-linked conversation of the selected Codex account home', async () => {
		const secondHome = join(root, 'codex-home-2');
		const secondSessions = join(secondHome, 'sessions', '2026', '08', '13');
		await fs.mkdir(secondSessions, { recursive: true });
		const codexPath = join(codexSessions, 'rollout-codex-session.jsonl');
		await writeLines(codexPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		const linkedPath = join(secondSessions, 'rollout-codex-session.jsonl');
		await fs.link(codexPath, linkedPath);
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());

		const selected = await service.list({ ...createListRequest(), preferredCodexHome: secondHome });
		// 選んでいるホームが一覧に無い（消えた）・既定のホームを選んでいるときは、既定のホームのもの
		const unknown = await service.list({ ...createListRequest(), preferredCodexHome: join(root, 'codex-home-9') });

		assert.deepStrictEqual({
			selected: selected.map(session => [session.id, session.codexHome]),
			unknown: unknown.map(session => [session.id, session.codexHome]),
		}, {
			selected: [['codex-session', secondHome]],
			unknown: [['codex-session', codexHome]],
		});
	});

	test('resumes a hard-linked conversation in the selected Codex home even when that home\'s state DB does not list it', async () => {
		const secondHome = join(root, 'codex-home-2');
		const secondSessions = join(secondHome, 'sessions', '2026', '08', '13');
		await fs.mkdir(secondSessions, { recursive: true });
		const codexPath = join(codexSessions, 'rollout-codex-session.jsonl');
		await writeLines(codexPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		await fs.link(codexPath, join(secondSessions, 'rollout-codex-session.jsonl'));
		// 選んだホームの state DB は、リンクで入った会話を知らない
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(join(secondHome, 'state_1.sqlite'));
		try {
			database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
			database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, updated_at INTEGER)');
		} finally {
			database.close();
		}
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());

		const sessions = await service.list({ ...createListRequest(), preferredCodexHome: secondHome });

		assert.deepStrictEqual(sessions.map(session => [session.id, session.codexHome]), [['codex-session', secondHome]]);
	});

	test('marks a conversation the selected Codex home does not have, and links it there on request', async () => {
		const secondHome = join(root, 'codex-home-2');
		await fs.mkdir(join(secondHome, 'sessions'), { recursive: true });
		const codexPath = join(codexSessions, 'rollout-codex-session.jsonl');
		await writeLines(codexPath, [
			JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());
		const request = { ...createListRequest(), preferredCodexHome: secondHome };

		const before = await service.list(request);
		const linkedHome = await service.linkCodexSession(before[0].catalogId, secondHome);
		const again = await service.linkCodexSession(before[0].catalogId, secondHome);
		const after = await service.list(request);
		const [original, linked] = await Promise.all([fs.stat(codexPath), fs.stat(join(secondHome, 'sessions', '2026', '08', '13', 'rollout-codex-session.jsonl'))]);

		assert.deepStrictEqual({
			before: before.map(session => [session.id, session.codexHome, session.otherCodexAccount]),
			linkedHome,
			again,
			sameFile: original.ino === linked.ino,
			after: after.map(session => [session.id, session.codexHome, session.otherCodexAccount]),
		}, {
			before: [['codex-session', codexHome, true]],
			linkedHome: secondHome,
			again: secondHome,
			sameFile: true,
			after: [['codex-session', secondHome, undefined]],
		});
	});

	test('refuses to link a conversation over a different file in the selected Codex home', async () => {
		const secondHome = join(root, 'codex-home-2');
		const secondSessions = join(secondHome, 'sessions', '2026', '08', '13');
		await fs.mkdir(secondSessions, { recursive: true });
		await writeLines(join(codexSessions, 'rollout-codex-session.jsonl'), [
			JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		await writeLines(join(secondSessions, 'rollout-codex-session.jsonl'), [JSON.stringify({ type: 'session_meta', payload: { id: 'another', cwd: '/elsewhere' } })]);
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());

		const [session] = await service.list({ ...createListRequest(), preferredCodexHome: secondHome });

		assert.deepStrictEqual(await service.linkCodexSession(session.catalogId, secondHome).then(() => 'linked', (error: NodeJS.ErrnoException) => error.code), 'EEXIST');
	});

	test('remembers the Codex home of a conversation that only another home has', async () => {
		const secondHome = join(root, 'codex-home-2');
		const secondSessions = join(secondHome, 'sessions', '2026', '08', '13');
		await fs.mkdir(secondSessions, { recursive: true });
		await writeLines(join(secondSessions, 'rollout-other-session.jsonl'), [
			JSON.stringify({ type: 'session_meta', payload: { id: 'other-session', cwd: workspace } }),
			codexMessage('user', 'Codex fixture prompt'),
		]);
		const service = new ParadisSessionResumeService({
			antigravityHome: join(root, 'agy-home'),
			openCodeDatabases: async () => [],
			resolveAgentHomes: cwd => ({ claude: claudeHome, codex: codexHome, codexHomes: [codexHome, secondHome], matchCwd: cwd }),
		}, new NullLogService());

		const sessions = await service.list(createListRequest());

		assert.deepStrictEqual(sessions.map(session => [session.id, session.codexHome]), [['other-session', secondHome]]);
	});
});
