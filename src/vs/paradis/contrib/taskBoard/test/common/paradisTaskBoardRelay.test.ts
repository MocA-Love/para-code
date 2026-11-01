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
import { ParadisTaskBoardRelaySessions } from '../../common/paradisTaskBoardRelaySessions.js';

const KEY = 'k'.repeat(43);
const SESSION = 'session-0123456789abcdef';
const AUTHORITY = 'ssh-remote+host';
const REPO = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/u/repo' });

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

suite('Paradis task board relay - window side', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options?: { remoteAuthority?: string | null; registered?: boolean; reh?: (command: string, arg: unknown) => unknown }) {
		const reh = new FakeChannel(options?.reh ?? (command => command === 'openSession' ? { toplevel: '/home/u/repo', commonDir: '/home/u/repo/.git' } : command === 'readFile' ? VSBuffer.fromString('plan') : { code: 0, stdout: 'x', stderr: '', timedOut: false }));
		const bridge = new FakeChannel(() => true);
		const sessions = store.add(new ParadisTaskBoardRelaySessions({
			remoteAuthority: options?.remoteAuthority === null ? undefined : options?.remoteAuthority ?? AUTHORITY,
			remoteChannel: () => reh,
			bridge,
			isWindowFolder: () => options?.registered ?? true,
			newSessionId: () => SESSION,
			warn: () => { },
		}));
		return { sessions, reh, bridge };
	}

	test('board registration and request shapes', () => {
		assert.deepStrictEqual([
			paradisParseTaskBoardBoardRegistration({ pid: 1234, key: KEY }),
			paradisParseTaskBoardBoardRegistration({ pid: 1, key: KEY }),
			paradisParseTaskBoardBoardRegistration({ pid: 1234, key: 'short' }),
			paradisTaskBoardRelayOperationName({ op: { kind: 'git', git: { kind: 'status' } } }),
			paradisTaskBoardRelayOperationName({ op: { kind: 'git', git: { kind: '<script>' } } }),
		], [{ pid: 1234, key: KEY }, undefined, undefined, 'git.status', 'git.unknown']);
	});

	test('requests are rebuilt from the allowed fields only, and anything but read-only git and readFile is not available yet', () => {
		const parse = (op: unknown) => {
			const result = paradisParseTaskBoardRelayRequest({ sessionId: SESSION, op, extra: 'x' });
			return result.ok ? result.value : result.code;
		};
		assert.deepStrictEqual([
			parse({ kind: 'git', git: { kind: 'status', args: ['--output=/tmp/x'], cwd: '/etc' }, cwd: '/etc' }),
			parse({ kind: 'git', git: { kind: 'aheadCount', base: { kind: 'remote', branch: 'main', x: 1 }, head: { kind: 'head', branch: 'y' } } }),
			parse({ kind: 'readFile', path: '.para/plan.html', maxBytes: 100, root: '/' }),
			parse({ kind: 'git', git: { kind: 'push', branch: 'para/x' } }),
			parse({ kind: 'git', git: { kind: 'commit', message: 'x' } }),
			parse({ kind: 'runCommand', command: 'rm -rf /' }),
			parse({ kind: 'writeFile', path: '.para/x', content: 'x' }),
			parse({ kind: 'git', git: { kind: 'aheadCount', base: 'HEAD~1', head: { kind: 'head' } } }),
		], [
			{ sessionId: SESSION, op: { kind: 'git', git: { kind: 'status' } } },
			{ sessionId: SESSION, op: { kind: 'git', git: { kind: 'aheadCount', base: { kind: 'remote', branch: 'main' }, head: { kind: 'head' } } } },
			{ sessionId: SESSION, op: { kind: 'readFile', path: '.para/plan.html', maxBytes: 100 } },
			'unavailable', 'unavailable', 'unavailable', 'unavailable', 'invalid',
		]);
	});

	test('a session opens only for a registered repository on the SSH host of this window', async () => {
		const other = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+other', path: '/home/u/repo' });
		const local = URI.file('/home/u/repo');
		const code = (result: { ok: boolean; code?: string }) => result.ok ? 'ok' : result.code;
		assert.deepStrictEqual([
			code(await create({ remoteAuthority: null }).sessions.open(REPO, KEY)),
			code(await create().sessions.open(other, KEY)),
			code(await create().sessions.open(local, KEY)),
			code(await create({ registered: false }).sessions.open(REPO, KEY)),
			code(await create().sessions.open(REPO, 'short')),
			code(await create({ reh: () => new Error('Unknown channel: paradisTaskBoardRemote') }).sessions.open(REPO, KEY)),
		], ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'unavailable']);
		const { sessions, reh, bridge } = create();
		assert.deepStrictEqual(await sessions.open(REPO, KEY), { ok: true, value: { sessionId: SESSION } });
		assert.deepStrictEqual([reh.calls, bridge.calls], [
			[{ command: 'openSession', arg: [SESSION, '/home/u/repo'] }],
			[{ command: 'registerRelaySession', arg: { sessionId: SESSION, boardKey: KEY, authority: AUTHORITY, repository: '/home/u/repo' } }],
		]);
	});

	test('the window sends only the rebuilt operation to the SSH host, for its own sessions', async () => {
		const { sessions, reh } = create();
		await sessions.open(REPO, KEY);
		const results = [
			await sessions.handle({ sessionId: SESSION, op: { kind: 'git', git: { kind: 'status', args: ['--exec=sh'] }, place: '/etc' } }),
			await sessions.handle({ sessionId: SESSION, op: { kind: 'readFile', path: '.para/plan.html' } }),
			await sessions.handle({ sessionId: SESSION, op: { kind: 'git', git: { kind: 'push', branch: 'para/x' } } }),
			await sessions.handle({ sessionId: 'session-ffffffffffffffff', op: { kind: 'git', git: { kind: 'status' } } }),
		];
		assert.deepStrictEqual({
			results: results.map(result => result.ok ? result.value : result.code),
			sent: reh.calls.slice(1),
		}, {
			results: [{ code: 0, stdout: 'x', stderr: '', timedOut: false }, { base64: 'cGxhbg==', size: 4, detail: '.para/plan.html 4' }, 'unavailable', 'not-found'],
			sent: [
				{ command: 'git', arg: [SESSION, '/home/u/repo', { kind: 'status' }] },
				{ command: 'readFile', arg: [SESSION, '/home/u/repo', '.para/plan.html', undefined] },
			],
		});
	});

	test('errors from the SSH host keep their meaning', async () => {
		const { sessions } = create({ reh: command => command === 'openSession' ? { toplevel: '/home/u/repo' } : new Error('[denied] the path goes through a symbolic link: x') });
		await sessions.open(REPO, KEY);
		const result = await sessions.handle({ sessionId: SESSION, op: { kind: 'readFile', path: 'x' } });
		assert.deepStrictEqual(result.ok ? 'ok' : result.code, 'rejected');
	});
});
