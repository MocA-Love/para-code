/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisIsTaskBoardTerminalId,
	paradisParseTaskBoardAnswer,
	paradisParseTaskBoardAskHumanArgs,
	paradisParseTaskBoardCompleteStepArgs,
	paradisParseTaskBoardKey,
	paradisParseTaskBoardLaunch,
	paradisParseTaskBoardReply,
	paradisParseTaskBoardSend,
	paradisParseTaskBoardStatusReport,
	paradisTaskBoardBearerToken,
	paradisTaskBoardHttpStatus,
	paradisTaskBoardIsAllowedHost,
	paradisTaskBoardSamePath,
	paradisTaskBoardSendBlock,
	paradisTaskBoardSseData,
	paradisTaskBoardStatusFrom,
	paradisTaskBoardTerminalId,
	paradisTaskBoardToolDetail,
} from '../../common/paradisTaskBoardBridge.js';

const TERMINAL = 't_0123456789ab';

suite('ParadisTaskBoardBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('terminal ids are stable hashes of the pane token', () => {
		const id = paradisTaskBoardTerminalId('secret-token');
		assert.deepStrictEqual([paradisIsTaskBoardTerminalId(id), id === paradisTaskBoardTerminalId('secret-token'), id.includes('secret'), paradisIsTaskBoardTerminalId('t_XYZ')], [true, true, false, false]);
	});

	test('launch requests are validated', () => {
		const good = paradisParseTaskBoardLaunch({ launchId: 'L1', repoPath: '/Users/example/repo', agent: 'claude', prompt: 'do it', modelId: 'opus', extra: 1 });
		assert.deepStrictEqual(good, { ok: true, value: { launchId: 'L1', repoPath: '/Users/example/repo', agent: 'claude', prompt: 'do it', modelId: 'opus' } });
		const failures = [
			paradisParseTaskBoardLaunch({ launchId: 'L1', repoPath: 'relative/path', agent: 'claude', prompt: '' }),
			paradisParseTaskBoardLaunch({ launchId: 'L1', repoPath: '/x', agent: 'gemini', prompt: '' }),
			paradisParseTaskBoardLaunch({ launchId: '', repoPath: '/x', agent: 'codex', prompt: '' }),
			paradisParseTaskBoardLaunch({ launchId: 'L1', repoPath: '/x', agent: 'codex', prompt: 1 }),
			paradisParseTaskBoardLaunch({ launchId: 'L1', repoPath: '/x', agent: 'codex', prompt: '', modelId: 'a\nb' }),
			paradisParseTaskBoardLaunch([]),
		].map(result => result.ok);
		assert.deepStrictEqual(failures, [false, false, false, false, false, false]);
		assert.strictEqual(paradisParseTaskBoardLaunch({ launchId: 'L2', repoPath: 'C:\\work\\repo', agent: 'codex', prompt: '' }).ok, true);
	});

	test('send, key, answer and reply requests are validated', () => {
		assert.deepStrictEqual([
			paradisParseTaskBoardSend({ terminal: TERMINAL, text: 'hi' }),
			paradisParseTaskBoardSend({ terminal: TERMINAL, text: 'hi', submit: false }),
			paradisParseTaskBoardSend({ terminal: TERMINAL, text: '' }).ok,
			paradisParseTaskBoardSend({ terminal: 'nope', text: 'hi' }).ok,
			paradisParseTaskBoardKey({ terminal: TERMINAL, key: '3' }),
			paradisParseTaskBoardKey({ terminal: TERMINAL, key: 'f1' }).ok,
			paradisParseTaskBoardAnswer({ terminal: TERMINAL, kind: 'question', optionIndex: 1 }),
			paradisParseTaskBoardAnswer({ terminal: TERMINAL, kind: 'question' }).ok,
			paradisParseTaskBoardAnswer({ terminal: TERMINAL, kind: 'permission', allow: false }),
			paradisParseTaskBoardAnswer({ terminal: TERMINAL, kind: 'permission', optionIndex: -1 }).ok,
			paradisParseTaskBoardReply({ replyId: 'r1', ok: true }),
			paradisParseTaskBoardReply({ replyId: 'r1', ok: 'yes', message: '' }).ok,
		], [
			{ ok: true, value: { terminal: TERMINAL, text: 'hi', submit: true } },
			{ ok: true, value: { terminal: TERMINAL, text: 'hi', submit: false } },
			false,
			false,
			{ ok: true, value: { terminal: TERMINAL, key: '3' } },
			false,
			{ ok: true, value: { terminal: TERMINAL, kind: 'question', optionIndex: 1 } },
			false,
			{ ok: true, value: { terminal: TERMINAL, kind: 'permission', allow: false } },
			false,
			{ ok: true, value: { replyId: 'r1', ok: true, message: '' } },
			false,
		]);
	});

	test('status is derived from what the window sees, and sending is allowed only while waiting for input', () => {
		const base = { closed: false, agentExited: false, choiceMenu: false };
		const statuses = [
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'working' }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'permission' }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'question' }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'review' }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: undefined }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'review', choiceMenu: true }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: 'working', agentExited: true }),
			paradisTaskBoardStatusFrom({ ...base, agentStatus: undefined, closed: true }),
		];
		assert.deepStrictEqual(statuses, ['working', 'permission', 'question', 'review', 'idle', 'question', 'exited', 'exited']);
		assert.deepStrictEqual(statuses.map(paradisTaskBoardSendBlock), ['busy', 'permission', 'question', undefined, undefined, 'question', 'exited', 'exited']);
		assert.deepStrictEqual(['busy', 'not-found', 'invalid', 'unavailable', 'failed', 'rejected'].map(code => paradisTaskBoardHttpStatus(code as never)), [409, 404, 400, 503, 500, 409]);
	});

	test('authentication helpers accept only the bridge host and a bearer token', () => {
		assert.deepStrictEqual([
			paradisTaskBoardIsAllowedHost('127.0.0.1:4100', 4100),
			paradisTaskBoardIsAllowedHost('localhost:4100', 4100),
			paradisTaskBoardIsAllowedHost('evil.example:4100', 4100),
			paradisTaskBoardIsAllowedHost('127.0.0.1:4101', 4100),
			paradisTaskBoardIsAllowedHost(undefined, 4100),
			paradisTaskBoardBearerToken('Bearer abcdefghijklmnop_-123'),
			paradisTaskBoardBearerToken('Basic abcdefghijklmnop'),
			paradisTaskBoardBearerToken('Bearer short'),
		], [true, true, false, false, false, 'abcdefghijklmnop_-123', undefined, undefined]);
	});

	test('events and tool details', () => {
		assert.strictEqual(paradisTaskBoardSseData({ type: 'status', terminal: TERMINAL, launchId: 'L1', status: 'idle' }), `data: {"type":"status","terminal":"${TERMINAL}","launchId":"L1","status":"idle"}\n\n`);
		assert.deepStrictEqual([
			paradisTaskBoardToolDetail({ file_path: '/a/b.ts', command: 'ls' }),
			paradisTaskBoardToolDetail({ command: 'echo 1\necho 2' }),
			paradisTaskBoardToolDetail({ command: ['git', 'status'] }),
			paradisTaskBoardToolDetail({ command: 'x'.repeat(300) })?.length,
			paradisTaskBoardToolDetail('nope'),
		], ['/a/b.ts', 'echo 1 echo 2', 'git status', 200, undefined]);
	});

	test('MCP arguments are validated', () => {
		assert.deepStrictEqual([
			paradisParseTaskBoardCompleteStepArgs({ summary: 'done', artifacts: [{ kind: 'plan', title: 'Plan', path: '/tmp/plan.md' }] }),
			paradisParseTaskBoardCompleteStepArgs({ summary: '' }).ok,
			paradisParseTaskBoardCompleteStepArgs({ summary: 'done', artifacts: [{ kind: 'video', title: 'x' }] }).ok,
			paradisParseTaskBoardCompleteStepArgs({ summary: 'done', artifacts: [{ kind: 'mock', title: 'x', path: 'relative.html' }] }).ok,
			paradisParseTaskBoardCompleteStepArgs({ summary: 'done', artifacts: [{ kind: 'mock', title: 'x', path: ' ' }] }).ok,
			paradisParseTaskBoardAskHumanArgs({ question: 'A or B?', options: ['A', 'B'], allow_text: false }),
			paradisParseTaskBoardAskHumanArgs({ question: 'A or B?', options: [1] }).ok,
		], [
			{ ok: true, value: { summary: 'done', artifacts: [{ kind: 'plan', title: 'Plan', path: '/tmp/plan.md' }] } },
			false,
			false,
			true,
			false,
			{ ok: true, value: { question: 'A or B?', options: ['A', 'B'], allow_text: false } },
			false,
		]);
	});

	test('status reports from windows are trimmed to the contract', () => {
		assert.deepStrictEqual([
			paradisParseTaskBoardStatusReport({ terminal: TERMINAL, status: 'question', question: { text: 'Q', options: [{ label: 'A', detail: 'a' }, { label: 1 }, { label: 'B', detail: '' }], allowText: true }, token: 'secret' }),
			paradisParseTaskBoardStatusReport({ terminal: TERMINAL, status: 'sleeping' }),
		], [
			{ terminal: TERMINAL, status: 'question', question: { text: 'Q', options: [{ label: 'A', detail: 'a' }, { label: 'B' }], allowText: true } },
			undefined,
		]);
	});

	test('paths are compared without trailing separators', () => {
		assert.deepStrictEqual([
			paradisTaskBoardSamePath('/Users/example/repo/', '/Users/example/repo', false),
			paradisTaskBoardSamePath('/Users/Example/Repo', '/users/example/repo', true),
			paradisTaskBoardSamePath('/Users/Example/Repo', '/users/example/repo', false),
			paradisTaskBoardSamePath('C:\\work\\repo\\', 'C:/work/repo', true),
		], [true, true, false, true]);
	});
});
