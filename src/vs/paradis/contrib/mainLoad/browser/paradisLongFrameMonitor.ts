/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * renderer の長いフレーム（Long Animation Frames、`long-animation-frame`）を、**何から呼ばれた処理か**で
 * 分けて数える。`paradisLongTaskMonitor.ts` の長いタスクは「塞がっていた時間」しか分からないので、
 * スペース切り替えの `verify_folder_wait` や `stat_probe_back_ms` の伸びが何で塞がっていたのかの
 * 候補を絞るために足した。
 *
 * 分け方（`invokerType` と `invoker` の型名だけを見る。スクリプトの URL や関数名は使わず、送りもしない）:
 *
 * | 区分 | 中身の候補 |
 * |---|---|
 * | `port` | `MessagePort` のメッセージ。手元の拡張ホスト・utility process との IPC |
 * | `socket` | `WebSocket` のメッセージ。SSH の接続先（接続先の拡張ホスト・ファイル・監視の通知） |
 * | `event` | それ以外のイベント（main からの IPC、DOM のイベント） |
 * | `timer` | `setTimeout` / `setInterval` / `requestIdleCallback`（スケジューラ・デバウンス） |
 * | `frame` | `requestAnimationFrame`（ツリーやリストの描き直し） |
 * | `promise` | promise の続き |
 * | `script` | それ以外のスクリプト |
 * | `layout` | スタイルとレイアウトの計算（DOM の作り直しの後の描画） |
 * | `other` | フレームのうち上のどれにも数えられなかった時間 |
 */

export const PARADIS_LONG_FRAME_BUCKETS = ['port', 'socket', 'event', 'timer', 'frame', 'promise', 'script', 'layout', 'other'] as const;
export type ParadisLongFrameBucket = typeof PARADIS_LONG_FRAME_BUCKETS[number];

/** `PerformanceLongAnimationFrameTiming` のうち使う面。 */
export interface IParadisLongFrameEntry {
	readonly startTime: number;
	readonly duration: number;
	readonly styleAndLayoutStart?: number;
	readonly scripts?: readonly {
		readonly duration: number;
		readonly invokerType?: string;
		readonly invoker?: string;
	}[];
}

export interface IParadisLongFrameSummary {
	readonly count: number;
	/** 区分ごとの ms（整数に丸める）。 */
	readonly bucketMs: Readonly<Record<ParadisLongFrameBucket, number>>;
}

export interface IParadisLongFrameObserver {
	observe(options: { readonly type: string; readonly buffered?: boolean }): void;
	takeRecords(): readonly IParadisLongFrameEntry[];
	disconnect(): void;
}

export type ParadisLongFrameObserverFactory = (onEntries: (entries: readonly IParadisLongFrameEntry[]) => void) => IParadisLongFrameObserver | undefined;

function defaultObserverFactory(onEntries: (entries: readonly IParadisLongFrameEntry[]) => void): IParadisLongFrameObserver | undefined {
	if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
		return undefined;
	}
	const observer = new PerformanceObserver(list => onEntries(list.getEntries() as readonly PerformanceEntry[] as readonly IParadisLongFrameEntry[]));
	return {
		observe: options => observer.observe(options),
		takeRecords: () => observer.takeRecords() as readonly PerformanceEntry[] as readonly IParadisLongFrameEntry[],
		disconnect: () => observer.disconnect(),
	};
}

/** スクリプト 1 つの区分。 */
export function paradisClassifyLongFrameScript(invokerType: string | undefined, invoker: string | undefined): ParadisLongFrameBucket {
	const name = invoker ?? '';
	switch (invokerType) {
		case 'event-listener':
			if (name.startsWith('MessagePort.')) {
				return 'port';
			}
			if (name.startsWith('WebSocket.')) {
				return 'socket';
			}
			return 'event';
		case 'user-callback':
			if (name.includes('requestAnimationFrame')) {
				return 'frame';
			}
			if (name.includes('setTimeout') || name.includes('setInterval') || name.includes('requestIdleCallback')) {
				return 'timer';
			}
			return 'script';
		case 'resolve-promise':
		case 'reject-promise':
			return 'promise';
		default:
			return 'script';
	}
}

function emptyBuckets(): Record<ParadisLongFrameBucket, number> {
	return { port: 0, socket: 0, event: 0, timer: 0, frame: 0, promise: 0, script: 0, layout: 0, other: 0 };
}

export interface IParadisLongFrameWindow {
	/** 始まりから今までの累計。止めずに返す。観測できない環境と `stop()` の後は undefined。 */
	snapshot(): IParadisLongFrameSummary | undefined;
	stop(): IParadisLongFrameSummary | undefined;
}

/**
 * 区間の間だけ長いフレームを数える。観測できない環境（古い Chromium・テスト）では undefined を返す。
 * フレームは**終わった時点で**数える（区間の境目を跨いだフレームは後ろの段階に載る）。
 */
export function paradisStartLongFrameWindow(createObserver: ParadisLongFrameObserverFactory = defaultObserverFactory): IParadisLongFrameWindow {
	let count = 0;
	const buckets = emptyBuckets();
	const add = (entries: readonly IParadisLongFrameEntry[]) => {
		for (const entry of entries) {
			count++;
			const end = entry.startTime + entry.duration;
			let accounted = 0;
			for (const script of entry.scripts ?? []) {
				const ms = Math.max(0, script.duration);
				buckets[paradisClassifyLongFrameScript(script.invokerType, script.invoker)] += ms;
				accounted += ms;
			}
			if (entry.styleAndLayoutStart !== undefined && entry.styleAndLayoutStart > 0 && entry.styleAndLayoutStart < end) {
				const layout = end - entry.styleAndLayoutStart;
				buckets.layout += layout;
				accounted += layout;
			}
			buckets.other += Math.max(0, entry.duration - accounted);
		}
	};
	let observer: IParadisLongFrameObserver | undefined;
	try {
		observer = createObserver(add);
		observer?.observe({ type: 'long-animation-frame' });
	} catch {
		observer = undefined;
	}
	let stopped = false;
	const summarize = (): IParadisLongFrameSummary => {
		const bucketMs = emptyBuckets();
		for (const bucket of PARADIS_LONG_FRAME_BUCKETS) {
			bucketMs[bucket] = Math.round(buckets[bucket]);
		}
		return { count, bucketMs };
	};
	return {
		snapshot: () => {
			if (stopped || observer === undefined) {
				return undefined;
			}
			try {
				add(observer.takeRecords());
			} catch {
				// 取れなかった分を数えないだけ。
			}
			return summarize();
		},
		stop: () => {
			if (stopped || observer === undefined) {
				stopped = true;
				return undefined;
			}
			stopped = true;
			try {
				add(observer.takeRecords());
			} finally {
				observer.disconnect();
			}
			return summarize();
		},
	};
}

/** 2 つの累計の差（段階の分）。どちらかが無ければ undefined。 */
export function paradisDiffLongFrames(before: IParadisLongFrameSummary | undefined, after: IParadisLongFrameSummary | undefined): IParadisLongFrameSummary | undefined {
	if (before === undefined || after === undefined) {
		return undefined;
	}
	const bucketMs = emptyBuckets();
	for (const bucket of PARADIS_LONG_FRAME_BUCKETS) {
		bucketMs[bucket] = Math.max(0, after.bucketMs[bucket] - before.bucketMs[bucket]);
	}
	return { count: Math.max(0, after.count - before.count), bucketMs };
}

/**
 * 送る形にする。キーは `<prefix>busy_<区分>_ms` と `<prefix>busy_frames`。0 の区分は送らない
 * （区分が多いので、Discover の列を埋めないため）。観測できなかった回はキーごと無い。
 */
export function paradisLongFrameAttributes(prefix: string, summary: IParadisLongFrameSummary | undefined): Record<string, number> {
	if (summary === undefined) {
		return {};
	}
	const out: Record<string, number> = { [`${prefix}busy_frames`]: summary.count };
	for (const bucket of PARADIS_LONG_FRAME_BUCKETS) {
		if (summary.bucketMs[bucket] > 0) {
			out[`${prefix}busy_${bucket}_ms`] = summary.bucketMs[bucket];
		}
	}
	return out;
}
