/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * Run this before pushing a beta tag:
 *
 *   node build/lib/paradisCheckBetaTag.ts <commit> [<tag>]
 *
 * A tag push runs the para-release.yml of the TAGGED commit. A commit whose workflow predates the
 * beta channel (no `classify` job) treats every `v*` tag as stable: it overwrites `stable:*` and
 * ships the build to every stable user. This script refuses such a commit:
 *   1. the tag (if given) must be a beta tag and must not exist yet,
 *   2. the commit must already be on a pushed branch,
 *   3. the commit's para-release.yml / para-reh.yml must contain the channel wiring and the commit
 *      must contain build/lib/paradisReleaseChannel.ts (`git grep` / `git cat-file` on the commit),
 *   4. the commit's own contract tests (paradisReleaseChannel.test.ts, paradisReleaseContract.test.ts)
 *      must pass, run from a temporary sparse worktree of that commit.
 * It only reads the repository and creates/removes a temporary worktree; it never pushes or tags.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyParadisReleaseTag } from './paradisReleaseChannel.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

/** Strings the tagged commit's workflows must contain for a beta tag to stay off the stable feed. */
const REQUIRED_WORKFLOW_SNIPPETS: readonly { readonly file: string; readonly snippet: string }[] = [
	{ file: '.github/workflows/para-release.yml', snippet: '  classify:\n' },
	{ file: '.github/workflows/para-release.yml', snippet: 'run: node build/lib/paradisReleaseChannel.ts' },
	{ file: '.github/workflows/para-release.yml', snippet: 'PARA_UPDATE_CHANNEL: ${{ needs.classify.outputs.channel }}' },
	{ file: '.github/workflows/para-release.yml', snippet: 'CHANNEL: ${{ needs.classify.outputs.channel }}' },
	{ file: '.github/workflows/para-reh.yml', snippet: 'run: node build/lib/paradisReleaseChannel.ts' },
];

const CONTRACT_TESTS = ['lib/test/paradisReleaseChannel.test.ts', 'lib/test/paradisReleaseContract.test.ts'];

/** Paths the contract tests read, checked out into the temporary worktree. */
const SPARSE_PATHS = ['/.github/', '/build/', '/product.json', '/package.json', '/.nvmrc', '/src/vs/platform/update/common/'];

function git(args: readonly string[], options: { readonly cwd?: string; readonly allowFailure?: boolean } = {}): string | undefined {
	try {
		return execFileSync('git', args, { cwd: options.cwd ?? repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } }).trim();
	} catch (error) {
		if (options.allowFailure) {
			return undefined;
		}
		throw error;
	}
}

function fail(message: string): never {
	console.error(`NG: ${message}`);
	console.error('Do not push this beta tag.');
	process.exit(1);
}

function checkTag(tag: string): void {
	if (classifyParadisReleaseTag(tag) !== 'beta') {
		fail(`'${tag}' is not a beta tag (v<ver>-paracode-<N>-beta.<M>).`);
	}
	if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true })) {
		fail(`tag '${tag}' already exists locally. Delete it first if you mean to re-tag.`);
	}
	console.log(`OK: '${tag}' is a new beta tag.`);
}

function checkPushed(commit: string): void {
	const branches = git(['branch', '-r', '--contains', commit]) ?? '';
	if (!branches) {
		fail(`${commit} is not on any remote branch. Push the beta branch first (git fetch if it is already pushed).`);
	}
	console.log(`OK: the commit is on ${branches.split('\n').map(branch => branch.trim()).join(', ')}.`);
}

function checkWorkflowWiring(commit: string): void {
	if (git(['cat-file', '-e', `${commit}:build/lib/paradisReleaseChannel.ts`], { allowFailure: true }) === undefined) {
		fail('build/lib/paradisReleaseChannel.ts is missing at this commit, so its release workflow cannot tell a beta tag from a stable one.');
	}
	for (const { file, snippet } of REQUIRED_WORKFLOW_SNIPPETS) {
		// `git grep` matches per line, so the multi-line `classify:` snippet is checked on its first line.
		const needle = snippet.replace(/\n$/, '');
		if (git(['grep', '-q', '-F', '-e', needle, commit, '--', file], { allowFailure: true }) === undefined) {
			fail(`${file} at this commit does not contain '${needle}'. Its workflow predates the beta channel and would publish the tag to stable:*.`);
		}
	}
	console.log('OK: the commit\'s workflows classify tags and route the beta channel.');
}

function runContractTests(commit: string): void {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'para-beta-check-'));
	fs.rmdirSync(worktree);
	git(['worktree', 'add', '--detach', '--no-checkout', worktree, commit]);
	try {
		git(['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATHS], { cwd: worktree });
		git(['checkout', '--detach', commit], { cwd: worktree });
		// Reuse this checkout's installed build dependencies instead of running npm ci.
		for (const modules of ['build/node_modules', 'node_modules']) {
			const source = path.join(repositoryRoot, modules);
			if (fs.existsSync(source)) {
				fs.symlinkSync(source, path.join(worktree, modules), 'dir');
			}
		}
		console.log(`Running the contract tests of ${commit} ...`);
		try {
			execFileSync(process.execPath, ['--test', ...CONTRACT_TESTS], { cwd: path.join(worktree, 'build'), stdio: 'inherit' });
		} catch {
			fail('the contract tests of this commit failed (see the output above).');
		}
		console.log('OK: the commit\'s release contract tests pass.');
	} finally {
		git(['worktree', 'remove', '--force', worktree], { allowFailure: true });
	}
}

if (import.meta.main) {
	const [commitArg, tag] = process.argv.slice(2);
	if (!commitArg) {
		console.error('Usage: node build/lib/paradisCheckBetaTag.ts <commit> [<tag>]');
		process.exit(2);
	}
	const commit = git(['rev-parse', '--verify', `${commitArg}^{commit}`], { allowFailure: true }) ?? fail(`'${commitArg}' is not a commit.`);
	console.log(`Checking ${commit} for a beta tag${tag ? ` '${tag}'` : ''}.`);
	if (tag) {
		checkTag(tag);
	}
	checkPushed(commit);
	checkWorkflowWiring(commit);
	runContractTests(commit);
	console.log('All checks passed. The tag can be pushed to this commit.');
}
