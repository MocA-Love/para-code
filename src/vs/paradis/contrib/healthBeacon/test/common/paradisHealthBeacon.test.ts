/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisHealthSnapshot,
	paradisBucketCount,
	paradisBucketUptimeHours,
	paradisBuildHealthContext,
	paradisBuildHealthMeasurements,
	paradisBuildHealthTags,
	paradisNormalizeHealthRole,
} from '../../common/paradisHealthBeacon.js';

function snapshot(overrides: Partial<IParadisHealthSnapshot> = {}): IParadisHealthSnapshot {
	return {
		reason: 'interval',
		uptimeMs: 5 * 3_600_000,
		mainV8: {
			heapUsed: 2_400_000_000,
			heapTotal: 2_500_000_000,
			heapLimit: 4_000_000_000,
			external: 10_000,
			malloced: 20_000,
			nativeContexts: 2,
			detachedContexts: 3,
			oldSpaceSize: 2_000,
			oldSpaceUsed: 1_500,
			largeObjectUsed: 41_000,
		},
		mainRss: 2_800_000_000,
		mainArrayBuffers: 1_000,
		processes: [
			{ kind: 'browser', role: 'browser', memory: 2_048, cpu: 10 },
			{ kind: 'renderer', role: 'renderer', memory: 4_096, cpu: 20 },
			{ kind: 'renderer', role: 'renderer', memory: 1_024, cpu: 5 },
			{ kind: 'gpu', role: 'gpu', memory: 8_192, cpu: 22 },
			{ kind: 'utility', role: 'extension_host', memory: 512, cpu: 1 },
			{ kind: 'utility', role: 'pty_host', memory: 256, cpu: 2 },
		],
		windows: [
			{ windowId: 1, jsHeapUsed: 300, jsHeapTotal: 400, jsHeapLimit: 4_000, privateMemory: 900, residentMemory: 0, domElements: 5_000, terminals: 30, editors: 3 },
			{ windowId: 2, jsHeapUsed: 100, jsHeapTotal: 200, jsHeapLimit: 4_000, privateMemory: 100, residentMemory: 0, domElements: 900, terminals: 5, editors: 1 },
		],
		windowCount: 2,
		browserViewCount: 8,
		hostMemoryTotal: 64_000,
		hostMemoryFree: 1_000,
		...overrides,
	};
}

suite('ParadisHealthBeacon', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes utility process names onto the fixed allow-list', () => {
		assert.deepStrictEqual([
			paradisNormalizeHealthRole('Extension Host'),
			paradisNormalizeHealthRole('Shared Process'),
			paradisNormalizeHealthRole('PTY Host'),
			paradisNormalizeHealthRole('File Watcher'),
			paradisNormalizeHealthRole('Network Service'),
			paradisNormalizeHealthRole('Some Extension Spawned Thing'),
			paradisNormalizeHealthRole(undefined),
		], [
			'extension_host',
			'shared_process',
			'pty_host',
			'file_watcher',
			'network',
			'extension_host',
			'other',
		]);
	});

	test('buckets uptime and counts at their boundaries', () => {
		assert.deepStrictEqual([
			paradisBucketUptimeHours(0.9),
			paradisBucketUptimeHours(1),
			paradisBucketUptimeHours(3.9),
			paradisBucketUptimeHours(4),
			paradisBucketUptimeHours(12),
			paradisBucketUptimeHours(24),
			paradisBucketCount(0),
			paradisBucketCount(2),
			paradisBucketCount(3),
			paradisBucketCount(51),
		], [
			'<1h', '1-4h', '1-4h', '4-12h', '12-24h', '>24h',
			'0', '1-2', '3-5', '>50',
		]);
	});

	test('tags carry the schema version and low-cardinality buckets only', () => {
		assert.deepStrictEqual(paradisBuildHealthTags(snapshot()), {
			'para.health.v': '1',
			'para.health.reason': 'interval',
			'para.uptime_bucket': '4-12h',
			'para.terminals_bucket': '21-50',
			'para.browser_views_bucket': '6-10',
			'para.windows_bucket': '1-2',
		});
	});

	test('measurements aggregate per process kind, per utility role and across windows', () => {
		const measurements = paradisBuildHealthMeasurements(snapshot());
		assert.deepStrictEqual({
			oldSpaceUsed: measurements['main.v8.old_space_used'],
			liveRatio: measurements['main.v8.old_space_live_ratio'],
			detached: measurements['main.v8.detached_contexts'],
			appTotal: measurements['app.memory_total'],
			rendererTotal: measurements['renderer.memory_total'],
			rendererMax: measurements['renderer.memory_max'],
			rendererCount: measurements['renderer.count'],
			gpu: measurements['gpu.memory'],
			extensionHost: measurements['extension_host.memory'],
			sharedProcess: measurements['shared_process.memory'],
			jsHeapTotal: measurements['window.js_heap_total'],
			jsHeapMax: measurements['window.js_heap_max'],
			domMax: measurements['window.dom_elements_max'],
			terminals: measurements['terminal.count'],
			uptime: measurements['uptime'],
		}, {
			oldSpaceUsed: { value: 1_500, unit: 'byte' },
			liveRatio: { value: 0.75, unit: 'ratio' },
			detached: { value: 3, unit: 'none' },
			appTotal: { value: 16_128, unit: 'byte' },
			rendererTotal: { value: 5_120, unit: 'byte' },
			rendererMax: { value: 4_096, unit: 'byte' },
			rendererCount: { value: 2, unit: 'none' },
			gpu: { value: 8_192, unit: 'byte' },
			extensionHost: { value: 512, unit: 'byte' },
			sharedProcess: { value: 0, unit: 'byte' },
			jsHeapTotal: { value: 400, unit: 'byte' },
			jsHeapMax: { value: 300, unit: 'byte' },
			domMax: { value: 5_000, unit: 'none' },
			terminals: { value: 35, unit: 'none' },
			uptime: { value: 5, unit: 'hour' },
		});
	});

	test('keeps ratios finite when the heap statistics are unavailable', () => {
		const measurements = paradisBuildHealthMeasurements(snapshot({
			mainV8: { ...snapshot().mainV8, oldSpaceSize: 0, oldSpaceUsed: 0 },
			processes: [],
			windows: [],
		}));
		assert.deepStrictEqual({
			liveRatio: measurements['main.v8.old_space_live_ratio'],
			rendererMax: measurements['renderer.memory_max'],
			jsHeapMax: measurements['window.js_heap_max'],
			terminals: measurements['terminal.count'],
		}, {
			liveRatio: { value: 0, unit: 'ratio' },
			rendererMax: { value: 0, unit: 'byte' },
			jsHeapMax: { value: 0, unit: 'byte' },
			terminals: { value: 0, unit: 'none' },
		});
	});

	test('context lists the heaviest processes only, capped at ten entries', () => {
		const processes = Array.from({ length: 14 }, (_, index) => ({
			kind: 'utility' as const, role: 'other', memory: index * 100, cpu: 1.4,
		}));
		const context = paradisBuildHealthContext(snapshot({ processes }));
		assert.deepStrictEqual({
			uptimeHours: context['uptime_hours'],
			processCount: context['process_count'],
			browserViewCount: context['browser_view_count'],
			top: context['top_processes'],
		}, {
			uptimeHours: 5,
			processCount: 14,
			browserViewCount: 8,
			top: Array.from({ length: 10 }, (_, index) => ({
				kind: 'utility', role: 'other', memory: (13 - index) * 100, cpu: 1,
			})),
		});
	});
});
