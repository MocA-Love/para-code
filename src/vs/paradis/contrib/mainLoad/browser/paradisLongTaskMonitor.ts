/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 区間内の renderer の長いタスク（50ms 以上、Chromium の定義）の要約。 */
export interface IParadisLongTaskSummary {
	readonly count: number;
	readonly totalMs: number;
	readonly maxMs: number;
}

/** `PerformanceObserver` のうち使う面。テストでは偽物を渡す。 */
export interface IParadisLongTaskObserver {
	observe(options: { readonly type: string; readonly buffered?: boolean }): void;
	takeRecords(): readonly { readonly duration: number }[];
	disconnect(): void;
}

export type ParadisLongTaskObserverFactory = (onEntries: (entries: readonly { readonly duration: number }[]) => void) => IParadisLongTaskObserver | undefined;

function defaultObserverFactory(onEntries: (entries: readonly { readonly duration: number }[]) => void): IParadisLongTaskObserver | undefined {
	if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
		return undefined;
	}
	return new PerformanceObserver(list => onEntries(list.getEntries()));
}

/** `paradisStartLongTaskWindow` の戻り値。`stop()` は 1 回だけ意味を持つ。 */
export interface IParadisLongTaskWindow {
	stop(): IParadisLongTaskSummary | undefined;
}

/**
 * 区間 (スペースの切り替えなど) の間だけ renderer の長いタスクを数える (M3)。常時は監視しない。
 * 長いタスクを観測できない環境 (古い Chromium・テスト環境) では `stop()` が undefined を返す。
 *
 * `stop()` で `takeRecords()` を呼んで、まだ配られていない分も取り込んでから要約する
 * (`PerformanceObserver` の配送は非同期なので、呼ばないと区間の最後の長いタスクを落とす)。
 */
export function paradisStartLongTaskWindow(createObserver: ParadisLongTaskObserverFactory = defaultObserverFactory): IParadisLongTaskWindow {
	let count = 0;
	let totalMs = 0;
	let maxMs = 0;
	const add = (entries: readonly { readonly duration: number }[]) => {
		for (const entry of entries) {
			count++;
			totalMs += entry.duration;
			maxMs = Math.max(maxMs, entry.duration);
		}
	};
	let observer: IParadisLongTaskObserver | undefined;
	try {
		observer = createObserver(add);
		observer?.observe({ type: 'longtask' });
	} catch {
		observer = undefined;
	}
	let stopped = false;
	return {
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
			return { count, totalMs: Math.round(totalMs), maxMs: Math.round(maxMs) };
		},
	};
}
