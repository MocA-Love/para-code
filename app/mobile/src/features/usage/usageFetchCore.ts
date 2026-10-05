// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SourceUsageValues, Timed, UsageKind, UsageSourceInfo } from './usageAggregate.js';
import type { UsageCacheRecord } from './usageCache.js';

/**
 * 使用量の取得の決まり（`usageStore.ts` の中の、テストで固定したい部分だけを純粋に切り出したもの）。
 *
 * - {@link UsageInFlight}: 同じ出どころ・同じ指標の要求を重ねない。取り直し（`bypassCache`）だけは重ねて送り、
 *   前の要求は「もう最新ではない」ものとして扱う（失敗しても注記を出さない）
 * - {@link UsageRequestLimiter}: 同時に送る要求の数を絞る（台数 × 指標ぶんを一度に PC へ投げない）
 * - {@link isFreshEnough}: 成功から間もなければ送らない
 * - {@link applyUsageResult}: 前後して届いた古い応答で新しい値を上書きしない
 * - {@link mergeLoadedRecords}: ファイルから読んだ値で、読んでいる間に取れた新しい値を上書きしない
 */

/** 同時に送る要求の数の上限。 */
export const USAGE_MAX_CONCURRENT = 4;

export class UsageRequestLimiter {
	private running = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly max: number = USAGE_MAX_CONCURRENT) { }

	/** 空きができるまで待ってから `task` を動かす。 */
	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.running >= this.max) {
			// 枠は終わった要求からそのまま渡される（`running` は渡した側が数えたまま）
			await new Promise<void>(resolve => this.waiting.push(resolve));
		} else {
			this.running++;
		}
		try {
			return await task();
		} finally {
			const next = this.waiting.shift();
			if (next !== undefined) {
				// 待っている要求があれば枠を減らさずに渡す（減らすと、その間に来た要求が割り込んで上限を超える）
				next();
			} else {
				this.running--;
			}
		}
	}

	/** いま動いている数（テスト用）。 */
	get active(): number {
		return this.running;
	}
}

export class UsageInFlight {
	private readonly jobs = new Map<string, Promise<void>>();

	/**
	 * `key` の要求を始める。同じ鍵の要求が動いていて `bypass` でなければ、それを返す（新しく送らない）。
	 * `launch` に渡す `isCurrent` は、その要求がまだ最新か（後から取り直しが始まっていないか）を返す。
	 */
	start(key: string, bypass: boolean, launch: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
		const existing = this.jobs.get(key);
		if (existing !== undefined && !bypass) {
			return existing;
		}
		let job: Promise<void> | undefined;
		const isCurrent = () => job !== undefined && this.jobs.get(key) === job;
		job = launch(isCurrent).finally(() => {
			if (isCurrent()) {
				this.jobs.delete(key);
			}
		});
		this.jobs.set(key, job);
		return job;
	}

	has(key: string): boolean {
		return this.jobs.has(key);
	}
}

/** 成功から `maxAgeMs` 以内なら送らなくてよい（`maxAgeMs` が 0 なら常に送る）。 */
export function isFreshEnough(lastSuccessAt: number | undefined, now: number, maxAgeMs: number): boolean {
	return maxAgeMs > 0 && lastSuccessAt !== undefined && now - lastSuccessAt >= 0 && now - lastSuccessAt < maxAgeMs;
}

/**
 * 取れた値を控えへ入れた新しい一覧。手元の値の方が新しければ undefined（上書きしない）。
 * 出どころの名前・接続先の名前・機械のハッシュは取れた時点のもので更新する（ハッシュは届かなければ前のものを残す）。
 */
export function applyUsageResult(
	records: Readonly<Record<string, UsageCacheRecord>>,
	source: UsageSourceInfo,
	kind: UsageKind,
	result: Timed<unknown>,
): Record<string, UsageCacheRecord> | undefined {
	const previous = records[source.key];
	const before = previous?.values[kind];
	if (before !== undefined && before.at > result.at) {
		return undefined;
	}
	const values = { ...previous?.values, [kind]: result } as SourceUsageValues;
	return {
		...records,
		[source.key]: {
			kind: source.kind,
			pcId: source.pcId,
			pcName: source.pcName,
			hostLabel: source.hostLabel,
			machineIdHash: source.machineIdHash ?? previous?.machineIdHash,
			values,
		},
	};
}

/** ファイルから読んだ控え（`loaded`）に、手元の値（`memory`）を指標ごとに新しい方で重ねる。 */
export function mergeLoadedRecords(
	memory: Readonly<Record<string, UsageCacheRecord>>,
	loaded: Readonly<Record<string, UsageCacheRecord>>,
): Record<string, UsageCacheRecord> {
	const merged: Record<string, UsageCacheRecord> = { ...loaded };
	for (const [key, record] of Object.entries(memory)) {
		const file = merged[key];
		if (file === undefined) {
			merged[key] = record;
			continue;
		}
		const values: Record<string, Timed<unknown> | undefined> = { ...file.values };
		for (const kind of ['limits', 'cost', 'rtk', 'github', 'voice'] as const) {
			const mine = record.values[kind];
			const theirs = file.values[kind];
			if (mine !== undefined && (theirs === undefined || mine.at >= theirs.at)) {
				values[kind] = mine;
			}
		}
		merged[key] = { ...record, machineIdHash: record.machineIdHash ?? file.machineIdHash, values: values as SourceUsageValues };
	}
	return merged;
}
