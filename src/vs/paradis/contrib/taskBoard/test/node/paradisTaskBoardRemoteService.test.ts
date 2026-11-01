/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisTaskBoardRemoteService } from '../../node/paradisTaskBoardRemoteService.js';

const SESSION = 'session-0123456789abcdef';

/** 投げた理由の `[code]`。投げなければ `ok`。 */
async function outcome(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'ok';
	} catch (error) {
		return /^\[(?<code>[a-z-]+)\]/.exec((error as Error).message)?.groups?.code ?? `other: ${(error as Error).message}`;
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
}

async function exists(path: string): Promise<boolean> {
	return fsp.lstat(path).then(() => true, () => false);
}

// 接続先の REH は Linux だけ（POSIX の持ち主と symlink の規則に依存する）
(isWindows ? suite.skip : suite)('Paradis task board remote - REH service', function () {

	this.timeout(30_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let repo: string;
	let outside: string;
	let worktrees: string;
	let service: ParadisTaskBoardRemoteService;
	let now: number;
	/** 立てると、次の git だけ終わらないプロセスに差し替える（待ち行列の上限を試す）。 */
	let hangGit: boolean;
	const baseEnv = { ...process.env, VSCODE_IPC_HOOK_CLI: '/tmp/cli.sock', PARA_CODE_PANE_TOKEN: 'pane-secret', PARADIS_PTY_DAEMON_BUILD_KEY: 'daemon-secret', GIT_DIR: '/nonexistent/.git', NODE_OPTIONS: '--require /nonexistent.js', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

	function createService(timeouts?: Partial<ConstructorParameters<typeof ParadisTaskBoardRemoteService>[2]>, afterCheck?: (stage: 'write' | 'reset') => Promise<void>): ParadisTaskBoardRemoteService {
		const spawn = ((file: string, args: readonly string[], options: cp.SpawnOptions) => hangGit && file === 'git'
			? cp.spawn('/bin/sh', ['-c', 'sleep 30'], options)
			: cp.spawn(file, [...args], options)) as typeof cp.spawn;
		return new ParadisTaskBoardRemoteService(new NullLogService(), async () => baseEnv, {
			gitShortMs: 10_000, gitLongMs: 10_000, commandMs: 10_000, killGraceMs: 500, closeGraceMs: 200, heartbeatExpiryMs: 120_000,
			...timeouts,
		}, () => now, spawn, process.getuid?.(), false, afterCheck);
	}

	setup(async () => {
		now = 1_000;
		hangGit = false;
		base = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'paradis-tb-remote-')));
		repo = join(base, 'repo');
		outside = join(base, 'outside');
		worktrees = join(base, 'repo-worktrees');
		await fsp.mkdir(repo);
		await fsp.mkdir(outside);
		await fsp.writeFile(join(outside, 'secret.txt'), 'secret');
		git(base, 'init', '--quiet', '--bare', join(base, 'origin.git'));
		git(repo, 'init', '--quiet', '-b', 'main');
		await fsp.writeFile(join(repo, 'a.txt'), 'a');
		git(repo, 'add', 'a.txt');
		git(repo, 'commit', '--quiet', '-m', 'init');
		git(repo, 'remote', 'add', 'origin', join(base, 'origin.git'));
		git(repo, 'push', '--quiet', 'origin', 'main');
		service = store.add(createService());
		await service.openSession(SESSION, repo, worktrees);
	});

	teardown(async () => {
		await fsp.rm(base, { recursive: true, force: true });
	});

	test('a session opens only at the top of a repository owned by this user, reached without symbolic links', async () => {
		await fsp.mkdir(join(repo, 'sub'));
		await fsp.symlink(repo, join(base, 'link'));
		const other = createService();
		try {
			assert.deepStrictEqual([
				await outcome(other.openSession('session-sub-0123456789', join(repo, 'sub'))),
				await outcome(other.openSession('session-link-0123456789', join(base, 'link'))),
				await outcome(other.openSession('short', repo)),
				await outcome(other.openSession('session-rel-0123456789', 'repo')),
				await outcome(other.openSession('session-ok-0123456789', repo)),
			], ['denied', 'denied', 'invalid', 'invalid', 'ok']);
		} finally {
			other.dispose();
		}
	});

	test('the worktree folder is created 0700 and must not be writable by others', async () => {
		assert.strictEqual((await fsp.stat(worktrees)).mode & 0o777, 0o700);
		const shared = join(base, 'shared');
		await fsp.mkdir(shared);
		await fsp.chmod(shared, 0o777);
		const other = createService();
		try {
			assert.strictEqual(await outcome(other.openSession('session-shared-0123456789', repo, shared)), 'denied');
		} finally {
			other.dispose();
		}
	});

	test('reading stays inside the workspace: dot-dot, absolute, symbolic links (last and middle), size', async () => {
		await fsp.mkdir(join(repo, 'shots'));
		await fsp.writeFile(join(repo, 'shots', 'ok.png'), 'png');
		await fsp.symlink(join(outside, 'secret.txt'), join(repo, 'shots', 'leak.png'));
		await fsp.symlink(outside, join(repo, 'linkdir'));
		await fsp.writeFile(join(repo, 'big.bin'), Buffer.alloc(2048));
		const read = (path: unknown, max?: number) => service.readFile(SESSION, repo, path, max);
		assert.strictEqual(Buffer.from((await read('shots/ok.png'))!).toString(), 'png');
		assert.deepStrictEqual([
			await outcome(read('../outside/secret.txt')),
			await outcome(read(join(outside, 'secret.txt'))),
			await outcome(read('shots/leak.png')),
			await outcome(read('linkdir/secret.txt')),
			await outcome(read('big.bin', 1024)),
			await outcome(read('shots')),
			await read('missing.png'),
		], ['invalid', 'invalid', 'denied', 'denied', 'denied', 'denied', undefined]);
	});

	test('a hard link to a file outside is not read or appended to', async () => {
		await fsp.mkdir(join(repo, '.para'));
		await fsp.link(join(outside, 'secret.txt'), join(repo, '.para', 'out.txt'));
		await fsp.unlink(join(repo, '.git', 'info', 'exclude')).catch(() => undefined);
		await fsp.link(join(outside, 'secret.txt'), join(repo, '.git', 'info', 'exclude'));
		assert.deepStrictEqual([
			await outcome(service.readFile(SESSION, repo, '.para/out.txt', 1024)),
			await outcome(service.excludeBoardDir(SESSION, repo)),
			await fsp.readFile(join(outside, 'secret.txt'), 'utf8'),
		], ['denied', 'denied', 'secret']);
	});

	test('swapping the board folder for a link after the checks does not write or delete outside', async () => {
		const swap = async () => {
			await fsp.rename(join(repo, '.para'), join(repo, '.para-moved'));
			await fsp.symlink(outside, join(repo, '.para'));
		};
		let armed = false;
		const swapping = createService(undefined, async () => {
			if (armed) {
				armed = false;
				await swap();
			}
		});
		try {
			await swapping.openSession(SESSION, repo, worktrees);
			await fsp.mkdir(join(repo, '.para'));
			armed = true;
			await swapping.writeFile(SESSION, repo, '.para/plan.html', 'plan');
			const afterWrite = [await exists(join(outside, 'plan.html')), await fsp.readFile(join(repo, '.para-moved', 'plan.html'), 'utf8')];
			await fsp.unlink(join(repo, '.para'));
			await fsp.rm(join(repo, '.para-moved'), { recursive: true });
			await fsp.mkdir(join(repo, '.para'));
			await fsp.writeFile(join(repo, '.para', 'old.html'), 'old');
			await fsp.writeFile(join(outside, 'keep.txt'), 'keep');
			armed = true;
			const reset = await outcome(swapping.resetBoardDir(SESSION, repo, 'task-2'));
			assert.deepStrictEqual([afterWrite, reset, (await fsp.readdir(outside)).sort(), await fsp.readdir(join(repo, '.para-moved'))], [[false, 'plan'], 'denied', ['keep.txt', 'secret.txt'], []]);
		} finally {
			swapping.dispose();
		}
	});

	test('push also refuses the default branch that origin/HEAD names on the host', async () => {
		git(repo, 'push', '--quiet', 'origin', 'main:develop');
		git(repo, 'fetch', '--quiet', 'origin');
		git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
		assert.strictEqual(await outcome(service.git(SESSION, repo, { kind: 'push', branch: 'develop', setUpstream: false, defaultBranch: undefined })), 'denied');
	});

	test('only registered places of the same repository are used', async () => {
		const otherRepo = join(base, 'other');
		await fsp.mkdir(otherRepo);
		git(otherRepo, 'init', '--quiet');
		await fsp.symlink(repo, join(base, 'repo-link'));
		assert.deepStrictEqual([
			await outcome(service.readFile(SESSION, outside, 'secret.txt', 100)),
			await outcome(service.registerPlace(SESSION, otherRepo)),
			await outcome(service.registerPlace(SESSION, join(base, 'repo-link'))),
			await outcome(service.registerPlace(SESSION, outside)),
			await outcome(service.git('session-unknown-0123456789', repo, { kind: 'status' })),
		], ['denied', 'denied', 'denied', 'denied', 'unknown-session']);
	});

	test('writing is limited to the flow files and the board folder, without following links', async () => {
		await service.writeFile(SESSION, repo, '.para-code/paracode.json', '{"workflows":[]}\n');
		assert.strictEqual(await fsp.readFile(join(repo, '.para-code', 'paracode.json'), 'utf8'), '{"workflows":[]}\n');
		await fsp.symlink(join(outside, 'secret.txt'), join(repo, '.paracode.json'));
		await fsp.symlink(outside, join(repo, '.para'));
		assert.deepStrictEqual([
			await outcome(service.writeFile(SESSION, repo, 'package.json', '{}')),
			await outcome(service.writeFile(SESSION, repo, '.git/config', '')),
			await outcome(service.writeFile(SESSION, repo, '.paracode.json', '{}')),
			await outcome(service.writeFile(SESSION, repo, '.para/plan.html', 'x')),
			await outcome(service.writeFile(SESSION, repo, '.para-code/../x', 'x')),
		], ['denied', 'denied', 'denied', 'denied', 'invalid']);
		assert.deepStrictEqual([await fsp.readFile(join(outside, 'secret.txt'), 'utf8'), await exists(join(outside, 'plan.html'))], ['secret', false]);
	});

	test('resetting the board folder refuses a linked folder and keeps the same task', async () => {
		await fsp.writeFile(join(outside, 'keep.txt'), 'keep');
		await fsp.symlink(outside, join(repo, '.para'));
		assert.strictEqual(await outcome(service.resetBoardDir(SESSION, repo, 'task-1')), 'denied');
		assert.strictEqual(await exists(join(outside, 'keep.txt')), true);
		await fsp.unlink(join(repo, '.para'));
		await fsp.mkdir(join(repo, '.para'));
		await fsp.writeFile(join(repo, '.para', 'old-plan.html'), 'old');
		await fsp.symlink(join(outside, 'keep.txt'), join(repo, '.para', 'link.txt'));
		assert.strictEqual(await service.resetBoardDir(SESSION, repo, 'task-1'), true);
		await fsp.writeFile(join(repo, '.para', 'plan.html'), 'new');
		assert.strictEqual(await service.resetBoardDir(SESSION, repo, 'task-1'), true);
		assert.deepStrictEqual([(await fsp.readdir(join(repo, '.para'))).sort(), await fsp.readFile(join(outside, 'keep.txt'), 'utf8')], [['.task', 'plan.html'], 'keep']);
	});

	test('the exclude line is added once inside the common git folder', async () => {
		await service.excludeBoardDir(SESSION, repo);
		await service.excludeBoardDir(SESSION, repo);
		const text = await fsp.readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
		assert.strictEqual(text.split('\n').filter(line => line === '/.para/').length, 1);
	});

	test('worktrees are added only under the worktree folder and removed only when this session made them', async () => {
		const dir = join(worktrees, '12-fix');
		const added = await service.git(SESSION, repo, { kind: 'worktreeAdd', dir, branch: 'para/12-fix', mode: 'new', base: { kind: 'local', branch: 'main' } });
		assert.strictEqual(added.code, 0, added.stderr);
		await fsp.writeFile(join(dir, 'b.txt'), 'b');
		git(repo, 'worktree', 'add', '--quiet', '-b', 'manual', join(base, 'manual'));
		assert.deepStrictEqual([
			await outcome(service.git(SESSION, repo, { kind: 'worktreeAdd', dir: join(outside, 'w'), branch: 'para/x', mode: 'new', base: { kind: 'head' } })),
			await outcome(service.git(SESSION, repo, { kind: 'worktreeAdd', dir: join(worktrees, 'a', 'b'), branch: 'para/x', mode: 'new', base: { kind: 'head' } })),
			await outcome(service.git(SESSION, repo, { kind: 'worktreeAdd', dir, branch: 'para/y', mode: 'new', base: { kind: 'head' } })),
			await outcome(service.git(SESSION, repo, { kind: 'worktreeRemove', dir: join(base, 'manual') })),
			await outcome(service.git(SESSION, dir, { kind: 'worktreeRemove', dir })),
			(await service.git(SESSION, dir, { kind: 'status' })).stdout.trim(),
		], ['denied', 'denied', 'denied', 'denied', 'denied', '?? b.txt']);
		// 未追跡のファイルがあるので --force なしでは外れない（強制では外さない）
		assert.notStrictEqual((await service.git(SESSION, repo, { kind: 'worktreeRemove', dir })).code, 0);
		await fsp.unlink(join(dir, 'b.txt'));
		assert.strictEqual((await service.git(SESSION, repo, { kind: 'worktreeRemove', dir })).code, 0);
		assert.strictEqual(await outcome(service.git(SESSION, dir, { kind: 'status' })), 'denied');
	});

	test('push sends HEAD to the task branch and refuses the default branch', async () => {
		const dir = join(worktrees, '7-feature');
		await service.git(SESSION, repo, { kind: 'worktreeAdd', dir, branch: 'para/7-feature', mode: 'new', base: { kind: 'local', branch: 'main' } });
		await fsp.writeFile(join(dir, 'a.txt'), 'changed');
		assert.strictEqual((await service.git(SESSION, dir, { kind: 'addTracked' })).code, 0);
		assert.strictEqual((await service.git(SESSION, dir, { kind: 'commit', message: 'change a' })).code, 0);
		const pushed = await service.git(SESSION, dir, { kind: 'push', branch: 'para/7-feature', setUpstream: true, defaultBranch: 'main' });
		assert.strictEqual(pushed.code, 0, pushed.stderr);
		assert.deepStrictEqual([
			git(join(base, 'origin.git'), 'rev-parse', 'refs/heads/para/7-feature') === git(dir, 'rev-parse', 'HEAD'),
			await outcome(service.git(SESSION, dir, { kind: 'push', branch: 'main', setUpstream: false, defaultBranch: 'main' })),
			await outcome(service.git(SESSION, dir, { kind: 'push', branch: 'release', setUpstream: false, defaultBranch: 'release' })),
			git(join(base, 'origin.git'), 'rev-parse', 'refs/heads/main') === git(repo, 'rev-parse', 'main'),
		], [true, 'denied', 'denied', true]);
	});

	test('commands do not see Para Code or VS Code secrets', async () => {
		const lines: string[] = [];
		const listener = service.onOutput(output => lines.push(...output.lines));
		try {
			const result = await service.runCommand(SESSION, repo, 'run-1', 'env; echo done');
			assert.strictEqual(result.code, 0);
			const names = result.stdout.split('\n').map(line => line.split('=')[0]);
			assert.deepStrictEqual([names.includes('VSCODE_IPC_HOOK_CLI'), names.includes('PARA_CODE_PANE_TOKEN'), names.includes('PARADIS_PTY_DAEMON_BUILD_KEY'), names.includes('GIT_DIR'), names.includes('NODE_OPTIONS'), result.stdout.includes('GIT_TERMINAL_PROMPT=0'), lines.includes('done')], [false, false, false, false, false, true, true]);
		} finally {
			listener.dispose();
		}
	});

	test('a command that runs too long is stopped with its whole process group', async () => {
		const quick = createService({ commandMs: 300 });
		try {
			await quick.openSession(SESSION, repo, worktrees);
			const pidFile = join(base, 'child.pid');
			const started = Date.now();
			const result = await quick.runCommand(SESSION, repo, 'run-slow', `sleep 30 & echo $! > ${pidFile}; wait`);
			const child = Number(await fsp.readFile(pidFile, 'utf8'));
			await new Promise(resolve => setTimeout(resolve, 200));
			let alive = true;
			try {
				process.kill(child, 0);
			} catch {
				alive = false;
			}
			assert.deepStrictEqual([result.timedOut, Date.now() - started < 5_000, alive], [true, true, false]);
		} finally {
			quick.dispose();
		}
	});

	test('at most two commands run at once, cancel and a lost heartbeat stop them', async () => {
		const first = service.runCommand(SESSION, repo, 'run-a', 'sleep 30');
		const second = service.runCommand(SESSION, repo, 'run-b', 'sleep 30');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepStrictEqual([
			await outcome(service.runCommand(SESSION, repo, 'run-c', 'true')),
			await outcome(service.runCommand(SESSION, repo, 'run-d', '')),
			service.cancelRun(SESSION, 'run-a'),
		], ['busy', 'invalid', true]);
		assert.strictEqual((await first).cancelled, true);
		now += 120_001;
		service.sweepHeartbeats();
		assert.deepStrictEqual([(await second).cancelled, await outcome(service.git(SESSION, repo, { kind: 'status' }))], [true, 'unknown-session']);
	});

	test('the git queue has a length limit', async () => {
		const slow = createService({ gitShortMs: 500 });
		try {
			await slow.openSession(SESSION, repo, worktrees);
			hangGit = true;
			const settled: string[] = [];
			const calls = Array.from({ length: 40 }, () => outcome(slow.git(SESSION, repo, { kind: 'status' })).then(result => { settled.push(result); }));
			await new Promise(resolve => setTimeout(resolve, 200));
			assert.deepStrictEqual([settled.length > 0, settled.every(result => result === 'busy')], [true, true]);
			slow.closeSession(SESSION);
			await Promise.all(calls);
		} finally {
			hangGit = false;
			slow.dispose();
		}
	});
});
