/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisTaskBoardRemoteAbsolutePathError,
	paradisTaskBoardRemoteBranchError,
	paradisTaskBoardRemoteCommandError,
	paradisTaskBoardRemoteEnv,
	paradisTaskBoardRemoteFlowFile,
	paradisTaskBoardRemoteGitPlan,
	paradisTaskBoardRemoteIsReadablePath,
	paradisTaskBoardRemoteIsWritablePath,
	paradisTaskBoardRemoteStripUrlCredentials,
	paradisTaskBoardRemoteRelativePathError,
} from '../../common/paradisTaskBoardRemote.js';

/** 投げた理由の `[code]`。投げなければ `ok`。 */
function outcome(fn: () => unknown): string {
	try {
		fn();
		return 'ok';
	} catch (error) {
		return /^\[(?<code>[a-z-]+)\]/.exec((error as Error).message)?.groups?.code ?? `other: ${(error as Error).message}`;
	}
}

suite('Paradis task board remote - checks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('branch names', () => {
		const names = ['para/12-fix', 'feature/a.b_c', '-delete', '+main', 'a..b', 'a//b', 'a/', '/a', 'a.lock', 'x/.hidden', 'HEAD', 'a b', 'a:b', 'a~1', 'a^', 'a@{1}', '', 'é', 'x'.repeat(201)];
		assert.deepStrictEqual(names.map(name => [name.slice(0, 12), paradisTaskBoardRemoteBranchError(name) === undefined]), [
			['para/12-fix', true], ['feature/a.b_', true], ['-delete', false], ['+main', false], ['a..b', false], ['a//b', false], ['a/', false], ['/a', false],
			['a.lock', false], ['x/.hidden', false], ['HEAD', false], ['a b', false], ['a:b', false], ['a~1', false], ['a^', false], ['a@{1}', false], ['', false], ['é', false], ['xxxxxxxxxxxx', false],
		]);
	});

	test('relative and absolute paths', () => {
		const relative = ['a/b.png', '.para/plan.html', '../x', 'a/../../x', '/etc/passwd', 'a//b', './a', 'a/.', 'a\\b', 'a\0b', ''];
		assert.deepStrictEqual(relative.map(value => paradisTaskBoardRemoteRelativePathError(value) === undefined), [true, true, false, false, false, false, false, false, false, false, false]);
		const absolute = ['/home/u/repo', '/home/u/repo/', '/home/u/../etc', '/home//u', 'home/u', '/home/u/./x', '/'];
		assert.deepStrictEqual(absolute.map(value => paradisTaskBoardRemoteAbsolutePathError(value) === undefined), [true, false, false, false, false, false, false]);
	});

	test('writable paths are the flow files and the board folder only', () => {
		const paths = ['.para-code/paracode.json', '.paracode.json', '.para-code/octocat/workflows.json', '.para/plan.html', '.para-code/x/y.json', 'package.json', '.git/config', '.paraX/a'];
		assert.deepStrictEqual(paths.map(paradisTaskBoardRemoteIsWritablePath), [true, true, true, true, false, false, false, false]);
		assert.deepStrictEqual([outcome(() => paradisTaskBoardRemoteFlowFile('personal', '../x')), paradisTaskBoardRemoteFlowFile('personal', 'octocat'), outcome(() => paradisTaskBoardRemoteFlowFile('other'))], ['invalid', '.para-code/octocat/workflows.json', 'invalid']);
	});

	test('git plans for read-only operations', () => {
		const plan = paradisTaskBoardRemoteGitPlan('/r', { kind: 'aheadCount', base: { kind: 'remote', branch: 'main' }, head: { kind: 'head' } });
		assert.deepStrictEqual(plan, {
			args: ['-C', '/r', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'rev-list', '--count', 'refs/remotes/origin/main..HEAD'],
			readOnly: true, network: false, hooks: false,
		});
		assert.deepStrictEqual(paradisTaskBoardRemoteGitPlan('/r', { kind: 'status' }).args.slice(6), ['--no-optional-locks', 'status', '--porcelain']);
		assert.deepStrictEqual(paradisTaskBoardRemoteGitPlan('/r', { kind: 'commit', message: 'fix (#1)' }).args, ['-C', '/r', '-c', 'core.quotepath=false', 'commit', '--quiet', '-m', 'fix (#1)']);
	});

	test('git plans refuse operations and values outside the list', () => {
		const ops: unknown[] = [
			{ kind: 'gc' },
			{ kind: 'raw', args: ['config', 'core.sshCommand', 'x'] },
			undefined,
			{ kind: 'refExists', rev: { kind: 'local', branch: '--output=/tmp/x' } },
			{ kind: 'aheadCount', base: 'HEAD~1', head: { kind: 'head' } },
			{ kind: 'worktreeAdd', dir: 'relative', branch: 'para/a', mode: 'new', base: { kind: 'head' } },
			{ kind: 'worktreeAdd', dir: '/w/a', branch: 'para/a', mode: 'force' },
			{ kind: 'commit', message: 'line1\nline2' },
			{ kind: 'commit', message: '' },
		];
		assert.deepStrictEqual(ops.map(op => outcome(() => paradisTaskBoardRemoteGitPlan('/r', op))), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
		// コミットのメッセージは値なので、`--output=` で始まっても禁止のオプションとしては扱わない
		assert.strictEqual(outcome(() => paradisTaskBoardRemoteGitPlan('/r', { kind: 'commit', message: '--output=/tmp/x' })), 'ok');
		assert.strictEqual(outcome(() => paradisTaskBoardRemoteGitPlan('relative', { kind: 'status' })), 'invalid');
	});

	test('push goes only to a non-default branch, never forced', () => {
		assert.deepStrictEqual(paradisTaskBoardRemoteGitPlan('/r', { kind: 'push', branch: 'para/12-fix', setUpstream: true, defaultBranch: 'develop', force: true }), {
			args: ['-C', '/r', '-c', 'core.quotepath=false', 'push', '--no-follow-tags', '--set-upstream', 'origin', 'HEAD:refs/heads/para/12-fix'],
			readOnly: false, network: true, hooks: true,
		});
		const pushes: unknown[] = [
			{ kind: 'push', branch: 'main', setUpstream: false, defaultBranch: 'develop' },
			{ kind: 'push', branch: 'master', setUpstream: false, defaultBranch: undefined },
			{ kind: 'push', branch: 'develop', setUpstream: false, defaultBranch: 'develop' },
			{ kind: 'push', branch: '+para/x', setUpstream: false, defaultBranch: 'main' },
			{ kind: 'push', branch: 'para/x:refs/heads/main', setUpstream: false, defaultBranch: 'main' },
			{ kind: 'push', branch: ':para/x', setUpstream: false, defaultBranch: 'main' },
			{ kind: 'push', branch: '--force', setUpstream: false, defaultBranch: 'main' },
			{ kind: 'push', branch: 'para/x', setUpstream: false, defaultBranch: '--all' },
		];
		assert.deepStrictEqual(pushes.map(op => outcome(() => paradisTaskBoardRemoteGitPlan('/r', op))), ['denied', 'denied', 'denied', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
	});

	test('fetch has only origin and --prune', () => {
		assert.deepStrictEqual(paradisTaskBoardRemoteGitPlan('/r', { kind: 'fetch', prune: true, remote: 'ext::sh -c x' }).args.slice(4), ['fetch', '--quiet', '--prune', 'origin']);
	});

	test('readable paths and remote URLs without credentials', () => {
		const paths = ['.para/plan.html', '.para-code/paracode.json', '.para-code/octocat/workflows.json', '.env', 'src/a.ts', '.git/config', '.para/.git/config', '.para/.GIT/x'];
		assert.deepStrictEqual(paths.map(paradisTaskBoardRemoteIsReadablePath), [true, true, true, false, false, false, false, false]);
		assert.deepStrictEqual([
			paradisTaskBoardRemoteStripUrlCredentials('https://user:token@github.com/o/r.git\n'),
			paradisTaskBoardRemoteStripUrlCredentials('ssh://git@github.com/o/r.git'),
			paradisTaskBoardRemoteStripUrlCredentials('git@github.com:o/r.git'),
			paradisTaskBoardRemoteStripUrlCredentials('https://github.com/o/r.git'),
			paradisTaskBoardRemoteStripUrlCredentials('https://user:p@ss@github.com/o/r@x.git'),
			paradisTaskBoardRemoteStripUrlCredentials(`fatal: unable to access 'https://u:t@h.example/o.git/' and ssh://git@h.example/x`),
		], ['https://github.com/o/r.git\n', 'ssh://github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r.git', 'https://github.com/o/r@x.git', `fatal: unable to access 'https://h.example/o.git/' and ssh://h.example/x`]);
	});

	test('command text', () => {
		assert.deepStrictEqual(['npm test', '', '   ', 'a\0b', 'x'.repeat(16 * 1024 + 1), 42].map(value => paradisTaskBoardRemoteCommandError(value) === undefined), [true, false, false, false, false, false]);
	});

	test('environment drops Para Code and VS Code internals and adds fixed values', () => {
		assert.deepStrictEqual(paradisTaskBoardRemoteEnv({
			PATH: '/usr/bin',
			HOME: '/home/u',
			SSH_AUTH_SOCK: '/tmp/agent.sock',
			VSCODE_IPC_HOOK_CLI: '/tmp/cli.sock',
			VSCODE_AGENT_HOST_CONNECTION_TOKEN: 'secret',
			vscode_lower: 'x',
			ELECTRON_RUN_AS_NODE: '1',
			PARA_CODE_PANE_TOKEN: 'secret',
			PARADIS_PTY_DAEMON_BUILD_KEY: 'secret',
			GIT_TERMINAL_PROMPT: '1',
			GIT_DIR: '/elsewhere/.git',
			GIT_WORK_TREE: '/elsewhere',
			GIT_CONFIG_PARAMETERS: 'core.sshCommand=sh',
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/tmp/hooks',
			GIT_EXEC_PATH: '/tmp/git-core',
			GIT_INDEX_FILE: '/tmp/index',
			NODE_OPTIONS: '--require /tmp/x.js',
			GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
			UNSET: undefined,
		}), {
			PATH: '/usr/bin',
			HOME: '/home/u',
			SSH_AUTH_SOCK: '/tmp/agent.sock',
			GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
			GIT_TERMINAL_PROMPT: '0',
			GCM_INTERACTIVE: 'never',
			GH_PROMPT_DISABLED: '1',
			CI: '1',
		});
	});
});
