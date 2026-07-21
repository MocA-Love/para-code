/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisNormalizeCodexLimitWindows } from '../../common/paradisLimitsMonitor.js';

suite('ParadisLimitsMonitor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes Codex rate-limit windows by duration', () => {
		const fiveHour = { id: 'five-hour', durationMinutes: 300 };
		const sevenDay = { id: 'seven-day', durationMinutes: 10_080 };
		const unknown = { id: 'unknown', durationMinutes: 540 };
		const normalize = (primary: typeof fiveHour | null | undefined, secondary: typeof fiveHour | null | undefined) =>
			paradisNormalizeCodexLimitWindows(primary, secondary, window => window.durationMinutes);

		assert.deepStrictEqual({
			regular: normalize(fiveHour, sevenDay),
			weeklyOnlyInPrimary: normalize(sevenDay, null),
			reversed: normalize(sevenDay, fiveHour),
			sessionOnlyInSecondary: normalize(undefined, fiveHour),
			unknownOnly: normalize(unknown, undefined),
		}, {
			regular: { fiveHour, sevenDay },
			weeklyOnlyInPrimary: { sevenDay },
			reversed: { fiveHour, sevenDay },
			sessionOnlyInSecondary: { fiveHour },
			unknownOnly: { fiveHour: unknown },
		});
	});
});
