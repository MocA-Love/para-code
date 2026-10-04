/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスの混雑の計測（main-process-file-io-research.html の M1〜M4）で、main と renderer が
// 共有する型・純関数と、renderer 側の受け口。
//
// 何を測るか:
// - M1 main のイベントループ遅延（`perf_hooks.monitorEventLoopDelay`）
// - M2 main の稼働率（`performance.eventLoopUtilization` の差分）
// - M3 renderer の長いタスク（`paradisLongTaskMonitor.ts`）
// - M4 stat の往復を「main へ届くまで／main で処理／renderer へ戻るまで」に割る
//
// M4 は upstream の `localFilesystem` チャネルを包まず、切り替え専用の計測チャネルで同じフォルダへ
// main から `fs.promises.stat` を投げる。同じ IPC の管と同じ main のイベントループを通るので、
// 本物の stat の往復と同じ混雑を受ける。upstream のファイルには触らない。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { UriComponents } from '../../../../base/common/uri.js';

export const PARADIS_MAIN_LOAD_CHANNEL = 'paradisMainLoad';

/** ある区間の main のイベントループの要約。すべて ms（稼働率だけ 0〜100 の %）。 */
export interface IParadisMainLoopSummary {
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
	/** 区間のうち main の JS スレッドが動いていた割合 (%)。 */
	readonly busyPct: number;
	/** 区間の長さ。 */
	readonly durationMs: number;
}

/**
 * Mac 全体の負荷。main が `os.loadavg()` と CPU のコア数から作る。renderer からは直接取れない。
 * ロードアベレージは Windows では常に 0 なので、Windows では作らない (0 を「暇だった」と読ませない)。
 */
export interface IParadisHostLoad {
	/** 1 分のロードアベレージ。小数 2 桁に丸める。 */
	readonly loadAvg1m: number;
	/** 論理 CPU の数。ロードアベレージをコア数で割って読むために一緒に送る。 */
	readonly cpuCount: number;
}

/** 切り替えなどの区間の要約。Mac 全体の負荷は区間を始めた時点の値を添える。 */
export interface IParadisMainLoopWindowSummary extends IParadisMainLoopSummary {
	readonly hostLoad?: IParadisHostLoad;
}

/** 定期の要約。いつの区間か (`endedAt`) を添える。 */
export interface IParadisMainLoopPeriodSummary extends IParadisMainLoopSummary {
	readonly endedAt: number;
}

/** main 側で計った stat の時刻。時刻はどちらも `Date.now()`（同じマシンの同じ時計）。 */
export interface IParadisStatProbeReply {
	readonly receivedAt: number;
	readonly repliedAt: number;
	/** `fs.promises.stat` そのものにかかった時間。main の処理時間との差が main の JS の負担。 */
	readonly fsMs: number;
	readonly ok: boolean;
}

/** main の計測チャネル。renderer からは `ProxyChannel.toService` で使う。 */
export interface IParadisMainLoadService {
	/** 切り替えなどの区間の計測を始める。返した番号を `endWindow` に渡す。 */
	beginWindow(): Promise<number>;
	/**
	 * 区間の計測を終えて要約を返す。番号が分からなければ undefined。
	 * Mac 全体の負荷もこの返事に相乗りさせる (切り替えのたびに IPC を 1 往復増やさないため)。
	 */
	endWindow(id: number): Promise<IParadisMainLoopWindowSummary | undefined>;
	/** main からそのファイルを stat し、受け取った時刻と返した時刻を返す。file 以外は undefined。 */
	probeStat(resource: UriComponents): Promise<IParadisStatProbeReply | undefined>;
	/** 直近の定期の要約（新しい順ではなく古い順）。 */
	getRecentSummaries(): Promise<readonly IParadisMainLoopPeriodSummary[]>;
}

/** `perf_hooks` の `IntervalHistogram` のうち要約に使う面。値はナノ秒。 */
export interface IParadisLoopDelayHistogram {
	readonly max: number;
	readonly count?: number;
	percentile(percentile: number): number;
}

function nsToMs(ns: number): number {
	return Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e5) / 10 : 0;
}

/** ヒストグラムと稼働率を ms・% の要約にする。 */
export function paradisSummarizeMainLoop(histogram: IParadisLoopDelayHistogram, utilization: number, durationMs: number): IParadisMainLoopSummary {
	return {
		p50Ms: nsToMs(histogram.percentile(50)),
		p99Ms: nsToMs(histogram.percentile(99)),
		maxMs: nsToMs(histogram.max),
		busyPct: Number.isFinite(utilization) ? Math.round(Math.min(Math.max(utilization, 0), 1) * 1000) / 10 : 0,
		durationMs: Math.max(0, Math.round(durationMs)),
	};
}

/**
 * main が混んでいたとみなすか。定期の要約をログへ残すかの判定に使う（毎分のログで溢れさせない）。
 * 100ms は人がクリックの遅れに気付き始める目安、1 秒は upstream の「応答なし」より手前の目安。
 */
export function paradisIsMainLoopCongested(summary: IParadisMainLoopSummary): boolean {
	return summary.p99Ms >= 100 || summary.maxMs >= 1000;
}

/** stat の往復を 3 つに割った結果 (ms)。 */
export interface IParadisStatRoundTrip {
	/** renderer が送ってから main が受け取るまで（IPC の行きと main の実行待ち）。 */
	readonly toMainMs: number;
	/** main が受け取ってから返すまで（`fs.promises.stat` とスレッドプールの待ちを含む）。 */
	readonly mainMs: number;
	/** main が返してから renderer が受け取るまで（IPC の帰りと renderer の実行待ち）。 */
	readonly backMs: number;
	/** main の処理のうち `fs.promises.stat` そのもの。 */
	readonly fsMs: number;
}

/**
 * 3 つの時刻から往復を割る。時計は同じだが `Date.now()` の粒度 (1ms) で前後しうるので 0 で止める。
 * 時刻の並びがあり得ない (main の時刻が送信より 1 秒以上前など) ときは undefined を返す
 * (時計が飛んだ回を分布に混ぜない)。
 */
export function paradisSplitStatRoundTrip(sentAt: number, reply: IParadisStatProbeReply, gotAt: number): IParadisStatRoundTrip | undefined {
	if (reply.receivedAt < sentAt - 1000 || reply.repliedAt < reply.receivedAt || gotAt < reply.repliedAt - 1000) {
		return undefined;
	}
	return {
		toMainMs: Math.max(0, reply.receivedAt - sentAt),
		mainMs: Math.max(0, reply.repliedAt - reply.receivedAt),
		backMs: Math.max(0, gotAt - reply.repliedAt),
		fsMs: Math.max(0, Math.round(reply.fsMs)),
	};
}

// renderer 側の受け口。main の計測チャネルは Electron のウィンドウにしか無いので、DI ではなく
// electron-browser の contribution がここへ登録する（Web のビルドでは誰も登録せず undefined のまま）。
let registeredProbe: IParadisMainLoadService | undefined;

export function paradisRegisterMainLoadProbe(probe: IParadisMainLoadService): IDisposable {
	registeredProbe = probe;
	return toDisposable(() => {
		if (registeredProbe === probe) {
			registeredProbe = undefined;
		}
	});
}

export function paradisGetMainLoadProbe(): IParadisMainLoadService | undefined {
	return registeredProbe;
}
