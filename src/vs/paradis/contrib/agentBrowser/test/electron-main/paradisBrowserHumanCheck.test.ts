/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHumanCheckTarget, paradisDetectHumanCheck } from '../../electron-main/paradisBrowserHumanCheck.js';

function target(origins: readonly string[], probes: unknown[]): { target: IParadisHumanCheckTarget; probed: () => number } {
	let probed = 0;
	return {
		target: {
			isDestroyed: () => false,
			mainFrame: { framesInSubtree: origins.map(origin => ({ origin })) },
			executeJavaScriptInIsolatedWorld: async () => probes[probed++],
		},
		probed: () => probed,
	};
}

suite('ParadisBrowserHumanCheck (main)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('looks into the page only when a Cloudflare frame exists, and re-checks before reporting', async () => {
		const noFrame = target(['https://example.com'], [{ page: true }]);
		const passedByItself = target(['https://example.com', 'https://challenges.cloudflare.com'], [{ page: false, unsolvedVisible: true }, { page: false, unsolvedVisible: false }]);
		const stuck = target(['https://challenges.cloudflare.com'], [{ page: true }, { page: true }]);
		const reported = target(['https://challenges.cloudflare.com'], [{ page: false, unsolvedVisible: true }]);
		const delay = async () => undefined;
		assert.deepStrictEqual({
			noFrame: [await paradisDetectHumanCheck(noFrame.target, false, delay), noFrame.probed()],
			passedByItself: [await paradisDetectHumanCheck(passedByItself.target, false, delay), passedByItself.probed()],
			stuck: [await paradisDetectHumanCheck(stuck.target, false, delay), stuck.probed()],
			alreadyReported: [await paradisDetectHumanCheck(reported.target, true, delay), reported.probed()],
		}, {
			noFrame: [undefined, 0],
			passedByItself: [undefined, 2],
			stuck: ['page', 2],
			alreadyReported: ['widget', 1],
		});
	});
});
