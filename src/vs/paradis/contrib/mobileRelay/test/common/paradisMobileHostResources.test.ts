/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHostResources } from '../../../resourceMonitor/common/paradisResourceMonitor.js';
import { paradisMobileResourcesEqual, paradisRoundMobileResources } from '../../common/paradisMobileHostResources.js';

const GB = 1024 * 1024 * 1024;
/** 32GB機でのメモリ丸め幅（総量の2%）。 */
const MEMORY_STEP = Math.round(32 * GB * 0.02);
/** 1TBディスクでの空き容量の丸め幅（総量の0.5%）。 */
const DISK_STEP = Math.round(1000 * GB * 0.005);
/** 空きが少ない領域での固定刻み。 */
const DISK_SMALL_STEP = 256 * 1024 * 1024;

/** 期待値を丸め幅の倍数として書くためのヘルパー。 */
function toStep(value: number, step: number): number {
	return Math.round(value / step) * step;
}

/** 空き容量は切り捨てる（実際より空きがあると誤認させないため）。 */
function floorToStep(value: number, step: number): number {
	return Math.floor(value / step) * step;
}

function host(overrides: Partial<IParadisHostResources> = {}): IParadisHostResources {
	return {
		cpu: 33,
		cores: 10,
		memory: { total: 32 * GB, used: 21 * GB },
		disks: [{ path: '/Users/example', label: 'example', total: 1000 * GB, free: 582 * GB }],
		collectedAt: 1,
		...overrides,
	};
}

suite('ParadisMobileHostResources', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rounds each value to its broadcast step', () => {
		const rounded = paradisRoundMobileResources(host());
		assert.deepStrictEqual(rounded, {
			// CPU は 10% 刻み
			cpu: 30,
			// メモリは総量の 2% 刻み
			memUsed: toStep(21 * GB, MEMORY_STEP),
			memTotal: 32 * GB,
			// ディスクは総量の 0.5% 刻みを切り捨て
			diskFree: floorToStep(582 * GB, DISK_STEP),
			diskTotal: 1000 * GB,
		});
	});

	test('omits values that could not be read, and drops the whole snapshot without memory', () => {
		assert.deepStrictEqual([
			paradisRoundMobileResources(host({ cpu: undefined, disks: [] })),
			paradisRoundMobileResources(host({ memory: { total: 0, used: 0 } })),
		], [
			{ memUsed: toStep(21 * GB, MEMORY_STEP), memTotal: 32 * GB },
			undefined,
		]);
	});

	test('clamps out-of-range input instead of broadcasting nonsense', () => {
		assert.deepStrictEqual(paradisRoundMobileResources(host({
			cpu: 480,
			memory: { total: 32 * GB, used: 40 * GB },
			disks: [{ path: '/', label: '/', total: 1000 * GB, free: 1200 * GB }],
		})), {
			cpu: 100,
			memUsed: 32 * GB,
			memTotal: 32 * GB,
			diskFree: 1000 * GB,
			diskTotal: 1000 * GB,
		});
	});

	test('floors the free space and switches to a fixed step when it runs low', () => {
		// 残り8GB。比率刻み（1TBなら5GB）で丸めると絶対量アラート（10GB/25GB）を跨いでしまうため、
		// 空きが少ない領域では 256MB 刻みへ切り替え、さらに必ず切り捨てる。
		const low = paradisRoundMobileResources(host({
			disks: [{ path: '/', label: '/', total: 1000 * GB, free: 8.4 * GB }],
		}));
		assert.deepStrictEqual([
			low?.diskFree,
			// 切り上げていたら実際より空きがあることになる
			(low?.diskFree ?? 0) <= 8.4 * GB,
		], [floorToStep(8.4 * GB, DISK_SMALL_STEP), true]);
	});

	test('treats only identical rounded snapshots as equal', () => {
		const base = paradisRoundMobileResources(host());
		assert.deepStrictEqual([
			paradisMobileResourcesEqual(base, paradisRoundMobileResources(host())),
			// 丸めの刻みに収まる揺れは再送しない
			paradisMobileResourcesEqual(base, paradisRoundMobileResources(host({ cpu: 29 }))),
			// 刻みを跨いだら再送する
			paradisMobileResourcesEqual(base, paradisRoundMobileResources(host({ cpu: 44 }))),
			paradisMobileResourcesEqual(undefined, undefined),
			paradisMobileResourcesEqual(base, undefined),
		], [true, true, false, true, false]);
	});
});
