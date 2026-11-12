/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisGithubMetricsSnapshot } from '../../common/paradisGithubMetrics.js';
import { ParadisGithubMetricsPopover } from '../../electron-browser/paradisGithubMetricsPopover.js';

suite('ParadisGithubMetricsPopover', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers({ now: 1_000_000_000_000 });
	});

	teardown(() => {
		clock.restore();
	});

	test('keeps the time since the last fetch moving while the popover stays open', async () => {
		const fetchedAt = Date.now();
		const snapshot: IParadisGithubMetricsSnapshot = {
			generatedAt: fetchedAt,
			sessionStartedAt: fetchedAt,
			ghAvailable: false,
			rateLimitError: undefined,
			rateLimitFetchedAt: fetchedAt,
			rateLimits: [],
			consumption: [],
			operations: [],
			spaces: [],
			totals: { sessionCalls: 0, sessionFailures: 0, rolling5mCalls: 0, rolling5mFailures: 0, rolling5mRateLimited: 0 },
			lastErrors: [],
		};
		const popover = store.add(new ParadisGithubMetricsPopover({ fetch: async () => snapshot, openDashboard: () => { } }));
		await clock.tickAsync(0);
		const updated = () => popover.element.querySelector('.paradis-ghm-popover-updated')?.textContent;
		const before = updated();
		await clock.tickAsync(3 * 60 * 1000);
		assert.notStrictEqual(updated(), before);
	});
});
