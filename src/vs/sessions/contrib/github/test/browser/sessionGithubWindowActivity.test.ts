/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPublishGithubWindowActivity, paradisStartPollingWhileWindowActive } from '../../browser/sessionGithubWindowActivity.js';

suite('paradisStartPollingWhileWindowActive', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('polls until the window goes to the background, resumes on return, and polls as before when nothing published', () => {
		const events: string[] = [];
		const model = {
			startPolling: () => {
				events.push('start');
				return toDisposable(() => events.push('stop'));
			},
		};

		const unpublished = paradisStartPollingWhileWindowActive(model);
		unpublished.dispose();

		const isActive = observableValue('test.windowActive', true);
		const publication = store.add(paradisPublishGithubWindowActivity(isActive));
		const polling = store.add(paradisStartPollingWhileWindowActive(model));
		isActive.set(false, undefined);
		isActive.set(true, undefined);
		polling.dispose();
		publication.dispose();

		assert.deepStrictEqual(events, ['start', 'stop', 'start', 'stop', 'start', 'stop']);
	});
});
