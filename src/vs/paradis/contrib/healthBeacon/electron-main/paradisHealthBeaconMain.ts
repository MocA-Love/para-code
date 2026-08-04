/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期ヘルスビーコンの main プロセス側。収集と Sentry への送信を担う。
//
// 収集は `v8.getHeapSpaceStatistics()` と `app.getAppMetrics()` だけで完結し、子プロセスは
// 一切起動しない。`ps` を回す resourceMonitor とは意図的に別経路にしてある(あちらは
// 2.5秒ごとに1600プロセス分のオブジェクトを作るので、常時走らせる収集には向かない)。
//
// ウィンドウ側の値は「main が要求 → renderer が申告」の往復で集める。renderer に常駐タイマーを
// 持たせないのは、表示に関係しない計測を各ウィンドウで回し続けたくないため。

import { app } from 'electron';
import { freemem, totalmem } from 'os';
import { getHeapStatistics, getHeapSpaceStatistics } from 'v8';
import { raceTimeout, timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { captureParadisMainMeasurementSnapshot, flushParadisMainSentry } from '../../sentry/electron-main/paradisSentryMain.js';
import {
	IParadisHealthBeaconMainService,
	IParadisHealthProcessSample,
	IParadisHealthSnapshot,
	IParadisHealthV8Stats,
	IParadisHealthWindowReport,
	PARADIS_HEALTH_BEACON_CHANNEL,
	PARADIS_HEALTH_BEACON_FIRST_DELAY_MS,
	PARADIS_HEALTH_BEACON_INTERVAL_MS,
	PARADIS_HEALTH_BEACON_REPORT_MAX_AGE_MS,
	PARADIS_HEALTH_BEACON_REPORT_WAIT_MS,
	PARADIS_HEALTH_BEACON_SPAN_NAME,
	ParadisHealthBeaconReason,
	paradisBuildHealthContext,
	paradisBuildHealthMeasurements,
	paradisBuildHealthTags,
	paradisNormalizeHealthRole,
} from '../common/paradisHealthBeacon.js';

/** 終了時の送信を待ち切る上限。これを超えたら諦めて終了を進める。 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

/** 内蔵ブラウザ数の問い合わせを待つ上限。終了経路でも必ず返るように時間で切る。 */
const BROWSER_VIEW_COUNT_TIMEOUT_MS = 500;

/** `IPCServer` 全体に依存しないための最小の受け口。 */
export interface IParadisHealthBeaconChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

function toProcessKind(type: string): IParadisHealthProcessSample['kind'] {
	switch (type) {
		case 'Browser': return 'browser';
		case 'Tab': return 'renderer';
		case 'GPU': return 'gpu';
		case 'Utility': return 'utility';
		default: return 'other';
	}
}

function readMainV8Stats(): IParadisHealthV8Stats {
	const heap = getHeapStatistics();
	const spaces = getHeapSpaceStatistics();
	const oldSpace = spaces.find(space => space.space_name === 'old_space');
	const largeObjectSpace = spaces.find(space => space.space_name === 'large_object_space');
	return {
		heapUsed: heap.used_heap_size,
		heapTotal: heap.total_heap_size,
		heapLimit: heap.heap_size_limit,
		external: heap.external_memory ?? 0,
		malloced: heap.malloced_memory,
		nativeContexts: heap.number_of_native_contexts,
		detachedContexts: heap.number_of_detached_contexts,
		oldSpaceSize: oldSpace?.space_size ?? 0,
		oldSpaceUsed: oldSpace?.space_used_size ?? 0,
		largeObjectUsed: largeObjectSpace?.space_used_size ?? 0,
	};
}

/**
 * 収集タイマーと、ウィンドウからの申告の保持。
 * app.ts から1度だけ生成されるプロセス寿命のシングルトン前提。
 */
export class ParadisHealthBeacon extends Disposable {

	private readonly _onDidRequestReport = this._register(new Emitter<void>());
	readonly onDidRequestReport: Event<void> = this._onDidRequestReport.event;

	private readonly reports = new Map<number, { readonly report: IParadisHealthWindowReport; readonly receivedAt: number }>();
	private readonly startedAt = Date.now();
	private pending: Promise<void> | undefined;

	constructor(
		private readonly windowsMainService: IWindowsMainService,
		private readonly browserViewMainService: IBrowserViewMainService,
		lifecycleMainService: ILifecycleMainService,
	) {
		super();

		// 終了時の1本が「そのセッションの最終形」で最も価値が高い。自動更新による再起動も
		// ここを通る（更新の適用はアプリの終了を伴うため）。
		this._register(lifecycleMainService.onWillShutdown(event => {
			event.join('paradisHealthBeacon', this.sendSnapshot('shutdown'));
		}));
	}

	start(): void {
		// 後始末は最初に1つだけ登録する。setTimeout のコールバックの中から _register すると、
		// 先に dispose 済みだった場合に「破棄済みストアへの追加」経路に落ちるため。
		let intervalTimer: ReturnType<typeof setInterval> | undefined;
		const firstTimer = setTimeout(() => {
			void this.sendSnapshot('startup');
			intervalTimer = setInterval(() => void this.sendSnapshot('interval'), PARADIS_HEALTH_BEACON_INTERVAL_MS);
		}, PARADIS_HEALTH_BEACON_FIRST_DELAY_MS);
		this._register(toDisposable(() => {
			clearTimeout(firstTimer);
			if (intervalTimer !== undefined) {
				clearInterval(intervalTimer);
			}
		}));
	}

	acceptWindowReport(report: IParadisHealthWindowReport): void {
		this.reports.set(report.windowId, { report, receivedAt: Date.now() });
	}

	/**
	 * 送信は常に1本ずつ。進行中のものがあれば、それに相乗りする。
	 *
	 * 終了時は「進行中のものを捨てて自分も諦める」ではなく、進行中の送信を待ってから flush する。
	 * 終了直前の1本はそのセッションの最終形なので、ここで取りこぼすと最も価値の高い標本を失う。
	 */
	private sendSnapshot(reason: ParadisHealthBeaconReason): Promise<void> {
		const inFlight = this.pending;
		if (inFlight) {
			return reason === 'shutdown'
				? inFlight.then(() => flushParadisMainSentry(SHUTDOWN_FLUSH_TIMEOUT_MS))
				: inFlight;
		}
		const running = this.captureSnapshot(reason).finally(() => {
			this.pending = undefined;
		});
		this.pending = running;
		return running;
	}

	private async captureSnapshot(reason: ParadisHealthBeaconReason): Promise<void> {
		try {
			// 終了時はウィンドウがもう応答できないので、最後に届いていた申告をそのまま使う。
			if (reason !== 'shutdown') {
				this._onDidRequestReport.fire();
				await timeout(PARADIS_HEALTH_BEACON_REPORT_WAIT_MS);
			}
			const snapshot = await this.collect(reason);
			captureParadisMainMeasurementSnapshot(
				PARADIS_HEALTH_BEACON_SPAN_NAME,
				paradisBuildHealthTags(snapshot),
				paradisBuildHealthMeasurements(snapshot),
				paradisBuildHealthContext(snapshot),
			);
			if (reason === 'shutdown') {
				await flushParadisMainSentry(SHUTDOWN_FLUSH_TIMEOUT_MS);
			}
		} catch {
			/* 計測が本体の動作や終了を壊さないよう、全部握り潰す */
		}
	}

	private async collect(reason: ParadisHealthBeaconReason): Promise<IParadisHealthSnapshot> {
		const memoryUsage = process.memoryUsage();
		const processes: IParadisHealthProcessSample[] = app.getAppMetrics().map(metric => {
			const kind = toProcessKind(metric.type);
			return {
				kind,
				role: kind === 'utility' ? paradisNormalizeHealthRole(metric.serviceName ?? metric.name) : kind,
				// Electron の workingSetSize はKB単位。
				memory: (metric.memory?.workingSetSize ?? 0) * 1024,
				cpu: metric.cpu?.percentCPUUsage ?? 0,
			};
		});

		// 終了時にもここを通る。返ってこない可能性を残すと onWillShutdown の join が終わらず
		// アプリが終了できなくなるので、必ず時間で切る。
		let browserViewCount = 0;
		try {
			browserViewCount = (await raceTimeout(this.browserViewMainService.getBrowserViews(), BROWSER_VIEW_COUNT_TIMEOUT_MS))?.length ?? 0;
		} catch {
			/* 取れなければ0のまま */
		}

		return {
			reason,
			uptimeMs: Date.now() - this.startedAt,
			mainV8: readMainV8Stats(),
			mainRss: memoryUsage.rss,
			mainArrayBuffers: memoryUsage.arrayBuffers,
			processes,
			windows: this.takeFreshReports(),
			windowCount: this.windowsMainService.getWindowCount(),
			browserViewCount,
			hostMemoryTotal: totalmem(),
			hostMemoryFree: freemem(),
		};
	}

	/**
	 * 古すぎる申告を捨てつつ、生きているぶんだけ返す。
	 * 閉じたウィンドウのぶんをここで落とさないと、このMap自体が調査対象のリークになる。
	 */
	private takeFreshReports(): IParadisHealthWindowReport[] {
		const now = Date.now();
		const fresh: IParadisHealthWindowReport[] = [];
		for (const [windowId, entry] of this.reports) {
			if (now - entry.receivedAt > PARADIS_HEALTH_BEACON_REPORT_MAX_AGE_MS) {
				this.reports.delete(windowId);
				continue;
			}
			fresh.push(entry.report);
		}
		return fresh;
	}
}

/** ProxyChannel へ出す面。公開メソッドはasyncのみ、イベントは `onDid*` 命名。 */
class ParadisHealthBeaconMainService implements IParadisHealthBeaconMainService {

	readonly onDidRequestReport: Event<void>;

	constructor(private readonly beacon: ParadisHealthBeacon) {
		this.onDidRequestReport = beacon.onDidRequestReport;
	}

	async reportWindow(report: IParadisHealthWindowReport): Promise<void> {
		this.beacon.acceptWindowReport(report);
	}
}

/**
 * app.ts の PARA-PATCH 点から1行で呼ぶための入り口。
 * ここ以外に main プロセス側の配線は無い。
 */
export function paradisRegisterHealthBeacon(
	channelHost: IParadisHealthBeaconChannelHost,
	windowsMainService: IWindowsMainService,
	browserViewMainService: IBrowserViewMainService,
	lifecycleMainService: ILifecycleMainService,
): IDisposable {
	const disposables = new DisposableStore();
	const beacon = disposables.add(new ParadisHealthBeacon(windowsMainService, browserViewMainService, lifecycleMainService));
	channelHost.registerChannel(PARADIS_HEALTH_BEACON_CHANNEL, ProxyChannel.fromService(new ParadisHealthBeaconMainService(beacon), disposables));
	beacon.start();
	return disposables;
}
