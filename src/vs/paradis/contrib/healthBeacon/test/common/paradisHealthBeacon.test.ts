/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

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
	PARADIS_HEALTH_MEASUREMENT_LIMIT,
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
		assert.deepStrictEqual(measurements, {
			'main.v8.old_space_used': { value: 1_500, unit: 'byte' },
			'main.v8.old_space_live_ratio': { value: 0.75, unit: 'ratio' },
			'main.rss': { value: 2_800_000_000, unit: 'byte' },
			'extension_host.memory': { value: 512, unit: 'byte' },
			'app.memory_total': { value: 16_128, unit: 'byte' },
			'renderer.memory_total': { value: 5_120, unit: 'byte' },
			'gpu.memory': { value: 8_192, unit: 'byte' },
			'app.process_count': { value: 6, unit: 'none' },
			'host.memory_free': { value: 1_000, unit: 'byte' },
			'uptime': { value: 5, unit: 'hour' },
		});
	});

	test('stays within the ten custom measurements Sentry keeps per transaction', () => {
		// 超えた分はエラーにならず、アルファベット順で先頭10個以外が黙って捨てられる。
		// 以前それで `main.v8.old_space_used` が本番に一度も届いていなかったので、数を固定する。
		assert.ok(
			Object.keys(paradisBuildHealthMeasurements(snapshot())).length <= PARADIS_HEALTH_MEASUREMENT_LIMIT,
			'measurements must stay within the ingestion limit or the extras are dropped silently',
		);
	});

	test('keeps ratios finite when the heap statistics are unavailable', () => {
		const measurements = paradisBuildHealthMeasurements(snapshot({
			mainV8: { ...snapshot().mainV8, oldSpaceSize: 0, oldSpaceUsed: 0 },
			processes: [],
			windows: [],
		}));
		assert.deepStrictEqual({
			liveRatio: measurements['main.v8.old_space_live_ratio'],
			rendererTotal: measurements['renderer.memory_total'],
			extensionHost: measurements['extension_host.memory'],
		}, {
			liveRatio: { value: 0, unit: 'ratio' },
			rendererTotal: { value: 0, unit: 'byte' },
			extensionHost: { value: 0, unit: 'byte' },
		});
	});

	test('context carries the breakdown that did not fit into measurements', () => {
		const context = paradisBuildHealthContext(snapshot());
		assert.deepStrictEqual({
			uptimeHours: context['uptime_hours'],
			processCount: context['process_count'],
			browserViewCount: context['browser_view_count'],
			detached: context['safe_main_v8_detached_contexts'],
			rendererCount: context['safe_renderer_count'],
			sharedProcess: context['safe_shared_process_memory'],
			jsHeapTotal: context['safe_window_js_heap_total'],
			domMax: context['safe_window_dom_elements_max'],
			terminals: context['safe_terminal_count'],
		}, {
			uptimeHours: 5,
			processCount: 6,
			browserViewCount: 8,
			detached: 3,
			rendererCount: 2,
			sharedProcess: 0,
			jsHeapTotal: 400,
			domMax: 5_000,
			terminals: 35,
		});
	});

	test('flattens the heaviest processes instead of nesting them', () => {
		// ネストしたオブジェクトの配列は Sentry の context 正規化で `"[Object]"` に潰れて
		// 内訳が読めなくなる。平たいキーで送ること。
		const processes = Array.from({ length: 14 }, (_, index) => ({
			kind: 'utility' as const, role: 'other', memory: index * 100, cpu: 1.4,
		}));
		const context = paradisBuildHealthContext(snapshot({ processes }));
		assert.deepStrictEqual({
			first: [context['safe_top1_role'], context['safe_top1_memory'], context['safe_top1_cpu']],
			fifth: [context['safe_top5_role'], context['safe_top5_memory'], context['safe_top5_cpu']],
			sixth: context['safe_top6_role'],
			nested: context['top_processes'],
		}, {
			first: ['other', 1_300, 1],
			fifth: ['other', 900, 1],
			sixth: undefined,
			nested: undefined,
		});
	});
});
