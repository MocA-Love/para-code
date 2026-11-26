/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisWorktreeGitService } from '../../node/paradisWorktreeGitChannel.js';

(isWindows ? suite.skip : suite)('ParadisWorktreeGitService existing branches (new space from a remote branch)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let origin: string;
	let repo: string;
	let other: string;
	let service: ParadisWorktreeGitService;

	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
	let counter = 0;
	const commit = async (cwd: string, message: string) => {
		await fs.writeFile(join(cwd, `f${counter++}.txt`), message);
		git(cwd, 'add', '.');
		git(cwd, 'commit', '-q', '-m', message);
		return git(cwd, 'rev-parse', 'HEAD');
	};
	/** origin に `branch` を作って push する（別のクローンから。`repo` は fetch するまで知らない）。 */
	const pushFromOther = async (branch: string, commits: number) => {
		git(other, 'switch', '-q', '-c', branch, 'origin/main');
		for (let i = 0; i < commits; i++) {
			await commit(other, `${branch} ${i}`);
		}
		git(other, 'push', '-q', 'origin', branch);
		git(other, 'switch', '-q', 'main');
	};
	const wt = (name: string) => join(root, 'wt', name);
	const head = (path: string) => git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
	const upstream = (branch: string) => {
		try {
			return git(repo, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`);
		} catch {
			return undefined;
		}
	};

	setup(async () => {
		root = join(tmpdir(), `paradis-existing-branch-${generateUuid()}`);
		origin = join(root, 'origin.git');
		repo = join(root, 'repo');
		other = join(root, 'other');
		await fs.mkdir(root, { recursive: true });
		git(root, 'init', '-q', '--bare', '-b', 'main', origin);
		git(root, 'clone', '-q', origin, other);
		git(other, 'switch', '-q', '-c', 'main');
		await commit(other, 'init');
		git(other, 'push', '-q', '-u', 'origin', 'main');
		git(root, 'clone', '-q', origin, repo);
		service = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, cp.execFile, async () => ({ ...process.env }));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('lists local and origin branches (without origin/HEAD), the branches in use, and whether origin exists', async () => {
		await pushFromOther('feature/remote-only', 1);
		git(repo, 'fetch', '-q', 'origin');
		git(repo, 'branch', 'local-only');
		git(repo, 'worktree', 'add', '-q', wt('busy'), '-b', 'busy');
		// フォルダの消えたワークツリー（prunable）は使用中に数えない
		git(repo, 'worktree', 'add', '-q', wt('gone'), '-b', 'gone');
		await fs.rm(wt('gone'), { recursive: true, force: true });

		const result = await service.listBranchCandidates(repo);
		assert.deepStrictEqual({
			local: result.local.map(branch => branch.name).sort(),
			remote: result.remote.map(branch => branch.name).sort(),
			inUse: result.inUse.map(entry => ({ branch: entry.branch, main: entry.main })),
			hasOrigin: result.hasOrigin,
			fetched: typeof result.lastFetchedAt === 'number',
		}, {
			local: ['busy', 'gone', 'local-only', 'main'],
			remote: ['feature/remote-only', 'main'],
			inUse: [{ branch: 'main', main: true }, { branch: 'busy', main: false }],
			hasOrigin: true,
			fetched: true,
		});
	});

	test('opens a local branch as it is', async () => {
		git(repo, 'branch', 'local-only');
		const result = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('a'), branch: 'local-only', source: 'local' });
		assert.deepStrictEqual({ result, head: head(wt('a')), branches: git(repo, 'branch', '--format=%(refname:short)').split('\n').sort() }, {
			result: { plan: 'open', synced: false },
			head: 'local-only',
			branches: ['local-only', 'main'],
		});
	});

	test('creates a local branch tracking origin for a branch that is only on origin', async () => {
		await pushFromOther('feature/remote-only', 2);
		git(repo, 'fetch', '-q', 'origin');
		const remoteSha = git(repo, 'rev-parse', 'origin/feature/remote-only');
		const result = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('b'), branch: 'feature/remote-only', source: 'origin' });
		assert.deepStrictEqual({ result, head: head(wt('b')), sha: git(wt('b'), 'rev-parse', 'HEAD'), upstream: upstream('feature/remote-only') }, {
			result: { plan: 'track', synced: false },
			head: 'feature/remote-only',
			sha: remoteSha,
			upstream: 'origin/feature/remote-only',
		});
	});

	test('fast-forwards a local branch that is only behind origin when asked, and leaves it when not', async () => {
		await pushFromOther('feature/behind', 1);
		git(repo, 'fetch', '-q', 'origin');
		git(repo, 'branch', 'feature/behind', 'origin/feature/behind');
		const oldSha = git(repo, 'rev-parse', 'feature/behind');
		git(other, 'switch', '-q', 'feature/behind');
		await commit(other, 'more 1');
		await commit(other, 'more 2');
		git(other, 'push', '-q', 'origin', 'feature/behind');
		git(other, 'switch', '-q', 'main');
		git(repo, 'fetch', '-q', 'origin');
		const remoteSha = git(repo, 'rev-parse', 'origin/feature/behind');

		const state = await service.inspectExistingBranch(repo, 'feature/behind');
		const off = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('off'), branch: 'feature/behind', source: 'origin' });
		const offSha = git(wt('off'), 'rev-parse', 'HEAD');
		git(repo, 'worktree', 'remove', wt('off'));
		const on = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('on'), branch: 'feature/behind', source: 'origin', sync: 'fastForward' });
		assert.deepStrictEqual({ ahead: state.ahead, behind: state.behind, off, offSha, on, onSha: git(wt('on'), 'rev-parse', 'HEAD') }, {
			ahead: 0,
			behind: 2,
			off: { plan: 'behind', synced: false },
			offSha: oldSha,
			on: { plan: 'behind', synced: true },
			onSha: remoteSha,
		});
	});

	test('discards local commits of a diverged branch only when asked and only if the local branch has not moved since', async () => {
		await pushFromOther('feature/diverged', 1);
		git(repo, 'fetch', '-q', 'origin');
		git(repo, 'switch', '-q', '-c', 'feature/diverged', 'origin/feature/diverged');
		await commit(repo, 'local 1');
		await commit(repo, 'local 2');
		const localSha = git(repo, 'rev-parse', 'HEAD');
		git(repo, 'switch', '-q', 'main');
		git(other, 'switch', '-q', 'feature/diverged');
		await commit(other, 'remote 1');
		git(other, 'push', '-q', 'origin', 'feature/diverged');
		git(other, 'switch', '-q', 'main');
		git(repo, 'fetch', '-q', 'origin');
		const remoteSha = git(repo, 'rev-parse', 'origin/feature/diverged');

		const state = await service.inspectExistingBranch(repo, 'feature/diverged');
		// 早送りの指定は分かれているときには受けない
		const ffError = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('ff'), branch: 'feature/diverged', source: 'origin', sync: 'fastForward' }).then(() => 'created', () => 'refused');
		// 見た後にローカルが動いていたら捨てない
		const staleError = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('stale'), branch: 'feature/diverged', source: 'origin', sync: 'reset', expectedLocalSha: remoteSha }).then(() => 'created', () => 'refused');
		const kept = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('kept'), branch: 'feature/diverged', source: 'origin' });
		const keptSha = git(wt('kept'), 'rev-parse', 'HEAD');
		git(repo, 'worktree', 'remove', wt('kept'));
		const reset = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('reset'), branch: 'feature/diverged', source: 'origin', sync: 'reset', expectedLocalSha: localSha });
		assert.deepStrictEqual({
			state: { ahead: state.ahead, behind: state.behind },
			ffError, staleError, kept, keptSha, reset,
			resetSha: git(wt('reset'), 'rev-parse', 'HEAD'),
			// reflog から戻せる
			reflogHasOld: git(repo, 'reflog', 'show', '--format=%H', 'refs/heads/feature/diverged').split('\n').includes(localSha),
			leftovers: await Promise.all(['ff', 'stale'].map(name => fs.stat(wt(name)).then(() => true, () => false))),
		}, {
			state: { ahead: 2, behind: 1 },
			ffError: 'refused',
			staleError: 'refused',
			kept: { plan: 'diverged', synced: false },
			keptSha: localSha,
			reset: { plan: 'diverged', synced: true },
			resetSha: remoteSha,
			reflogHasOld: true,
			leftovers: [false, false],
		});
	});

	test('refuses a branch that is open in another worktree or in the main checkout', async () => {
		git(repo, 'worktree', 'add', '-q', wt('busy'), '-b', 'busy');
		const state = await service.inspectExistingBranch(repo, 'busy');
		const results = [
			await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('x'), branch: 'busy', source: 'local' }).then(() => 'created', () => 'refused'),
			await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('y'), branch: 'main', source: 'origin' }).then(() => 'created', () => 'refused'),
		];
		assert.deepStrictEqual({ inUse: state.inUse && { branch: state.inUse.branch, main: state.inUse.main }, results }, {
			inUse: { branch: 'busy', main: false },
			results: ['refused', 'refused'],
		});
	});

	test('a failed fetch (unreachable origin) leaves the last known origin branches listed', async () => {
		await pushFromOther('feature/known', 1);
		git(repo, 'fetch', '-q', 'origin');
		git(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
		const fetch = await service.runGit(repo, ['fetch', '--prune', '--quiet', 'origin']);
		const result = await service.listBranchCandidates(repo);
		assert.deepStrictEqual({ failed: fetch.code !== 0, remote: result.remote.map(branch => branch.name).sort(), hasOrigin: result.hasOrigin }, {
			failed: true,
			remote: ['feature/known', 'main'],
			hasOrigin: true,
		});
	});

	test('opens a pull request from a fork by fetching its head into a local branch of its own', async function () {
		// 本物の git を何本も動かすので、既定の 5 秒より長く待つ
		this.timeout(20_000);
		// origin が持つ PR の先頭（GitHub の refs/pull/<番号>/head）。ブランチとしては origin に無い
		git(other, 'switch', '-q', '-c', 'fork-work', 'origin/main');
		const prHead = await commit(other, 'from the fork');
		git(other, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
		git(other, 'switch', '-q', 'main');
		const mainBefore = git(repo, 'rev-parse', 'refs/heads/main');

		const result = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('pr'), branch: 'pr-7-main', source: 'local', pullRequestNumber: 7 });
		// 同じ PR をもう一度開く: ブランチは上のワークツリーで開いているので、使用中として断る（取得は git が断る）
		const inUse = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('pr-again'), branch: 'pr-7-main', source: 'local', pullRequestNumber: 7 }).then(() => 'opened', error => /開いています/.test(String(error)) ? 'in use' : String(error));
		const missing = await service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('pr-none'), branch: 'pr-8-x', source: 'local', pullRequestNumber: 8 }).then(() => 'opened', error => /#8/.test(String(error)) ? 'not fetched' : String(error));
		// origin のブランチとしては開かない・番号は正の整数だけ（git を動かす前に断る）
		const invalid = await Promise.all([
			service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('x'), branch: 'pr-7-main', source: 'origin', pullRequestNumber: 7 }).then(() => 'opened', () => 'rejected'),
			service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('y'), branch: 'pr-7-main', source: 'local', pullRequestNumber: 1.5 }).then(() => 'opened', () => 'rejected'),
		]);

		assert.deepStrictEqual({ result, head: head(wt('pr')), sha: git(wt('pr'), 'rev-parse', 'HEAD') === prHead, mainUntouched: git(repo, 'rev-parse', 'refs/heads/main') === mainBefore, upstream: upstream('pr-7-main'), inUse, missing, invalid }, {
			result: { plan: 'open', synced: false },
			head: 'pr-7-main',
			sha: true,
			mainUntouched: true,
			upstream: undefined,
			inUse: 'in use',
			missing: 'not fetched',
			invalid: ['rejected', 'rejected'],
		});
	});

	test('does not pre-trust the worktree of a pull request from a fork, nor of the branches that come from it', async function () {
		this.timeout(30_000);
		// 信頼の書き込み先を一時フォルダにする（本物の ~/.claude.json・~/.codex を読み書きしない）
		const claudeDir = join(root, 'claude-config');
		const codexHome = join(root, 'codex-home');
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.mkdir(codexHome, { recursive: true });
		// Claude Code の設定ファイルは、あるときだけ書き足す（無ければ Claude Code を使っていない）
		await fs.writeFile(join(claudeDir, '.claude.json'), '{}');
		const trusting = new ParadisWorktreeGitService(new NullLogService(), undefined, undefined, cp.execFile, async () => ({ ...process.env, CLAUDE_CONFIG_DIR: claudeDir }),
			undefined, undefined, undefined, undefined, undefined, () => [codexHome]);
		const trusted = async (name: string) => {
			const real = await fs.realpath(wt(name));
			const claude = JSON.parse(await fs.readFile(join(claudeDir, '.claude.json'), 'utf8').catch(() => '{}')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
			const codex = await fs.readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '');
			return {
				claude: Object.entries(claude.projects ?? {}).some(([key, value]) => (key === real || key === wt(name)) && value.hasTrustDialogAccepted === true),
				codex: codex.includes(real) || codex.includes(wt(name)),
			};
		};
		git(other, 'switch', '-q', '-c', 'fork-work', 'origin/main');
		await commit(other, 'from the fork');
		git(other, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
		git(other, 'switch', '-q', 'main');
		await pushFromOther('feature/ours', 1);
		git(repo, 'fetch', '-q', 'origin');

		// 対照: 同じリポジトリのブランチと、main から切った新しいブランチには信頼を書く
		await trusting.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('ours'), branch: 'feature/ours', source: 'origin', trustClaudeFolder: true });
		await trusting.addWorktree({ repoPath: repo, worktreePath: wt('new'), newBranch: 'new-from-main', baseRef: 'origin/main', trustClaudeFolder: true });
		// fork の PR: 取って開く。信頼は頼まれても書かない
		await trusting.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('pr'), branch: 'pr-7-main', source: 'local', pullRequestNumber: 7, trustClaudeFolder: true });
		const pr = await trusted('pr');
		// 取ったブランチを、PR のカードなしで「既存のブランチ」から開き直す・ベースブランチにして新しいブランチを切る
		git(repo, 'worktree', 'remove', wt('pr'));
		await trusting.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('pr-reopened'), branch: 'pr-7-main', source: 'local', trustClaudeFolder: true });
		await trusting.addWorktree({ repoPath: repo, worktreePath: wt('pr-child'), newBranch: 'on-top-of-pr', baseRef: 'pr-7-main', trustClaudeFolder: true });
		await trusting.addWorktree({ repoPath: repo, worktreePath: wt('pr-grandchild'), newBranch: 'on-top-of-child', baseRef: 'refs/heads/on-top-of-pr', trustClaudeFolder: true });

		assert.deepStrictEqual({
			ours: await trusted('ours'),
			new: await trusted('new'),
			pr,
			reopened: await trusted('pr-reopened'),
			child: await trusted('pr-child'),
			grandchild: await trusted('pr-grandchild'),
			marks: ['pr-7-main', 'on-top-of-pr', 'on-top-of-child', 'feature/ours'].map(branch => {
				try {
					return git(repo, 'config', '--get', `branch.${branch}.paradisForkPullRequest`);
				} catch {
					return undefined;
				}
			}),
		}, {
			ours: { claude: true, codex: true },
			new: { claude: true, codex: true },
			pr: { claude: false, codex: false },
			reopened: { claude: false, codex: false },
			child: { claude: false, codex: false },
			grandchild: { claude: false, codex: false },
			marks: ['7', '7', '7', undefined],
		});
	});

	test('tells which github.com repository origin is, and nothing for other remotes', async () => {
		const local = await service.getOriginRepository(repo);
		git(repo, 'remote', 'set-url', 'origin', 'git@github.com:Acme/App.git');

		assert.deepStrictEqual([local, await service.getOriginRepository(repo), await service.getOriginRepository(join(root, 'nowhere'))], [undefined, 'acme/app', undefined]);
	});

	test('rejects branch names that git could read as options or that are not valid refs', async () => {
		const results = await Promise.all(['-x', 'a..b', 'a b', ''].map(branch => service.addWorktreeFromBranch({ repoPath: repo, worktreePath: wt('z'), branch, source: 'local' }).then(() => 'created', () => 'refused')));
		assert.deepStrictEqual(results, ['refused', 'refused', 'refused', 'refused']);
	});
});
