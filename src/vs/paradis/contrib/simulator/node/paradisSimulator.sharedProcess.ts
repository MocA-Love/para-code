/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process にシミュレータを立ち上げる。`paradis.sharedProcess.contribution.ts` から、前の
// `registerParadisMobileCanvas(...)` の直呼びの代わりに呼ぶ（agentBrowser の `registerToolProvider` を値で受け取るため、
// 登録口ではなく直呼び。設計書 1 節）。
//
//  - Mobile Canvas の台帳と mobile_* の 17 本は今のまま。ホストへの要求を振り分けで包み、設定がオンで macOS なら
//    iOS のシミュレータを serve-sim へ回す（paradisMobileHostRouter.ts。q.html Q585 の ③、案A）
//  - mobile_fold を足す（設定がオンのときだけ一覧に出る）
//  - renderer のエディタのペインが使う映像と入力のチャネル

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IPCServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { registerParadisMobileCanvas } from '../../mobileCanvas/node/paradisMobileCanvasChannel.js';
import { ParadisMobileCanvasService } from '../../mobileCanvas/node/paradisMobileCanvasService.js';
import { PARADIS_SIMULATOR_CHANNEL, PARADIS_SIMULATOR_DEVICE_ID_PREFIX, PARADIS_SIMULATOR_ENABLED_SETTING } from '../common/paradisSimulator.js';
import { ParadisMobileHostRouter } from './paradisMobileHostRouter.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { ParadisServeSimDeviceHost } from './paradisServeSimDeviceHost.js';
import { ParadisSimulatorChannel, ParadisSimulatorService } from './paradisSimulatorChannel.js';
import { ParadisSimulatorFoldToolProvider } from './paradisSimulatorFoldTool.js';
import { ParadisSimulatorHostProcess } from './paradisSimulatorHostProcess.js';

export interface IParadisSimulatorRegistration extends IDisposable {
	/** Mobile Canvas の台帳（端末⇔ペイン）。 */
	readonly ledger: ParadisMobileCanvasService;
}

export function registerParadisSimulator(
	server: IPCServer<string>,
	userDataPath: string,
	builtinExtensionsPath: string,
	configurationService: IConfigurationService,
	logService: ILogService,
	registerToolProvider: (provider: ParadisMobileCanvasService) => void,
): IParadisSimulatorRegistration {
	const store = new DisposableStore();
	const isEnabled = () => configurationService.getValue<boolean>(PARADIS_SIMULATOR_ENABLED_SETTING) === true;
	const useServeSim = () => isMacintosh && isEnabled();

	// ホストはここでは起こさない（最初の要求で起こす）。macOS 以外でも作るだけなら何も起きない
	const host = store.add(new ParadisSimulatorHostProcess({ userDataPath, logService }));
	const backend = store.add(new ParadisServeSimBackend(host, logService));
	const deviceHost = new ParadisServeSimDeviceHost(backend, logService);
	const service = store.add(new ParadisSimulatorService(host, backend, isEnabled, isMacintosh, logService));
	server.registerChannel(PARADIS_SIMULATOR_CHANNEL, new ParadisSimulatorChannel<string>(service));

	// モバイル端末⇔ターミナルペインのアタッチ台帳。ツールは para-browser の MCP サーバーへ相乗りさせるため、
	// エージェントCLI側に追加のMCP設定は要らない
	const { service: ledger, deviceOps } = registerParadisMobileCanvas(server, builtinExtensionsPath, logService, registerToolProvider,
		mobileCanvas => new ParadisMobileHostRouter(mobileCanvas, deviceHost, useServeSim, logService));
	store.add(ledger);
	const fold = new ParadisSimulatorFoldToolProvider(ledger, backend, deviceHost, deviceId => deviceOps.forgetScreenSize(deviceId), useServeSim, logService);
	store.add(paradisRegisterMcpToolProvider(fold));

	// 設定を切り替えたら: オフならホストを止める。どちらでも、新しい一覧に無い端末の割り当てを外す
	// （iOS を受け持つ仕組みが替わるので、もう操作できない端末をペインに握らせたままにしない）
	store.add(configurationService.onDidChangeConfiguration(event => {
		if (!event.affectsConfiguration(PARADIS_SIMULATOR_ENABLED_SETTING)) {
			return;
		}
		if (!isEnabled()) {
			void service.stopHost();
		}
		void paradisDropUnreachableAttachments(ledger, logService);
	}));
	return { ledger, dispose: () => store.dispose() };
}

/**
 * シミュレータの設定を切り替えたとき、iOS のシミュレータ（`ios:core-simulator:`）の割り当てのうち、今の一覧に無いものを
 * 外す。一覧を取れなければ iOS のシミュレータの割り当てをすべて外す（受け持つ仕組みが替わり、操作できるかが確かめ
 * られないため）。Android など iOS のシミュレータでない割り当ては、受け持つ仕組みが替わらないので触らない
 * （振り分けは Mobile Canvas が失敗しても iOS だけの一覧を返すので、一覧に無いことは消えた証拠にならない）。
 * 外したペインの数を返す。
 */
export async function paradisDropUnreachableAttachments(ledger: Pick<ParadisMobileCanvasService, 'listAttachments' | 'listDevices' | 'detach'>, logService: ILogService): Promise<number> {
	let known: ReadonlySet<string> | undefined;
	try {
		known = new Set((await ledger.listDevices()).map(device => device.id));
	} catch (error) {
		logService.warn('[paradis-simulator] could not list devices after the simulator setting changed', error);
	}
	let dropped = 0;
	for (const attachment of ledger.listAttachments()) {
		if (!attachment.deviceId.startsWith(PARADIS_SIMULATOR_DEVICE_ID_PREFIX)) {
			continue;
		}
		if (!known || !known.has(attachment.deviceId)) {
			ledger.detach(attachment.paneToken);
			dropped++;
		}
	}
	if (dropped) {
		logService.info(`[paradis-simulator] detached ${dropped} pane(s) from devices that are no longer listed after the simulator setting changed`);
	}
	return dropped;
}
