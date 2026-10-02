// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { UsageSourceInfo } from './usageAggregate.js';
import type { UsageCacheRecord } from './usageCache.js';
import { UsageInFlight, UsageRequestLimiter, applyUsageResult, isFreshEnough, mergeLoadedRecords } from './usageFetchCore.js';

const SOURCE: UsageSourceInfo = { key: 'ssh:a:srv', kind: 'ssh', pcId: 'a', pcName: 'A', hostLabel: 'srv', online: true, machineIdHash: 'm-srv' };

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function record(at: Record<string, number>, extra: Partial<UsageCacheRecord> = {}): UsageCacheRecord {
	const values: Record<string, { value: unknown; at: number }> = {};
	for (const [kind, time] of Object.entries(at)) {
		values[kind] = { value: { mark: `${kind}@${time}` }, at: time };
	}
	return { kind: 'pc', pcId: 'a', pcName: 'A', values: values as UsageCacheRecord['values'], ...extra };
}

describe('UsageInFlight', () => {
	it('同じ鍵の要求は重ねない。取り直しだけは重ね、追い越された要求は最新ではなくなる', async () => {
		const flight = new UsageInFlight();
		const first = deferred();
		const second = deferred();
		let launches = 0;
		let firstIsCurrent: (() => boolean) | undefined;
		const a = flight.start('k', false, isCurrent => { launches++; firstIsCurrent = isCurrent; return first.promise; });
		const b = flight.start('k', false, () => { launches++; return second.promise; });
		expect([a === b, launches, firstIsCurrent?.()]).toEqual([true, 1, true]);
		let secondIsCurrent: (() => boolean) | undefined;
		flight.start('k', true, isCurrent => { launches++; secondIsCurrent = isCurrent; return second.promise; });
		expect([launches, firstIsCurrent?.(), secondIsCurrent?.()]).toEqual([2, false, true]);
		first.resolve();
		await a;
		// 追い越された要求が終わっても、新しい要求は動いたまま
		expect(flight.has('k')).toBe(true);
		second.resolve();
		await second.promise;
		await Promise.resolve();
		expect(flight.has('k')).toBe(false);
	});
});

describe('UsageRequestLimiter', () => {
	it('同時に動かすのは上限の数まで', async () => {
		const limiter = new UsageRequestLimiter(2);
		const gates = [deferred(), deferred(), deferred()];
		let peak = 0;
		const runs = gates.map(gate => limiter.run(async () => {
			peak = Math.max(peak, limiter.active);
			await gate.promise;
		}));
		await Promise.resolve();
		expect(limiter.active).toBe(2);
		gates.forEach(gate => gate.resolve());
		await Promise.all(runs);
		expect([peak, limiter.active]).toEqual([2, 0]);
	});
});

describe('UsageRequestLimiter の枠の受け渡し', () => {
	it('終わった要求の枠は待っている要求へそのまま渡り、その間に来た要求は割り込まない', async () => {
		const limiter = new UsageRequestLimiter(1);
		const first = deferred();
		const order: string[] = [];
		let peak = 0;
		const track = (name: string, gate: Promise<void>) => limiter.run(async () => {
			order.push(name);
			peak = Math.max(peak, limiter.active);
			await gate;
		});
		const a = track('a', first.promise);
		const b = track('b', Promise.resolve());
		await Promise.resolve();
		first.resolve();
		await a;
		// a の枠が b へ渡った直後（b がまだ動き出す前）に来た c は待つ
		const c = track('c', Promise.resolve());
		await Promise.all([b, c]);
		expect({ order, peak, active: limiter.active }).toEqual({ order: ['a', 'b', 'c'], peak: 1, active: 0 });
	});
});

describe('isFreshEnough', () => {
	it('成功から間もなければ送らない。0 は常に送る', () => {
		expect([
			isFreshEnough(1_000, 1_500, 1_000),
			isFreshEnough(1_000, 2_000, 1_000),
			isFreshEnough(undefined, 2_000, 1_000),
			isFreshEnough(1_000, 1_500, 0),
		]).toEqual([true, false, false, false]);
	});
});

describe('applyUsageResult', () => {
	it('前後して届いた古い応答では上書きしない。新しい応答は出どころの名前と機械のハッシュも更新する', () => {
		const records = { 'ssh:a:srv': record({ cost: 200 }, { kind: 'ssh', machineIdHash: 'm-old' }) };
		expect(applyUsageResult(records, SOURCE, 'cost', { value: 'old', at: 100 })).toBeUndefined();
		const next = applyUsageResult(records, { ...SOURCE, machineIdHash: undefined }, 'cost', { value: 'new', at: 300 });
		expect([next?.['ssh:a:srv']?.values.cost, next?.['ssh:a:srv']?.machineIdHash, next?.['ssh:a:srv']?.hostLabel]).toEqual([{ value: 'new', at: 300 }, 'm-old', 'srv']);
		expect(applyUsageResult({}, SOURCE, 'limits', { value: 'x', at: 1 })?.['ssh:a:srv']?.values.limits).toEqual({ value: 'x', at: 1 });
	});
});

describe('mergeLoadedRecords', () => {
	it('ファイルの古い値で、読んでいる間に取れた新しい値を上書きしない', () => {
		const merged = mergeLoadedRecords(
			{ 'pc:a': record({ cost: 300 }), 'pc:b': record({ rtk: 1 }, { pcId: 'b' }) },
			{ 'pc:a': record({ cost: 100, limits: 50 }, { machineIdHash: 'm' }), 'pc:c': record({ github: 5 }, { pcId: 'c' }) },
		);
		expect({
			keys: Object.keys(merged).sort(),
			cost: merged['pc:a']?.values.cost?.at,
			limits: merged['pc:a']?.values.limits?.at,
			hash: merged['pc:a']?.machineIdHash,
		}).toEqual({ keys: ['pc:a', 'pc:b', 'pc:c'], cost: 300, limits: 50, hash: 'm' });
	});
});
