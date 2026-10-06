/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShellsAccess } from '../../../agentChat/common/paradisAgentShells.js';
import { IParadisRemoteShellOutputRequest } from '../../common/paradisRemoteShellOutput.js';
import { IParadisShellOutputSource, IParadisShellOutputTail, paradisClaudeSessionIdFromTranscript, paradisCleanShellOutputLine, paradisHandleShellRequest, paradisIsShellOutputPath, paradisIsValidShellRequest, paradisReadRemoteShellOutputTail, paradisReadShellOutputs, paradisReadShellOutputTail, paradisRemoteShellOutputBase, paradisSplitShellOutputTail } from '../../node/paradisAgentShellOutput.js';
import { ParadisRemoteShellOutputChannel } from '../../node/paradisRemoteShellOutputChannel.js';
import { ParadisRemoteShellOutputRequests } from '../../node/paradisRemoteShellOutputRequests.js';

suite('paradisAgentShellOutput', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cleans terminal control and keeps the last of a carriage-return progress line', () => {
		assert.deepStrictEqual([
			paradisCleanShellOutputLine('\u001b[32m✓\u001b[0m src/login.test.ts (12 tests)'),
			paradisCleanShellOutputLine('progress 10%\rprogress 50%\rprogress 100%\r'),
			paradisCleanShellOutputLine('\u001b]0;title\u0007plain\u0000'),
			paradisCleanShellOutputLine('x'.repeat(1_005)).length,
		], ['✓ src/login.test.ts (12 tests)', 'progress 100%', 'plain', 1_001]);
	});

	test('splits the tail, drops a cut first line, and reads the end marker', () => {
		assert.deepStrictEqual([
			paradisSplitShellOutputTail('a\nb\nc\n[exited with code 2]\n', true, 20),
			paradisSplitShellOutputTail('half line\nb\nc\n', false, 1),
			paradisSplitShellOutputTail('one\n', true, 20),
		], [
			{ lines: ['a', 'b', 'c', '[exited with code 2]'], truncated: false, ended: { status: 'failed', exitCode: 2 } },
			{ lines: ['c'], truncated: true },
			{ lines: ['one'], truncated: false },
		]);
	});

	test('accepts only <root>/claude-<uid>/<slug>/<session>/tasks/<id>.output', () => {
		const roots = ['/private/tmp'];
		const ok = (path: string) => paradisIsShellOutputPath(path, roots, 501, 'sess', 'b1');
		assert.deepStrictEqual([
			ok('/private/tmp/claude-501/-Users-example-app/sess/tasks/b1.output'),
			ok('/private/tmp/claude-502/-Users-example-app/sess/tasks/b1.output'),
			ok('/private/tmp/claude-501/-Users-example-app/other/tasks/b1.output'),
			ok('/private/tmp/claude-501/-Users-example-app/sess/tasks/b2.output'),
			ok('/private/tmp/claude-501/sess/tasks/b1.output'),
			ok('/Users/example/.ssh/id_rsa'),
		], [true, false, false, false, false, false]);
	});

	test('validates the requests from the app', () => {
		assert.deepStrictEqual([
			paradisIsValidShellRequest({ t: 'shell-output', epoch: 'e', shellIds: ['b1', 'b2'], lines: 20 }),
			paradisIsValidShellRequest({ t: 'shell-output', epoch: 'e', shellIds: ['../x'] }),
			paradisIsValidShellRequest({ t: 'shell-output', epoch: 'e', shellIds: [] }),
			paradisIsValidShellRequest({ t: 'shell-output', epoch: 'e', shellIds: ['b1'], lines: 51 }),
			paradisIsValidShellRequest({ t: 'shell-output', epoch: 'e', shellIds: ['b1'], path: '/etc/passwd' }),
			paradisIsValidShellRequest({ t: 'action/stopShell', epoch: 'e', shellId: 'b1' }),
			paradisIsValidShellRequest({ t: 'action/stopShell', epoch: 'e', shellId: 'b1/..' }),
		], [true, false, false, false, true, true, false]);
	});

	test('a stop goes to Claude Mods only where it can, sends only fixed text to the app, and marks the shell stopped from the phone', async () => {
		const replies: unknown[] = [];
		const stopped: unknown[] = [];
		const asked: unknown[] = [];
		const logged: string[] = [];
		const context = (access: { output: boolean; stop: boolean; where?: 'ssh' }, outcome: 'stopped' | 'refused' | 'throws' = 'stopped') => ({
			key: 'pane', access, sessionId: 'sess', reads: new Set<string>(),
			outputFile: () => undefined,
			markOutputEnded: () => { },
			markOutputRunning: () => { },
			isRunning: (id: string) => id === 'brun',
			markStopped: (id: string) => stopped.push(id),
			stopTask: async (sessionId: string, id: string) => {
				asked.push([sessionId, id]);
				if (outcome === 'throws') {
					throw new Error('raw failure text from the mod');
				}
				return outcome === 'stopped' ? { outcome } : { outcome, message: 'No task found with ID: brun <raw>' };
			},
			log: (message: string) => logged.push(message),
		});
		const stop = (shellId: string) => ({ t: 'action/stopShell' as const, id: 7, requestId: 'r', epoch: 'e', shellId });
		await paradisHandleShellRequest(stop('brun'), context({ output: true, stop: true }), reply => replies.push(reply));
		await paradisHandleShellRequest(stop('brun'), context({ output: true, stop: true }, 'refused'), reply => replies.push(reply));
		await paradisHandleShellRequest(stop('brun'), context({ output: true, stop: true }, 'throws'), reply => replies.push(reply));
		await paradisHandleShellRequest(stop('bdone'), context({ output: true, stop: true }), reply => replies.push(reply));
		await paradisHandleShellRequest(stop('brun'), context({ output: false, stop: false, where: 'ssh' }), reply => replies.push(reply));
		await paradisHandleShellRequest(stop('brun'), undefined, reply => replies.push(reply));
		await paradisHandleShellRequest({ t: 'shell-output', id: 7, requestId: 'r', epoch: 'e', shellIds: ['brun'] }, context({ output: false, stop: false, where: 'ssh' }), reply => replies.push(reply));
		assert.deepStrictEqual({ replies: replies.map(reply => JSON.stringify(reply)), rawInReplies: replies.some(reply => /raw|No task/.test(JSON.stringify(reply))), stopped, asked, logged: logged.length }, {
			replies: [
				'{"t":"action-result","status":"accepted"}',
				'{"t":"action-result","status":"rejected","code":"stop-failed","message":"止められませんでした。もう終わっていたかもしれません。PC の端末で /tasks を確かめてください"}',
				'{"t":"action-result","status":"rejected","code":"outcome-unknown","message":"止めたかどうかを確かめられませんでした。PC の端末で /tasks を確かめてください"}',
				'{"t":"action-result","status":"rejected","code":"not-running","message":"このシェルはもう止まっています"}',
				'{"t":"action-result","status":"rejected","code":"unsupported","message":"このペインでは Claude Mods が動いていないため、アプリからは止められません"}',
				'{"t":"action-result","status":"rejected","code":"stale-session","message":"操作対象のエージェントセッションが変わりました"}',
				'{"t":"shell-output","error":"unavailable"}',
			],
			rawInReplies: false,
			stopped: ['brun'],
			asked: [['sess', 'brun'], ['sess', 'brun'], ['sess', 'brun']],
			logged: 2,
		});
	});

	test('reads a real output file under the tasks directory of a temporary root and refuses one elsewhere', async function () {
		if (process.platform === 'win32' || typeof process.getuid !== 'function') {
			this.skip();
		}
		const uid = process.getuid!();
		// /tmp/claude-<uid> は作らない。一時ディレクトリを root として渡す
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-shell-output-')));
		const claudeDir = join(root, `claude-${uid}`);
		const tasks = join(claudeDir, '-workspace', 'sess-1', 'tasks');
		const outside = join(root, 'outside.output');
		await fs.mkdir(claudeDir, { mode: 0o700 });
		await fs.mkdir(tasks, { recursive: true });
		try {
			await fs.writeFile(join(tasks, 'bok.output'), 'start\n\u001b[31merror\u001b[0m: boom\n[exited with code 1]\n');
			await fs.writeFile(join(tasks, 'blive.output'), 'listening on 5173\n');
			await fs.writeFile(outside, 'secret\n');
			await fs.symlink(outside, join(tasks, 'blink.output'));
			const ended: unknown[] = [];
			const items = await paradisReadShellOutputs({
				sessionId: 'sess-1', roots: [root],
				outputFile: id => id === 'bok' || id === 'blive' ? join(tasks, `${id}.output`) : id === 'blink' ? join(tasks, 'blink.output') : id === 'bwrong' ? outside : undefined,
				markOutputEnded: (id, end) => ended.push([id, end]),
				markOutputRunning: id => ended.push([id, 'running']),
			}, ['bok', 'blive', 'blink', 'bwrong', 'bnone'], 20);
			const wrongSession = await paradisReadShellOutputTail(join(tasks, 'bok.output'), 'sess-2', 'bok', 20, [root]);
			// <root>/claude-<uid> は Claude Code が 0700 で作る。グループの書き込みは通し、他人が書き込めるなら信じない
			await fs.chmod(claudeDir, 0o770);
			const groupWritable = typeof await paradisReadShellOutputTail(join(tasks, 'bok.output'), 'sess-1', 'bok', 20, [root]);
			await fs.chmod(claudeDir, 0o702);
			const otherWritable = await paradisReadShellOutputTail(join(tasks, 'bok.output'), 'sess-1', 'bok', 20, [root]);
			await fs.chmod(claudeDir, 0o700);
			assert.deepStrictEqual({ items, ended, wrongSession, groupWritable, otherWritable }, {
				items: [
					{ id: 'bok', lines: ['start', 'error: boom', '[exited with code 1]'] },
					{ id: 'blive', lines: ['listening on 5173'] },
					{ id: 'blink', error: 'unavailable' },
					{ id: 'bwrong', error: 'unavailable' },
					{ id: 'bnone', error: 'not-found' },
				],
				ended: [['bok', { status: 'failed', exitCode: 1 }], ['blive', 'running']],
				wrongSession: 'unavailable',
				groupWritable: 'object',
				otherWritable: 'unavailable',
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('on the host, accepts …/claude-<uid>/<slug>/<session>/tasks/<id>.output under any root', () => {
		const base = (path: string) => paradisRemoteShellOutputBase(path, 1000, 'sess', 'b1');
		assert.deepStrictEqual([
			base('/var/tmp/abc/claude-1000/-home-example-app/sess/tasks/b1.output'),
			base('/tmp/claude-1000/-home-example-app/sess/tasks/b1.output'),
			base('/tmp/claude-1001/-home-example-app/sess/tasks/b1.output'),
			base('/tmp/claude-1000/-home-example-app/other/tasks/b1.output'),
			base('/tmp/claude-1000/-home-example-app/sess/tasks/b2.output'),
			base('/tmp/claude-1000/-home-example-app/sess/logs/b1.output'),
			base('/tmp/claude-1000/sess/tasks/b1.output'),
			base('claude-1000/-home-example-app/sess/tasks/b1.output'),
			base('/tmp/claude-1000/../claude-1000/x/sess/tasks/b1.output'),
			base('/home/example/.ssh/id_rsa'),
		], ['/var/tmp/abc/claude-1000', '/tmp/claude-1000', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('on the host, reads only the owned output file, not through links, and finds it under the temporary roots when the transcript names another one', async function () {
		if (process.platform === 'win32' || typeof process.getuid !== 'function') {
			this.skip();
		}
		const uid = process.getuid!();
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paradis-remote-shell-output-')));
		// 接続先の TMPDIR に当たる場所（根は決めない）
		const processTmp = join(root, 'var-tmp', 'abc');
		const claudeDir = join(processTmp, `claude-${uid}`);
		const tasks = join(claudeDir, '-home-example-app', 'sess-1', 'tasks');
		const outside = join(root, 'outside.output');
		await fs.mkdir(join(processTmp), { recursive: true });
		await fs.mkdir(claudeDir, { mode: 0o700 });
		await fs.mkdir(tasks, { recursive: true });
		try {
			await fs.writeFile(join(tasks, 'bok.output'), 'one\ntwo\n[exited with code 0]\n');
			await fs.writeFile(outside, 'secret\n');
			await fs.symlink(outside, join(tasks, 'blink.output'));
			const read = (file: string, id: string, roots: readonly string[] = [join(root, 'nowhere')]) => paradisReadRemoteShellOutputTail(file, 'sess-1', id, 20, roots);
			const results = {
				ok: await read(join(tasks, 'bok.output'), 'bok'),
				// transcript には /tmp 側が書かれていて、実物は TMPDIR 側にある
				fallback: await read(`/nonexistent-${uid}/claude-${uid}/-home-example-app/sess-1/tasks/bok.output`, 'bok', [processTmp]),
				link: await read(join(tasks, 'blink.output'), 'blink'),
				missing: await read(join(tasks, 'bnone.output'), 'bnone'),
				wrongShape: await read(outside, 'bok'),
				wrongSession: await paradisReadRemoteShellOutputTail(join(tasks, 'bok.output'), 'sess-2', 'bok', 20, []),
				badArguments: await paradisReadRemoteShellOutputTail(42, 'sess-1', 'bok', 20, []),
				otherWritable: '',
			};
			await fs.chmod(claudeDir, 0o702);
			results.otherWritable = String(await read(join(tasks, 'bok.output'), 'bok'));
			await fs.chmod(claudeDir, 0o700);
			assert.deepStrictEqual(results, {
				ok: { lines: ['one', 'two', '[exited with code 0]'], truncated: false, ended: { status: 'completed', exitCode: 0 } },
				fallback: { lines: ['one', 'two', '[exited with code 0]'], truncated: false, ended: { status: 'completed', exitCode: 0 } },
				link: 'unavailable',
				missing: 'not-found',
				wrongShape: 'unavailable',
				wrongSession: 'unavailable',
				badArguments: 'unavailable',
				otherWritable: 'unavailable',
			});
			// REH のチャネル: 形の合わない頼みには何も返さない
			const channel = new ParadisRemoteShellOutputChannel<string>([join(root, 'nowhere')]);
			assert.deepStrictEqual({
				read: await channel.call('ctx', 'readTails', [[{ id: 'bok', outputFile: join(tasks, 'bok.output') }, { id: 'blink', outputFile: join(tasks, 'blink.output') }], 'sess-1', 1]),
				invalid: await channel.call('ctx', 'readTails', [[{ id: '../x', outputFile: '/etc/passwd' }], 'sess-1', 1]),
			}, {
				read: [{ id: 'bok', lines: ['[exited with code 0]'], truncated: true, ended: { status: 'completed', exitCode: 0 } }, { id: 'blink', error: 'unavailable' }],
				invalid: [],
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('reads an SSH pane through the host: one request for all shells, no window means no-window', async () => {
		const ended: unknown[] = [];
		const asked: unknown[] = [];
		const source = (reply: Awaited<ReturnType<NonNullable<IParadisShellOutputSource['readRemote']>>>): IParadisShellOutputSource => ({
			sessionId: 'sess',
			outputFile: id => id === 'bnone' ? undefined : `/tmp/claude-1000/x/sess/tasks/${id}.output`,
			readRemote: async (items, sessionId, lines) => { asked.push([items.map(item => item.id), sessionId, lines]); return reply; },
			markOutputEnded: (id, end) => ended.push([id, end]),
			markOutputRunning: id => ended.push([id, 'running']),
		});
		const read = await paradisReadShellOutputs(source(new Map<string, IParadisShellOutputTail | 'not-found'>([
			['b1', { lines: ['a'], truncated: true, ended: { status: 'failed', exitCode: 2 } }],
			['b2', 'not-found'],
		])), ['b1', 'b2', 'b3', 'bnone'], undefined);
		const noWindow = await paradisReadShellOutputs(source('no-window'), ['b1', 'bnone'], 5);
		assert.deepStrictEqual({ read, noWindow, ended, asked }, {
			read: [{ id: 'b1', lines: ['a'], truncated: true }, { id: 'b2', error: 'not-found' }, { id: 'b3', error: 'unavailable' }, { id: 'bnone', error: 'not-found' }],
			noWindow: [{ id: 'b1', error: 'no-window' }, { id: 'bnone', error: 'not-found' }],
			ended: [['b1', { status: 'failed', exitCode: 2 }]],
			asked: [[['b1', 'b2', 'b3'], 'sess', 20], [['b1'], 'sess', 5]],
		});
	});

	test('asks only the owning window, ignores other windows and junk, and gives up after the timeout', async () => {
		const requests = new ParadisRemoteShellOutputRequests(20);
		try {
			const fired: IParadisRemoteShellOutputRequest[] = [];
			const listener = requests.onDidRequest(request => fired.push(request));
			const items = [{ id: 'b1', outputFile: '/tmp/claude-1000/x/sess/tasks/b1.output' }, { id: 'b2', outputFile: '/tmp/claude-1000/x/sess/tasks/b2.output' }];
			const noOwner = await requests.request(undefined, items, 'sess', 20);
			const answered = requests.request('window-a', items, 'sess', 20);
			const [request] = fired;
			requests.complete('window-b', request.requestId, [{ id: 'b1', lines: ['forged'] }]);
			requests.complete('window-a', request.requestId, [
				{ id: 'b1', lines: ['\u001b[31mred\u001b[0m', 7, 'x'.repeat(2_000)], truncated: true, ended: { status: 'stopped' } },
				{ id: 'b2', error: 'not-found' },
				{ id: 'b9', lines: ['not asked'] },
			]);
			const timedOut = requests.request('window-a', items, 'sess', 20);
			const timedOutResult = await timedOut;
			listener.dispose();
			const result = await answered;
			assert.deepStrictEqual({
				noOwner,
				fired: fired.map(entry => ({ ownerId: entry.ownerId, sessionId: entry.sessionId, lines: entry.lines, ids: entry.items.map(item => item.id) })),
				result: result === 'no-window' ? result : [...result].map(([id, tail]) => [id, typeof tail === 'string' ? tail : { ...tail, lines: tail.lines.map(line => line.length > 20 ? line.length : line) }]),
				timedOut: timedOutResult === 'no-window' ? timedOutResult : timedOutResult.size,
			}, {
				noOwner: 'no-window',
				fired: [
					{ ownerId: 'window-a', sessionId: 'sess', lines: 20, ids: ['b1', 'b2'] },
					{ ownerId: 'window-a', sessionId: 'sess', lines: 20, ids: ['b1', 'b2'] },
				],
				result: [['b1', { lines: ['red', 1_001], truncated: true, ended: { status: 'stopped' } }], ['b2', 'not-found']],
				timedOut: 0,
			});
		} finally {
			requests.dispose();
		}
	});

	test('the SSH access reads output only on a PC that reads on the host, and never stops there', () => {
		assert.deepStrictEqual([
			paradisShellsAccess('ssh', true),
			paradisShellsAccess('ssh', true, true),
			paradisShellsAccess('wsl', true, true),
			paradisShellsAccess(undefined, false, true),
		], [
			{ output: false, stop: false, where: 'ssh' },
			{ output: true, stop: false, where: 'ssh' },
			{ output: false, stop: false, where: 'wsl' },
			{ output: true, stop: false },
		]);
	});

	test('takes the session id from the transcript file name', () => {
		assert.deepStrictEqual([
			paradisClaudeSessionIdFromTranscript('/Users/example/.claude/projects/-work/92d36234-0205-49dd-b32d-8ec0b91c814a.jsonl'),
			paradisClaudeSessionIdFromTranscript('/Users/example/.claude/projects/-work/bad name.jsonl'),
		], ['92d36234-0205-49dd-b32d-8ec0b91c814a', undefined]);
	});
});
