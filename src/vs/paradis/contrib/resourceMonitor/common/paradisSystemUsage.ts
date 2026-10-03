/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率の時系列（マシン全体の CPU・メモリ・ディスク・ディスク I/O・帯域・スワップ）の共有定義。
//
// 測る側（手元は shared process、接続先は REH サーバー）が 5 秒ごとに測り、2 段の輪バッファ
// （5 秒刻み 720 点＝1 時間、1 分刻み 1440 点＝24 時間）へ常に貯める。画面（PC のパネル・エディタ、
// モバイルの「システム」）は開いたときに履歴をまとめて取り、以後は `since` を付けて差分だけを取る。
//
// このファイルは node にも DOM にも依存しない（REH・shared process・renderer のどこからでも読む）。
// モバイルアプリには同じ形の定義が `app/mobile/src/systemUsageHistory.ts` にある。形を変えるときは両方を直す。

/** shared process（手元のマシン）の履歴のチャネル。接続先は既存の `paradisHostResources` チャネルの同名コマンドで答える。 */
export const PARADIS_SYSTEM_USAGE_CHANNEL = 'paradisSystemUsage';
/**
 * 履歴を返すコマンド。shared process の {@link PARADIS_SYSTEM_USAGE_CHANNEL} と、REH の `paradisHostResources`
 * チャネルの両方にある。この版より古い REH は `Method not found` で失敗する（そのときは今の値だけを出す）。
 */
export const PARADIS_SYSTEM_USAGE_COMMAND = 'getSystemUsage';

/** 応答の形の版。形を壊す変更をしたら上げる（受け手は知らない版を「取得できない」として扱う）。 */
export const PARADIS_SYSTEM_USAGE_VERSION = 1;

/** 細かい段の刻みと点数（1 時間）。 */
export const PARADIS_SYSTEM_USAGE_FINE_STEP_MS = 5_000;
export const PARADIS_SYSTEM_USAGE_FINE_CAPACITY = 720;
/** 粗い段の刻みと点数（24 時間）。細かい段の 1 分ぶんの平均。 */
export const PARADIS_SYSTEM_USAGE_COARSE_STEP_MS = 60_000;
export const PARADIS_SYSTEM_USAGE_COARSE_CAPACITY = 1_440;

export type ParadisSystemUsageTier = 'fine' | 'coarse';
export type ParadisSystemUsageRange = '5m' | '1h' | '24h';

/** グラフにする 6 項目。`unsupported` で「取得できません」を伝える単位でもある。 */
export type ParadisSystemUsageMetric = 'cpu' | 'memory' | 'disk' | 'diskIo' | 'network' | 'swap';

export const PARADIS_SYSTEM_USAGE_METRICS: readonly ParadisSystemUsageMetric[] = ['cpu', 'memory', 'disk', 'diskIo', 'network', 'swap'];

/**
 * 1 点ぶんの値。取れなかった項目は省く（1 点目の速度のように、前回が無いと出せないものもある）。
 */
export interface IParadisSystemUsageSample {
	/** 測った時刻(ms)。粗い段では、その 1 分の始まり。 */
	readonly t: number;
	/** CPU 使用率（0〜100、全コアの平均。Linux では iowait を待ち、steal を使用中として数える）。 */
	readonly cpu?: number;
	/** メモリ使用率（0〜100。Linux は MemTotal - MemAvailable、macOS は active + wired + compressed）。 */
	readonly mem?: number;
	/** ディスク使用率（0〜100。Linux は `/`、macOS は `/System/Volumes/Data`）。 */
	readonly disk?: number;
	/** ディスクの読み・書き(B/s)。 */
	readonly diskRead?: number;
	readonly diskWrite?: number;
	/** 受信・送信(B/s)。ループバックや仮想インターフェースは除く。 */
	readonly netRx?: number;
	readonly netTx?: number;
	/** スワップ使用量(バイト)。 */
	readonly swapUsed?: number;
}

/** 1 点の数値項目の名前（`t` 以外）。 */
export type ParadisSystemUsageField = Exclude<keyof IParadisSystemUsageSample, 't'>;

export const PARADIS_SYSTEM_USAGE_FIELDS: readonly ParadisSystemUsageField[] = ['cpu', 'mem', 'disk', 'diskRead', 'diskWrite', 'netRx', 'netTx', 'swapUsed'];

/** 列ごとに並べた点列（JSON にしたときに鍵名を点の数だけ繰り返さない）。取れなかった値は null。 */
export interface IParadisSystemUsageSeries {
	readonly t: readonly number[];
	readonly cpu: readonly (number | null)[];
	readonly mem: readonly (number | null)[];
	readonly disk: readonly (number | null)[];
	readonly diskRead: readonly (number | null)[];
	readonly diskWrite: readonly (number | null)[];
	readonly netRx: readonly (number | null)[];
	readonly netTx: readonly (number | null)[];
	readonly swapUsed: readonly (number | null)[];
}

export interface IParadisSystemUsageRequest {
	readonly tier: ParadisSystemUsageTier;
	/** これより後の点だけを返す（差分の取得）。省略時はその段の全点。 */
	readonly since?: number;
	/** 前回の応答の `instanceId`。違えば（測る側が再起動した）`since` を無視して全点を返す。 */
	readonly instanceId?: string;
	/** 返す点の上限。超える分は間引く（画面の幅より細かい点を送らない）。 */
	readonly maxPoints?: number;
}

/** 測っているマシンの情報。点ごとには変わらない値。 */
export interface IParadisSystemUsageMachine {
	/** `process.platform`。 */
	readonly os: string;
	readonly hostname: string;
	readonly cores: number;
	/** 物理メモリの総量(バイト)。 */
	readonly memTotal: number;
	/** ディスク使用率を測っているボリュームのパスと総量。 */
	readonly diskPath?: string;
	readonly diskTotal?: number;
	/** スワップの総量(バイト)。macOS では必要に応じて増える。 */
	readonly swapTotal?: number;
}

export interface IParadisSystemUsageResponse {
	readonly version: number;
	/** 測る側の起動ごとに変わる印。変わったら受け手は手元の点を捨てる。 */
	readonly instanceId: string;
	readonly machine: IParadisSystemUsageMachine;
	readonly tier: ParadisSystemUsageTier;
	readonly stepMs: number;
	/** true なら `since` を無視して全点を返した（受け手は置き換える）。 */
	readonly reset: boolean;
	/** この OS では取れない項目。 */
	readonly unsupported: readonly ParadisSystemUsageMetric[];
	readonly series: IParadisSystemUsageSeries;
	/** 細かい段の最新の 1 点（粗い段を聞かれたときも、今の値を出すために付ける）。 */
	readonly latest?: IParadisSystemUsageSample;
}

/** 時間の幅を、使う段と見せる長さに直す。 */
export function paradisSystemUsageRangeSpec(range: ParadisSystemUsageRange): { readonly tier: ParadisSystemUsageTier; readonly windowMs: number; readonly stepMs: number } {
	switch (range) {
		case '5m': return { tier: 'fine', windowMs: 5 * 60_000, stepMs: PARADIS_SYSTEM_USAGE_FINE_STEP_MS };
		case '1h': return { tier: 'fine', windowMs: 60 * 60_000, stepMs: PARADIS_SYSTEM_USAGE_FINE_STEP_MS };
		case '24h': return { tier: 'coarse', windowMs: 24 * 60 * 60_000, stepMs: PARADIS_SYSTEM_USAGE_COARSE_STEP_MS };
	}
}

export function paradisSystemUsageTierCapacity(tier: ParadisSystemUsageTier): number {
	return tier === 'fine' ? PARADIS_SYSTEM_USAGE_FINE_CAPACITY : PARADIS_SYSTEM_USAGE_COARSE_CAPACITY;
}

/**
 * 固定長の輪バッファ。古い点から上書きする。点は時刻順に積まれる前提（測る側が自分で積むので保たれる）。
 */
export class ParadisRingBuffer<T> {

	private readonly items: (T | undefined)[];
	private start = 0;
	private count = 0;

	constructor(readonly capacity: number) {
		this.items = new Array<T | undefined>(Math.max(1, capacity));
	}

	get size(): number {
		return this.count;
	}

	push(item: T): void {
		const capacity = this.items.length;
		if (this.count < capacity) {
			this.items[(this.start + this.count) % capacity] = item;
			this.count++;
			return;
		}
		this.items[this.start] = item;
		this.start = (this.start + 1) % capacity;
	}

	/** 古い順の配列。 */
	toArray(): T[] {
		const result: T[] = [];
		for (let i = 0; i < this.count; i++) {
			result.push(this.items[(this.start + i) % this.items.length] as T);
		}
		return result;
	}

	last(): T | undefined {
		return this.count === 0 ? undefined : this.items[(this.start + this.count - 1) % this.items.length];
	}

	clear(): void {
		this.items.fill(undefined);
		this.start = 0;
		this.count = 0;
	}
}

/** 小数を 1 桁に丸める（% の値。JSON を短くする）。 */
function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * 点の並びを平均で丸める。値が無い点は数えない（全部無ければその項目は無し）。
 * % の項目は 1 桁、それ以外は整数に丸める。
 */
export function paradisAverageSamples(samples: readonly IParadisSystemUsageSample[], t: number): IParadisSystemUsageSample {
	const result: { -readonly [K in keyof IParadisSystemUsageSample]: IParadisSystemUsageSample[K] } = { t };
	for (const field of PARADIS_SYSTEM_USAGE_FIELDS) {
		let sum = 0;
		let n = 0;
		for (const sample of samples) {
			const value = sample[field];
			if (typeof value === 'number' && Number.isFinite(value)) {
				sum += value;
				n++;
			}
		}
		if (n > 0) {
			const average = sum / n;
			result[field] = field === 'cpu' || field === 'mem' || field === 'disk' ? roundPercent(average) : Math.round(average);
		}
	}
	return result;
}

/**
 * 点の数を `maxPoints` 以下に間引く。等しい数ずつの組に分けて平均する。
 * 組の時刻は組の末尾の点の時刻にする。こうすると最後の組の時刻が実際の最新の点の時刻と一致し、
 * 受け手がそれを次の `since` に使っても、同じ点を二重に数えたり取りこぼしたりしない（線の右端も今に揃う）。
 */
export function paradisDownsampleSamples(samples: readonly IParadisSystemUsageSample[], maxPoints: number): IParadisSystemUsageSample[] {
	const limit = Math.max(1, Math.floor(maxPoints));
	if (samples.length <= limit) {
		return [...samples];
	}
	const bucket = Math.ceil(samples.length / limit);
	const result: IParadisSystemUsageSample[] = [];
	// 右端（最新）から組を作る。左端の半端な組が欠けても、最新の点の組は常に揃う。
	const groups: IParadisSystemUsageSample[][] = [];
	for (let end = samples.length; end > 0; end -= bucket) {
		groups.unshift(samples.slice(Math.max(0, end - bucket), end));
	}
	for (const group of groups) {
		result.push(paradisAverageSamples(group, group[group.length - 1].t));
	}
	return result;
}

/** 点の並びを列ごとの形にする。 */
export function paradisEncodeSystemUsageSeries(samples: readonly IParadisSystemUsageSample[]): IParadisSystemUsageSeries {
	const column = (field: ParadisSystemUsageField) => samples.map(sample => {
		const value = sample[field];
		return typeof value === 'number' && Number.isFinite(value) ? value : null;
	});
	return {
		t: samples.map(sample => sample.t),
		cpu: column('cpu'),
		mem: column('mem'),
		disk: column('disk'),
		diskRead: column('diskRead'),
		diskWrite: column('diskWrite'),
		netRx: column('netRx'),
		netTx: column('netTx'),
		swapUsed: column('swapUsed'),
	};
}

/**
 * 列ごとの形を点の並びに戻す。相手は信用しない前提で、形の崩れた値は捨てる（時刻が数でない点は落とす）。
 */
export function paradisDecodeSystemUsageSeries(series: unknown): IParadisSystemUsageSample[] {
	if (typeof series !== 'object' || series === null) {
		return [];
	}
	const record = series as Record<string, unknown>;
	const times = Array.isArray(record.t) ? record.t : [];
	const columns = new Map<ParadisSystemUsageField, readonly unknown[]>();
	for (const field of PARADIS_SYSTEM_USAGE_FIELDS) {
		const column = record[field];
		columns.set(field, Array.isArray(column) ? column : []);
	}
	const result: IParadisSystemUsageSample[] = [];
	for (let i = 0; i < times.length; i++) {
		const t = times[i];
		if (typeof t !== 'number' || !Number.isFinite(t)) {
			continue;
		}
		const sample: { -readonly [K in keyof IParadisSystemUsageSample]: IParadisSystemUsageSample[K] } = { t };
		for (const field of PARADIS_SYSTEM_USAGE_FIELDS) {
			const value = columns.get(field)?.[i];
			if (typeof value === 'number' && Number.isFinite(value)) {
				sample[field] = value;
			}
		}
		result.push(sample);
	}
	return result;
}

/**
 * 受け手の手元の点へ、届いた点を足す。`reset` なら置き換える。時刻が既にある点以前のものは捨て、
 * `capacity` を超えた古い点を落とす。
 */
export function paradisMergeSystemUsageSamples(existing: readonly IParadisSystemUsageSample[], incoming: readonly IParadisSystemUsageSample[], reset: boolean, capacity: number): IParadisSystemUsageSample[] {
	const base = reset ? [] : [...existing];
	let lastT = base.length > 0 ? base[base.length - 1].t : -Infinity;
	for (const sample of incoming) {
		if (sample.t > lastT) {
			base.push(sample);
			lastT = sample.t;
		}
	}
	return base.length > capacity ? base.slice(base.length - capacity) : base;
}

/**
 * 測る側が持つ 2 段の履歴。細かい段へ 1 点ずつ積み、1 分が変わるたびに直前の 1 分の平均を粗い段へ積む。
 */
export class ParadisSystemUsageHistory {

	readonly fine = new ParadisRingBuffer<IParadisSystemUsageSample>(PARADIS_SYSTEM_USAGE_FINE_CAPACITY);
	readonly coarse = new ParadisRingBuffer<IParadisSystemUsageSample>(PARADIS_SYSTEM_USAGE_COARSE_CAPACITY);

	/** 集計中の 1 分（その分の始まりの時刻と、そこまでの点）。 */
	private pendingMinute: number | undefined;
	private pendingSamples: IParadisSystemUsageSample[] = [];

	push(sample: IParadisSystemUsageSample): void {
		const last = this.fine.last();
		if (last !== undefined && sample.t <= last.t) {
			// 時計が戻った（手で合わせた等）。順序が崩れると差分の取得が壊れるので積まない。
			return;
		}
		this.fine.push(sample);
		const minute = Math.floor(sample.t / PARADIS_SYSTEM_USAGE_COARSE_STEP_MS) * PARADIS_SYSTEM_USAGE_COARSE_STEP_MS;
		if (this.pendingMinute !== undefined && minute !== this.pendingMinute) {
			this.flushMinute();
		}
		this.pendingMinute = minute;
		this.pendingSamples.push(sample);
	}

	private flushMinute(): void {
		if (this.pendingMinute !== undefined && this.pendingSamples.length > 0) {
			this.coarse.push(paradisAverageSamples(this.pendingSamples, this.pendingMinute));
		}
		this.pendingSamples = [];
		this.pendingMinute = undefined;
	}

	/**
	 * その段の点を古い順に返す。粗い段は確定した 1 分だけ（集計中の 1 分は返さない。返すと次の差分で
	 * 同じ時刻の点が別の値で来て、受け手が置き換えを考えなければならなくなる）。今の値は応答の `latest` で出す。
	 */
	samples(tier: ParadisSystemUsageTier): IParadisSystemUsageSample[] {
		return tier === 'fine' ? this.fine.toArray() : this.coarse.toArray();
	}

	latest(): IParadisSystemUsageSample | undefined {
		return this.fine.last();
	}

	/** 全部捨てる（時計が大きく巻き戻ったとき。測る側は `instanceId` も変えて、受け手に取り直させる）。 */
	clear(): void {
		this.fine.clear();
		this.coarse.clear();
		this.pendingMinute = undefined;
		this.pendingSamples = [];
	}
}

/**
 * 履歴から 1 回の応答の点を選ぶ。`since` より後の点だけにし、`maxPoints` で間引く。
 * `reset` は「受け手が手元の点を捨てて置き換えるべきか」。
 */
export function paradisSelectSystemUsageSamples(all: readonly IParadisSystemUsageSample[], request: IParadisSystemUsageRequest, instanceId: string): { readonly samples: IParadisSystemUsageSample[]; readonly reset: boolean } {
	const sameInstance = request.instanceId === instanceId;
	const since = sameInstance && typeof request.since === 'number' && Number.isFinite(request.since) ? request.since : undefined;
	const reset = since === undefined;
	const selected = since === undefined ? [...all] : all.filter(sample => sample.t > since);
	const maxPoints = typeof request.maxPoints === 'number' && request.maxPoints > 0 ? request.maxPoints : undefined;
	return { samples: maxPoints !== undefined ? paradisDownsampleSamples(selected, maxPoints) : selected, reset };
}

/** 届いた要求を読む（相手は信用しない。崩れた値は既定に倒す）。 */
export function paradisParseSystemUsageRequest(value: unknown): IParadisSystemUsageRequest {
	const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
	const tier: ParadisSystemUsageTier = record.tier === 'coarse' ? 'coarse' : 'fine';
	const since = typeof record.since === 'number' && Number.isFinite(record.since) ? record.since : undefined;
	const instanceId = typeof record.instanceId === 'string' && record.instanceId.length <= 64 ? record.instanceId : undefined;
	const maxPoints = typeof record.maxPoints === 'number' && Number.isFinite(record.maxPoints) && record.maxPoints >= 1
		? Math.min(paradisSystemUsageTierCapacity(tier), Math.floor(record.maxPoints))
		: undefined;
	return {
		tier,
		...(since !== undefined ? { since } : {}),
		...(instanceId !== undefined ? { instanceId } : {}),
		...(maxPoints !== undefined ? { maxPoints } : {}),
	};
}

/**
 * 時間の幅に入る点だけを返す。右端は最新の点の時刻（手元と測る側の時計のずれで、線が右に寄りきらないのを避ける）。
 */
export function paradisSystemUsageWindow(samples: readonly IParadisSystemUsageSample[], windowMs: number): { readonly samples: IParadisSystemUsageSample[]; readonly start: number; readonly end: number } {
	if (samples.length === 0) {
		return { samples: [], start: 0, end: 0 };
	}
	const end = samples[samples.length - 1].t;
	const start = end - windowMs;
	let first = samples.length;
	while (first > 0 && samples[first - 1].t >= start) {
		first--;
	}
	return { samples: samples.slice(first), start, end };
}

/** 古い REH（{@link PARADIS_SYSTEM_USAGE_COMMAND} を知らない）の失敗か。 */
export function paradisIsSystemUsageUnsupportedError(error: unknown): boolean {
	const message = error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
	return message.includes('Method not found') || message.includes('Unknown channel');
}

/** 届いた 1 点を読む（応答の `latest`。相手は信用しない）。 */
export function paradisParseSystemUsageSample(value: unknown): IParadisSystemUsageSample | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const t = record.t;
	if (typeof t !== 'number' || !Number.isFinite(t)) {
		return undefined;
	}
	const sample: { -readonly [K in keyof IParadisSystemUsageSample]: IParadisSystemUsageSample[K] } = { t };
	for (const field of PARADIS_SYSTEM_USAGE_FIELDS) {
		const fieldValue = record[field];
		if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
			sample[field] = fieldValue;
		}
	}
	return sample;
}
