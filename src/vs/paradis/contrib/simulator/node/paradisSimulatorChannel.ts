/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer ⇔ shared process のシミュレータのチャネル（映像と入力の受け渡しの口）。登録は `paradisSimulator.sharedProcess.ts`。
//
// 設定 `paradis.simulator.enabled` がオフのとき・macOS でないときは、`getStatus` 以外の呼び出しを断り、
// ホストも起こさない（q.html Q585 の D2: Mobile Canvas を外すまでは今の Mobile Canvas と mobile_* がそのまま動く）。
//
// 映像は `frames` のイベントで 1 枚ずつ送る。送るのは「1 枚まで先行、追いつかなければ最新の 1 枚だけ」:
// 受け取った側が `ackFrame` を呼ぶまで次は送らず、その間に届いた分は最新の 1 枚だけを残す。上限は 30fps。
// 購読する窓が居なくなったら映像の流れを止める（端末のセッションはホストに残る）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, PARADIS_SIMULATOR_ENABLED_SETTING, paradisIsSimulatorUdid } from '../common/paradisSimulator.js';
import { paradisParseSimulatorFold, paradisSimulatorInputFrame } from '../common/paradisSimulatorFrames.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { IParadisSimulatorHostProvider } from './paradisSimulatorHostProcess.js';

/** `frames` のイベントで送る 1 枚。 */
export interface IParadisSimulatorFrameEvent {
	readonly udid: string;
	readonly jpeg: VSBuffer;
}

const MIN_FRAME_INTERVAL_MS = 1000 / 30;

/** 1 台ぶんの映像の中継。最初の購読で流れを開き、最後の購読が外れたら閉じる。 */
class ParadisSimulatorFrameRelay extends Disposable {

	private readonly _onFrame: Emitter<IParadisSimulatorFrameEvent>;
	readonly onFrame: Event<IParadisSimulatorFrameEvent>;

	private _stream: IDisposable | undefined;
	private _inFlight = false;
	private _pending: Uint8Array | undefined;
	private _lastSentAt = 0;
	private _timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _udid: string,
		private readonly _backend: ParadisServeSimBackend,
		private readonly _logService: ILogService,
	) {
		super();
		this._onFrame = this._register(new Emitter<IParadisSimulatorFrameEvent>({
			onWillAddFirstListener: () => this._open(),
			onDidRemoveLastListener: () => this._close(),
		}));
		this.onFrame = this._onFrame.event;
		this._register({ dispose: () => this._close() });
	}

	ack(): void {
		this._inFlight = false;
		this._flush();
	}

	private _open(): void {
		this._stream = this._backend.subscribeFrames(this._udid, jpeg => {
			this._pending = jpeg;
			this._flush();
		}, error => {
			this._stream = undefined;
			if (error) {
				this._logService.warn(`[paradis-simulator] video stream ended: ${error.message}`);
			}
		});
	}

	private _close(): void {
		this._stream?.dispose();
		this._stream = undefined;
		this._pending = undefined;
		this._inFlight = false;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _flush(): void {
		if (this._inFlight || !this._pending || this._timer) {
			return;
		}
		const wait = this._lastSentAt + MIN_FRAME_INTERVAL_MS - Date.now();
		if (wait > 0) {
			this._timer = setTimeout(() => {
				this._timer = undefined;
				this._flush();
			}, wait);
			return;
		}
		const jpeg = this._pending;
		this._pending = undefined;
		this._inFlight = true;
		this._lastSentAt = Date.now();
		this._onFrame.fire({ udid: this._udid, jpeg: VSBuffer.wrap(jpeg) });
	}
}

/** チャネルの中身。テストからも使う。 */
export class ParadisSimulatorService extends Disposable {

	private readonly _relays = new Map<string, ParadisSimulatorFrameRelay>();

	constructor(
		private readonly _host: IParadisSimulatorHostProvider & { stop(): Promise<void> },
		private readonly _backend: ParadisServeSimBackend,
		private readonly _isEnabled: () => boolean,
		private readonly _supported: boolean,
		private readonly _logService: ILogService,
	) {
		super();
		this._register({ dispose: () => { for (const relay of this._relays.values()) { relay.dispose(); } this._relays.clear(); } });
	}

	getStatus(): IParadisSimulatorStatus {
		return { enabled: this._isEnabled(), supported: this._supported, hostRunning: this._host.isRunning, hostError: this._host.lastError };
	}

	/** 使えないときは理由を投げる。 */
	assertAvailable(): void {
		if (!this._supported) {
			throw new Error('The iOS simulator is only available on macOS');
		}
		if (!this._isEnabled()) {
			throw new Error(`The simulator is turned off (${PARADIS_SIMULATOR_ENABLED_SETTING})`);
		}
	}

	listDevices(): Promise<IParadisSimulatorDevice[]> {
		this.assertAvailable();
		return this._backend.listDevices();
	}

	boot(udid: string): Promise<void> {
		this.assertAvailable();
		return this._backend.boot(udid);
	}

	getScreenConfig(udid: string): Promise<IParadisSimulatorScreenConfig> {
		this.assertAvailable();
		return this._backend.getScreenConfig(udid);
	}

	async captureFrame(udid: string): Promise<VSBuffer> {
		this.assertAvailable();
		return VSBuffer.wrap(await this._backend.captureFrame(udid));
	}

	sendInput(udid: string, input: unknown): Promise<void> {
		this.assertAvailable();
		return this._backend.send(udid, paradisSimulatorInputFrame(input));
	}

	async fold(udid: string, fold: unknown): Promise<{ ok: boolean }> {
		this.assertAvailable();
		return { ok: await this._backend.fold(udid, paradisParseSimulatorFold(fold)) };
	}

	deviceHubActive(udid: string): Promise<boolean> {
		this.assertAvailable();
		return this._backend.deviceHubActive(udid);
	}

	onFrames(udid: string): Event<IParadisSimulatorFrameEvent> {
		this.assertAvailable();
		return this._relay(udid).onFrame;
	}

	ackFrame(udid: string): void {
		this._relays.get(udid)?.ack();
	}

	/** ホストを止める（開発用のコマンドの後始末。次の要求でまた起きる）。 */
	stopHost(): Promise<void> {
		for (const relay of this._relays.values()) {
			relay.dispose();
		}
		this._relays.clear();
		return this._host.stop();
	}

	private _relay(udid: string): ParadisSimulatorFrameRelay {
		if (!paradisIsSimulatorUdid(udid)) {
			throw new Error(`Not a simulator UDID: ${udid}`);
		}
		let relay = this._relays.get(udid);
		if (!relay) {
			relay = new ParadisSimulatorFrameRelay(udid, this._backend, this._logService);
			this._relays.set(udid, relay);
		}
		return relay;
	}
}

function requireUdidArg(arg: unknown): string {
	const udid = arg && typeof arg === 'object' ? (arg as Record<string, unknown>).udid : undefined;
	if (typeof udid !== 'string' || !paradisIsSimulatorUdid(udid)) {
		throw new Error('Protocol error: "udid" must be a simulator UDID');
	}
	return udid;
}

function argField(arg: unknown, name: string): unknown {
	return arg && typeof arg === 'object' ? (arg as Record<string, unknown>)[name] : undefined;
}

export class ParadisSimulatorChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly _service: ParadisSimulatorService) { }

	listen<T>(_ctx: TContext, event: string, arg?: unknown): Event<T> {
		switch (event) {
			case 'frames':
				return this._service.onFrames(requireUdidArg(arg)) as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'getStatus':
				return this._service.getStatus() as T;
			case 'listDevices':
				return await this._service.listDevices() as T;
			case 'boot':
				return await this._service.boot(requireUdidArg(arg)) as T;
			case 'getScreenConfig':
				return await this._service.getScreenConfig(requireUdidArg(arg)) as T;
			case 'captureFrame':
				return await this._service.captureFrame(requireUdidArg(arg)) as T;
			case 'sendInput':
				return await this._service.sendInput(requireUdidArg(arg), argField(arg, 'input')) as T;
			case 'fold':
				return await this._service.fold(requireUdidArg(arg), argField(arg, 'fold')) as T;
			case 'deviceHubActive':
				return await this._service.deviceHubActive(requireUdidArg(arg)) as T;
			case 'ackFrame':
				this._service.ackFrame(requireUdidArg(arg));
				return undefined as T;
			case 'stopHost':
				return await this._service.stopHost() as T;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}
