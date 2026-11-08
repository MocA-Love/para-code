/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process のシミュレータのチャネル（node/paradisSimulatorChannel.ts）を呼ぶ口。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisSimulatorDevice, IParadisSimulatorFrameEvent, IParadisSimulatorScreenConfig, IParadisSimulatorStatus, PARADIS_SIMULATOR_CHANNEL, ParadisSimulatorInput } from '../common/paradisSimulator.js';

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
	/** 映像の購読。最後の購読が外れると shared process は流れを止める。届いた 1 枚ごとに {@link ackFrame} を呼ぶこと。 */
	onFrames(udid: string): Event<IParadisSimulatorFrameEvent>;
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
	onFrames(udid: string): Event<IParadisSimulatorFrameEvent> {
		return this._channel.listen('frames', { udid });
	}
	ackFrame(udid: string): Promise<void> {
		return this._channel.call('ackFrame', { udid });
	}
}

class ParadisSimulatorClient extends ParadisSimulatorChannelClient {
	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super(sharedProcessService.getChannel(PARADIS_SIMULATOR_CHANNEL));
	}
}

registerSingleton(IParadisSimulatorClient, ParadisSimulatorClient, InstantiationType.Delayed);
