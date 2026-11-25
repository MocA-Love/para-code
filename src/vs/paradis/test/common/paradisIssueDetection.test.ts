/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IParadisIssueLookupTarget, paradisClassifyGithubReferenceFailure, paradisExtractGithubReferences, paradisExtractIssueUrls, paradisParseGhIssueStatus, paradisParseGithubReferenceResponse, paradisParseGithubReferenceUrl, paradisParseGithubRemoteRepository, paradisParseIssueUrl, paradisPreferGithubReferenceFailure, paradisSelectIssueLookupBatch } from '../../common/paradisIssueDetection.js';

suite('paradisExtractIssueUrls / paradisParseIssueUrl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extracts a single URL from a line', () => {
		const urls = paradisExtractIssueUrls('see https://github.com/MocA-Love/para-code/issues/482 for details');
		assert.deepStrictEqual(urls, ['https://github.com/MocA-Love/para-code/issues/482']);
	});

	test('extracts multiple distinct URLs from one line, in order, without duplicates', () => {
		const line = 'related: https://github.com/MocA-Love/para-code/issues/482 and https://github.com/MocA-Love/para-code/issues/501, also https://github.com/MocA-Love/para-code/issues/482 again';
		const urls = paradisExtractIssueUrls(line);
		assert.deepStrictEqual(urls, [
			'https://github.com/MocA-Love/para-code/issues/482',
			'https://github.com/MocA-Love/para-code/issues/501',
		]);
	});

	test('returns an empty array when no issue URL is present', () => {
		assert.deepStrictEqual(paradisExtractIssueUrls('no issue links here, just prose'), []);
	});

	// 回帰テスト: 抽出用と解析用で正規表現オブジェクトを分けていないと、global 正規表現の
	// lastIndex が exec 呼び出しで進んだままになり、次の matchAll がその位置から再開してしまう。
	// paradisParseIssueUrl を挟んだ後に、同じ行から2件とも取れることを確認する。
	test('extraction is unaffected by an interleaved paradisParseIssueUrl call (regression for shared lastIndex)', () => {
		const line = 'https://github.com/owner/repo/issues/1 and https://github.com/owner/repo/issues/2';

		// 1回目の抽出はここでは検証しない。paradisParseIssueUrl を挟んだ後の2回目が本題。
		paradisExtractIssueUrls(line);
		paradisParseIssueUrl('https://github.com/owner/repo/issues/999');

		const urls = paradisExtractIssueUrls(line);
		assert.deepStrictEqual(urls, [
			'https://github.com/owner/repo/issues/1',
			'https://github.com/owner/repo/issues/2',
		]);
	});

	test('repeated paradisParseIssueUrl calls do not affect each other (non-global regex, no shared lastIndex)', () => {
		const first = paradisParseIssueUrl('https://github.com/owner/repo/issues/1');
		const second = paradisParseIssueUrl('https://github.com/owner/repo/issues/2');
		assert.deepStrictEqual(first, { owner: 'owner', repo: 'repo', number: 1 });
		assert.deepStrictEqual(second, { owner: 'owner', repo: 'repo', number: 2 });
	});

	test('parses owner, repo, and number out of a well-formed URL', () => {
		const parsed = paradisParseIssueUrl('https://github.com/MocA-Love/para-code/issues/482');
		assert.deepStrictEqual(parsed, { owner: 'MocA-Love', repo: 'para-code', number: 482 });
	});

	test('rejects a URL that is not a GitHub issue link', () => {
		assert.strictEqual(paradisParseIssueUrl('https://github.com/MocA-Love/para-code/pull/482'), undefined);
		assert.strictEqual(paradisParseIssueUrl('https://example.com/issues/482'), undefined);
		assert.strictEqual(paradisParseIssueUrl('not a url'), undefined);
	});

	test('rejects a URL with trailing content after the issue number', () => {
		// 解析用は完全一致 (^...$) なので、末尾にコメントアンカー等が付いた形は拒否する
		assert.strictEqual(paradisParseIssueUrl('https://github.com/owner/repo/issues/482#issuecomment-1'), undefined);
	});

	// 回帰テスト: \d{1,9} が末尾非固定だと、10桁の番号の頭9桁だけを拾って別issueのURLに
	// 化けてしまう (例: .../issues/1234567890 → .../issues/123456789)。(?!\d) を付けて
	// 桁溢れは検出そのものを見送るようにした。
	test('does not truncate a 10-digit issue number into a different, shorter one', () => {
		const urls = paradisExtractIssueUrls('see https://github.com/owner/repo/issues/1234567890 for details');
		assert.deepStrictEqual(urls, []);
		assert.strictEqual(paradisParseIssueUrl('https://github.com/owner/repo/issues/1234567890'), undefined);
	});

	test('still extracts a 9-digit issue number (the maximum supported length)', () => {
		const urls = paradisExtractIssueUrls('https://github.com/owner/repo/issues/123456789');
		assert.deepStrictEqual(urls, ['https://github.com/owner/repo/issues/123456789']);
	});
});

suite('paradisParseGhIssueStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses an open issue', () => {
		const status = paradisParseGhIssueStatus(JSON.stringify({ number: 482, title: 'something broke', url: 'https://github.com/owner/repo/issues/482', state: 'OPEN' }));
		assert.deepStrictEqual(status, { number: 482, title: 'something broke', url: 'https://github.com/owner/repo/issues/482', state: 'open' });
	});

	test('parses a closed issue', () => {
		const status = paradisParseGhIssueStatus(JSON.stringify({ number: 12, title: 'fixed', url: 'https://github.com/owner/repo/issues/12', state: 'CLOSED' }));
		assert.strictEqual(status?.state, 'closed');
	});

	test('defaults a missing title to an empty string', () => {
		const status = paradisParseGhIssueStatus(JSON.stringify({ number: 1, url: 'https://github.com/owner/repo/issues/1', state: 'OPEN' }));
		assert.strictEqual(status?.title, '');
	});

	test('returns undefined for malformed JSON', () => {
		assert.strictEqual(paradisParseGhIssueStatus('not json'), undefined);
	});

	test('returns undefined for an unrecognized state', () => {
		assert.strictEqual(paradisParseGhIssueStatus(JSON.stringify({ number: 1, url: 'https://github.com/owner/repo/issues/1', state: 'MERGED' })), undefined);
	});

	test('rejects a non-http(s) url to keep openerService safe from protocol handler schemes', () => {
		assert.strictEqual(paradisParseGhIssueStatus(JSON.stringify({ number: 1, url: 'vscode://owner/repo/issues/1', state: 'OPEN' })), undefined);
	});
});

suite('paradisSelectIssueLookupBatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function targetsFor(counts: readonly number[]): IParadisIssueLookupTarget<number>[] {
		return counts.map((count, targetIndex) => ({
			resource: targetIndex,
			issueUrls: Array.from({ length: count }, (_, urlIndex) => `t${targetIndex}-${urlIndex}`),
		}));
	}

	/**
	 * 「今回どれを送るか選ぶ → 送った分を記録する → まだ未送信のURLが残っていれば繰り返す」を、
	 * 実際の paradisWorkspacesView.ts の使い方 (_issueLookupRequested によるループ防止) と
	 * 同じ形でシミュレートする。収束しない (=無限ループの再発) 場合は maxRounds で打ち切って
	 * 例外にする。
	 */
	function simulateRoundsToConverge(counts: readonly number[], budget: number): number {
		const targets = targetsFor(counts);
		const attempted = new Set<string>();
		const requested = new Set<string>();
		const total = counts.reduce((sum, count) => sum + count, 0);
		const maxRounds = total + 5;
		let rounds = 0;
		while (requested.size < total) {
			rounds++;
			if (rounds > maxRounds) {
				throw new Error(`did not converge within ${maxRounds} rounds (requested ${requested.size}/${total})`);
			}
			const batch = paradisSelectIssueLookupBatch(targets, attempted, budget);
			assert.ok(batch.length > 0, 'a non-empty target set with remaining budget must always select something');
			for (const item of batch) {
				for (const url of item.issueUrls) {
					requested.add(url);
					attempted.add(url); // このシミュレーションでは常に成功して attempted へ入る想定
				}
			}
		}
		return rounds;
	}

	test('selects at most budget URLs total across all targets, not per target', () => {
		const targets = targetsFor([4, 4, 4]);
		const batch = paradisSelectIssueLookupBatch(targets, new Set(), 8);
		const totalSelected = batch.reduce((sum, item) => sum + item.issueUrls.length, 0);
		assert.strictEqual(totalSelected, 8);
	});

	test('prioritizes URLs that have not been attempted yet over ones that have', () => {
		const targets = targetsFor([3]);
		const attempted = new Set(['t0-0']);
		const batch = paradisSelectIssueLookupBatch(targets, attempted, 2);
		assert.deepStrictEqual(batch, [{ resource: 0, issueUrls: ['t0-1', 't0-2'] }]);
	});

	// Critical#2 の回帰テスト本体: worktree ごとに budget を割り当てていた旧実装では、
	// 複数 worktree の合計が budget を超える構成 ([4,4,4] のようなごく普通の構成) で、
	// 先行 worktree が予算を食い切り後続 worktree の URL が二度と送られず収束しなかった。
	test('converges across multiple targets whose combined URL count exceeds the per-call budget', () => {
		// budget=8 で合計12件 → ちょうど2ラウンドで全件が一度は送信されるはず
		assert.strictEqual(simulateRoundsToConverge([4, 4, 4], 8), 2);
	});

	test('converges for a variety of multi-target shapes reported as non-converging under the old per-target budget', () => {
		for (const counts of [[8, 3], [9, 1], [5, 5, 2]]) {
			const total = counts.reduce((sum, count) => sum + count, 0);
			assert.strictEqual(simulateRoundsToConverge(counts, 8), Math.ceil(total / 8), `counts=${JSON.stringify(counts)}`);
		}
	});

	test('still converges for a single target that alone exceeds the budget', () => {
		assert.strictEqual(simulateRoundsToConverge([12], 8), Math.ceil(12 / 8));
	});

	test('returns nothing when the budget is exhausted (non-positive)', () => {
		assert.deepStrictEqual(paradisSelectIssueLookupBatch(targetsFor([3]), new Set(), 0), []);
	});
});

suite('issue and pull request URLs pasted into a prompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks up issues and pull requests in order, once each, up to three, and only on github.com', () => {
		const text = [
			'fix https://github.com/acme/app/pull/2241/files#diff-1 and https://github.com/acme/app/issues/2236#issuecomment-9,',
			'again https://github.com/Acme/App/issues/2241 then https://github.com/acme/tools/issues/41',
			'https://github.com/acme/app/issues/7 https://ghe.example.com/acme/app/issues/8 https://github.com/acme/app/discussions/9',
		].join('\n');

		assert.deepStrictEqual({
			found: paradisExtractGithubReferences(text),
			first: paradisExtractGithubReferences(text, 1).map(reference => reference.url),
			none: paradisExtractGithubReferences('https://gitlab.com/acme/app/issues/1 https://github.com/acme/app/issues/'),
			// 抽出の後でも単発の解析がずれない（正規表現を分けている）
			parsed: [paradisParseGithubReferenceUrl('https://github.com/acme/app/pull/12/files'), paradisParseGithubReferenceUrl('https://github.com/acme/app/issues/0'), paradisParseGithubReferenceUrl('see https://github.com/acme/app/issues/3')],
		}, {
			found: [
				{ url: 'https://github.com/acme/app/pull/2241', owner: 'acme', repo: 'app', number: 2241, kind: 'pr' },
				{ url: 'https://github.com/acme/app/issues/2236', owner: 'acme', repo: 'app', number: 2236, kind: 'issue' },
				{ url: 'https://github.com/acme/tools/issues/41', owner: 'acme', repo: 'tools', number: 41, kind: 'issue' },
			],
			first: ['https://github.com/acme/app/pull/2241'],
			none: [],
			parsed: [{ url: 'https://github.com/acme/app/pull/12', owner: 'acme', repo: 'app', number: 12, kind: 'pr' }, undefined, undefined],
		});
	});

	test('reads the issue or pull request behind the URL, whichever the URL said, and only branches of the same repository', () => {
		const response = (node: object | null) => JSON.stringify({ data: { repository: { issueOrPullRequest: node } } });

		assert.deepStrictEqual([
			// /issues/N の URL でも、実体が PR なら PR として読む
			paradisParseGithubReferenceResponse(response({ __typename: 'PullRequest', number: 2241, title: 'Fix the mapping', url: 'https://github.com/acme/app/pull/2241', state: 'OPEN', isDraft: true, headRefName: 'fix/mapping', isCrossRepository: false }), 'acme', 'app'),
			paradisParseGithubReferenceResponse(response({ __typename: 'PullRequest', number: 5, title: 'From a fork', url: 'https://github.com/acme/app/pull/5', state: 'MERGED', isDraft: false, headRefName: 'main', isCrossRepository: true }), 'acme', 'app'),
			paradisParseGithubReferenceResponse(response({
				__typename: 'Issue', number: 2236, title: 'Mapping is off', url: 'https://github.com/acme/app/issues/2236', state: 'CLOSED',
				linkedBranches: { nodes: [{ ref: null }, { ref: { name: 'theirs', repository: { nameWithOwner: 'someone/app' } } }, { ref: { name: '2236-mapping', repository: { nameWithOwner: 'Acme/App' } } }] },
			}), 'acme', 'app'),
			paradisParseGithubReferenceResponse(response({ __typename: 'Issue', number: 1, title: 'No branch', url: 'https://github.com/acme/app/issues/1', state: 'OPEN', linkedBranches: { nodes: [] } }), 'acme', 'app'),
			paradisParseGithubReferenceResponse(response(null), 'acme', 'app'),
			paradisParseGithubReferenceResponse(response({ __typename: 'Issue', number: 1, title: 'x', url: 'file:///etc/passwd', state: 'OPEN' }), 'acme', 'app'),
			paradisParseGithubReferenceResponse('not json', 'acme', 'app'),
		], [
			{ kind: 'pr', owner: 'acme', repo: 'app', number: 2241, title: 'Fix the mapping', url: 'https://github.com/acme/app/pull/2241', state: 'draft', branch: 'fix/mapping' },
			{ kind: 'pr', owner: 'acme', repo: 'app', number: 5, title: 'From a fork', url: 'https://github.com/acme/app/pull/5', state: 'merged', branch: 'main', crossRepository: true },
			{ kind: 'issue', owner: 'acme', repo: 'app', number: 2236, title: 'Mapping is off', url: 'https://github.com/acme/app/issues/2236', state: 'closed', branch: '2236-mapping' },
			{ kind: 'issue', owner: 'acme', repo: 'app', number: 1, title: 'No branch', url: 'https://github.com/acme/app/issues/1', state: 'open' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('sorts a gh failure into not found, gh unusable, or unreachable', () => {
		assert.deepStrictEqual([
			'gh: Could not resolve to an issue or pull request with the number of 99999999.',
			'gh: Could not resolve to a Repository with the name \'acme/private\'.',
			'spawn gh ENOENT',
			'sh: 1: gh: not found',
			'To get started with GitHub CLI, please run:  gh auth login',
			'gh: Bad credentials (HTTP 401)',
			'error connecting to api.github.com',
			'Command failed: gh api graphql',
		].map(paradisClassifyGithubReferenceFailure), ['notFound', 'notFound', 'noGh', 'noGh', 'noGh', 'noGh', 'unreachable', 'unreachable']);
		// 両方のマシンで駄目なら、手がかりの多い方を見せる
		assert.deepStrictEqual([paradisPreferGithubReferenceFailure('noGh', 'notFound'), paradisPreferGithubReferenceFailure('unreachable', 'noGh'), paradisPreferGithubReferenceFailure('rateLimited', 'unreachable')], ['notFound', 'unreachable', 'rateLimited']);
	});

	test('reads the github.com repository out of an origin URL in any of its spellings', () => {
		assert.deepStrictEqual([
			'https://github.com/Acme/App.git',
			'https://github.com/acme/app',
			'https://user@github.com/acme/app.git/',
			'git@github.com:acme/app.git',
			'ssh://git@github.com/acme/app.git',
			'git://github.com/acme/app',
			'git@ghe.example.com:acme/app.git',
			'https://github.com.example.com/acme/app.git',
			'/srv/git/app.git',
		].map(paradisParseGithubRemoteRepository), ['acme/app', 'acme/app', 'acme/app', 'acme/app', 'acme/app', 'acme/app', undefined, undefined, undefined]);
	});
});
