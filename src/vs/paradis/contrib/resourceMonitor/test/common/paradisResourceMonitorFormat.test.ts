/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisFormatMemory,
	paradisGetTrackedHostMemorySeverity,
	paradisGetUsageSeverity,
} from '../../common/paradisResourceMonitorFormat.js';

suite('ParadisResourceMonitorFormat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats byte-unit boundaries with their configured precision', () => {
		assert.deepStrictEqual([
			paradisFormatMemory(1_023),
			paradisFormatMemory(1_024),
			paradisFormatMemory(1_048_575),
			paradisFormatMemory(1_048_576),
			paradisFormatMemory(1_073_741_823),
			paradisFormatMemory(1_073_741_824),
		], [
			'1 KB',
			'1 KB',
			'1024 KB',
			'1.0 MB',
			'1024.0 MB',
			'1.00 GB',
		]);
	});

	test('classifies non-finite and negative usage values without promoting NaN or negatives', () => {
		assert.deepStrictEqual([
			paradisGetUsageSeverity(
				{ cpu: Number.NaN, memory: Number.NaN },
				{ cpu: Number.POSITIVE_INFINITY, memory: Number.POSITIVE_INFINITY },
			),
			paradisGetUsageSeverity(
				{ cpu: Number.POSITIVE_INFINITY, memory: 0 },
				{ cpu: Number.POSITIVE_INFINITY, memory: 0 },
			),
			paradisGetUsageSeverity(
				{ cpu: -100, memory: -1 },
				{ cpu: 100, memory: 2 * 1_073_741_824 },
			),
			paradisGetTrackedHostMemorySeverity(Number.NaN),
			paradisGetTrackedHostMemorySeverity(Number.POSITIVE_INFINITY),
			paradisGetTrackedHostMemorySeverity(-1),
		], [
			'normal',
			'high',
			'normal',
			'normal',
			'high',
			'normal',
		]);
	});

	test('promotes CPU usage at the absolute elevated and high thresholds', () => {
		const gibibyte = 1_073_741_824;
		assert.deepStrictEqual([
			paradisGetUsageSeverity({ cpu: 69.9, memory: 1.49 * gibibyte }, { cpu: 200, memory: 4 * gibibyte }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 70, memory: 0 }, { cpu: 200, memory: 0 }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 119.999, memory: 0 }, { cpu: 200, memory: 0 }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 120, memory: 0 }, { cpu: 200, memory: 0 }),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});

	test('promotes memory usage at the absolute elevated and high thresholds', () => {
		const gibibyte = 1_073_741_824;
		const elevatedThreshold = gibibyte + gibibyte / 2;
		const highThreshold = 3 * gibibyte;

		assert.deepStrictEqual([
			paradisGetUsageSeverity({ cpu: 0, memory: elevatedThreshold - 1 }, { cpu: 0, memory: 4 * gibibyte }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 0, memory: elevatedThreshold }, { cpu: 0, memory: 4 * gibibyte }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 0, memory: highThreshold - 1 }, { cpu: 0, memory: 4 * gibibyte }, { includeShare: false }),
			paradisGetUsageSeverity({ cpu: 0, memory: highThreshold }, { cpu: 0, memory: 4 * gibibyte }, { includeShare: false }),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});

	test('promotes CPU share at the configured elevated and high thresholds', () => {
		assert.deepStrictEqual([
			paradisGetUsageSeverity({ cpu: 34.999, memory: 0 }, { cpu: 100, memory: 0 }),
			paradisGetUsageSeverity({ cpu: 35, memory: 0 }, { cpu: 100, memory: 0 }),
			paradisGetUsageSeverity({ cpu: 54.999, memory: 0 }, { cpu: 100, memory: 0 }),
			paradisGetUsageSeverity({ cpu: 55, memory: 0 }, { cpu: 100, memory: 0 }),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});

	test('promotes memory share immediately at the elevated and high thresholds', () => {
		const mebibyte = 1_048_576;
		const totalMemory = 1_600 * mebibyte;
		const elevatedThreshold = 560 * mebibyte;
		const highThreshold = 880 * mebibyte;

		assert.deepStrictEqual([
			paradisGetUsageSeverity({ cpu: 0, memory: elevatedThreshold - 1 }, { cpu: 0, memory: totalMemory }),
			paradisGetUsageSeverity({ cpu: 0, memory: elevatedThreshold }, { cpu: 0, memory: totalMemory }),
			paradisGetUsageSeverity({ cpu: 0, memory: highThreshold - 1 }, { cpu: 0, memory: totalMemory }),
			paradisGetUsageSeverity({ cpu: 0, memory: highThreshold }, { cpu: 0, memory: totalMemory }),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});

	test('promotes tracked host memory at the elevated and high thresholds', () => {
		assert.deepStrictEqual([
			paradisGetTrackedHostMemorySeverity(19.999),
			paradisGetTrackedHostMemorySeverity(20),
			paradisGetTrackedHostMemorySeverity(34.999),
			paradisGetTrackedHostMemorySeverity(35),
		], [
			'normal',
			'elevated',
			'elevated',
			'high',
		]);
	});
});
