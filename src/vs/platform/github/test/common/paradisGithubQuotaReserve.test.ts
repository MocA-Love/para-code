/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { RateLimitState } from '../../common/cooldownState.js';
import { paradisGithubQuotaReserveDelay } from '../../common/paradisGithubQuotaReserve.js';
import { RequestAccount, RequestPriority } from '../../common/types.js';

suite('paradisGithubQuotaReserve', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const account: RequestAccount = { host: 'github.com', accountId: '1' };
	const now = 1_000_000;
	const resetAt = now + 60_000;

	function delay(priority: RequestPriority, remaining: number | undefined, resource = 'core', readResource?: (resource: string) => void): number {
		const state: RateLimitState = { limit: 5000, remaining, resetAt };
		return paradisGithubQuotaReserveDelay({
			getState: (_account, stateResource) => {
				readResource?.(stateResource);
				return state;
			},
		}, { account, resource, priority }, now);
	}

	test('low-priority requests wait for the reset once the quota is nearly spent; interactive work never does', () => {
		const resources: string[] = [];
		assert.deepStrictEqual({
			backgroundAbove: delay('background', 1300),
			backgroundAt25: delay('background', 1250),
			enrichmentLow: delay('enrichment', 100),
			visibleAt10: delay('visible', 500),
			visibleAt5: delay('visible', 250),
			interactiveEmpty: delay('interactive', 0),
			mutationEmpty: delay('mutation', 0),
			unknownRemaining: delay('background', undefined),
			checksReadCore: delay('background', 10, 'checks', resource => resources.push(resource)),
			resources,
		}, {
			backgroundAbove: 0,
			backgroundAt25: 60_000,
			enrichmentLow: 60_000,
			visibleAt10: 0,
			visibleAt5: 60_000,
			interactiveEmpty: 0,
			mutationEmpty: 0,
			unknownRemaining: 0,
			checksReadCore: 60_000,
			resources: ['core'],
		});
	});
});
