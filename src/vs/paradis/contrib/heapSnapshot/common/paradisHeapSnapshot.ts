/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスの V8 ヒープスナップショットを取るための最小の契約。
//
// なぜ専用の経路が要るのか:
// ヘルスビーコンが送っている `main.v8.old_space_used` は「どれだけ生き残っているか」までしか
// 答えられない。本番では24時間で 96MB → 2046MB、GC後の生存率がほぼ 1.00 という値が出ており、
// 本物の滞留であることは確定しているが、**何が参照を握っているかは measurement では原理的に
// 分からない**。retainer tree を見るにはヒープスナップショットそのものが要る。
//
// CDP の `Tracing.requestMemoryDump` では代用できない。あれが返すのは領域ごとの合計値だけで、
// オブジェクト単位の情報は含まれない。かといって main を `--inspect` 付きで起動する方法は、
// **リークが現れるのが長時間稼働後**である以上、普段使いの実機では選べない。だから配布版の
// まま自分で叩ける入口を用意する。

export const PARADIS_HEAP_SNAPSHOT_CHANNEL = 'paradisHeapSnapshot';

export interface IParadisHeapSnapshotResult {
	/** 書き出したファイルの絶対パス。 */
	readonly path: string;
	/** 書き出したファイルのバイト数。**大きさを読めなかった場合は -1**（0 は「空だった」を意味する）。 */
	readonly bytes: number;
	/** 書き出しに要した時間 (ms)。この間 main プロセスは止まっている。 */
	readonly durationMs: number;
	/** 書き出し直前の old space 使用量 (bytes)。連続して取った2枚を比べるときの目印。 */
	readonly oldSpaceUsed: number;
	/** main プロセスの連続稼働時間 (ms)。リークは稼働時間に比例するので必ず添える。 */
	readonly uptimeMs: number;
}

export interface IParadisHeapSnapshotMainService {
	/**
	 * main プロセスの V8 ヒープスナップショットをファイルへ書き出す。
	 *
	 * **同期的にブロックする**。2GB 規模のヒープでは数秒〜数十秒アプリ全体が無反応になるので、
	 * 呼び出し側は必ず事前にユーザーへ確認を取ること。
	 */
	writeSnapshot(): Promise<IParadisHeapSnapshotResult>;
}
