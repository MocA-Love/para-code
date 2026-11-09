/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process のシミュレータのチャネル（node/paradisSimulatorChannel.ts）を呼ぶ口。
//
// シミュレータ（simctl・serve-sim のホスト・映像・入力・adb）は、この窓を表示している手元の機械の機能なので、
// SSH などのリモートの窓でも必ず手元の shared process のチャネルを使う（接続先の REH には Xcode も simctl も無い）。
// リモートのチャネル（IRemoteAgentService）へは振らない。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisAndroidDeviceSummary } from '../common/paradisAndroid.js';
import { ParadisAndroidInput, ParadisAndroidVideoWire } from '../common/paradisScrcpy.js';
import { IParadisSimulatorDevice, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, PARADIS_SIMULATOR_CHANNEL, ParadisSimulatorInput, ParadisSimulatorStreamEvent } from '../common/paradisSimulator.js';

export const IParadisSimulatorClient = createDecorator<IParadisSimulatorClient>('paradisSimulatorClient');

export interface IParadisSimulatorClient {
	readonly _serviceBrand: undefined;
	getStatus(): Promise<IParadisSimulatorStatus>;
	listDevices(): Promise<IParadisSimulatorDevice[]>;
	boot(udid: string): Promise<void>;
	shutdown(udid: string): Promise<void>;
	getScreenConfig(udid: string): Promise<IParadisSimulatorScreenConfig>;
	captureFrame(udid: string): Promise<VSBuffer>;
	sendInput(udid: string, input: ParadisSimulatorInput): Promise<void>;
	fold(udid: string, fold: { readonly pose: string } | { readonly hinge: number }): Promise<{ readonly ok: boolean }>;
	deviceHubActive(udid: string): Promise<boolean>;
	/** Android の端末の一覧（adb で動いているもの・起動していない AVD）。adb が無ければ空。 */
	listAndroidDevices(): Promise<IParadisAndroidDeviceSummary[]>;
	/** Android の映像（scrcpy の H.264）の購読。最後の購読が外れると shared process は通話を手放す。 */
	onAndroidVideo(serial: string): Event<ParadisAndroidVideoWire>;
	/** ペインからの Android の人の入力。 */
	androidInput(serial: string, input: ParadisAndroidInput): Promise<void>;
	/** 次の key frame を求める（復号が崩れたとき）。 */
	androidResetVideo(serial: string): Promise<void>;
	/** 起動していない Android の AVD（`android:avd:<name>`）を起動する。 */
	bootAndroid(deviceId: string): Promise<void>;
	/** Device Hub のアプリが起動しているか（iPhone Duo の開閉の前提）。 */
	deviceHubRunning(): Promise<boolean>;
	/** Device Hub を裏で起動する。 */
	openDeviceHub(): Promise<void>;
	/**
	 * 映像の購読。最後の購読が外れると shared process は流れを止める。届いた 1 枚ごとに {@link ackFrame} を呼ぶこと。
	 * 流れが終わったら `ended`（理由つき）が届く。
	 */
	onFrames(udid: string): Event<ParadisSimulatorStreamEvent>;
	ackFrame(udid: string): Promise<void>;
}

/** チャネルを包むだけの実装。テストでは {@link IChannel} の偽物を渡す。 */
export class ParadisSimulatorChannelClient implements IParadisSimulatorClient {

	declare readonly _serviceBrand: undefined;

	constructor(private readonly _channel: IChannel) { }

	getStatus(): Promise<IParadisSimulatorStatus> {
		return this._channel.call('getStatus');
	}
	listDevices(): Promise<IParadisSimulatorDevice[]> {
		return this._channel.call('listDevices');
	}
	boot(udid: string): Promise<void> {
		return this._channel.call('boot', { udid });
	}
	shutdown(udid: string): Promise<void> {
		return this._channel.call('shutdown', { udid });
	}
	getScreenConfig(udid: string): Promise<IParadisSimulatorScreenConfig> {
		return this._channel.call('getScreenConfig', { udid });
	}
	captureFrame(udid: string): Promise<VSBuffer> {
		return this._channel.call('captureFrame', { udid });
	}
	sendInput(udid: string, input: ParadisSimulatorInput): Promise<void> {
		return this._channel.call('sendInput', { udid, input });
	}
	fold(udid: string, fold: { readonly pose: string } | { readonly hinge: number }): Promise<{ readonly ok: boolean }> {
		return this._channel.call('fold', { udid, fold });
	}
	deviceHubActive(udid: string): Promise<boolean> {
		return this._channel.call('deviceHubActive', { udid });
	}
	deviceHubRunning(): Promise<boolean> {
		return this._channel.call('deviceHubRunning');
	}
	bootAndroid(deviceId: string): Promise<void> {
		return this._channel.call('bootAndroid', { deviceId });
	}
	listAndroidDevices(): Promise<IParadisAndroidDeviceSummary[]> {
		return this._channel.call('listAndroidDevices');
	}
	onAndroidVideo(serial: string): Event<ParadisAndroidVideoWire> {
		return this._channel.listen('androidVideo', { serial });
	}
	androidInput(serial: string, input: ParadisAndroidInput): Promise<void> {
		return this._channel.call('androidInput', { serial, input });
	}
	androidResetVideo(serial: string): Promise<void> {
		return this._channel.call('androidResetVideo', { serial });
	}
	openDeviceHub(): Promise<void> {
		return this._channel.call('openDeviceHub');
	}
	onFrames(udid: string): Event<ParadisSimulatorStreamEvent> {
		return this._channel.listen('frames', { udid });
	}
	ackFrame(udid: string): Promise<void> {
		return this._channel.call('ackFrame', { udid });
	}
}

/** 手元の shared process のチャネルを使う実装（リモートの窓でも同じ。SSH の窓を模したテストから直接作る）。 */
export class ParadisSimulatorClient extends ParadisSimulatorChannelClient {
	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super(sharedProcessService.getChannel(PARADIS_SIMULATOR_CHANNEL));
	}
}

registerSingleton(IParadisSimulatorClient, ParadisSimulatorClient, InstantiationType.Delayed);
