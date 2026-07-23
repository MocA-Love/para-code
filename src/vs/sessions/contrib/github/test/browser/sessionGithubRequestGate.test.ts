/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { GitHubApiError } from '../../browser/githubApiClient.js';
import { isRateLimitError, SessionGithubRequestGate } from '../../browser/sessionGithubRequestGate.js';

const LOW_PRIORITY_CALL_SITE = 'githubApi.findPullRequestByHeadBranch';

suite('SessionGithubRequestGate', () => {

	const store = new DisposableStore();
	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drains the high lane before the low lane', async () => {
		const gate = store.add(new SessionGithubRequestGate(new NullLogService(), { maxConcurrent: 1 }));
		const order: string[] = [];
		const blocker = new DeferredPromise<void>();

		const first = gate.run('test.blocker', () => blocker.p);
		await timeout(1);
		const low = gate.run(LOW_PRIORITY_CALL_SITE, async () => { order.push('low'); });
		const high = gate.run('test.interactive', async () => { order.push('high'); });

		blocker.complete();
		await Promise.all([first, low, high]);

		assert.deepStrictEqual(order, ['high', 'low']);
	});

	test('caps in-flight concurrency', async () => {
		const gate = store.add(new SessionGithubRequestGate(new NullLogService(), { maxConcurrent: 2 }));
		const blockers = [new DeferredPromise<void>(), new DeferredPromise<void>(), new DeferredPromise<void>()];
		let dispatched = 0;

		const runs = blockers.map(blocker => gate.run('test.call', () => {
			dispatched++;
			return blocker.p;
		}));
		await timeout(1);
		assert.strictEqual(dispatched, 2);

		blockers[0].complete();
		await timeout(1);
		assert.strictEqual(dispatched, 3);

		blockers[1].complete();
		blockers[2].complete();
		await Promise.all(runs);
	});

	test('caps throughput at the configured budget', async () => {
		const gate = store.add(new SessionGithubRequestGate(new NullLogService(), { budgetPerMinute: 2, maxConcurrent: 10 }));
		let dispatched = 0;

		const runs = [1, 2, 3].map(() => gate.run('test.call', async () => { dispatched++; }).catch(err => {
			assert.ok(isCancellationError(err));
		}));
		await timeout(1);
		// The bucket starts with 2 tokens; the 3rd request must wait ~30s for a
		// refill, which the test does not do — it is rejected on dispose instead.
		assert.strictEqual(dispatched, 2);

		store.clear();
		await Promise.all(runs);
	});

	test('pauses all traffic after a rate-limit error and resumes after the backoff', async () => {
		const gate = store.add(new SessionGithubRequestGate(new NullLogService(), { maxConcurrent: 1, backoffInitialMs: 8 }));
		let dispatched = 0;

		await gate.run('test.call', () => Promise.reject(new GitHubApiError('API rate limit exceeded', 403, 0))).catch(() => { });
		const next = gate.run('test.call', async () => { dispatched++; });
		await timeout(1);
		assert.strictEqual(dispatched, 0);

		await next;
		assert.strictEqual(dispatched, 1);
	});

	test('rejects queued requests with a cancellation error on dispose', async () => {
		const gate = new SessionGithubRequestGate(new NullLogService(), { maxConcurrent: 1 });
		const blocker = new DeferredPromise<void>();

		const first = gate.run('test.blocker', () => blocker.p);
		await timeout(1);
		const queued = gate.run('test.queued', async () => 'never');

		gate.dispose();
		await assert.rejects(queued, err => isCancellationError(err));

		blocker.complete();
		await first;
	});

	test('isRateLimitError classifies GitHub throttling signals', () => {
		const cases: [unknown, boolean][] = [
			[new GitHubApiError('too many requests', 429, undefined), true],
			[new GitHubApiError('API rate limit exceeded for user', 403, 0), true],
			[new GitHubApiError('You have exceeded a secondary rate limit', 403, 4999), true],
			[new GitHubApiError('Resource not accessible by integration', 403, 4999), false],
			[new GitHubApiError('API rate limit exceeded', 200, undefined), true], // GraphQL RATE_LIMITED
			[new GitHubApiError('Field "foo" does not exist', 200, undefined), false],
			[new GitHubApiError('Not Found', 404, undefined), false],
			[new Error('API rate limit exceeded'), false],
		];
		assert.deepStrictEqual(cases.map(([err]) => isRateLimitError(err)), cases.map(([, expected]) => expected));
	});
});
