// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import {
	EMPTY_SYSTEM_USAGE_COPY,
	axisMax,
	chartPaths,
	downsampleSamples,
	formatUsageValue,
	historyRequestFor,
	responseMatchesMachine,
	systemResourcesOptionsFor,
	initialSystemMachineKey,
	systemMachinesFor,
	mergeSystemUsage,
	parseSystemUsageResponse,
	rangeSpec,
	systemUsageWindow,
	type SystemUsageSample,
} from './systemUsageHistory.js';

/** PC の `getSystemUsage` が返す形（列ごと）。 */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		instanceId: 'run-a',
		machine: { os: 'linux', hostname: 'devbox', cores: 16, memTotal: 68719476736, diskPath: '/', diskTotal: 494384795648, swapTotal: 2147483648 },
		tier: 'fine',
		stepMs: 5000,
		reset: true,
		unsupported: [],
		series: {
			t: [1000, 6000, 11000],
			cpu: [12.5, null, 40],
			mem: [50, 51, 52],
			disk: [30, 30, 30],
			diskRead: [null, 2048, 4096],
			diskWrite: [null, 1024, 0],
			netRx: [null, 100, 200],
			netTx: [null, 50, 60],
			swapUsed: [0, 0, 1048576],
		},
		latest: { t: 11000, cpu: 40, mem: 52 },
		...overrides,
	};
}

describe('systemUsageHistory', () => {
	test('列ごとの形を読み、null と崩れた値を落とす', () => {
		const parsed = parseSystemUsageResponse(wire({ series: { t: [1000, 'x', 6000], cpu: [1, 2, 'bad'], mem: [null] }, unsupported: ['swap', 'unknown'] }));
		expect({
			samples: parsed?.samples,
			unsupported: parsed?.unsupported,
			oldVersion: parseSystemUsageResponse(wire({ version: 2 })),
			noInstance: parseSystemUsageResponse(wire({ instanceId: '' })),
		}).toEqual({
			samples: [{ t: 1000, cpu: 1 }, { t: 6000 }],
			unsupported: ['swap'],
			oldVersion: undefined,
			noInstance: undefined,
		});
	});

	test('差分を足し、測る側が変わったら置き換え、上限で古い点を落とす', () => {
		const first = mergeSystemUsage(EMPTY_SYSTEM_USAGE_COPY, parseSystemUsageResponse(wire())!);
		const delta = mergeSystemUsage(first, parseSystemUsageResponse(wire({ reset: false, series: { t: [11000, 16000], cpu: [99, 20] } }))!);
		const restarted = mergeSystemUsage(delta, parseSystemUsageResponse(wire({ instanceId: 'run-b', reset: false, series: { t: [500], cpu: [5] } }))!);
		const many = Array.from({ length: 800 }, (_, i) => i * 5000);
		const capped = mergeSystemUsage(EMPTY_SYSTEM_USAGE_COPY, parseSystemUsageResponse(wire({ series: { t: many } }))!);
		expect({
			firstTimes: first.samples.map(s => s.t),
			deltaTimes: delta.samples.map(s => s.t),
			deltaLastCpu: delta.samples[delta.samples.length - 1]?.cpu,
			restarted: restarted.samples,
			cappedLength: capped.samples.length,
			cappedFirst: capped.samples[0]?.t,
			nextRequest: historyRequestFor(delta, 'fine', 'remote'),
			firstRequest: historyRequestFor(EMPTY_SYSTEM_USAGE_COPY, 'coarse', 'local'),
		}).toEqual({
			firstTimes: [1000, 6000, 11000],
			deltaTimes: [1000, 6000, 11000, 16000],
			deltaLastCpu: 20,
			restarted: [{ t: 500, cpu: 5 }],
			cappedLength: 720,
			cappedFirst: 80 * 5000,
			nextRequest: { machine: 'remote', tier: 'fine', since: 16000, instanceId: 'run-a' },
			firstRequest: { machine: 'local', tier: 'coarse', maxPoints: 720 },
		});
	});

	test('間引きは平均で、最新の点の組を必ず揃え、窓は最新の点から測る', () => {
		const samples: SystemUsageSample[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 5000, cpu: i * 10 }));
		expect({
			down: downsampleSamples(samples, 4),
			same: downsampleSamples(samples, 20).length,
			window: systemUsageWindow(samples, 20_000).samples.map(s => s.t),
			range: [rangeSpec('5m'), rangeSpec('24h').tier],
		}).toEqual({
			// 組の時刻は組の末尾の点（最後の組は実際の最新の点 45000 と一致する）
			down: [{ t: 0, cpu: 0 }, { t: 15000, cpu: 20 }, { t: 30000, cpu: 50 }, { t: 45000, cpu: 80 }],
			same: 10,
			window: [25000, 30000, 35000, 40000, 45000],
			range: [{ tier: 'fine', windowMs: 300000, stepMs: 5000 }, 'coarse'],
		});
	});

	test('線は値の無い点と大きな空きで切れ、軸と書式は単位ごと', () => {
		const samples: SystemUsageSample[] = [{ t: 0, cpu: 0 }, { t: 5000, cpu: 100 }, { t: 10000 }, { t: 15000, cpu: 50 }, { t: 60000, cpu: 50 }];
		expect({
			paths: chartPaths(samples, 'cpu', 0, 60000, 100, 15000, 120, 10),
			axis: [axisMax('percent', 30), axisMax('bytes', 10, 4096), axisMax('rate', 3000)],
			text: [formatUsageValue(42.4, 'percent'), formatUsageValue(1536, 'rate'), formatUsageValue(3 * 1024 ** 3, 'bytes'), formatUsageValue(undefined, 'rate')],
		}).toEqual({
			paths: {
				line: 'M0,10L10,0M30,5M120,5',
				area: 'M0,10L0,10L10,0L10,10ZM30,10L30,5L30,10ZM120,10L120,5L120,10Z',
			},
			axis: [100, 4096, 4096],
			text: ['42%', '1.5 KB/s', '3.00 GB', '—'],
		});
	});

	test('マシンはこの PC が先頭で、SSH の行・使用量の接続先から最初の 1 台を選ぶ', () => {
		const machines = systemMachinesFor({ localWindowId: 3, remotes: [{ id: 'ssh-remote+devbox', label: 'devbox', windowId: 7, ready: true }] }, 'この PC');
		expect({
			machines,
			noTarget: systemMachinesFor(undefined, 'この PC').map(m => m.key),
			fromRow: initialSystemMachineKey('ssh:pc1:ssh-remote+devbox', 'pc1', undefined, machines),
			fromPicker: initialSystemMachineKey('pc:pc1', 'pc1', 'ssh-remote+devbox', machines),
			closed: initialSystemMachineKey('ssh:pc1:ssh-remote+gone', 'pc1', undefined, machines),
			otherPc: initialSystemMachineKey('ssh:pc2:ssh-remote+devbox', 'pc1', undefined, machines),
		}).toEqual({
			machines: [
				{ key: 'local', label: 'この PC', windowId: 3, ready: true, remote: false },
				{ key: 'ssh-remote+devbox', label: 'devbox', windowId: 7, ready: true, remote: true },
			],
			noTarget: ['local'],
			fromRow: 'ssh-remote+devbox',
			fromPicker: 'ssh-remote+devbox',
			closed: 'local',
			otherPc: 'local',
		});
	});

	test('sysres の送り先と history.machine は選んだマシンで決まり、違うマシンの応答は受け入れない', () => {
		const [local, remote] = systemMachinesFor({ localWindowId: undefined, remotes: [{ id: 'ssh-remote+devbox', label: 'devbox', windowId: 7, ready: true }] }, 'この PC');
		const copy = mergeSystemUsage(EMPTY_SYSTEM_USAGE_COPY, parseSystemUsageResponse(wire())!);
		expect({
			// この PC のウィンドウが無い（SSH のウィンドウしか無い）: 送り先は PC に任せ、machine で名指しする
			local: systemResourcesOptionsFor(local!, EMPTY_SYSTEM_USAGE_COPY, 'fine'),
			remote: systemResourcesOptionsFor(remote!, copy, 'fine'),
			match: [
				responseMatchesMachine('local', local!),
				responseMatchesMachine('remote', local!),
				responseMatchesMachine(undefined, local!),
				responseMatchesMachine('remote', remote!),
			],
		}).toEqual({
			local: { history: { machine: 'local', tier: 'fine' } },
			remote: { windowId: 7, history: { machine: 'remote', tier: 'fine', since: 11000, instanceId: 'run-a' } },
			match: [true, false, true, true],
		});
	});

	test('間引いた応答の直後の since は最新の点の時刻になり、次の差分と重ならない', () => {
		// PC が 6 点を 2 点に間引いて返した（組の時刻は組の末尾）
		const first = mergeSystemUsage(EMPTY_SYSTEM_USAGE_COPY, parseSystemUsageResponse(wire({ series: { t: [15000, 30000], cpu: [10, 20] } }))!);
		const request = historyRequestFor(first, 'coarse', 'local');
		const next = mergeSystemUsage(first, parseSystemUsageResponse(wire({ reset: false, series: { t: [35000], cpu: [30] } }))!);
		expect({ since: request.since, times: next.samples.map(s => s.t) }).toEqual({ since: 30000, times: [15000, 30000, 35000] });
	});
});
