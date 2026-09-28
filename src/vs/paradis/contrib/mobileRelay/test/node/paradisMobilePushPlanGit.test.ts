/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_BRANCH_FORMAT, paradisMobilePushPlan, paradisParseCurrentBranchUpstream } from '../../common/paradisMobileScmSync.js';

/**
 * スマホの push の宛先の判定を、本物の git の `git branch --format` の出力で確かめる（Orca W2-15 の再レビューの High）。
 * `%(push:remoteref)` は `remote.<name>.push` が無いと空になり、`%(push)` は push.default で変わる。git が無い環境では飛ばす。
 */
suite('ParadisMobilePushPlan (real git)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let work: string;
	let env: NodeJS.ProcessEnv;
	let available = true;

	const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

	suiteSetup(async () => {
		root = join(tmpdir(), `paradis-push-plan-${generateUuid()}`);
		await fs.mkdir(root, { recursive: true });
		const emptyConfig = join(root, 'gitconfig');
		await fs.writeFile(emptyConfig, '');
		// 利用者の設定（push.default・remote.pushDefault など）に左右されないようにする
		env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
		try {
			git(root, 'init', '-q', '--bare', 'remote.git');
			git(root, 'init', '-q', '--bare', 'fork.git');
			git(root, 'clone', '-q', 'remote.git', 'work');
			work = join(root, 'work');
			git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
			git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
			git(work, 'fetch', '-q', 'origin');
			git(work, 'remote', 'add', 'fork', join(root, 'fork.git'));
			git(work, 'switch', '-q', '-c', 'same');
			git(work, 'push', '-q', '-u', 'origin', 'same');
			git(work, 'switch', '-q', '-c', 'feat', '--track', 'origin/main');
			git(work, 'switch', '-q', '-c', 'lonely');
		} catch {
			available = false;
		}
	});

	suiteTeardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('pushes same-named branches for simple / current / matching / triangular-current, and refuses renamed upstreams and nothing', function () {
		if (!available) {
			this.skip();
		}
		const plan = (branch: string, config: string[]) => {
			git(work, 'switch', '-q', branch);
			const current = paradisParseCurrentBranchUpstream(git(work, ...config.flatMap(entry => ['-c', entry]), 'branch', PARADIS_MOBILE_BRANCH_FORMAT));
			const result = current !== undefined ? paradisMobilePushPlan(current, git(work, 'remote').split('\n').filter(name => name.length > 0)) : undefined;
			return result === undefined ? 'no-branch' : result.kind === 'push' ? `${result.remote} ${result.ref}${result.publish ? ' publish' : ''}` : result.code;
		};
		assert.deepStrictEqual({
			simpleSame: plan('same', ['push.default=simple']),
			simpleRenamed: plan('feat', ['push.default=simple']),
			upstreamRenamed: plan('feat', ['push.default=upstream']),
			nothing: plan('same', ['push.default=nothing']),
			currentRenamed: plan('feat', ['push.default=current']),
			matching: plan('same', ['push.default=matching']),
			triangularCurrent: plan('feat', ['push.default=current', 'branch.feat.pushRemote=fork']),
			triangularSimple: plan('feat', ['push.default=simple', 'branch.feat.pushRemote=fork']),
			publish: plan('lonely', ['push.default=simple']),
		}, {
			simpleSame: 'origin refs/heads/same',
			simpleRenamed: 'renamed-upstream',
			upstreamRenamed: 'renamed-upstream',
			nothing: 'no-push-target',
			currentRenamed: 'origin refs/heads/feat',
			matching: 'origin refs/heads/same',
			triangularCurrent: 'fork refs/heads/feat',
			// simple は三角のワークフローでも上流と比べるので、git が push 先を決められない（%(push) が空）。断る側に倒れる
			triangularSimple: 'renamed-upstream',
			publish: 'origin refs/heads/lonely publish',
		});
	});
});
