/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_DO_NOT_DISTURB_DURATIONS, paradisFormatDoNotDisturbRemaining } from '../../common/paradisDoNotDisturb.js';
import {
	PARADIS_DO_NOT_DISTURB_DURATION_IDS,
	PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA,
	paradisFormatDoNotDisturbRemainingJa,
	paradisIsDoNotDisturbDurationId,
	paradisResolveDoNotDisturbUntil,
} from '../../common/paradisDoNotDisturbRules.js';

suite('Paradis DND rules (PC and mobile)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('期限の計算: 30分・1時間・朝まで（深夜はその日の 7:00、それ以外は翌日）・自分でオフにするまで', () => {
		const evening = new Date(2026, 9, 6, 23, 18, 0, 0).getTime();
		const lateNight = new Date(2026, 9, 7, 3, 0, 0, 0).getTime();
		const exactlySeven = new Date(2026, 9, 7, 7, 0, 0, 0).getTime();
		const at = (until: number | undefined) => until === undefined ? undefined : new Date(until).toString();
		assert.deepStrictEqual({
			minutes30: paradisResolveDoNotDisturbUntil('minutes30', evening)! - evening,
			hours1: paradisResolveDoNotDisturbUntil('hours1', evening)! - evening,
			morningFromEvening: at(paradisResolveDoNotDisturbUntil('morning', evening)),
			morningFromLateNight: at(paradisResolveDoNotDisturbUntil('morning', lateNight)),
			morningAtSeven: at(paradisResolveDoNotDisturbUntil('morning', exactlySeven)),
			manual: paradisResolveDoNotDisturbUntil('manual', evening),
			pcUsesSameRules: PARADIS_DO_NOT_DISTURB_DURATIONS.map(duration => duration.resolveUntil(evening) === paradisResolveDoNotDisturbUntil(duration.id, evening)),
			ids: [paradisIsDoNotDisturbDurationId('morning'), paradisIsDoNotDisturbDurationId('hours2'), paradisIsDoNotDisturbDurationId(undefined)],
		}, {
			minutes30: 30 * 60 * 1000,
			hours1: 60 * 60 * 1000,
			morningFromEvening: new Date(2026, 9, 7, 7, 0, 0, 0).toString(),
			morningFromLateNight: new Date(2026, 9, 7, 7, 0, 0, 0).toString(),
			morningAtSeven: new Date(2026, 9, 8, 7, 0, 0, 0).toString(),
			manual: undefined,
			pcUsesSameRules: [true, true, true, true],
			ids: [true, false, false],
		});
	});

	test('PC の文言とアプリの文言が同じ（選択肢の並び・残り時間）', () => {
		const now = 1_000_000_000_000;
		const samples = [undefined, now - 1, now + 30_000, now + 42 * 60_000, now + 60 * 60_000, now + (7 * 60 + 42) * 60_000];
		assert.deepStrictEqual({
			durations: PARADIS_DO_NOT_DISTURB_DURATIONS.map(duration => [duration.id, duration.label]),
			remaining: samples.map(until => paradisFormatDoNotDisturbRemaining(until, now)),
		}, {
			durations: PARADIS_DO_NOT_DISTURB_DURATION_IDS.map(id => [id, PARADIS_DO_NOT_DISTURB_DURATION_LABELS_JA[id]]),
			remaining: samples.map(until => paradisFormatDoNotDisturbRemainingJa(until, now)),
		});
		assert.deepStrictEqual(samples.map(until => paradisFormatDoNotDisturbRemainingJa(until, now)), [undefined, 'まもなく', '1分', '42分', '1時間', '7時間42分']);
	});
});
