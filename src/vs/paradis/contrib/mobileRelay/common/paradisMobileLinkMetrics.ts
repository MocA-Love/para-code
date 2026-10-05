/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC ⇄ モバイルの通信の計測（設計書 5 章の F0「測るもの」）。挙動は変えず、区間ごとの時間・大きさ・件数だけを集める。
//
// - 値は名前ごとのヒストグラム（2 の冪を 8 つに割った対数の桶。相対誤差は約 9%）と件数だけを持つ。本文・パス・識別子は持たない
// - 既定はオフ。オフの間の observe / count は真偽値を 1 回見て戻るだけ
// - 同じ形の生の値（raw）を足し合わせられる。PC の renderer が数えた分を shared process へ送って 1 つにまとめる
// - 端末の間で時計を引き算しない。区間は同じプロセスの中の時計で測る（往復時間はアプリが自分の時計で測る）
//
// **このファイルは import を持たない。** モバイルアプリ（`app/mobile`）が相対パスで直接 import し、PC と同じ集計を使う。

/** 書き出す JSON の形の版。 */
export const PARADIS_MOBILE_LINK_METRICS_FORMAT = 1;

/** 2 の冪 1 つを割る桶の数。 */
const SUB_BUCKETS = 8;
/** 桶で区別するいちばん小さい値（2^-10 ≒ 0.001）。これより小さい正の値は最初の桶に入れる。 */
const MIN_EXPONENT = -10;
/** 桶で区別するいちばん大きい値（2^40）。 */
const MAX_EXPONENT = 40;
const MAX_BUCKET = (MAX_EXPONENT - MIN_EXPONENT) * SUB_BUCKETS;
/** 名前の数の上限（増え続ける名前で記憶が膨らまないように）。 */
export const PARADIS_MOBILE_LINK_METRICS_MAX_SERIES = 256;
const MAX_NAME_LENGTH = 96;
const NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/;
/** 計測そのものの時間は、この回数に 1 回だけ測る。 */
const SELF_COST_SAMPLE_EVERY = 256;

/** 値を入れる桶の番号。0 は 0 以下（と数でない値）。 */
export function paradisLinkMetricsBucketOf(value: number): number {
	if (!(value > 0)) {
		return 0;
	}
	const index = Math.floor((Math.log2(value) - MIN_EXPONENT) * SUB_BUCKETS) + 1;
	return Math.min(MAX_BUCKET, Math.max(1, index));
}

/** 桶の代表値（上下の境の幾何平均）。 */
export function paradisLinkMetricsBucketValue(bucket: number): number {
	if (bucket <= 0) {
		return 0;
	}
	return Math.pow(2, (bucket - 0.5) / SUB_BUCKETS + MIN_EXPONENT);
}

/** 1 つの名前の生の値（足し合わせられる形）。`buckets` は桶の番号 → 件数。 */
export interface IParadisMobileLinkHistogramRaw {
	readonly count: number;
	readonly sum: number;
	readonly min: number;
	readonly max: number;
	readonly buckets: Readonly<Record<string, number>>;
}

export interface IParadisMobileLinkMetricsRaw {
	readonly histograms: Readonly<Record<string, IParadisMobileLinkHistogramRaw>>;
	readonly counters: Readonly<Record<string, number>>;
}

/** 書き出す要約（1 つの名前）。値の単位は名前の末尾（`Ms` / `Bytes` など）で表す。 */
export interface IParadisMobileLinkHistogramSummary {
	readonly count: number;
	readonly min: number;
	readonly max: number;
	readonly mean: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
}

/** 計測そのものの負荷。 */
export interface IParadisMobileLinkMetricsSelfCost {
	readonly observations: number;
	/** observe 1 回の平均（マイクロ秒。{@link SELF_COST_SAMPLE_EVERY} 回に 1 回だけ測った値）。測れていなければ undefined。 */
	readonly observeMicros?: number;
	/** ヒストグラムが使う記憶のおおよその量（バイト）。 */
	readonly approxBytes: number;
	/** 上限を超えて捨てた名前の数。 */
	readonly droppedSeries: number;
}

export interface IParadisMobileLinkMetricsSnapshot {
	readonly format: number;
	readonly enabled: boolean;
	/** 計測を始めた時刻（ms、epoch）。始めていなければ undefined。 */
	readonly startedAt?: number;
	readonly durationMs: number;
	readonly histograms: Readonly<Record<string, IParadisMobileLinkHistogramSummary>>;
	readonly counters: Readonly<Record<string, number>>;
	readonly selfCost: IParadisMobileLinkMetricsSelfCost;
	/** 後で別の計測と比べられるように、桶の生の値も残す。 */
	readonly raw: IParadisMobileLinkMetricsRaw;
}

interface MutableHistogram {
	count: number;
	sum: number;
	min: number;
	max: number;
	readonly buckets: Map<number, number>;
}

function emptyHistogram(): MutableHistogram {
	return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, buckets: new Map() };
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** 分位点（0〜1）。桶の代表値を、実際の最小・最大の間に収めて返す。 */
export function paradisLinkMetricsQuantile(histogram: IParadisMobileLinkHistogramRaw, quantile: number): number {
	if (histogram.count <= 0) {
		return 0;
	}
	const rank = Math.max(1, Math.ceil(quantile * histogram.count));
	const buckets = Object.keys(histogram.buckets).map(Number).sort((a, b) => a - b);
	let seen = 0;
	for (const bucket of buckets) {
		seen += histogram.buckets[String(bucket)] ?? 0;
		if (seen >= rank) {
			return Math.min(histogram.max, Math.max(histogram.min, paradisLinkMetricsBucketValue(bucket)));
		}
	}
	return histogram.max;
}

/** 生の値を書き出す要約にする。 */
export function paradisSummarizeLinkHistogram(histogram: IParadisMobileLinkHistogramRaw): IParadisMobileLinkHistogramSummary {
	return {
		count: histogram.count,
		min: round3(histogram.count > 0 ? histogram.min : 0),
		max: round3(histogram.max),
		mean: round3(histogram.count > 0 ? histogram.sum / histogram.count : 0),
		p50: round3(paradisLinkMetricsQuantile(histogram, 0.5)),
		p95: round3(paradisLinkMetricsQuantile(histogram, 0.95)),
		p99: round3(paradisLinkMetricsQuantile(histogram, 0.99)),
	};
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 名前として受け入れるか（ドット区切りの英数字。本文や識別子を名前に混ぜない）。 */
export function paradisIsLinkMetricName(name: unknown): name is string {
	return typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

/** 区間・大きさ・件数の集計。 */
export class ParadisMobileLinkMetrics {
	private on = false;
	private startedAt: number | undefined;
	private startedMonotonic = 0;
	private stoppedMonotonic: number | undefined;
	private histograms = new Map<string, MutableHistogram>();
	private counters = new Map<string, number>();
	private observations = 0;
	private sampledMicros = 0;
	private samples = 0;
	private droppedSeries = 0;

	constructor(
		private readonly wallClock: () => number = Date.now,
		private readonly monotonic: () => number = Date.now,
	) { }

	get enabled(): boolean {
		return this.on;
	}

	/** 計測を始める・やめる。始めるたびに前の値は捨てる。やめても集めた値は書き出せる。 */
	setEnabled(enabled: boolean): void {
		if (enabled === this.on) {
			return;
		}
		this.on = enabled;
		if (enabled) {
			this.reset();
			this.startedAt = this.wallClock();
			this.startedMonotonic = this.monotonic();
			this.stoppedMonotonic = undefined;
		} else {
			this.stoppedMonotonic = this.monotonic();
		}
	}

	/** 集めた値を捨てる（オン・オフは変えない）。 */
	reset(): void {
		this.histograms = new Map();
		this.counters = new Map();
		this.observations = 0;
		this.sampledMicros = 0;
		this.samples = 0;
		this.droppedSeries = 0;
	}

	/** 今の時刻（区間の始まりを控えるのに使う。同じ時計で終わりを測る）。 */
	now(): number {
		return this.monotonic();
	}

	/** 値を 1 つ足す。オフ・負・数でない値は捨てる。 */
	observe(name: string, value: number): void {
		if (!this.on || !isNonNegativeFinite(value)) {
			return;
		}
		this.observations++;
		const timed = this.observations % SELF_COST_SAMPLE_EVERY === 0;
		const startedAt = timed ? this.monotonic() : 0;
		const histogram = this.seriesOf(name);
		if (histogram === undefined) {
			return;
		}
		histogram.count++;
		histogram.sum += value;
		histogram.min = Math.min(histogram.min, value);
		histogram.max = Math.max(histogram.max, value);
		const bucket = paradisLinkMetricsBucketOf(value);
		histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
		if (timed) {
			this.sampledMicros += Math.max(0, this.monotonic() - startedAt) * 1000;
			this.samples++;
		}
	}

	/** `startedAt`（{@link now} の値）からの経過を足す。 */
	observeSince(name: string, startedAt: number): void {
		if (this.on) {
			this.observe(name, this.monotonic() - startedAt);
		}
	}

	/** 件数を足す。 */
	count(name: string, delta = 1): void {
		if (!this.on || !isNonNegativeFinite(delta)) {
			return;
		}
		if (!this.counters.has(name) && !this.acceptName(name)) {
			return;
		}
		this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
	}

	/** 生の値（足し合わせられる形）。`reset` なら取り出した後に捨てる。 */
	raw(reset = false): IParadisMobileLinkMetricsRaw {
		const histograms: Record<string, IParadisMobileLinkHistogramRaw> = {};
		for (const [name, histogram] of this.histograms) {
			const buckets: Record<string, number> = {};
			for (const [bucket, count] of histogram.buckets) {
				buckets[String(bucket)] = count;
			}
			histograms[name] = { count: histogram.count, sum: histogram.sum, min: histogram.count > 0 ? histogram.min : 0, max: histogram.max, buckets };
		}
		const counters: Record<string, number> = {};
		for (const [name, value] of this.counters) {
			counters[name] = value;
		}
		if (reset) {
			this.histograms = new Map();
			this.counters = new Map();
		}
		return { histograms, counters };
	}

	/** ほかで集めた生の値を足す（PC の renderer の分）。形の合わない値は捨てる。オフなら何もしない。 */
	merge(raw: unknown): void {
		if (!this.on || raw === null || typeof raw !== 'object') {
			return;
		}
		const { histograms, counters } = raw as { histograms?: unknown; counters?: unknown };
		if (histograms !== null && typeof histograms === 'object') {
			for (const [name, value] of Object.entries(histograms as Record<string, unknown>)) {
				this.mergeHistogram(name, value);
			}
		}
		if (counters !== null && typeof counters === 'object') {
			for (const [name, value] of Object.entries(counters as Record<string, unknown>)) {
				if (isNonNegativeFinite(value)) {
					this.count(name, value);
				}
			}
		}
	}

	snapshot(): IParadisMobileLinkMetricsSnapshot {
		const raw = this.raw();
		const histograms: Record<string, IParadisMobileLinkHistogramSummary> = {};
		let approxBytes = 0;
		for (const name of Object.keys(raw.histograms).sort()) {
			const histogram = raw.histograms[name]!;
			histograms[name] = paradisSummarizeLinkHistogram(histogram);
			approxBytes += 96 + name.length * 2 + Object.keys(histogram.buckets).length * 24;
		}
		const counters: Record<string, number> = {};
		for (const name of Object.keys(raw.counters).sort()) {
			counters[name] = raw.counters[name]!;
			approxBytes += 48 + name.length * 2;
		}
		return {
			format: PARADIS_MOBILE_LINK_METRICS_FORMAT,
			enabled: this.on,
			...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
			durationMs: this.startedAt !== undefined ? Math.max(0, Math.round((this.stoppedMonotonic ?? this.monotonic()) - this.startedMonotonic)) : 0,
			histograms,
			counters,
			selfCost: {
				observations: this.observations,
				...(this.samples > 0 ? { observeMicros: round3(this.sampledMicros / this.samples) } : {}),
				approxBytes,
				droppedSeries: this.droppedSeries,
			},
			raw,
		};
	}

	private acceptName(name: string): boolean {
		if (!paradisIsLinkMetricName(name)) {
			return false;
		}
		if (this.histograms.size + this.counters.size >= PARADIS_MOBILE_LINK_METRICS_MAX_SERIES) {
			this.droppedSeries++;
			return false;
		}
		return true;
	}

	private seriesOf(name: string): MutableHistogram | undefined {
		let histogram = this.histograms.get(name);
		if (histogram === undefined) {
			if (!this.acceptName(name)) {
				return undefined;
			}
			histogram = emptyHistogram();
			this.histograms.set(name, histogram);
		}
		return histogram;
	}

	private mergeHistogram(name: string, value: unknown): void {
		if (value === null || typeof value !== 'object') {
			return;
		}
		const source = value as { count?: unknown; sum?: unknown; min?: unknown; max?: unknown; buckets?: unknown };
		if (!isNonNegativeFinite(source.count) || source.count === 0 || !isNonNegativeFinite(source.sum) || !isNonNegativeFinite(source.min) || !isNonNegativeFinite(source.max)
			|| source.buckets === null || typeof source.buckets !== 'object') {
			return;
		}
		const buckets: [number, number][] = [];
		let total = 0;
		for (const [key, count] of Object.entries(source.buckets as Record<string, unknown>)) {
			const bucket = Number(key);
			if (!Number.isInteger(bucket) || bucket < 0 || bucket > MAX_BUCKET || !isNonNegativeFinite(count) || !Number.isInteger(count)) {
				return;
			}
			buckets.push([bucket, count]);
			total += count;
		}
		if (total !== source.count) {
			return;
		}
		const histogram = this.seriesOf(name);
		if (histogram === undefined) {
			return;
		}
		histogram.count += source.count;
		histogram.sum += source.sum;
		histogram.min = Math.min(histogram.min, source.min);
		histogram.max = Math.max(histogram.max, source.max);
		for (const [bucket, count] of buckets) {
			histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + count);
		}
	}
}

/**
 * キー入力から出力（エコー）までの区間を、鍵（ターミナルなど）ごとに控える。古い印は時間で捨て、数にも上限を持つ。
 * 「入力の後に最初に来た出力」をエコーとみなす（本文を見ないので、入力と無関係な出力が先に来れば短く出る）。
 */
export class ParadisMobileEchoTracker {
	private readonly marks = new Map<string, number>();

	constructor(private readonly maxAgeMs = 3_000, private readonly maxKeys = 64) { }

	/** 入力した。既に印があれば古い方を残す（続けて打った最初の 1 文字からのエコーを測る）。 */
	mark(key: string, at: number): void {
		if (this.marks.has(key)) {
			return;
		}
		if (this.marks.size >= this.maxKeys) {
			const oldest = this.marks.keys().next().value;
			if (oldest !== undefined) {
				this.marks.delete(oldest);
			}
		}
		this.marks.set(key, at);
	}

	/** 出力が来た。印があれば経過を返して印を消す。古すぎる印は捨てて undefined。 */
	take(key: string, now: number): number | undefined {
		const at = this.marks.get(key);
		if (at === undefined) {
			return undefined;
		}
		this.marks.delete(key);
		const elapsed = now - at;
		return elapsed >= 0 && elapsed <= this.maxAgeMs ? elapsed : undefined;
	}

	/** 印を見るだけ（消さない）。 */
	peek(key: string, now: number): number | undefined {
		const at = this.marks.get(key);
		if (at === undefined) {
			return undefined;
		}
		const elapsed = now - at;
		return elapsed >= 0 && elapsed <= this.maxAgeMs ? elapsed : undefined;
	}

	clear(): void {
		this.marks.clear();
	}
}

// --- 往復時間の ping（capability `metrics.ping.v1`） ---
//
// アプリは計測している間だけ、browser チャネルで `{"t":"metrics-ping","id":n,"rttMs":前回}` を送る。PC は shared process で
// すぐ `{"t":"metrics-pong","id":n}` を返す（renderer を通さない。PC の送信の列は通るので、負荷時の待ちも往復に入る）。
// アプリは自分の時計で往復を測り、次の ping に前回の値を載せる。PC は計測中ならそれも数える。
// PC がこの capability を広告していなければ、アプリは送らない（古い PC は知らない `t` を受けない）。

const PING_PREFIX = '{"t":"metrics-ping"';
const PONG_PREFIX = '{"t":"metrics-pong"';
const MAX_PING_ID = 0x7fffffff;
const MAX_REPORTED_RTT_MS = 600_000;
const MAX_PING_BYTES = 128;

function startsWithAscii(payload: Uint8Array, prefix: string): boolean {
	if (payload.length < prefix.length) {
		return false;
	}
	for (let i = 0; i < prefix.length; i++) {
		if (payload[i] !== prefix.charCodeAt(i)) {
			return false;
		}
	}
	return true;
}

/** browser チャネルのペイロードが ping か（JSON を読む前の安い判定）。 */
export function paradisIsMetricsPingPayload(payload: Uint8Array): boolean {
	return payload.length <= MAX_PING_BYTES && startsWithAscii(payload, PING_PREFIX);
}

/** browser チャネルのペイロードが pong か。 */
export function paradisIsMetricsPongPayload(payload: Uint8Array): boolean {
	return payload.length <= MAX_PING_BYTES && startsWithAscii(payload, PONG_PREFIX);
}

export interface IParadisMobileMetricsPing {
	readonly id: number;
	/** アプリが測った直前の往復（ms）。 */
	readonly rttMs?: number;
}

function isPingId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PING_ID;
}

export function paradisEncodeMetricsPing(ping: IParadisMobileMetricsPing): string {
	return JSON.stringify({ t: 'metrics-ping', id: ping.id, ...(ping.rttMs !== undefined ? { rttMs: Math.round(ping.rttMs * 10) / 10 } : {}) });
}

export function paradisParseMetricsPing(text: string): IParadisMobileMetricsPing | undefined {
	let message: { t?: unknown; id?: unknown; rttMs?: unknown };
	try {
		message = JSON.parse(text) as typeof message;
	} catch {
		return undefined;
	}
	if (message === null || typeof message !== 'object' || message.t !== 'metrics-ping' || !isPingId(message.id)) {
		return undefined;
	}
	const rttMs = isNonNegativeFinite(message.rttMs) && message.rttMs <= MAX_REPORTED_RTT_MS ? message.rttMs : undefined;
	return { id: message.id, ...(rttMs !== undefined ? { rttMs } : {}) };
}

export function paradisEncodeMetricsPong(id: number): string {
	return JSON.stringify({ t: 'metrics-pong', id });
}

export function paradisParseMetricsPong(text: string): number | undefined {
	let message: { t?: unknown; id?: unknown };
	try {
		message = JSON.parse(text) as typeof message;
	} catch {
		return undefined;
	}
	return message !== null && typeof message === 'object' && message.t === 'metrics-pong' && isPingId(message.id) ? message.id : undefined;
}
