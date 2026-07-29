/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisLimitsAccount,
	paradisLimitsFormatCountdown,
	paradisLimitsFormatResetClock,
	paradisLimitsSeverity,
	paradisLimitsWorstPercent,
	paradisNormalizeCodexLimitWindows,
} from '../../common/paradisLimitsMonitor.js';

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

	test('recognizes exact duration boundaries and keeps unknown durations positional', () => {
		type WindowFixture = { id: string; durationMinutes?: number };
		const exactFiveHour: WindowFixture = { id: 'exact-five-hour', durationMinutes: 300 };
		const exactSevenDay: WindowFixture = { id: 'exact-seven-day', durationMinutes: 10_080 };
		const belowSevenDay: WindowFixture = { id: 'below-seven-day', durationMinutes: 10_079 };
		const missingDuration: WindowFixture = { id: 'missing-duration' };
		const durationMinutes = (window: WindowFixture) => window.durationMinutes;

		assert.deepStrictEqual({
			exactFiveHourOnly: paradisNormalizeCodexLimitWindows(undefined, exactFiveHour, durationMinutes),
			exactSevenDayOnly: paradisNormalizeCodexLimitWindows(undefined, exactSevenDay, durationMinutes),
			belowSevenDayOnly: paradisNormalizeCodexLimitWindows(undefined, belowSevenDay, durationMinutes),
			missingDurationOnly: paradisNormalizeCodexLimitWindows(missingDuration, undefined, durationMinutes),
		}, {
			exactFiveHourOnly: { fiveHour: exactFiveHour },
			exactSevenDayOnly: { sevenDay: exactSevenDay },
			belowSevenDayOnly: { fiveHour: belowSevenDay },
			missingDurationOnly: { fiveHour: { id: 'missing-duration' } },
		});
	});

	test('returns no windows or worst percentage for missing usage payloads', () => {
		const account: IParadisLimitsAccount = {
			provider: 'codex',
			id: '/tmp/.codex-test',
			status: 'ok',
		};

		assert.deepStrictEqual(paradisNormalizeCodexLimitWindows(undefined, null, () => undefined), {});
		assert.strictEqual(paradisLimitsWorstPercent(account), undefined);
		assert.strictEqual(paradisLimitsWorstPercent({ ...account, scoped: [] }), undefined);
		assert.strictEqual(paradisLimitsFormatResetClock(undefined, Date.now()), undefined);
		assert.strictEqual(paradisLimitsFormatCountdown(undefined, Date.now()), undefined);
	});

	test('uses the documented severity boundaries', () => {
		assert.deepStrictEqual([
			paradisLimitsSeverity(59.999),
			paradisLimitsSeverity(60),
			paradisLimitsSeverity(84.999),
			paradisLimitsSeverity(85),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});

	test('selects the worst percentage from each account window family', () => {
		const account: IParadisLimitsAccount = {
			provider: 'codex',
			id: '/tmp/.codex-test',
			status: 'ok',
		};

		assert.deepStrictEqual([
			paradisLimitsWorstPercent({
				...account,
				fiveHour: { usedPercent: 92 },
				sevenDay: { usedPercent: 84 },
				scoped: [{ usedPercent: 91, label: 'model' }],
			}),
			paradisLimitsWorstPercent({
				...account,
				fiveHour: { usedPercent: 59 },
				sevenDay: { usedPercent: 93 },
				scoped: [{ usedPercent: 91, label: 'model' }],
			}),
			paradisLimitsWorstPercent({
				...account,
				fiveHour: { usedPercent: 59 },
				sevenDay: { usedPercent: 84 },
				scoped: [{ usedPercent: 94, label: 'model' }],
			}),
		], [
			92,
			93,
			94,
		]);
	});
});
