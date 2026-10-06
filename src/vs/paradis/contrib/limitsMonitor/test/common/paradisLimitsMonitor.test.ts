/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisLimitsAccount,
	paradisLimitsFormatCountdown,
	paradisLimitsNeedsRelogin,
	paradisLimitsNotFetchedCause,
	paradisLimitsPreviousValue,
	paradisLimitsSeverity,
	paradisLimitsWindowView,
	paradisLimitsWorstPercent,
	paradisNormalizeCodexLimitWindows,
} from '../../common/paradisLimitsMonitor.js';

suite('ParadisLimitsMonitor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only states that re-login can fix ask for a re-login', () => {
		assert.deepStrictEqual(
			(['ok', 'refreshing', 'relogin_required', 'no_credentials', 'unavailable', 'error'] as const).map(status => [status, paradisLimitsNeedsRelogin(status)]),
			[['ok', false], ['refreshing', false], ['relogin_required', true], ['no_credentials', true], ['unavailable', false], ['error', true]],
		);
	});

	// 「制限に達した…」と一律に出していた説明を、取得を控えている本当の理由で出し分ける。
	test('tells why a Claude account has not been fetched from its status detail', () => {
		assert.deepStrictEqual(
			['shared with claude-swap', 'same lineage as the current login', undefined, 'usage API returned 500'].map(detail => paradisLimitsNotFetchedCause(detail)),
			['shared_with_claude_swap', 'same_lineage', 'not_yet', 'not_yet'],
		);
	});

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

	// 取りに行くのを控えている間の前の値: 控えている（'not_fetched'）ときだけ、値があれば古さと理由を添えて出す。
	test('shows the previous usage only while fetching is held off and there is a value', () => {
		const now = 1_800_000_000_000;
		const held: IParadisLimitsAccount = {
			provider: 'claude', id: 'para-claude:b', status: 'unavailable', unavailableReason: 'not_fetched', statusDetail: 'shared with claude-swap',
			fetchedAt: now - 12 * 60_000, fiveHour: { usedPercent: 30 },
		};
		assert.deepStrictEqual({
			shared: paradisLimitsPreviousValue(held, now),
			sameLineageHours: paradisLimitsPreviousValue({ ...held, statusDetail: 'same lineage as the current login', fetchedAt: now - 3 * 3600_000 - 1 }, now),
			notYetDays: paradisLimitsPreviousValue({ ...held, statusDetail: undefined, fetchedAt: now - 2 * 86_400_000 }, now),
			scopedOnly: paradisLimitsPreviousValue({ ...held, fiveHour: undefined, scoped: [{ usedPercent: 5, label: 'model' }] }, now)?.cause,
			// 古い PC（控えている間は値を送らない）・値の無いアカウント
			noValue: paradisLimitsPreviousValue({ ...held, fiveHour: undefined }, now),
			noFetchedAt: paradisLimitsPreviousValue({ ...held, fetchedAt: undefined }, now),
			// 控えている以外の状態はいつもの説明文のまま
			ok: paradisLimitsPreviousValue({ ...held, status: 'ok', unavailableReason: undefined }, now),
			rateLimited: paradisLimitsPreviousValue({ ...held, unavailableReason: 'rate_limited' }, now),
			relogin: paradisLimitsPreviousValue({ ...held, status: 'relogin_required', unavailableReason: undefined }, now),
		}, {
			shared: { age: { amount: 12, unit: 'minutes' }, cause: 'shared_with_claude_swap' },
			sameLineageHours: { age: { amount: 3, unit: 'hours' }, cause: 'same_lineage' },
			notYetDays: { age: { amount: 2, unit: 'days' }, cause: 'not_yet' },
			scopedOnly: 'shared_with_claude_swap',
			noValue: undefined,
			noFetchedAt: undefined,
			ok: undefined,
			rateLimited: undefined,
			relogin: undefined,
		});
	});

	// リセット時刻を過ぎた枠は、古い使用率を出さない。
	test('hides the usage of a window whose reset time has passed', () => {
		const now = 1_800_000_000_000;
		assert.deepStrictEqual([
			paradisLimitsWindowView({ usedPercent: 80, resetsAt: now + 90 * 60_000 }, now),
			paradisLimitsWindowView({ usedPercent: 80, resetsAt: now }, now),
			paradisLimitsWindowView({ usedPercent: 80, resetsAt: now - 1 }, now),
			paradisLimitsWindowView({ usedPercent: 80 }, now),
		], [
			{ kind: 'value', percent: 80, countdown: '1h 30m' },
			{ kind: 'reset' },
			{ kind: 'reset' },
			{ kind: 'value', percent: 80 },
		]);
	});
});
