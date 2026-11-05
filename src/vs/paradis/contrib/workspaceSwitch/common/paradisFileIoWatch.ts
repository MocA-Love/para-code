/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * renderer が投げたファイルの IPC（手元は main の `localFilesystem`、SSH は接続先の
 * `remoteFilesystem`）の、返事待ちの数と待ち時間を常に数える。
 *
 * スペースの切り替えが遅かったときにウィンドウのログへ 1 行出すため（`paradisSlowSwitchLog.ts`）。
 * Sentry が上限で使えない回でも、「切り替えの間、接続先のファイル操作が何本詰まっていたか・
 * 1 往復がどこまで伸びたか」を手元のログで読めるようにする。
 *
 * 数えるのは `paradisFolderUpdateTrace.ts` の `paradisCountFileChannel`（チャネルの包み）。
 * 返事待ちの台帳は常に持つ（Map への出し入れだけ）。区間ごとの集計は `paradisBeginFileIoWindow` で
 * 開いている間だけ。
 *
 * **持つのは数と時間だけ**。パス・ホスト名は受け取らない（コマンド名だけを見る）。
 */

export type ParadisFileIoSide = 'remote' | 'local';

interface IInflightCall {
	readonly startedAt: number;
	readonly isDelete: boolean;
}

interface IWindowTally {
	readonly inflightAtStart: number;
	calls: number;
	failed: number;
	maxInflight: number;
	maxMs: number;
	minStatMs: number | undefined;
	maxStatMs: number | undefined;
	deletes: number;
}

export interface IParadisFileIoSideSummary {
	/** 区間の間に始まった呼び出しの数。 */
	readonly calls: number;
	readonly failed: number;
	/** 区間を開いた時点の返事待ちの数。 */
	readonly inflightAtStart: number;
	/** 区間の間の返事待ちの最大。 */
	readonly maxInflight: number;
	/** 集計した時点の返事待ちの数。 */
	readonly inflightNow: number;
	/** 集計した時点の返事待ちのうち、削除の数。 */
	readonly inflightDeletesNow: number;
	/** 集計した時点で一番長く返事を待っている呼び出しの待ち時間。無ければ 0。 */
	readonly oldestInflightMs: number;
	/** 区間の間に返事が来た呼び出しの最長の待ち時間（区間の前に始まった呼び出しも含む）。 */
	readonly maxMs: number;
	/** 区間の間に成功した stat の最短と最長。1 往復の時間と、詰まり方の目安。 */
	readonly minStatMs: number | undefined;
	readonly maxStatMs: number | undefined;
	/** 区間の間に始まった削除の数。 */
	readonly deletes: number;
}

export interface IParadisFileIoWindow {
	summarize(): Record<ParadisFileIoSide, IParadisFileIoSideSummary>;
	dispose(): void;
}

let clock: () => number = () => Date.now();
let nextCallId = 1;
const inflight: Record<ParadisFileIoSide, Map<number, IInflightCall>> = { remote: new Map(), local: new Map() };
const windows = new Set<Record<ParadisFileIoSide, IWindowTally>>();

function newTally(side: ParadisFileIoSide): IWindowTally {
	return { inflightAtStart: inflight[side].size, calls: 0, failed: 0, maxInflight: inflight[side].size, maxMs: 0, minStatMs: undefined, maxStatMs: undefined, deletes: 0 };
}

/**
 * 呼び出しの開始を記録し、返事が来たときに呼ぶ関数を返す。`listen` で流すストリームは数えない
 * （返事の終わりが分からないため）。
 */
export function paradisNoteFileCallStarted(side: ParadisFileIoSide, command: string): (ok: boolean) => void {
	const id = nextCallId++;
	const startedAt = clock();
	const isDelete = command === 'delete';
	const table = inflight[side];
	table.set(id, { startedAt, isDelete });
	for (const tallies of windows) {
		const tally = tallies[side];
		tally.calls++;
		if (isDelete) {
			tally.deletes++;
		}
		tally.maxInflight = Math.max(tally.maxInflight, table.size);
	}
	let settled = false;
	return ok => {
		if (settled) {
			return;
		}
		settled = true;
		table.delete(id);
		const ms = Math.max(0, clock() - startedAt);
		for (const tallies of windows) {
			const tally = tallies[side];
			tally.maxMs = Math.max(tally.maxMs, ms);
			if (!ok) {
				tally.failed++;
			} else if (command === 'stat') {
				tally.minStatMs = tally.minStatMs === undefined ? ms : Math.min(tally.minStatMs, ms);
				tally.maxStatMs = tally.maxStatMs === undefined ? ms : Math.max(tally.maxStatMs, ms);
			}
		}
	};
}

/** 区間の集計を始める。いくつ同時に開いてもよい（切り替えの本体と、締め切りの警告が別々に読む）。 */
export function paradisBeginFileIoWindow(): IParadisFileIoWindow {
	const tallies: Record<ParadisFileIoSide, IWindowTally> = { remote: newTally('remote'), local: newTally('local') };
	windows.add(tallies);
	const summarizeSide = (side: ParadisFileIoSide): IParadisFileIoSideSummary => {
		const tally = tallies[side];
		const now = clock();
		let oldestInflightMs = 0;
		let inflightDeletesNow = 0;
		for (const call of inflight[side].values()) {
			oldestInflightMs = Math.max(oldestInflightMs, now - call.startedAt);
			if (call.isDelete) {
				inflightDeletesNow++;
			}
		}
		return {
			calls: tally.calls,
			failed: tally.failed,
			inflightAtStart: tally.inflightAtStart,
			maxInflight: tally.maxInflight,
			inflightNow: inflight[side].size,
			inflightDeletesNow,
			oldestInflightMs: Math.max(0, oldestInflightMs),
			maxMs: tally.maxMs,
			minStatMs: tally.minStatMs,
			maxStatMs: tally.maxStatMs,
			deletes: tally.deletes,
		};
	};
	return {
		summarize: () => ({ remote: summarizeSide('remote'), local: summarizeSide('local') }),
		dispose: () => { windows.delete(tallies); },
	};
}

/** テスト用。時計を差し替え、返事待ちの台帳を空にする。 */
export function paradisResetFileIoWatchForTest(now: () => number): { dispose(): void } {
	const previous = clock;
	clock = now;
	inflight.remote.clear();
	inflight.local.clear();
	windows.clear();
	return {
		dispose: () => {
			clock = previous;
			inflight.remote.clear();
			inflight.local.clear();
			windows.clear();
		},
	};
}
