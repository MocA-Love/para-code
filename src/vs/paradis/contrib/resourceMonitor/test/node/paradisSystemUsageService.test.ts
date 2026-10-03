/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDecodeSystemUsageSeries } from '../../common/paradisSystemUsage.js';
import { IParadisSystemUsageCounters } from '../../common/paradisSystemUsageParsers.js';
import { IParadisShellRun, IParadisSystemUsageReader, ParadisDarwinSystemUsageReader, ParadisDiskUsageReader, paradisCreateSystemUsageReader, paradisIsProcessGroupAlive, paradisIsRecordedProcessGroupAlive, paradisRunShellInProcessGroup } from '../../node/paradisSystemUsageSampler.js';
import { ParadisSystemUsageService } from '../../node/paradisSystemUsageService.js';

class TestReader implements IParadisSystemUsageReader {

	readonly platform = 'linux';
	readonly diskPath = '/';
	readonly unsupported = [];
	reads = 0;

	async read(now: number): Promise<IParadisSystemUsageCounters> {
		this.reads++;
		return { at: now, cpu: { busy: this.reads * 50, total: this.reads * 100 }, memUsed: 4, memTotal: 16, netRxBytes: this.reads * 5000, swapTotal: 10 };
	}
}

function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

suite('ParadisSystemUsageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps measuring on its own timer and answers full and incremental requests', async () => {
		let now = 1_000_000;
		const scheduled: { callback: () => void; delay: number; disposed: boolean }[] = [];
		const reader = new TestReader();
		const service = new ParadisSystemUsageService({
			reader,
			now: () => now,
			schedule: (callback, delay): IDisposable => {
				const entry = { callback, delay, disposed: false };
				scheduled.push(entry);
				return { dispose: () => { entry.disposed = true; } };
			},
		});
		try {
			service.start();
			service.start();
			// 1 回目はすぐ、以後は刻み（5 秒）ごと
			scheduled[0].callback();
			await settle();
			now += 5_000;
			scheduled[1].callback();
			await settle();

			const full = await service.getSystemUsage({ tier: 'fine' });
			now += 5_000;
			await service.sampleOnce();
			const delta = await service.getSystemUsage({ tier: 'fine', since: 1_005_000, instanceId: full.instanceId });
			const otherInstance = await service.getSystemUsage({ tier: 'fine', since: 1_005_000, instanceId: 'stale' });

			assert.deepStrictEqual({
				delays: scheduled.map(entry => entry.delay),
				full: { reset: full.reset, samples: paradisDecodeSystemUsageSeries(full.series), machine: { os: full.machine.os, memTotal: full.machine.memTotal, swapTotal: full.machine.swapTotal, diskPath: full.machine.diskPath }, stepMs: full.stepMs },
				delta: { reset: delta.reset, t: paradisDecodeSystemUsageSeries(delta.series).map(sample => sample.t) },
				otherInstance: { reset: otherInstance.reset, t: paradisDecodeSystemUsageSeries(otherInstance.series).map(sample => sample.t) },
			}, {
				delays: [0, 5_000, 5_000],
				full: {
					reset: true,
					samples: [
						{ t: 1_000_000, mem: 25 },
						{ t: 1_005_000, mem: 25, cpu: 50, netRx: 1000 },
					],
					machine: { os: 'linux', memTotal: 16, swapTotal: 10, diskPath: '/' },
					stepMs: 5_000,
				},
				delta: { reset: false, t: [1_010_000] },
				otherInstance: { reset: true, t: [1_000_000, 1_005_000, 1_010_000] },
			});

			service.dispose();
			assert.strictEqual(scheduled.at(-1)?.disposed, true);
		} finally {
			service.dispose();
		}
	});

	test('measures once on demand when nothing has been recorded yet', async () => {
		const reader = new TestReader();
		const service = new ParadisSystemUsageService({ reader, now: () => 42, schedule: () => ({ dispose() { } }) });
		try {
			const response = await service.getSystemUsage({ tier: 'coarse' });
			assert.deepStrictEqual({ reads: reader.reads, latest: response.latest, coarse: response.series.t }, { reads: 1, latest: { t: 42, mem: 25 }, coarse: [] });
		} finally {
			service.dispose();
		}
	});

	test('reads real counters on this machine', async () => {
		const reader = paradisCreateSystemUsageReader();
		const counters = await reader.read(1).finally(() => reader.dispose?.());
		assert.deepStrictEqual({
			at: counters.at,
			hasCpu: process.platform === 'win32' || (counters.cpu !== undefined && counters.cpu.total > 0),
			memory: counters.memTotal !== undefined && counters.memTotal > 0 && counters.memUsed !== undefined && counters.memUsed >= 0,
		}, { at: 1, hasCpu: true, memory: true });
	});

	test('does not start a new reading while a slow one is still running', async () => {
		let release: (() => void) | undefined;
		let reads = 0;
		const reader: IParadisSystemUsageReader = {
			platform: 'linux',
			diskPath: '/',
			unsupported: [],
			read: now => {
				reads++;
				return new Promise(resolve => { release = () => resolve({ at: now, memUsed: 1, memTotal: 4 }); });
			},
		};
		const service = new ParadisSystemUsageService({ reader, now: () => 1_000, schedule: () => ({ dispose() { } }) });
		try {
			const first = service.sampleOnce();
			const second = service.sampleOnce();
			await second;
			const readsWhileSlow = reads;
			release?.();
			await first;
			assert.deepStrictEqual({ readsWhileSlow, reads, samples: service.history.samples('fine').length }, { readsWhileSlow: 1, reads: 1, samples: 1 });
		} finally {
			service.dispose();
		}
	});

	test('drops the history and changes the instance when the clock jumps far back', async () => {
		let now = 10_000_000;
		const reader = new TestReader();
		const service = new ParadisSystemUsageService({ reader, now: () => now, schedule: () => ({ dispose() { } }) });
		try {
			await service.sampleOnce();
			now += 5_000;
			await service.sampleOnce();
			const before = service.instanceId;
			// 少しだけ戻った（数秒）: その点は積まず、履歴も印もそのまま
			now -= 3_000;
			await service.sampleOnce();
			const afterSmall = { id: service.instanceId === before, t: service.history.samples('fine').map(sample => sample.t) };
			// 大きく戻った（1 時間）: 捨てて印を変える
			now -= 3_600_000;
			await service.sampleOnce();
			const response = await service.getSystemUsage({ tier: 'fine', since: 10_005_000, instanceId: before });
			assert.deepStrictEqual({
				afterSmall,
				changed: service.instanceId !== before,
				reset: response.reset,
				t: paradisDecodeSystemUsageSeries(response.series).map(sample => sample.t),
			}, {
				afterSmall: { id: true, t: [10_000_000, 10_005_000] },
				changed: true,
				reset: true,
				t: [now],
			});
		} finally {
			service.dispose();
		}
	});

	test('reuses the last disk usage while a previous statfs has not returned', async () => {
		let calls = 0;
		let hang = false;
		const disk = new ParadisDiskUsageReader('/', async () => {
			calls++;
			if (hang) {
				return new Promise<never>(() => { });
			}
			return { bsize: 100, blocks: 10, bfree: 4, bavail: 2 };
		}, 10);
		const first = await disk.readUsage();
		hang = true;
		const timedOut = await disk.readUsage();
		const whileHanging = await disk.readUsage();
		assert.deepStrictEqual({ calls, first, timedOut, whileHanging }, {
			// 使用中 600、一般ユーザーが使える空き 200
			calls: 2,
			first: { diskUsed: 600, diskTotal: 800 },
			timedOut: { diskUsed: 600, diskTotal: 800 },
			whileHanging: { diskUsed: 600, diskTotal: 800 },
		});
	});

	(process.platform === 'win32' ? test.skip : test)('kills the whole process group on timeout so no child is left behind', async function () {
		this.timeout(10_000);
		const run = paradisRunShellInProcessGroup('/bin/sleep 30 & /bin/sleep 31; echo never', { timeoutMs: 200, maxBuffer: 1024 });
		try {
			const startedAt = Date.now();
			const result = await run.result;
			assert.ok(run.pid !== undefined);
			assert.deepStrictEqual({
				timedOut: result.timedOut,
				stdout: result.stdout,
				groupAlive: paradisIsProcessGroupAlive(run.pid),
				quick: Date.now() - startedAt < 5_000,
			}, { timedOut: true, stdout: '', groupAlive: false, quick: true });
		} finally {
			// 失敗しても sleep を残さない
			if (run.pid !== undefined) {
				try {
					process.kill(-run.pid, 'SIGKILL');
				} catch {
					// もう居ない
				}
			}
		}
	});

	(process.platform === 'win32' ? test.skip : test)('kills the process group on demand (dispose) and returns normal output otherwise', async function () {
		this.timeout(10_000);
		const normal = paradisRunShellInProcessGroup('echo hello', { timeoutMs: 5_000, maxBuffer: 1024 });
		const stopped = paradisRunShellInProcessGroup('/bin/sleep 30; echo never', { timeoutMs: 30_000, maxBuffer: 1024 });
		try {
			stopped.kill();
			const [normalResult, stoppedResult] = await Promise.all([normal.result, stopped.result]);
			assert.ok(stopped.pid !== undefined);
			assert.deepStrictEqual({
				normal: normalResult,
				stopped: stoppedResult,
				groupAlive: paradisIsProcessGroupAlive(stopped.pid),
			}, {
				normal: { stdout: 'hello\n', timedOut: false },
				stopped: { stdout: '', timedOut: false },
				groupAlive: false,
			});
		} finally {
			for (const pid of [normal.pid, stopped.pid]) {
				if (pid !== undefined) {
					try {
						process.kill(-pid, 'SIGKILL');
					} catch {
						// もう居ない
					}
				}
			}
		}
	});

	test('forgets a statfs result that failed instead of repeating the old value', async () => {
		let fail = false;
		const disk = new ParadisDiskUsageReader('/', async () => {
			if (fail) {
				throw new Error('volume went away');
			}
			return { bsize: 100, blocks: 10, bfree: 4, bavail: 2 };
		}, 1_000);
		const before = await disk.readUsage();
		fail = true;
		const afterFailure = await disk.readUsage();
		fail = false;
		const recovered = await disk.readUsage();
		assert.deepStrictEqual({ before, afterFailure, recovered }, {
			before: { diskUsed: 600, diskTotal: 800 },
			afterFailure: {},
			recovered: { diskUsed: 600, diskTotal: 800 },
		});
	});

	test('treats EPERM on a recorded process group as gone', () => {
		const throwing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
		assert.deepStrictEqual([
			paradisIsRecordedProcessGroupAlive(123, () => true),
			paradisIsRecordedProcessGroupAlive(123, throwing('EPERM')),
			paradisIsRecordedProcessGroupAlive(123, throwing('ESRCH')),
		], [true, false, false]);
	});

	test('keeps showing memory, logs once and retries at most one more run when a killed group will not go away', async () => {
		let now = 0;
		const alive = new Set<number>();
		const killed: number[] = [];
		const errors: string[] = [];
		const started: number[] = [];
		let nextPid = 100;
		const reader = new ParadisDarwinSystemUsageReader({
			now: () => now,
			memory: () => ({ total: 1000, free: 250 }),
			diskReader: new ParadisDiskUsageReader('/', async () => ({ bsize: 1, blocks: 1, bfree: 0, bavail: 0 })),
			isRecordedGroupAlive: pgid => alive.has(pgid),
			killGroup: pgid => killed.push(pgid),
			onError: error => errors.push(error instanceof Error ? error.message : String(error)),
			runShell: (): IParadisShellRun => {
				const pid = nextPid++;
				started.push(pid);
				// SIGKILL でも消えない（D 状態）グループを装う
				alive.add(pid);
				return { pid, result: Promise.resolve({ stdout: '', timedOut: true }), kill: () => { } };
			},
		});
		const memUsed: (number | undefined)[] = [];
		const step = async (advanceMs: number) => {
			now += advanceMs;
			memUsed.push((await reader.read(now)).memUsed);
		};
		await step(0);           // 1 本目が止まる
		await step(5_000);       // 止まっているので起こさない（ログは 1 回）
		await step(5_000);
		await step(5 * 60_000);  // 5 分を超えた: もう 1 本だけ起こす（それも止まる）
		await step(10 * 60_000); // 上限の 2 本が残っているので、もう起こさない
		const stalledStarts = [...started];
		const stalledErrors = errors.length;
		alive.clear();           // グループが消えた
		await step(5_000);
		assert.deepStrictEqual({
			stalledStarts,
			stalledErrors,
			killedSomething: killed.length > 0,
			startsAfterRecovery: started.length,
			// スクリプトが動かない回も、RAM は total - free で出し続ける
			memUsed,
		}, {
			stalledStarts: [100, 101],
			stalledErrors: 1,
			killedSomething: true,
			startsAfterRecovery: 3,
			memUsed: [750, 750, 750, 750, 750, 750],
		});
	});
});
