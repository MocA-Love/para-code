/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率を 5 秒ごとに測り、2 段の輪バッファへ貯め続ける役。手元は shared process、接続先は
// REH サーバーが 1 つずつ持つ（`paradisSystemUsage.sharedProcess.ts`・`paradisHostResourcesChannel.ts`）。
//
// 履歴はメモリにしか無い。測る側のプロセスが再起動すると消える（応答の `instanceId` が変わるので、
// 受け手は手元の点を捨てて取り直す）。

import { generateUuid } from '../../../../base/common/uuid.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { hostname, cpus } from 'os';
import {
	IParadisSystemUsageMachine,
	IParadisSystemUsageRequest,
	IParadisSystemUsageResponse,
	PARADIS_SYSTEM_USAGE_COARSE_STEP_MS,
	PARADIS_SYSTEM_USAGE_FINE_STEP_MS,
	PARADIS_SYSTEM_USAGE_VERSION,
	ParadisSystemUsageHistory,
	paradisEncodeSystemUsageSeries,
	paradisParseSystemUsageRequest,
	paradisSelectSystemUsageSamples,
} from '../common/paradisSystemUsage.js';
import { IParadisSystemUsageCounters, paradisComputeSystemUsageSample } from '../common/paradisSystemUsageParsers.js';
import { IParadisSystemUsageReader, paradisCreateSystemUsageReader } from './paradisSystemUsageSampler.js';

/** これより大きく時計が巻き戻ったら履歴を捨てる。小さな戻りは、その点を積まずにやり過ごす。 */
const CLOCK_ROLLBACK_RESET_MS = 60_000;

export interface IParadisSystemUsageServiceOptions {
	readonly reader?: IParadisSystemUsageReader;
	readonly now?: () => number;
	/** タイマー（テストから差し替える）。既定は unref した setTimeout（このタイマーだけでプロセスを生かさない）。 */
	readonly schedule?: (callback: () => void, delayMs: number) => IDisposable;
	readonly onError?: (error: unknown) => void;
}

function defaultSchedule(callback: () => void, delayMs: number): IDisposable {
	const handle = setTimeout(callback, delayMs);
	// node のタイマーにだけある unref（型の上では共通の TimeoutHandle なので取り出して呼ぶ）
	(handle as unknown as { unref?: () => void }).unref?.();
	return { dispose: () => clearTimeout(handle) };
}

export class ParadisSystemUsageService implements IDisposable {

	private readonly reader: IParadisSystemUsageReader;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => IDisposable;
	private readonly onError: (error: unknown) => void;

	readonly history = new ParadisSystemUsageHistory();
	private _instanceId = generateUuid();
	/** 測る側の起動ごと（と、時計が大きく巻き戻って履歴を捨てたとき）に変わる印。 */
	get instanceId(): string {
		return this._instanceId;
	}

	private previous: IParadisSystemUsageCounters | undefined;
	private lastCounters: IParadisSystemUsageCounters | undefined;
	private timer: IDisposable | undefined;
	private running = false;
	private disposed = false;

	constructor(options: IParadisSystemUsageServiceOptions = {}) {
		// 外部コマンドが止まり始めたことも、読み取りの失敗と同じ口でログに残す
		this.reader = options.reader ?? paradisCreateSystemUsageReader(process.platform, { onError: error => this.onError(error) });
		this.now = options.now ?? (() => Date.now());
		this.schedule = options.schedule ?? defaultSchedule;
		this.onError = options.onError ?? (() => { });
	}

	/** 測り始める。1 回目はすぐ、以後は刻みごと。 */
	start(): void {
		if (this.timer !== undefined || this.disposed) {
			return;
		}
		this.timer = this.schedule(() => this.tick(), 0);
	}

	dispose(): void {
		this.disposed = true;
		this.timer?.dispose();
		this.timer = undefined;
		// 実行中の外部コマンドもグループごと止める
		this.reader.dispose?.();
	}

	/** 1 回測って積む（テストから直接呼ぶ）。前回がまだ終わっていなければ何もしない。 */
	async sampleOnce(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			const counters = await this.reader.read(this.now());
			if (this.disposed) {
				return;
			}
			const latest = this.history.latest();
			if (latest !== undefined && counters.at < latest.t - CLOCK_ROLLBACK_RESET_MS) {
				// 時計が大きく巻き戻った（手で合わせた・NTP の大きな補正）。古い時刻の点が先に並んだままだと
				// 新しい点が積めず差分の取得も壊れるので、履歴を捨てて印を変え、受け手に全部取り直させる。
				this.history.clear();
				this._instanceId = generateUuid();
				this.previous = undefined;
			}
			this.history.push(paradisComputeSystemUsageSample(this.previous, counters));
			this.previous = counters;
			this.lastCounters = counters;
		} catch (error) {
			this.onError(error);
		} finally {
			this.running = false;
		}
	}

	private tick(): void {
		this.timer = undefined;
		const startedAt = this.now();
		void this.sampleOnce().finally(() => {
			if (this.disposed) {
				return;
			}
			// 測るのに掛かった時間を引き、刻みがずれていかないようにする（最短 1 秒は空ける）。
			const elapsed = this.now() - startedAt;
			this.timer = this.schedule(() => this.tick(), Math.max(1_000, PARADIS_SYSTEM_USAGE_FINE_STEP_MS - elapsed));
		});
	}

	machine(): IParadisSystemUsageMachine {
		const counters = this.lastCounters;
		return {
			os: this.reader.platform,
			hostname: hostname(),
			cores: cpus().length,
			memTotal: counters?.memTotal ?? 0,
			diskPath: this.reader.diskPath,
			...(counters?.diskTotal !== undefined ? { diskTotal: counters.diskTotal } : {}),
			...(counters?.swapTotal !== undefined ? { swapTotal: counters.swapTotal } : {}),
		};
	}

	async getSystemUsage(rawRequest: unknown): Promise<IParadisSystemUsageResponse> {
		const request: IParadisSystemUsageRequest = paradisParseSystemUsageRequest(rawRequest);
		// 起動直後でまだ 1 点も無いときは、その場で 1 回測る（開いた直後に何も出ないのを避ける）。
		if (this.history.latest() === undefined) {
			await this.sampleOnce();
		}
		const { samples, reset } = paradisSelectSystemUsageSamples(this.history.samples(request.tier), request, this.instanceId);
		const latest = this.history.latest();
		return {
			version: PARADIS_SYSTEM_USAGE_VERSION,
			instanceId: this.instanceId,
			machine: this.machine(),
			tier: request.tier,
			stepMs: request.tier === 'fine' ? PARADIS_SYSTEM_USAGE_FINE_STEP_MS : PARADIS_SYSTEM_USAGE_COARSE_STEP_MS,
			reset,
			unsupported: this.reader.unsupported,
			series: paradisEncodeSystemUsageSeries(samples),
			...(latest !== undefined ? { latest } : {}),
		};
	}
}
