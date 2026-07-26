/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { startChangeDrivenReviewThreadsRefresh } from '../../browser/sessionGithubReviewThreadsRefresh.js';

suite('startChangeDrivenReviewThreadsRefresh', () => {

	const store = new DisposableStore();
	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshes when the pull request changes, and not while it stands still', () => {
		const changeToken = observableValue<string | undefined>('test.changeToken', undefined);
		const model = new TestRefreshable();

		store.add(startChangeDrivenReviewThreadsRefresh(model, changeToken, new NullLogService()));
		const withoutPullRequestData = model.refreshCalls;

		changeToken.set('2026-07-27T00:00:00Z', undefined);
		const afterFirstToken = model.refreshCalls;

		changeToken.set('2026-07-27T00:01:00Z', undefined);

		assert.deepStrictEqual(
			{ withoutPullRequestData, afterFirstToken, afterSecondToken: model.refreshCalls },
			{ withoutPullRequestData: 0, afterFirstToken: 1, afterSecondToken: 2 },
		);
	});

	test('refreshes on the fallback interval when the pull request never moves', async () => {
		const changeToken = observableValue<string | undefined>('test.changeToken', '2026-07-27T00:00:00Z');
		const model = new TestRefreshable();

		store.add(startChangeDrivenReviewThreadsRefresh(model, changeToken, new NullLogService(), { fallbackIntervalMs: 5 }));
		await timeout(30);

		assert.ok(model.refreshCalls > 1, `expected a fallback refresh, got ${model.refreshCalls} call(s)`);
	});
});

class TestRefreshable {

	refreshCalls = 0;

	refresh(): Promise<void> {
		this.refreshCalls++;
		return Promise.resolve();
	}
}
