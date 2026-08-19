/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisCachedShellEnv } from '../../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

interface IExecFileCall {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv | undefined;
}

function createExecFile(calls: IExecFileCall[]): typeof cp.execFile {
	return ((command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => {
		calls.push({ command, args: [...args], env: options.env });
		queueMicrotask(() => callback(null, '', ''));
		return {} as cp.ChildProcess;
	}) as typeof cp.execFile;
}

suite('ParadisWorktreeGitService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs git worktree commands with the resolved shell PATH', async () => {
		const calls: IExecFileCall[] = [];
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => ({ PATH: '/opt/homebrew/bin:/usr/bin', PARADIS_TEST_ENV: 'shell' }),
		);

		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});

		assert.deepStrictEqual(calls.map(call => call.command), ['git', 'git']);
		assert.deepStrictEqual(calls.map(call => call.args), [
			['-C', '/repo', 'worktree', 'prune'],
			['-C', '/repo', 'worktree', 'add', '--no-track', '-b', 'feature-lfs', '/repo-worktrees/feature-lfs', 'main'],
		]);
		assert.strictEqual(calls[0].env?.PATH, '/opt/homebrew/bin:/usr/bin');
		assert.strictEqual(calls[1].env?.PATH, '/opt/homebrew/bin:/usr/bin');
		assert.strictEqual(calls[1].env?.PARADIS_TEST_ENV, 'shell');
	});

	test('falls back to the inherited process env when shell resolution fails', async () => {
		const calls: IExecFileCall[] = [];
		let resolverCalls = 0;
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => {
				resolverCalls++;
				throw new Error('shell resolution timed out');
			},
		);

		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});

		assert.deepStrictEqual({ resolverCalls, paths: calls.map(call => call.env?.PATH) }, {
			resolverCalls: 1,
			paths: [process.env.PATH, process.env.PATH],
		});
	});

	test('retries shell resolution after the failure cooldown', async () => {
		let now = 0;
		let resolverCalls = 0;
		const cachedEnv = new ParadisCachedShellEnv(
			new NullLogService(),
			'ParadisWorktreeGitTest',
			async () => {
				resolverCalls++;
				if (resolverCalls === 1) {
					throw new Error('shell resolution timed out');
				}
				return { PATH: '/resolved/bin' };
			},
			() => now,
		);

		const first = await cachedEnv.getEnv();
		const cachedFallback = await cachedEnv.getEnv();
		now = 5_000;
		const retried = await cachedEnv.getEnv();

		assert.deepStrictEqual({ resolverCalls, first: first.PATH, cached: cachedFallback.PATH, retried: retried.PATH }, {
			resolverCalls: 2,
			first: process.env.PATH,
			cached: process.env.PATH,
			retried: '/resolved/bin',
		});
	});

	test('resolves the shell environment only once and reuses it across execs', async () => {
		const calls: IExecFileCall[] = [];
		let resolverCalls = 0;
		const service = new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			createExecFile(calls),
			async () => {
				resolverCalls++;
				return { PATH: '/opt/homebrew/bin:/usr/bin' };
			},
		);

		// prune + add で execFile は2回呼ばれるが、シェル環境の解決は1回だけであるべき
		await service.addWorktree({
			repoPath: '/repo',
			worktreePath: '/repo-worktrees/feature-lfs',
			newBranch: 'feature-lfs',
			baseRef: 'main',
		});
		await service.listBranches('/repo');

		assert.strictEqual(resolverCalls, 1);
		assert.ok(calls.length > 2);
		for (const call of calls) {
			assert.strictEqual(call.env?.PATH, '/opt/homebrew/bin:/usr/bin');
		}
	});

	suite('WSL namespace dispatch', () => {
		const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo';
		const WSL_WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\u\\wt';
		const LOGIN_PATH = '/home/u/.local/bin:/usr/bin';
		/** ログインシェルの PATH を取りに行く一手。プロファイルの出力に紛れても目印で拾える。 */
		const isLoginPathProbe = (args: readonly string[]) => args.includes('-lc');
		const probeStdout = `Welcome to Ubuntu!\n__paracode_wsl_path__=${LOGIN_PATH}\n`;
		/** ディストロの中で実際に走るコマンドの部分だけを取り出す（前置きの env / sh は除く）。 */
		const runnerArgs = (args: readonly string[]) => args.slice(args.indexOf('cd -- "$0" && exec "$@"') + 1);

		/** Windows ホストを装ったサービス。wsl.exe への振り分けはホスト OS 判定で決まるため。 */
		function createWindowsHostService(handler: (command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => void): ParadisWorktreeGitService {
			return new ParadisWorktreeGitService(
				new NullLogService(),
				undefined,
				undefined,
				handler as unknown as typeof cp.execFile,
				async () => ({}),
				true,
			);
		}

		test('runs git inside the distro with distro-relative paths and the login PATH', async () => {
			const calls: Array<{ command: string; args: readonly string[]; cwd?: string; wslenv?: string }> = [];
			const service = createWindowsHostService((command, args, options, callback) => {
				calls.push({ command, args, cwd: options.cwd as string | undefined, wslenv: (options.env as NodeJS.ProcessEnv | undefined)?.WSLENV });
				callback(null, isLoginPathProbe(args) ? probeStdout : '3\t1\tsrc/a.ts\n', '');
			});

			assert.deepStrictEqual(await service.getDiffStat(WSL_REPO), { insertions: 3, deletions: 1 });
			assert.deepStrictEqual(calls, [
				// System32 が無い環境（CI の macOS/Linux）では PATH 解決へ委ねる
				{ command: 'wsl.exe', args: ['-d', 'Ubuntu', '-e', 'bash', '-lc', 'printf \'\\n%s%s\\n\' \'__paracode_wsl_path__=\' "$PATH"'], cwd: undefined, wslenv: undefined },
				{
					command: 'wsl.exe',
					// ログインシェルは通さない（プロファイルの出力が git の stdout に混ざるため）。
					// 代わりに env で PATH だけ被せ、作業ディレクトリは sh の cd で入る。
					args: ['-d', 'Ubuntu', '-e', 'env', `PATH=${LOGIN_PATH}`, 'sh', '-c', 'cd -- "$0" && exec "$@"', '/', 'git', '-C', '/home/u/repo', 'diff', 'HEAD', '--numstat'],
					cwd: undefined,
					// WSLENV を通さないと GIT_TERMINAL_PROMPT がディストロ内へ届かない
					wslenv: 'GIT_TERMINAL_PROMPT',
				},
			]);
		});

		test('runs gh inside the distro, anchored by cd instead of a UNC cwd', async () => {
			const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
			const service = createWindowsHostService((command, args, options, callback) => {
				calls.push({ command, args, cwd: options.cwd as string | undefined });
				if (isLoginPathProbe(args)) { callback(null, probeStdout, ''); return; }
				callback(null, runnerArgs(args)[1] === 'git' ? 'feat/x\n' : JSON.stringify({
					number: 7, title: 'x', url: 'https://example.com/pr/7', state: 'OPEN', isDraft: true, headRefName: 'feat/x',
				}), '');
			});

			assert.deepStrictEqual(await service.getPrStatus(WSL_REPO), {
				number: 7, title: 'x', url: 'https://example.com/pr/7', state: 'draft',
			});
			// PATH の取得はディストロにつき一度だけで、以降の実行では再利用される
			assert.deepStrictEqual(calls.filter(call => isLoginPathProbe(call.args)).length, 1);
			assert.deepStrictEqual(calls.slice(1).map(call => ({ command: call.command, cwd: call.cwd, runner: runnerArgs(call.args) })), [
				{ command: 'wsl.exe', cwd: undefined, runner: ['/', 'git', '-C', '/home/u/repo', 'rev-parse', '--abbrev-ref', 'HEAD'] },
				{ command: 'wsl.exe', cwd: undefined, runner: ['/home/u/repo', 'gh', 'pr', 'view', '--json', 'number,title,url,state,isDraft,headRefName'] },
			]);
		});

		test('keeps a free-text lock reason that looks like a Windows path out of the namespace check', async () => {
			// `--reason` の値はユーザーの自由入力。ここをパスとして扱うと、ロックの掛け直しが
			// 名前空間の不一致として弾かれ、削除できていないのにロックだけ消える。
			const runners: string[][] = [];
			const service = createWindowsHostService((_command, args, _options, callback) => {
				if (isLoginPathProbe(args)) { callback(null, probeStdout, ''); return; }
				const runner = runnerArgs(args);
				runners.push([...runner]);
				if (runner.includes('list')) { callback(null, 'worktree /home/u/wt\0locked C:\\builds\\agent held\0\0', ''); return; }
				if (runner.includes('remove')) { callback(Object.assign(new Error('exit 1'), { code: 1 }), '', 'fatal: still in use'); return; }
				callback(null, '', '');
			});

			await assert.rejects(service.removeWorktree({ repoPath: WSL_REPO, worktreePath: WSL_WORKTREE, unlock: true, force: false }), /still in use/);
			// remove が失敗した以上、外したロックは理由ごと掛け直されていなければならない
			assert.deepStrictEqual(runners.at(-1), ['/', 'git', '-C', '/home/u/repo', 'worktree', 'lock', '--reason', 'C:\\builds\\agent held', '/home/u/wt']);
		});

		test('falls back to the default PATH when the login shell cannot be read', async () => {
			const calls: string[][] = [];
			const service = createWindowsHostService((_command, args, _options, callback) => {
				calls.push([...args]);
				if (isLoginPathProbe(args)) { callback(Object.assign(new Error('exit 1'), { code: 1 }), '', 'no bash'); return; }
				callback(null, '', '');
			});

			await service.getDiffStat(WSL_REPO);
			assert.deepStrictEqual(calls[1].slice(0, 4), ['-d', 'Ubuntu', '-e', 'sh']);
		});

		test('refuses to mix a Windows worktree target into a WSL repository', async () => {
			const service = createWindowsHostService((_command, _args, _options, callback) => callback(null, '', ''));

			await assert.rejects(
				service.addWorktree({ repoPath: WSL_REPO, worktreePath: 'C:\\worktrees\\x', newBranch: 'x', baseRef: 'main' }),
				/across the Windows and WSL namespaces/,
			);
		});

		test('leaves local repositories on the direct git invocation', async () => {
			const calls: Array<{ command: string; args: readonly string[] }> = [];
			const service = createWindowsHostService((command, args, _options, callback) => {
				calls.push({ command, args });
				callback(null, '', '');
			});

			await service.getDiffStat('C:\\repo');
			assert.deepStrictEqual(calls, [{ command: 'git', args: ['-C', 'C:\\repo', 'diff', 'HEAD', '--numstat'] }]);
		});
	});

	function createLifecycleService(handler: (command: string, args: readonly string[], options: cp.ExecFileOptions, callback: (error: (cp.ExecFileException & { code?: number }) | null, stdout: string, stderr: string) => void) => void): ParadisWorktreeGitService {
		return new ParadisWorktreeGitService(
			new NullLogService(),
			undefined,
			undefined,
			handler as unknown as typeof cp.execFile,
			async () => ({}),
		);
	}

	test('sums insertions and deletions across files, skipping binary entries', async () => {
		const service = createLifecycleService((_command, args, _options, callback) => {
			assert.deepStrictEqual(args, ['-C', '/worktree', 'diff', 'HEAD', '--numstat']);
			// バイナリファイルは "-\t-\t<path>" で出力される (加算対象外)
			callback(null, '10\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n0\t5\tsrc/b.ts\n', '');
		});

		assert.deepStrictEqual(await service.getDiffStat('/worktree'), { insertions: 10, deletions: 7 });
	});

	test('returns zero stats instead of throwing when git fails (removed worktree, not a repo, ...)', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			callback(Object.assign(new Error('exit 128'), { code: 128 }), '', 'fatal: not a git repository');
		});

		assert.deepStrictEqual(await service.getDiffStat('/gone'), { insertions: 0, deletions: 0 });
	});

	test('runs lifecycle script in worktree with project root environment and a hang-protection timeout', async () => {
		const calls: Array<{ command: string; args: readonly string[]; cwd?: string; root?: string; timeout?: number }> = [];
		const service = createLifecycleService((command, args, options, callback) => {
			calls.push({ command, args, cwd: options.cwd as string, root: (options.env as NodeJS.ProcessEnv | undefined)?.PARACODE_PROJECT_ROOT_PATH, timeout: options.timeout });
			callback(null, '', '');
		});
		await service.runLifecycleScript({
			kind: 'setup', repoPath: '/repo', worktreePath: '/repo-worktrees/task', script: 'bun install'
		});
		assert.deepStrictEqual(calls, [{
			command: process.env.SHELL || '/bin/sh',
			args: ['-lc', 'bun install'],
			cwd: '/repo-worktrees/task',
			root: '/repo',
			timeout: 10 * 60_000
		}]);
	});

	test('rejects a non-zero lifecycle script exit', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			callback(Object.assign(new Error('exit 7'), { code: 7 }), '', 'failed setup');
		});
		await assert.rejects(
			service.runLifecycleScript({ kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'false' }),
			/setup スクリプトが失敗しました.*failed setup/
		);
	});

	test('reports an output-limit overflow as such instead of mislabeling it a timeout', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			// maxBuffer 超過時も killed=true になるが、code に文字列エラーコードが入る
			callback(Object.assign(new Error('stdout maxBuffer length exceeded'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' as unknown as number }), '', '');
		});
		await assert.rejects(
			service.runLifecycleScript({ kind: 'setup', repoPath: '/repo', worktreePath: '/worktree', script: 'yes' }),
			/setup スクリプトの出力が上限/
		);
	});

	test('reports a timed-out lifecycle script as timeout instead of a generic failure', async () => {
		const service = createLifecycleService((_command, _args, _options, callback) => {
			// Node は timeout 到達時に子プロセスを kill し、killed=true・code=null のエラーを返す
			callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' as NodeJS.Signals }), '', '');
		});
		await assert.rejects(
			service.runLifecycleScript({ kind: 'teardown', repoPath: '/repo', worktreePath: '/worktree', script: 'sleep infinity' }),
			/teardown スクリプトが 10 分以内に終了しなかった/
		);
	});

	suite('runGit', () => {
		test('runs an allowed subcommand with -C and core.quotepath=false, returning exit code 0', async () => {
			const calls: IExecFileCall[] = [];
			const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, createExecFile(calls));

			const result = await service.runGit('/repo', ['status', '--porcelain=v1']);

			assert.deepStrictEqual(calls.map(call => ({ command: call.command, args: call.args })), [
				{ command: 'git', args: ['-C', '/repo', '-c', 'core.quotepath=false', 'status', '--porcelain=v1'] },
			]);
			assert.deepStrictEqual(result, { code: 0, stdout: '', stderr: '' });
		});

		test('rejects a subcommand outside the allow list without spawning a process', async () => {
			const calls: IExecFileCall[] = [];
			const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, createExecFile(calls));

			await assert.rejects(service.runGit('/repo', ['push', 'origin', 'main']), /subcommand not allowed/);

			assert.strictEqual(calls.length, 0);
		});

		test('rejects a forbidden option even inside an allowed subcommand, without spawning a process', async () => {
			const calls: IExecFileCall[] = [];
			const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, createExecFile(calls));

			await assert.rejects(service.runGit('/repo', ['log', '--upload-pack=evil']), /argument not allowed/);

			assert.strictEqual(calls.length, 0);
		});

		test('returns a non-zero exit code instead of rejecting when git itself fails', async () => {
			const execFile = ((_command: string, _args: readonly string[], _options: cp.ExecFileOptions, callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void) => {
				callback(Object.assign(new Error('exit 128'), { code: 128 }), '', 'fatal: not a git repository');
				return {} as cp.ChildProcess;
			}) as typeof cp.execFile;
			const service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, execFile);

			const result = await service.runGit('/repo', ['status', '--porcelain=v1']);

			assert.deepStrictEqual(result, { code: 128, stdout: '', stderr: 'fatal: not a git repository' });
		});
	});
});
