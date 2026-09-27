/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS, PARADIS_KEEP_AWAKE_AUTO_SNAPSHOT_STALE_MS, paradisAgentsActiveAfterSnapshotFailure, paradisAgentsNeedKeepAwake, toParadisKeepAwakeMode } from '../../common/paradisKeepAwake.js';

suite('ParadisKeepAwake', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only supported modes and turns every other setting value off', () => {
		assert.deepStrictEqual([
			toParadisKeepAwakeMode('system'),
			toParadisKeepAwakeMode('display'),
			toParadisKeepAwakeMode('off'),
			toParadisKeepAwakeMode('auto'),
			toParadisKeepAwakeMode('SYSTEM'),
			toParadisKeepAwakeMode(undefined),
			toParadisKeepAwakeMode(null),
			toParadisKeepAwakeMode(1),
		], [
			'system',
			'display',
			'off',
			'auto',
			'off',
			'off',
			'off',
			'off',
		]);
	});

	test('auto mode keeps awake only for working, permission and question panes younger than the cap', () => {
		const now = 10 * PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS;
		const fresh = now - 1000;
		const stale = now - PARADIS_KEEP_AWAKE_AUTO_MAX_SAME_STATE_MS;
		assert.deepStrictEqual([
			paradisAgentsNeedKeepAwake([], now),
			paradisAgentsNeedKeepAwake([{ status: 'working', changedAt: fresh }], now),
			paradisAgentsNeedKeepAwake([{ status: 'permission', changedAt: fresh }], now),
			paradisAgentsNeedKeepAwake([{ status: 'question', changedAt: fresh }], now),
			paradisAgentsNeedKeepAwake([{ status: 'review', changedAt: fresh }], now),
			paradisAgentsNeedKeepAwake([{ status: 'permission', changedAt: stale }], now),
			paradisAgentsNeedKeepAwake([{ status: 'permission', changedAt: stale }, { status: 'working', changedAt: fresh }], now),
		], [false, true, true, true, false, false, true]);
	});

	test('keeps the last decision through short snapshot failures and stops keeping awake after about a minute', () => {
		const lastSnapshotAt = 1_000_000;
		assert.deepStrictEqual([
			paradisAgentsActiveAfterSnapshotFailure(true, lastSnapshotAt, lastSnapshotAt + 2_000),
			paradisAgentsActiveAfterSnapshotFailure(true, lastSnapshotAt, lastSnapshotAt + PARADIS_KEEP_AWAKE_AUTO_SNAPSHOT_STALE_MS - 1),
			paradisAgentsActiveAfterSnapshotFailure(true, lastSnapshotAt, lastSnapshotAt + PARADIS_KEEP_AWAKE_AUTO_SNAPSHOT_STALE_MS),
			paradisAgentsActiveAfterSnapshotFailure(false, lastSnapshotAt, lastSnapshotAt + 2_000),
		], [true, true, false, false]);
	});
});
