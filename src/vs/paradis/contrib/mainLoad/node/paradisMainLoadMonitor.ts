/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import * as os from 'os';
import { EventLoopUtilization, monitorEventLoopDelay, performance } from 'perf_hooks';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IParadisHostLoad, IParadisLoopDelayHistogram, IParadisMainLoopPeriodSummary, IParadisMainLoopWindowSummary, IParadisStatProbeReply, paradisIsMainLoopCongested, paradisSummarizeMainLoop } from '../common/paradisMainLoad.js';

/** 計測に使う道具。テストでは偽物を渡す。 */
export interface IParadisMainLoadDependencies {
	createHistogram(resolutionMs: number): IParadisLoopDelayHistogram & { enable(): void; disable(): void; reset(): void };
	eventLoopUtilization(previous?: EventLoopUtilization): EventLoopUtilization;
	now(): number;
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	stat(fsPath: string): Promise<unknown>;
	/** Mac 全体の負荷。取れない環境 (Windows) では undefined。 */
	hostLoad(): IParadisHostLoad | undefined;
}

export const PARADIS_MAIN_LOAD_DEFAULTS = {
	/**
	 * 常時動かすヒストグラムの分解能。`monitorEventLoopDelay` は内部でこの間隔のタイマーを回し、
	 * そのたびに main を起こす。アイドル中の起床 (省電力) を増やさないよう 200ms (5 回/秒) にする。
	 * 遅延はタイマーの遅れとして記録されるので、分解能より長い詰まり (数百 ms〜) はこれで見える。
	 * 細かい分布が要る切り替えの区間は、別の 10ms のヒストグラムで測る (`windowResolutionMs`)。
	 */
	periodicResolutionMs: 200,
	/** 定期の要約の間隔。要約は数値を数個読むだけで、ログに出すのは混んでいたときだけ。 */
	periodMs: 60_000,
	/** 覚えておく定期の要約の数（10 分ぶん）。 */
	recentLimit: 10,
	/** 切り替えの区間だけ動かすヒストグラムの分解能。区間は数秒なので細かくしてよい。 */
	windowResolutionMs: 10,
	/**
	 * 1 つの呼び出し元 (ウィンドウ) が同時に開ける区間の上限。終わらせ忘れた区間でヒストグラムが
	 * 溜まり続けないように。ウィンドウごとに数えるので、あるウィンドウの連打が別のウィンドウの
	 * 計測中の区間を追い出すことは無い。
	 */
	maxOpenWindows: 4,
	/**
	 * 全体で同時に開ける区間の上限。持ち主ごとの上限だけだと、開いたまま消えたウィンドウ
	 * (renderer のクラッシュ・リロードで `endWindow` が届かない) の分が溜まり続ける。
	 */
	maxOpenWindowsTotal: 16,
	/** これより古い区間は持ち主に関わらず捨てる。切り替えは長くても 60 秒でスロットを手放す。 */
	maxWindowAgeMs: 120_000,
} as const;

function defaultDependencies(): IParadisMainLoadDependencies {
	return {
		createHistogram: resolution => monitorEventLoopDelay({ resolution }),
		eventLoopUtilization: previous => performance.eventLoopUtilization(previous),
		now: () => Date.now(),
		setInterval: (handler, ms) => setInterval(handler, ms),
		clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
		stat: fsPath => fs.stat(fsPath),
		hostLoad: readHostLoad,
	};
}

/**
 * `os.loadavg()` は Windows では常に `[0, 0, 0]` を返すので、Windows では undefined にする。
 * どちらも同期の軽い呼び出し (macOS では sysctl 1 回ずつ) で、ディスクにも触らない。
 */
function readHostLoad(): IParadisHostLoad | undefined {
	if (process.platform === 'win32') {
		return undefined;
	}
	try {
		const loadAvg1m = os.loadavg()[0];
		const cpuCount = os.availableParallelism();
		if (!Number.isFinite(loadAvg1m) || loadAvg1m < 0 || !Number.isFinite(cpuCount) || cpuCount <= 0) {
			return undefined;
		}
		return { loadAvg1m: Math.round(loadAvg1m * 100) / 100, cpuCount };
	} catch {
		return undefined;
	}
}

interface IOpenWindow {
	readonly owner: string;
	readonly histogram: ReturnType<IParadisMainLoadDependencies['createHistogram']>;
	readonly elu: EventLoopUtilization;
	readonly startedAt: number;
	/** 区間を始めた時点の Mac 全体の負荷。 */
	readonly hostLoad: IParadisHostLoad | undefined;
}

/**
 * main のイベントループ遅延と稼働率を常時測り、1 分ごとに要約する。切り替えの区間だけの計測と、
 * main からの stat の時刻の計測もここが受け持つ。
 */
export class ParadisMainLoadMonitor extends Disposable {

	private readonly deps: IParadisMainLoadDependencies;
	private readonly periodic: ReturnType<IParadisMainLoadDependencies['createHistogram']>;
	private periodElu: EventLoopUtilization;
	private periodStartedAt: number;
	private readonly recent: IParadisMainLoopPeriodSummary[] = [];
	private readonly openWindows = new Map<number, IOpenWindow>();
	private nextWindowId = 1;

	constructor(
		private readonly logService: ILogService,
		dependencies: Partial<IParadisMainLoadDependencies> = {},
		private readonly options: typeof PARADIS_MAIN_LOAD_DEFAULTS = PARADIS_MAIN_LOAD_DEFAULTS,
	) {
		super();
		this.deps = { ...defaultDependencies(), ...dependencies };
		this.periodic = this.deps.createHistogram(options.periodicResolutionMs);
		this.periodic.enable();
		this.periodElu = this.deps.eventLoopUtilization();
		this.periodStartedAt = this.deps.now();
		const timer = this.deps.setInterval(() => this.summarizePeriod(), options.periodMs);
		// 計測のためにプロセスの終了を引き止めない。
		const unrefable = timer as { unref?(): void } | undefined;
		if (typeof unrefable?.unref === 'function') {
			unrefable.unref();
		}
		this._register(toDisposable(() => {
			this.deps.clearInterval(timer);
			this.periodic.disable();
			for (const window of this.openWindows.values()) {
				window.histogram.disable();
			}
			this.openWindows.clear();
		}));
	}

	/** 定期の要約を 1 回作る。タイマーから呼ばれる（テストからも直接呼ぶ）。 */
	summarizePeriod(): IParadisMainLoopPeriodSummary {
		const now = this.deps.now();
		const elu = this.deps.eventLoopUtilization(this.periodElu);
		const summary: IParadisMainLoopPeriodSummary = {
			...paradisSummarizeMainLoop(this.periodic, elu.utilization, now - this.periodStartedAt),
			endedAt: now,
		};
		this.periodic.reset();
		this.periodElu = this.deps.eventLoopUtilization();
		this.periodStartedAt = now;
		this.recent.push(summary);
		while (this.recent.length > this.options.recentLimit) {
			this.recent.shift();
		}
		if (paradisIsMainLoopCongested(summary)) {
			this.logService.warn(`[paradisMainLoad] the main process event loop was congested: ${JSON.stringify(summary)}`);
		}
		return summary;
	}

	/** `owner` は呼び出し元 (IPC の接続ごとの文脈)。上限はこの単位で数える。 */
	beginWindow(owner: string): number {
		// 持ち主に関わらず、古すぎる区間 (`endWindow` が届かなかったもの) を捨てる。
		const now = this.deps.now();
		for (const [id, window] of [...this.openWindows]) {
			if (now - window.startedAt > this.options.maxWindowAgeMs) {
				window.histogram.disable();
				this.openWindows.delete(id);
			}
		}
		// 同じ呼び出し元の、終わらせ忘れた古い区間から捨てる (Map は追加順なので先頭が古い)。
		const own = [...this.openWindows].filter(([, window]) => window.owner === owner);
		for (const [id, window] of own.slice(0, Math.max(0, own.length - this.options.maxOpenWindows + 1))) {
			window.histogram.disable();
			this.openWindows.delete(id);
		}
		// 全体の上限。超える分は持ち主に関わらず古い順に捨てる。
		while (this.openWindows.size >= this.options.maxOpenWindowsTotal) {
			const oldest = this.openWindows.keys().next();
			if (oldest.done) {
				break;
			}
			this.openWindows.get(oldest.value)?.histogram.disable();
			this.openWindows.delete(oldest.value);
		}
		const id = this.nextWindowId++;
		const histogram = this.deps.createHistogram(this.options.windowResolutionMs);
		histogram.enable();
		this.openWindows.set(id, { owner, histogram, elu: this.deps.eventLoopUtilization(), startedAt: now, hostLoad: this.deps.hostLoad() });
		return id;
	}

	/** 開いた本人以外は終わらせられない (別のウィンドウの区間を番号で閉じない)。 */
	endWindow(owner: string, id: number): IParadisMainLoopWindowSummary | undefined {
		const window = this.openWindows.get(id);
		if (window === undefined || window.owner !== owner) {
			return undefined;
		}
		this.openWindows.delete(id);
		window.histogram.disable();
		const elu = this.deps.eventLoopUtilization(window.elu);
		const summary = paradisSummarizeMainLoop(window.histogram, elu.utilization, this.deps.now() - window.startedAt);
		return window.hostLoad === undefined ? summary : { ...summary, hostLoad: window.hostLoad };
	}

	async probeStat(resource: UriComponents): Promise<IParadisStatProbeReply | undefined> {
		const receivedAt = this.deps.now();
		const uri = URI.revive(resource);
		if (uri.scheme !== Schemas.file) {
			return undefined;
		}
		const fsStartedAt = performance.now();
		let ok = true;
		try {
			await this.deps.stat(uri.fsPath);
		} catch {
			ok = false;
		}
		const fsMs = performance.now() - fsStartedAt;
		return { receivedAt, repliedAt: this.deps.now(), fsMs, ok };
	}

	getRecentSummaries(): readonly IParadisMainLoopPeriodSummary[] {
		return [...this.recent];
	}
}

/**
 * main の計測チャネル。外に出すのは `IParadisMainLoadService` の 4 つだけにする
 * (`ProxyChannel.fromService` はクラスの公開メソッドを全部出してしまうため、使わない)。
 * 呼び出し元の文脈 (`ctx`、ウィンドウごとの接続) を区間の持ち主として渡す。
 */
export function paradisCreateMainLoadChannel(monitor: ParadisMainLoadMonitor): IServerChannel<string> {
	return {
		listen<T>(_ctx: string, event: string): Event<T> {
			throw new Error(`Event not found: ${event}`);
		},
		async call<T>(ctx: string, command: string, args?: unknown[]): Promise<T> {
			const arg = Array.isArray(args) ? args : [];
			switch (command) {
				case 'beginWindow': return monitor.beginWindow(ctx) as T;
				case 'endWindow': return monitor.endWindow(ctx, Number(arg[0])) as T;
				case 'probeStat': return await monitor.probeStat(arg[0] as UriComponents) as T;
				case 'getRecentSummaries': return monitor.getRecentSummaries() as T;
			}
			throw new Error(`Call not found: ${command}`);
		},
	};
}
