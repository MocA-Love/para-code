/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスが固まったことを、別スレッドから見張る（W2-33）。
//
// main が 2 秒ごとに共有メモリへ「生きている時刻」とヒープの大きさを書き、worker が 1 秒ごとに
// 読む。10 秒途切れたら固まったとみなして印のファイルを書き、途切れている間は長さを書き足す。
// main が戻ってきたら worker が知らせて印を消す（main はその場で報告する）。戻らないまま強制
// 終了されたら印が残るので、次の起動で報告する。
//
// Sentry の既製品（`@sentry/electron/native` の `eventLoopBlockIntegration`）は配布版で動かない
// ので使わない（`NOTES.md` の Sentry 節）。worker は文字列から起動する（`eval: true`）。ファイル
// から起動すると、配布版では `node_modules.asar` の解決の仕組みが worker に引き継がれず、新しい
// ビルドの入口も要る。そのため worker の中では Node の組み込みしか使わない。
//
// スリープ中を固まったと読まないよう、2 つの手当てをする。main が OS のスリープを聞いたら見張りを
// 止める（`pause` / `resume`）。聞き逃しても、worker 自身の見回りの間隔が大きく空いたら（機械ごと
// 止まっていた）その回は数えず、猶予を取り直す。

import { Worker } from 'worker_threads';
import { promises as fs } from 'fs';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** 印のファイルの中身。数値だけで、パスや利用者の内容は持たない。 */
export interface IParadisMainHangMarker {
	readonly version: 1;
	/** 最後に main が生きていた時刻（epoch ミリ秒）。 */
	readonly lastBeatAt: number;
	/** 最後に書き足した時点で、どれだけ止まっていたか。 */
	readonly blockedMs: number;
	/** 止まる直前の main のヒープ使用量（バイト）。GC の長い停止かの目安。 */
	readonly heapUsed: number;
	readonly rss: number;
	/** 起動から止まるまでの時間。 */
	readonly uptimeMs: number;
}

/** main が戻ってきたときの知らせ。 */
export interface IParadisMainHangRecovery {
	readonly blockedMs: number;
	readonly heapUsed: number;
	readonly rss: number;
	readonly uptimeMs: number;
}

export interface IParadisMainHangWatchdogOptions {
	/** 印のファイルの置き場所。 */
	readonly markerPath: string;
	/** これだけ途切れたら固まったとみなす。 */
	readonly hangMs: number;
	/** main が生きている時刻を書く間隔。 */
	readonly heartbeatMs: number;
	/** worker が見回る間隔。 */
	readonly pollMs: number;
	/** worker 自身の見回りがこれだけ空いたら、機械ごと止まっていた（スリープ）とみなす。 */
	readonly sleepGapMs: number;
	/** 止まっている間に印を書き足す間隔。 */
	readonly markerUpdateMs: number;
	readonly onRecovered: (recovery: IParadisMainHangRecovery) => void;
	/** worker を起こせなかった・worker が落ちた。見張りが無いだけで、本体には影響しない。 */
	readonly onError?: (error: unknown) => void;
}

/** 既定の値。しきい値 10 秒・心拍 2 秒は決定事項（Q125）。スリープの判定は Orca と同じ 15 秒。 */
export const PARADIS_MAIN_HANG_DEFAULTS = {
	hangMs: 10_000,
	heartbeatMs: 2_000,
	pollMs: 1_000,
	sleepGapMs: 15_000,
	markerUpdateMs: 10_000,
} as const;

/** 共有メモリの並び。 */
const enum Slot {
	LastBeat = 0,
	HeapUsed = 1,
	Rss = 2,
	Paused = 3,
	StartedAt = 4,
	Length = 5,
}

/**
 * worker の本体。**Node の組み込みしか使わないこと**（上の説明）。`Slot` の番号はここに直書き
 * しているので、並びを変えるときは両方を直す。
 */
const WORKER_SOURCE = `
'use strict';
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const shared = new Float64Array(workerData.buffer);
const { markerPath, hangMs, pollMs, sleepGapMs, markerUpdateMs } = workerData;
let lastPoll = Date.now();
let graceUntil = 0;
let hangBeat = 0;
let lastWrite = 0;
function snapshot(blockedMs) {
	return { version: 1, lastBeatAt: hangBeat, blockedMs: Math.round(blockedMs), heapUsed: shared[1], rss: shared[2], uptimeMs: Math.max(0, Math.round(hangBeat - shared[4])) };
}
function write(blockedMs) {
	try {
		fs.writeFileSync(markerPath, JSON.stringify(snapshot(blockedMs)), { mode: 0o600 });
	} catch (e) { }
}
function clear() {
	try { fs.unlinkSync(markerPath); } catch (e) { }
}
const timer = setInterval(() => {
	const now = Date.now();
	const gap = now - lastPoll;
	lastPoll = now;
	if (gap > sleepGapMs) {
		// The whole machine was asleep (this thread too). Start over.
		graceUntil = now + hangMs;
		if (hangBeat) { hangBeat = 0; clear(); }
		return;
	}
	const lastBeat = shared[0];
	if (shared[3] === 1 || now < graceUntil) {
		if (hangBeat) { hangBeat = 0; clear(); }
		return;
	}
	const blocked = now - lastBeat;
	if (!hangBeat) {
		if (blocked >= hangMs) {
			hangBeat = lastBeat;
			lastWrite = now;
			write(blocked);
		}
		return;
	}
	if (lastBeat !== hangBeat) {
		const recovered = snapshot(lastBeat - hangBeat);
		hangBeat = 0;
		clear();
		parentPort.postMessage({ type: 'recovered', blockedMs: recovered.blockedMs, heapUsed: recovered.heapUsed, rss: recovered.rss, uptimeMs: recovered.uptimeMs });
		return;
	}
	if (now - lastWrite >= markerUpdateMs) {
		lastWrite = now;
		write(blocked);
	}
}, pollMs);
parentPort.on('message', message => {
	if (message === 'stop') {
		clearInterval(timer);
		if (hangBeat) { clear(); }
		parentPort.close();
	}
});
`;

/**
 * 見張り 1 本。`dispose` で worker・タイマーを畳む（印は worker が止まる前に消す）。
 */
export class ParadisMainHangWatchdog extends Disposable {

	private readonly shared: Float64Array;
	private readonly worker: Worker;

	constructor(options: IParadisMainHangWatchdogOptions) {
		super();
		this.shared = new Float64Array(new SharedArrayBuffer(Slot.Length * Float64Array.BYTES_PER_ELEMENT));
		const now = Date.now();
		this.shared[Slot.StartedAt] = now;
		this.beat(now);

		this.worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: {
				buffer: this.shared.buffer,
				markerPath: options.markerPath,
				hangMs: options.hangMs,
				pollMs: options.pollMs,
				sleepGapMs: options.sleepGapMs,
				markerUpdateMs: options.markerUpdateMs,
			},
			// 起動時のフラグ（--inspect 等）を worker へ持ち込まない。
			execArgv: [],
		});
		// 見張りのためにプロセスを生かし続けない。
		this.worker.unref();
		this.worker.on('message', (message: { type?: string } & Partial<IParadisMainHangRecovery>) => {
			if (message?.type === 'recovered') {
				options.onRecovered({
					blockedMs: Number(message.blockedMs) || 0,
					heapUsed: Number(message.heapUsed) || 0,
					rss: Number(message.rss) || 0,
					uptimeMs: Number(message.uptimeMs) || 0,
				});
			}
		});
		this.worker.on('error', error => options.onError?.(error));

		const heartbeat = setInterval(() => this.beat(Date.now()), options.heartbeatMs);
		this._register(toDisposable(() => {
			clearInterval(heartbeat);
			this.worker.postMessage('stop');
			// 止める合図が届かなくても畳む（届けば worker が自分で閉じる）。
			setTimeout(() => void this.worker.terminate(), 1_000);
		}));
	}

	/** OS がスリープに入る。戻るまで数えない。 */
	pause(): void {
		this.shared[Slot.Paused] = 1;
	}

	/** スリープから戻った。心拍を今に合わせてから数え直す。 */
	resume(): void {
		this.beat(Date.now());
		this.shared[Slot.Paused] = 0;
	}

	private beat(now: number): void {
		const memory = process.memoryUsage();
		this.shared[Slot.HeapUsed] = memory.heapUsed;
		this.shared[Slot.Rss] = memory.rss;
		this.shared[Slot.LastBeat] = now;
	}
}

/** 前回の起動が残した印を読み、消す。無い・読めないときは undefined（読めない印も消す）。 */
export async function paradisTakeMainHangMarker(markerPath: string): Promise<IParadisMainHangMarker | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(markerPath, 'utf8');
	} catch {
		return undefined;
	}
	await fs.unlink(markerPath).catch(() => undefined);
	try {
		const parsed = JSON.parse(raw) as Partial<IParadisMainHangMarker>;
		if (parsed?.version !== 1 || typeof parsed.blockedMs !== 'number') {
			return undefined;
		}
		return {
			version: 1,
			lastBeatAt: Number(parsed.lastBeatAt) || 0,
			blockedMs: parsed.blockedMs,
			heapUsed: Number(parsed.heapUsed) || 0,
			rss: Number(parsed.rss) || 0,
			uptimeMs: Number(parsed.uptimeMs) || 0,
		};
	} catch {
		return undefined;
	}
}

/** Sentry へ載せる数値（MB・分に丸める）。`safe_` 以外は落とされる。 */
export function paradisMainHangExtra(value: IParadisMainHangRecovery | IParadisMainHangMarker): Record<`safe_${string}`, number> {
	const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
	return {
		safe_blocked_ms: Math.round(value.blockedMs),
		safe_heap_used_mb: mb(value.heapUsed),
		safe_rss_mb: mb(value.rss),
		safe_uptime_min: Math.round(value.uptimeMs / 60_000),
	};
}
