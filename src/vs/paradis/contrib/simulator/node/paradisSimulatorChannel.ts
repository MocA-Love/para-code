/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer ⇔ shared process のシミュレータのチャネル（映像と入力の受け渡しの口）。登録は `paradisSimulator.sharedProcess.ts`。
//
// macOS でないときは、`getStatus` 以外の iOS の呼び出しを断り、ホストも起こさない。
//
// 映像は `frames` のイベントで 1 枚ずつ送る。送るのは「1 枚まで先行、追いつかなければ最新の 1 枚だけ」:
// 受け取った側が `ackFrame` を呼ぶまで次は送らず、その間に届いた分は最新の 1 枚だけを残す。上限は 30fps。
// 購読する窓が居なくなったら映像の流れを止める（端末のセッションはホストに残る）。
// 流れが終わったら（ホストが起きない・serve-sim が断った・切れた）、理由を `ended` のイベントで購読している窓へ送る
// （ログにだけ残すと、ペインは黒いまま理由が分からない）。窓は購読を外して、様子を読み直してから購読し直す。

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, ParadisSimulatorStreamEvent, paradisIsSimulatorUdid } from '../common/paradisSimulator.js';
import { paradisParseSimulatorFold, paradisSimulatorInputFrame } from '../common/paradisSimulatorFrames.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { IParadisSimulatorHostProvider } from './paradisSimulatorHostProcess.js';
import { ParadisSimulatorDeviceHub } from './paradisSimulatorDeviceHub.js';
import { ParadisAdbDeviceHost } from './android/paradisAdbDeviceHost.js';
import { ParadisScrcpySessions } from './android/paradisScrcpySessions.js';
import { IParadisAndroidDeviceSummary, PARADIS_ANDROID_SERIAL_PREFIX, paradisAndroidKeycode, paradisAndroidSerialOf } from '../common/paradisAndroid.js';
import { ParadisAndroidVideoWire, paradisAndroidInputMessages } from '../common/paradisScrcpy.js';

const MIN_FRAME_INTERVAL_MS = 1000 / 30;

/** 1 台ぶんの映像の中継。最初の購読で流れを開き、最後の購読が外れたら閉じる。 */
class ParadisSimulatorFrameRelay extends Disposable {

	private readonly _onFrame: Emitter<ParadisSimulatorStreamEvent>;
	readonly onFrame: Event<ParadisSimulatorStreamEvent>;

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
		this._onFrame = this._register(new Emitter<ParadisSimulatorStreamEvent>({
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
			if (error) {
				this._logService.warn(`[paradis-simulator] video stream ended: ${error.message}`);
			}
			// 待っている 1 枚と返事の待ちを捨て、次の購読で開き直せるようにしてから知らせる
			this._close();
			this._onFrame.fire({ kind: 'ended', udid: this._udid, ...(error ? { reason: error.message } : {}) });
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
		this._onFrame.fire({ kind: 'frame', udid: this._udid, jpeg: VSBuffer.wrap(jpeg) });
	}
}

/** Android の 1 台ぶんの映像の中継。最初の購読で scrcpy の通話を使い始め、最後の購読が外れたら使い終わる。 */
class ParadisAndroidVideoRelay extends Disposable {

	private readonly _onMessage: Emitter<ParadisAndroidVideoWire>;
	readonly onMessage: Event<ParadisAndroidVideoWire>;
	private readonly _lease = this._register(new MutableDisposable());
	private _generation = 0;

	constructor(
		private readonly _serial: string,
		private readonly _sessions: Pick<ParadisScrcpySessions, 'acquire'>,
		private readonly _logService: ILogService,
	) {
		super();
		this._onMessage = this._register(new Emitter<ParadisAndroidVideoWire>({
			onWillAddFirstListener: () => void this._open(),
			onDidRemoveLastListener: () => this._close(),
		}));
		this.onMessage = this._onMessage.event;
	}

	private async _open(): Promise<void> {
		const generation = ++this._generation;
		try {
			const { session, lease } = await this._sessions.acquire(this._serial);
			if (generation !== this._generation) {
				lease.dispose();
				return;
			}
			const store = new DisposableStore();
			store.add(lease);
			// 後から購読しても復号できるよう、今の大きさと最後の config（SPS・PPS）を先に渡し、key frame を求める
			if (session.size) {
				this._onMessage.fire({ serial: this._serial, kind: 'size', width: session.size.width, height: session.size.height });
			}
			if (session.config) {
				this._onMessage.fire({ serial: this._serial, kind: 'config', data: VSBuffer.wrap(session.config) });
			}
			void session.resetVideo().catch(() => undefined);
			store.add(session.onVideo(event => {
				if (event.kind === 'session') {
					this._onMessage.fire({ serial: this._serial, kind: 'size', width: event.width, height: event.height });
				} else if (event.kind === 'config') {
					this._onMessage.fire({ serial: this._serial, kind: 'config', data: VSBuffer.wrap(event.data) });
				} else if (event.kind === 'frame') {
					this._onMessage.fire({ serial: this._serial, kind: 'frame', data: VSBuffer.wrap(event.data), key: event.key, pts: event.pts });
				}
			}));
			store.add(session.onDidEnd(error => this._onMessage.fire({ serial: this._serial, kind: 'ended', ...(error ? { reason: error.message } : {}) })));
			this._lease.value = store;
		} catch (error) {
			if (generation === this._generation) {
				this._logService.warn(`[paradis-simulator] could not start scrcpy: ${error instanceof Error ? error.message : String(error)}`);
				this._onMessage.fire({ serial: this._serial, kind: 'ended', reason: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private _close(): void {
		this._generation++;
		this._lease.clear();
	}
}

/** Android の受け持ち（⑥a の adb・⑥b の scrcpy）。 */
export interface IParadisSimulatorAndroid {
	readonly adb: Pick<ParadisAdbDeviceHost, 'bootAvd' | 'listDevices'>;
	readonly scrcpy?: Pick<ParadisScrcpySessions, 'acquire' | 'use'>;
}

/** チャネルの中身。テストからも使う。 */
export class ParadisSimulatorService extends Disposable {

	private readonly _relays = new Map<string, ParadisSimulatorFrameRelay>();
	private readonly _androidRelays = new Map<string, ParadisAndroidVideoRelay>();

	constructor(
		private readonly _host: IParadisSimulatorHostProvider & { stop(): Promise<void> },
		private readonly _backend: ParadisServeSimBackend,
		private readonly _supported: boolean,
		private readonly _logService: ILogService,
		private readonly _deviceHub: Pick<ParadisSimulatorDeviceHub, 'isRunning' | 'open'> = new ParadisSimulatorDeviceHub(),
		private readonly _android?: IParadisSimulatorAndroid,
	) {
		super();
		this._register({ dispose: () => { for (const relay of this._relays.values()) { relay.dispose(); } this._relays.clear(); } });
		this._register({ dispose: () => { for (const relay of this._androidRelays.values()) { relay.dispose(); } this._androidRelays.clear(); } });
	}

	getStatus(): IParadisSimulatorStatus {
		return { supported: this._supported, hostRunning: this._host.isRunning, hostError: this._host.lastError };
	}

	/** iOS のシミュレータ（serve-sim のホスト）を使えないときは理由を投げる。Android の呼び出しは全 OS で使う（Q588）。 */
	assertAvailable(): void {
		if (!this._supported) {
			throw new Error('The iOS simulator is only available on macOS');
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

	shutdown(udid: string): Promise<void> {
		this.assertAvailable();
		return this._backend.shutdown(udid);
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

	/** 起動していない Android の AVD を起動する（エージェントの要求を承認したとき。起動しきるのは待たない）。 */
	async bootAndroid(deviceId: string): Promise<void> {
		await this._android?.adb.bootAvd(deviceId);
	}

	/** Android の端末の一覧（エディタのタブを開くため。adb が無ければ空）。 */
	async listAndroidDevices(): Promise<IParadisAndroidDeviceSummary[]> {
		const entries = await this._android?.adb.listDevices().catch(() => []) ?? [];
		return entries.flatMap(entry => {
			const record = entry as Record<string, unknown>;
			const serial = typeof record.id === 'string' ? paradisAndroidSerialOf(record.id) : undefined;
			return serial ? [{ serial, name: typeof record.name === 'string' ? record.name : serial, runtime: typeof record.runtimeName === 'string' ? record.runtimeName : '', state: typeof record.state === 'string' ? record.state : '' }] : [];
		});
	}

	/** Android の映像（scrcpy）の購読。使えないときは何も届かないイベント。 */
	onAndroidVideo(serial: string): Event<ParadisAndroidVideoWire> {
		const scrcpy = this._android?.scrcpy;
		try {
			if (!scrcpy || !paradisAndroidSerialOf(`${PARADIS_ANDROID_SERIAL_PREFIX}${serial}`)) {
				throw new Error('Android video is not available');
			}
		} catch (error) {
			this._logService.warn(`[paradis-simulator] refused an Android video subscription: ${error instanceof Error ? error.message : String(error)}`);
			return Event.None;
		}
		let relay = this._androidRelays.get(serial);
		if (!relay) {
			relay = new ParadisAndroidVideoRelay(serial, scrcpy, this._logService);
			this._androidRelays.set(serial, relay);
		}
		return relay.onMessage;
	}

	/** ペインからの Android の人の入力（scrcpy の操作のソケット）。 */
	async androidInput(serial: string, input: unknown): Promise<void> {
		const scrcpy = this._android?.scrcpy;
		if (!scrcpy || !paradisAndroidSerialOf(`${PARADIS_ANDROID_SERIAL_PREFIX}${serial}`)) {
			throw new Error('Android input is not available');
		}
		await scrcpy.use(serial, async session => {
			const size = session.size;
			if (!size) {
				throw new Error('The Android device has not sent its screen size yet');
			}
			for (const message of paradisAndroidInputMessages(input, size, paradisAndroidKeycode)) {
				await session.send(message);
			}
		});
	}

	/** 次の key frame を求める（renderer の復号が崩れたとき）。 */
	async androidResetVideo(serial: string): Promise<void> {
		await this._android?.scrcpy?.use(serial, session => session.resetVideo());
	}

	/** Device Hub のアプリが起動しているか（開閉の前提）。 */
	deviceHubRunning(): Promise<boolean> {
		this.assertAvailable();
		return this._deviceHub.isRunning();
	}

	/** Device Hub を裏で起動する（利用者がペインのボタンを押したとき）。 */
	openDeviceHub(): Promise<void> {
		this.assertAvailable();
		return this._deviceHub.open();
	}

	deviceHubActive(udid: string): Promise<boolean> {
		this.assertAvailable();
		return this._backend.deviceHubActive(udid);
	}

	/** 使えないときは何も届かないイベントを返す（`listen` の中で投げると shared process の未処理の例外になるため）。 */
	onFrames(udid: string): Event<ParadisSimulatorStreamEvent> {
		try {
			this.assertAvailable();
		} catch (error) {
			this._logService.warn(`[paradis-simulator] refused a video subscription: ${error instanceof Error ? error.message : String(error)}`);
			return Event.None;
		}
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

function requireSerialArg(arg: unknown): string {
	const serial = argField(arg, 'serial');
	if (typeof serial !== 'string' || !paradisAndroidSerialOf(`${PARADIS_ANDROID_SERIAL_PREFIX}${serial}`)) {
		throw new Error('Protocol error: "serial" must be an Android serial');
	}
	return serial;
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
			case 'androidVideo':
				return this._service.onAndroidVideo(requireSerialArg(arg)) as Event<T>;
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
			case 'shutdown':
				return await this._service.shutdown(requireUdidArg(arg)) as T;
			case 'getScreenConfig':
				return await this._service.getScreenConfig(requireUdidArg(arg)) as T;
			case 'captureFrame':
				return await this._service.captureFrame(requireUdidArg(arg)) as T;
			case 'sendInput':
				return await this._service.sendInput(requireUdidArg(arg), argField(arg, 'input')) as T;
			case 'fold':
				return await this._service.fold(requireUdidArg(arg), argField(arg, 'fold')) as T;
			case 'bootAndroid': {
				const deviceId = argField(arg, 'deviceId');
				if (typeof deviceId !== 'string') {
					throw new Error('Protocol error: "deviceId" must be a string');
				}
				return await this._service.bootAndroid(deviceId) as T;
			}
			case 'listAndroidDevices':
				return await this._service.listAndroidDevices() as T;
			case 'androidInput':
				return await this._service.androidInput(requireSerialArg(arg), argField(arg, 'input')) as T;
			case 'androidResetVideo':
				return await this._service.androidResetVideo(requireSerialArg(arg)) as T;
			case 'deviceHubRunning':
				return await this._service.deviceHubRunning() as T;
			case 'openDeviceHub':
				return await this._service.openDeviceHub() as T;
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
