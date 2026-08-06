// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	CPU_THRESHOLDS, DISK_CRITICAL_FREE_BYTES, buildProcessRows, buildScopeRows, diskLevel, formatBytes,
	formatCpu, resourceHeadline, sortRowsBy, usageLevel, usagePercent, worstLevel,
} from './systemResources.js';
import type { SystemResourcesResult } from './store.js';

const GB = 1024 * 1024 * 1024;

function report(overrides: Partial<SystemResourcesResult['snapshot']> = {}): SystemResourcesResult {
	return {
		host: {
			cpu: 34,
			cores: 10,
			memory: { total: 32 * GB, used: 21 * GB },
			disks: [{ path: '/Users/example', label: 'example', total: 994 * GB, free: 582 * GB }],
			collectedAt: 1,
		},
		snapshot: {
			app: {
				cpu: 12, memory: 3 * GB,
				main: { cpu: 2, memory: 1 * GB },
				renderer: { cpu: 9, memory: 1.5 * GB },
				other: { cpu: 1, memory: 0.5 * GB },
			},
			scopes: [
				{
					stateKey: 'repo-a', scopeName: 'para-code', cpu: 20, memory: 4 * GB,
					sessions: [
						{ name: 'claude', pid: 1, cpu: 18, memory: 2 * GB },
						{ name: 'tsc', pid: 2, cpu: 2, memory: 2 * GB },
					],
				},
				{
					stateKey: 'repo-b', scopeName: 'relay', cpu: 1, memory: 1 * GB,
					sessions: [{ name: 'codex', pid: 3, cpu: 1, memory: 1 * GB }],
				},
			],
			totalCpu: 33,
			totalMemory: 8 * GB,
			hostTotalMemory: 32 * GB,
			collectedAt: 1,
			...overrides,
		},
	};
}

describe('usagePercent / usageLevel', () => {
	test('割合と閾値の判定', () => {
		expect([
			usagePercent(21 * GB, 32 * GB).toFixed(1),
			usagePercent(1, 0),
			usagePercent(5, 4),
			usageLevel(50, CPU_THRESHOLDS),
			usageLevel(75, CPU_THRESHOLDS),
			usageLevel(92, CPU_THRESHOLDS),
			worstLevel(['normal', 'warn', 'normal']),
			worstLevel(['warn', 'critical']),
			worstLevel(['normal']),
		]).toStrictEqual(['65.6', 0, 100, 'normal', 'warn', 'critical', 'warn', 'critical', 'normal']);
	});
});

describe('diskLevel', () => {
	test('使用率と空き容量の厳しいほうを採る', () => {
		expect([
			// 空きは十分、使用率も低い
			diskLevel(1000 * GB, 500 * GB),
			// 使用率は低いが空きが絶対量で足りない（2TBの1%でも枯渇は枯渇）
			diskLevel(2000 * GB, DISK_CRITICAL_FREE_BYTES - 1),
			// 使用率が高いが空きはまだある小容量ディスク
			diskLevel(100 * GB, 3 * GB),
			// 空きは多いが使用率が warn 帯
			diskLevel(1000 * GB, 100 * GB),
		]).toStrictEqual(['normal', 'critical', 'critical', 'warn']);
	});
});

describe('formatBytes / formatCpu', () => {
	test('単位の切り替わり', () => {
		expect([
			formatBytes(0),
			formatBytes(900),
			formatBytes(1536),
			formatBytes(5 * 1024 * 1024),
			formatBytes(2.25 * GB),
			formatBytes(1024 * GB),
			formatBytes(-1),
			formatCpu(undefined),
			formatCpu(142.4),
		]).toStrictEqual(['0 B', '900 B', '2 KB', '5 MB', '2.3 GB', '1.0 TB', '—', '—', '142%']);
	});
});

describe('buildProcessRows / buildScopeRows', () => {
	test('Para Code本体を含めてメモリ降順、スペース軸は本体を含めない', () => {
		expect([
			buildProcessRows(report()).map(row => [row.name, row.sub, row.cpu]),
			buildScopeRows(report()).map(row => [row.name, row.sub, row.memory / GB]),
		]).toStrictEqual([
			[
				['Para Code', 'ウィンドウ・拡張ホスト', 12],
				['claude', 'para-code', 18],
				['tsc', 'para-code', 2],
				['codex', 'relay', 1],
			],
			[
				['para-code', '2 ターミナル', 4],
				['relay', '1 ターミナル', 1],
			],
		]);
	});

	test('ターミナルが1つも無くても本体の行は出る', () => {
		expect(buildProcessRows(report({ scopes: [] })).map(row => row.key)).toStrictEqual(['__paracode__']);
	});
});

describe('sortRowsBy', () => {
	test('CPU順とメモリ順で並びが変わる（同じ行を別々の軸で見せるため）', () => {
		const rows = buildProcessRows(report());
		expect([
			sortRowsBy(rows, 'cpu').map(row => [row.name, row.cpu]),
			sortRowsBy(rows, 'memory').map(row => [row.name, row.memory / GB]),
		]).toStrictEqual([
			[['claude', 18], ['Para Code', 12], ['tsc', 2], ['codex', 1]],
			[['Para Code', 3], ['claude', 2], ['tsc', 2], ['codex', 1]],
		]);
	});

	test('元の配列を壊さない（2つのリストが同じ配列を共有するため）', () => {
		const rows = buildProcessRows(report());
		const before = rows.map(row => row.key);
		sortRowsBy(rows, 'cpu');
		expect(rows.map(row => row.key)).toStrictEqual(before);
	});
});

describe('resourceHeadline', () => {
	test('厳しい順に1つだけ出し、平常時は何も出さない', () => {
		expect([
			resourceHeadline({ cpuLevel: 'normal', memoryLevel: 'normal', diskLevel: 'normal' }),
			resourceHeadline({ cpuLevel: 'normal', memoryLevel: 'warn', diskLevel: 'normal' }),
			resourceHeadline({ cpuLevel: 'critical', memoryLevel: 'normal', diskLevel: 'normal' }),
			resourceHeadline({ cpuLevel: 'critical', memoryLevel: 'critical', diskLevel: 'normal' }),
			resourceHeadline({ cpuLevel: 'normal', memoryLevel: 'normal', diskLevel: 'critical', diskFree: 8 * GB }),
		]).toStrictEqual([
			undefined,
			'PCの負荷が高めです',
			'CPUがほぼ使い切られています',
			'メモリが逼迫しています',
			'ディスクの空きが残り 8.0 GB',
		]);
	});
});
