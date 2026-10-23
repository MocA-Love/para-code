/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanCheckTarget, paradisDetectHumanCheck } from '../../electron-main/paradisBrowserHumanCheck.js';

function target(origins: readonly string[], probes: unknown[], loading = false): { target: IParadisHumanCheckTarget; probed: () => number } {
	let probed = 0;
	return {
		target: {
			isDestroyed: () => false,
			isLoading: () => loading,
			mainFrame: { framesInSubtree: origins.map(origin => ({ origin })) },
			executeJavaScriptInIsolatedWorld: async () => probes[probed++],
		},
		probed: () => probed,
	};
}

suite('ParadisBrowserHumanCheck (main)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks into the page only when a Cloudflare frame exists, re-checks before reporting, and tells a failed look apart from no check', async () => {
		const noFrame = target(['https://example.com'], [{ page: true }]);
		const loadingWithoutFrame = target(['https://example.com'], [], true);
		const passedByItself = target(['https://example.com', 'https://challenges.cloudflare.com'], [{ page: false, unsolvedVisible: true }, { page: false, unsolvedVisible: false }]);
		const stuck = target(['https://challenges.cloudflare.com'], [{ page: true, submits: 0 }, { page: true, submits: 0 }]);
		const reported = target(['https://challenges.cloudflare.com'], [{ page: false, unsolvedVisible: true, submits: 3 }]);
		// ページが時間内に答えなかった（raceTimeout の undefined）
		const timedOut = target(['https://challenges.cloudflare.com'], [undefined]);
		const delay = async () => undefined;
		assert.deepStrictEqual({
			noFrame: [await paradisDetectHumanCheck(noFrame.target, false, delay), noFrame.probed()],
			loadingWithoutFrame: await paradisDetectHumanCheck(loadingWithoutFrame.target, true, delay),
			passedByItself: [await paradisDetectHumanCheck(passedByItself.target, false, delay), passedByItself.probed()],
			stuck: [await paradisDetectHumanCheck(stuck.target, false, delay), stuck.probed()],
			alreadyReported: [await paradisDetectHumanCheck(reported.target, true, delay), reported.probed()],
			timedOut: await paradisDetectHumanCheck(timedOut.target, true, delay),
		}, {
			noFrame: [{ state: 'none' }, 0],
			loadingWithoutFrame: { state: 'unknown' },
			passedByItself: [{ state: 'none' }, 2],
			stuck: [{ state: 'check', kind: 'page', submits: 0 }, 2],
			alreadyReported: [{ state: 'check', kind: 'widget', submits: 3 }, 1],
			timedOut: { state: 'unknown' },
		});
	});
});
