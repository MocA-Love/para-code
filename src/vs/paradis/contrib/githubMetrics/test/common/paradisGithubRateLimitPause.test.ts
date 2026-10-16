/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisGithubRateLimitPause } from '../../common/paradisGithubRateLimitPause.js';

suite('ParadisGithubRateLimitPause', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const MINUTE = 60_000;

	test('pauses until the reset the probe last saw, and falls back to 15 minutes without one', () => {
		let now = 1_000_000;
		const pause = new ParadisGithubRateLimitPause(() => now);
		pause.noteRateLimits([{ resource: 'graphql', limit: 5000, remaining: 12, used: 4988, resetAt: now + 40 * MINUTE }]);

		const graphqlUntil = pause.noteRateLimited('', 'graphql');
		// 手元のプローブのリセット時刻は WSL のディストロの gh には効かせない
		const wslUntil = pause.noteRateLimited('wsl:ubuntu', 'graphql');
		const coreUntil = pause.noteRateLimited('', 'core');
		const before = { graphql: pause.pausedUntilFor('', 'graphql'), core: pause.pausedUntilFor('', 'core') };
		now += 16 * MINUTE;
		const after = { graphql: pause.pausedUntilFor('', 'graphql'), core: pause.pausedUntilFor('', 'core'), wsl: pause.pausedUntilFor('wsl:ubuntu', 'graphql') };

		assert.deepStrictEqual({ graphqlUntil, wslUntil, coreUntil, before, after }, {
			graphqlUntil: 1_000_000 + 40 * MINUTE,
			wslUntil: 1_000_000 + 15 * MINUTE,
			coreUntil: 1_000_000 + 15 * MINUTE,
			before: { graphql: 1_000_000 + 40 * MINUTE, core: 1_000_000 + 15 * MINUTE },
			after: { graphql: 1_000_000 + 40 * MINUTE, core: undefined, wsl: undefined },
		});
	});

	test('pauses on an exhausted probe and resumes once a probe sees budget again', () => {
		let now = 1_000_000;
		const pause = new ParadisGithubRateLimitPause(() => now);

		pause.noteRateLimits([
			{ resource: 'core', limit: 5000, remaining: 4388, used: 612, resetAt: now + 11 * MINUTE },
			{ resource: 'graphql', limit: 5000, remaining: 0, used: 5000, resetAt: now + 10 * MINUTE },
		]);
		const exhausted = pause.activePauses();
		now += 11 * MINUTE;
		pause.noteRateLimits([{ resource: 'graphql', limit: 5000, remaining: 4999, used: 1, resetAt: now + 60 * MINUTE }]);

		assert.deepStrictEqual({ exhausted, resumed: pause.activePauses() }, {
			exhausted: [{ resource: 'graphql', until: 1_000_000 + 10 * MINUTE }],
			resumed: [],
		});
	});

	test('does not trust a reset time more than an hour ahead', () => {
		const now = 1_000_000;
		const pause = new ParadisGithubRateLimitPause(() => now);
		pause.noteRateLimits([{ resource: 'graphql', limit: 5000, remaining: 0, used: 5000, resetAt: now + 5 * 60 * MINUTE }]);

		assert.deepStrictEqual(pause.activePauses(), [{ resource: 'graphql', until: now + 61 * MINUTE }]);
	});
});
