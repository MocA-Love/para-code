/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseTaskBoardBoardRegistration, paradisParseTaskBoardRelayRequest, paradisTaskBoardRelayOperationName } from '../../common/paradisTaskBoardRelay.js';
import { IParadisTaskBoardRelayRecord, ParadisTaskBoardRelaySessions } from '../../common/paradisTaskBoardRelaySessions.js';

const KEY = 'k'.repeat(43);
const SESSION = 'session-0123456789abcdef';
const AUTHORITY = 'ssh-remote+host';
const ROOT = '/home/u/repo';
const WORKTREES = '/home/u/repo-worktrees';
const REPO = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: ROOT });

/** REH や接続口の代わり。届いた呼び出しを記録し、決めた答えを返す。 */
class FakeChannel implements IChannel {
	readonly calls: { command: string; arg: unknown }[] = [];
	constructor(private readonly answer: (command: string, arg: unknown) => unknown) { }
	async call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		const value = this.answer(command, arg);
		if (value instanceof Error) {
			throw value;
		}
		return value as T;
	}
	listen<T>(): Event<T> {
		return Event.None;
	}
}

function defaultReh(command: string, arg: unknown): unknown {
	switch (command) {
		case 'openSession': {
			const path = (arg as string[])[1];
			return { toplevel: path, commonDir: `${ROOT}/.git` };
		}
		case 'readFile': return VSBuffer.fromString('plan');
		case 'adoptWorktree': return (arg as string[])[1].endsWith('/gone') ? new Error('[denied] gone') : undefined;
		case 'git': {
			const op = (arg as unknown[])[2] as { kind: string; push?: boolean };
			if (op.kind === 'remoteUrl') {
				return { code: 0, stdout: op.push ? 'git@example.com:o/r.git\n' : 'https://user:token@example.com/o/r.git\n', stderr: '', timedOut: false };
			}
			if (op.kind === 'defaultBranch') {
				return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '', timedOut: false };
			}
			return { code: 0, stdout: 'x', stderr: '', timedOut: false };
		}
		default: return undefined;
	}
}

suite('Paradis task board relay - window side', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options?: { remoteAuthority?: string | null; registered?: boolean; reh?: (command: string, arg: unknown) => unknown; record?: IParadisTaskBoardRelayRecord }) {
		const reh = new FakeChannel(options?.reh ?? defaultReh);
		const bridge = new FakeChannel(() => true);
		const records = new Map<string, IParadisTaskBoardRelayRecord>(options?.record ? [[REPO.toString(), options.record]] : []);
		const sessions = store.add(new ParadisTaskBoardRelaySessions({
			remoteAuthority: options?.remoteAuthority === null ? undefined : options?.remoteAuthority ?? AUTHORITY,
			remoteChannel: () => reh,
			bridge,
			isWindowFolder: () => options?.registered ?? true,
			newSessionId: () => SESSION,
			readRecord: repository => records.get(repository) ?? { worktrees: [], branches: [] },
			writeRecord: (repository, record) => records.set(repository, record),
			warn: () => { },
		}));
		return { sessions, reh, bridge, records };
	}

	async function opened(options?: Parameters<typeof create>[0]) {
		const created = create(options);
		assert.deepStrictEqual(await created.sessions.prepare(REPO), { ok: true, value: { sessionId: SESSION, root: ROOT } });
		assert.deepStrictEqual(await created.sessions.bind(SESSION, KEY), { ok: true, value: true });
		return created;
	}

	const code = (result: { ok: boolean; code?: string }) => result.ok ? 'ok' : result.code;

	test('board registration and request shapes', () => {
		assert.deepStrictEqual([
			paradisParseTaskBoardBoardRegistration({ pid: 1234, key: KEY }),
			paradisParseTaskBoardBoardRegistration({ pid: 1, key: KEY }),
			paradisParseTaskBoardBoardRegistration({ pid: 1234, key: 'short' }),
			paradisTaskBoardRelayOperationName({ op: { kind: 'git', git: { kind: 'status' } } }),
			paradisTaskBoardRelayOperationName({ op: { kind: 'git', git: { kind: '<script>' } } }),
		], [{ pid: 1234, key: KEY }, undefined, undefined, 'git.status', 'git.unknown']);
	});

	test('requests are rebuilt from the allowed fields only; commits, pushes and commands are not available yet', () => {
		const parse = (op: unknown) => {
			const result = paradisParseTaskBoardRelayRequest({ sessionId: SESSION, op, extra: 'x' });
			return result.ok ? result.value.op : result.code;
		};
		assert.deepStrictEqual([
			parse({ kind: 'git', place: ROOT, git: { kind: 'status', args: ['--output=/tmp/x'], cwd: '/etc' }, cwd: '/etc' }),
			parse({ kind: 'git', place: ROOT, git: { kind: 'worktreeAdd', dir: `${WORKTREES}/a`, branch: 'para/a', mode: 'new', base: { kind: 'remote', branch: 'main', x: 1 }, force: true } }),
			parse({ kind: 'git', place: ROOT, git: { kind: 'switch', branch: 'para/a', mode: 'existing', base: { kind: 'head' } } }),
			parse({ kind: 'git', git: { kind: 'status' } }),
			parse({ kind: 'git', place: ROOT, git: { kind: 'push', branch: 'para/x' } }),
			parse({ kind: 'git', place: ROOT, git: { kind: 'commit', message: 'x' } }),
			parse({ kind: 'git', place: ROOT, git: { kind: 'addTracked' } }),
			parse({ kind: 'runCommand', command: 'rm -rf /' }),
			parse({ kind: 'readFile', place: ROOT, path: '.env' }),
			parse({ kind: 'writeFile', path: '.para-code/paracode.json', content: '{}', place: '/etc' }),
			parse({ kind: 'writeFile', path: 'package.json', content: '{}' }),
			parse({ kind: 'resetBoardDir', place: ROOT, taskId: '../x' }),
		], [
			{ kind: 'git', place: ROOT, git: { kind: 'status' } },
			{ kind: 'git', place: ROOT, git: { kind: 'worktreeAdd', dir: `${WORKTREES}/a`, branch: 'para/a', mode: 'new', base: { kind: 'remote', branch: 'main' } } },
			{ kind: 'git', place: ROOT, git: { kind: 'switch', branch: 'para/a', mode: 'existing' } },
			'invalid', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'rejected',
			{ kind: 'writeFile', path: '.para-code/paracode.json', content: '{}' },
			'rejected', 'invalid',
		]);
	});

	test('a session opens only for a registered repository on the SSH host of this window', async () => {
		const other = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+other', path: ROOT });
		assert.deepStrictEqual([
			code(await create({ remoteAuthority: null }).sessions.prepare(REPO)),
			code(await create().sessions.prepare(other)),
			code(await create().sessions.prepare(URI.file(ROOT))),
			code(await create({ registered: false }).sessions.prepare(REPO)),
			code(await create({ reh: () => new Error('Unknown channel: paradisTaskBoardRemote') }).sessions.prepare(REPO)),
		], ['invalid', 'invalid', 'invalid', 'invalid', 'unavailable']);
		const { sessions, reh, bridge } = create();
		await sessions.prepare(REPO);
		// 鍵を結ぶまでは依頼を受けない
		assert.strictEqual(code(await sessions.handle({ sessionId: SESSION, op: { kind: 'sessionInfo' } })), 'not-found');
		assert.strictEqual(code(await sessions.bind(SESSION, 'short')), 'invalid');
		await sessions.bind(SESSION, KEY);
		assert.deepStrictEqual([reh.calls, bridge.calls], [
			[{ command: 'openSession', arg: [SESSION, ROOT] }, { command: 'closeSession', arg: [SESSION] }, { command: 'openSession', arg: [SESSION, ROOT, WORKTREES] }],
			[{ command: 'registerRelaySession', arg: { sessionId: SESSION, boardKey: KEY, authority: AUTHORITY, repository: ROOT } }],
		]);
	});

	test('a session opened from a worktree folder moves to the main repository, if the window has it', async () => {
		const worktree = REPO.with({ path: `${WORKTREES}/x` });
		const registered = create();
		const result = await registered.sessions.prepare(worktree);
		const missing = create({ registered: false });
		// 窓に本体が無ければ断る（最初の確かめは通すため、isWindowFolder は本体のときだけ false にする）
		const onlyWorktree = new ParadisTaskBoardRelaySessions({
			remoteAuthority: AUTHORITY, remoteChannel: () => new FakeChannel(defaultReh), bridge: new FakeChannel(() => true),
			isWindowFolder: uri => uri.path !== ROOT, newSessionId: () => SESSION,
			readRecord: () => ({ worktrees: [], branches: [] }), writeRecord: () => { }, warn: () => { },
		});
		store.add(onlyWorktree);
		assert.deepStrictEqual([
			result.ok ? result.value.root : result.code,
			registered.reh.calls.filter(call => call.command === 'openSession').map(call => call.arg),
			code(await missing.sessions.prepare(worktree)),
			code(await onlyWorktree.prepare(worktree)),
		], [ROOT, [[SESSION, `${WORKTREES}/x`], [SESSION, ROOT, WORKTREES]], 'invalid', 'invalid']);
	});

	test('tokens in git output are removed anywhere in the text', async () => {
		const { sessions } = await opened({ reh: (command, arg) => command === 'git' ? { code: 128, stdout: '', stderr: `fatal: unable to access 'https://user:p@ss@example.com/o/r.git/': 403\n`, timedOut: false } : defaultReh(command, arg) });
		const result = await sessions.handle({ sessionId: SESSION, op: { kind: 'git', place: ROOT, git: { kind: 'fetch' } } });
		assert.deepStrictEqual(result.ok ? (result.value as { stderr: string }).stderr : result.code, `fatal: unable to access 'https://example.com/o/r.git/': 403\n`);
	});

	test('session info comes from the window, with the credentials removed from the origin URL', async () => {
		const { sessions } = await opened({ record: { worktrees: [{ dir: `${WORKTREES}/kept`, branch: 'para/kept' }, { dir: `${WORKTREES}/gone`, branch: 'para/gone' }], branches: [] } });
		const info = await sessions.handle({ sessionId: SESSION, op: { kind: 'sessionInfo' } });
		assert.deepStrictEqual(info.ok ? info.value : info.code, {
			root: ROOT, worktreeRoot: WORKTREES, defaultBranch: 'main',
			originFetch: 'https://example.com/o/r.git', originPush: 'git@example.com:o/r.git',
			worktrees: [`${WORKTREES}/kept`],
		});
	});

	test('workspaces are the session root and the worktrees this window made, recorded across restarts', async () => {
		const { sessions, reh, records } = await opened();
		const git = (place: string, op: unknown) => sessions.handle({ sessionId: SESSION, op: { kind: 'git', place, git: op } });
		const dir = `${WORKTREES}/7-feature`;
		const results = [
			code(await git('/etc', { kind: 'status' })),
			code(await git(ROOT, { kind: 'worktreeAdd', dir: '/tmp/7-feature', branch: 'para/7', mode: 'new', base: { kind: 'head' } })),
			code(await git(dir, { kind: 'status' })),
			sessions.launchTarget(SESSION, dir)?.toString(),
			code(await git(ROOT, { kind: 'worktreeAdd', dir, branch: 'para/7-feature', mode: 'new', base: { kind: 'remote', branch: 'main' } })),
			code(await git(dir, { kind: 'status' })),
			sessions.launchTarget(SESSION, dir)?.toString(),
			sessions.launchTarget(SESSION, dir.toUpperCase()),
			code(await git(ROOT, { kind: 'worktreeRemove', dir: ROOT })),
		];
		assert.deepStrictEqual({ results, record: records.get(REPO.toString()), sentToReh: reh.calls.filter(call => call.command === 'git').length }, {
			results: ['rejected', 'rejected', 'rejected', undefined, 'ok', 'ok', `vscode-remote://ssh-remote%2Bhost${dir}`, undefined, 'rejected'],
			record: { worktrees: [{ dir, branch: 'para/7-feature' }], branches: ['para/7-feature'] },
			sentToReh: 2,
		});
	});

	test('branch switches and board folder resets happen only in board worktrees, not in the main working tree', async () => {
		const { sessions } = await opened({ record: { worktrees: [{ dir: `${WORKTREES}/kept`, branch: 'para/kept' }], branches: [] } });
		const run = (place: string, op: unknown) => sessions.handle({ sessionId: SESSION, op });
		assert.deepStrictEqual([
			code(await run(ROOT, { kind: 'git', place: ROOT, git: { kind: 'switch', branch: 'para/x', mode: 'existing' } })),
			code(await run(ROOT, { kind: 'git', place: ROOT, git: { kind: 'detach', base: { kind: 'remote', branch: 'main' } } })),
			code(await run(ROOT, { kind: 'git', place: ROOT, git: { kind: 'mergeFfOnly', branch: 'para/x' } })),
			code(await run(ROOT, { kind: 'resetBoardDir', place: ROOT, taskId: 't1' })),
			code(await run(ROOT, { kind: 'git', place: `${WORKTREES}/kept`, git: { kind: 'switch', branch: 'para/kept', mode: 'existing' } })),
		], ['rejected', 'rejected', 'rejected', 'rejected', 'ok']);
	});

	test('the window sends only the rebuilt operation to the SSH host', async () => {
		const { sessions, reh } = await opened();
		const results = [
			await sessions.handle({ sessionId: SESSION, op: { kind: 'git', place: ROOT, git: { kind: 'status', args: ['--exec=sh'] } } }),
			await sessions.handle({ sessionId: SESSION, op: { kind: 'readFile', place: ROOT, path: '.para/plan.html' } }),
			await sessions.handle({ sessionId: 'session-ffffffffffffffff', op: { kind: 'git', place: ROOT, git: { kind: 'status' } } }),
		];
		assert.deepStrictEqual({
			results: results.map(result => result.ok ? result.value : result.code),
			sent: reh.calls.filter(call => call.command === 'git' || call.command === 'readFile'),
		}, {
			results: [{ code: 0, stdout: 'x', stderr: '', timedOut: false }, { base64: 'cGxhbg==', size: 4, detail: '.para/plan.html 4' }, 'not-found'],
			sent: [
				{ command: 'git', arg: [SESSION, ROOT, { kind: 'status' }] },
				{ command: 'readFile', arg: [SESSION, ROOT, '.para/plan.html', undefined] },
			],
		});
	});

	test('errors from the SSH host keep their meaning', async () => {
		const { sessions } = await opened({ reh: (command, arg) => command === 'readFile' ? new Error('[denied] the path goes through a symbolic link: x') : defaultReh(command, arg) });
		const result = await sessions.handle({ sessionId: SESSION, op: { kind: 'readFile', place: ROOT, path: '.para/x' } });
		assert.strictEqual(code(result), 'rejected');
	});
});
