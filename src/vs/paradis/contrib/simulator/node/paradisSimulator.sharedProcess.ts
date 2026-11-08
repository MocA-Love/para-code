/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process にシミュレータを立ち上げる。`paradis.sharedProcess.contribution.ts` から直呼びする
// （agentBrowser の `registerToolProvider` を値で受け取るため、登録口ではなく直呼び。設計書 1 節）。
//
//  - 端末の台帳（端末⇔ペイン）と mobile_* の 17 本。端末の口は振り分け（paradisSimulatorDeviceRouter.ts）で、
//    iOS のシミュレータは serve-sim、Android は利用者の adb（⑦ で Mobile Canvas を外した）
//  - mobile_fold
//  - renderer のエディタのペインが使う映像と入力のチャネル

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IPCServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { registerParadisDeviceLedger } from './paradisDeviceLedgerChannel.js';
import { ParadisMobileCanvasService } from './paradisDeviceLedger.js';
import { PARADIS_SIMULATOR_CHANNEL, PARADIS_SIMULATOR_DEVICE_ID_PREFIX, PARADIS_SIMULATOR_ENABLED_SETTING } from '../common/paradisSimulator.js';
import { ParadisSimulatorDeviceRouter } from './paradisSimulatorDeviceRouter.js';
import { ParadisServeSimBackend } from './paradisServeSimBackend.js';
import { ParadisServeSimDeviceHost } from './paradisServeSimDeviceHost.js';
import { ParadisSimulatorChannel, ParadisSimulatorService } from './paradisSimulatorChannel.js';
import { ParadisSimulatorFoldToolProvider } from './paradisSimulatorFoldTool.js';
import { ParadisSimulatorHostProcess } from './paradisSimulatorHostProcess.js';
import { ParadisSimulatorDeviceHub } from './paradisSimulatorDeviceHub.js';
import { ParadisAdbDeviceHost } from './android/paradisAdbDeviceHost.js';
import { ParadisScrcpySessions } from './android/paradisScrcpySessions.js';
import { PARADIS_SCRCPY_SERVER_JAR } from './android/paradisScrcpyDist.js';
import { ParadisScrcpyReverseFileRecord } from './android/paradisScrcpyReverseRecord.js';
import { join } from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { promises as fs } from 'fs';

export interface IParadisSimulatorRegistration extends IDisposable {
	/** Mobile Canvas の台帳（端末⇔ペイン）。 */
	readonly ledger: ParadisMobileCanvasService;
}

export function registerParadisSimulator(
	server: IPCServer<string>,
	userDataPath: string,
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
	const deviceHub = new ParadisSimulatorDeviceHub();
	// Android は利用者の adb（⑥a。adb は同梱しない）と、同梱した scrcpy-server（⑥b。映像・ペインの入力・2 本指・日本語）
	let scrcpy: ParadisScrcpySessions | undefined = undefined;
	const android = new ParadisAdbDeviceHost({
		exists: async path => (await fs.stat(path).catch(() => undefined))?.isFile() === true,
		scrcpy: { use: (serial, run) => scrcpy!.use(serial, run) },
	}, logService);
	// Para Code が作った adb reverse の記録（途中で落ちて残った reverse を、次に始めるときに外すため）
	const reverseRecord = new ParadisScrcpyReverseFileRecord(join(userDataPath, 'paradis-simulator', 'scrcpy-reverses.json'));
	scrcpy = store.add(new ParadisScrcpySessions(async () => ({
		adbPath: await android.adbPath(),
		serverJar: FileAccess.asFileUri(PARADIS_SCRCPY_SERVER_JAR).fsPath,
		adb: (args, timeoutMs) => android.run(args, timeoutMs),
		reverseRecord,
	}), logService));
	const service = store.add(new ParadisSimulatorService(host, backend, isEnabled, isMacintosh, logService, deviceHub, { adb: android, scrcpy }));
	server.registerChannel(PARADIS_SIMULATOR_CHANNEL, new ParadisSimulatorChannel<string>(service));

	// モバイル端末⇔ターミナルペインのアタッチ台帳。ツールは para-browser の MCP サーバーへ相乗りさせるため、
	// エージェントCLI側に追加のMCP設定は要らない
	const router = new ParadisSimulatorDeviceRouter(deviceHost, android, useServeSim, useServeSim, logService);
	const { service: ledger, deviceOps } = registerParadisDeviceLedger(server, router, logService, registerToolProvider);
	ledger.setListNotice(() => isEnabled() ? router.androidNotice : `The simulator is turned off (${PARADIS_SIMULATOR_ENABLED_SETTING}).`);
	store.add(ledger);
	const fold = new ParadisSimulatorFoldToolProvider(ledger, backend, deviceHost, deviceId => deviceOps.forgetScreenSize(deviceId), useServeSim, logService, deviceHub);
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
		void paradisDropUnreachableAttachments(ledger, logService, () => router.androidNotice === undefined);
	}));
	return { ledger, dispose: () => store.dispose() };
}

/**
 * シミュレータの設定を切り替えたとき、受け持つ仕組みが替わる端末（iOS のシミュレータ `ios:core-simulator:` と
 * Android `android:`）の割り当てのうち、今の一覧に無いものを外す（Mobile Canvas と新しい仕組みで id の形が違いうるので、
 * 残すと「Unknown mobile device」のまま握り続ける）。
 *  - 一覧を取れなければ、iOS のシミュレータの割り当てをすべて外す（操作できるかが確かめられないため）。Android は外さない
 *  - Android は、直前の一覧で Android を確かに読めたとき（`androidListed`）だけ見る。振り分けは adb や Mobile Canvas が
 *    失敗しても残りの一覧を返すので、読めなかった一覧に無いことは消えた証拠にならない
 *  - それ以外の割り当ては触らない
 * 外したペインの数を返す。
 */
export async function paradisDropUnreachableAttachments(ledger: Pick<ParadisMobileCanvasService, 'listAttachments' | 'listDevices' | 'detach'>, logService: ILogService, androidListed: () => boolean = () => false): Promise<number> {
	let known: ReadonlySet<string> | undefined;
	try {
		known = new Set((await ledger.listDevices()).map(device => device.id));
	} catch (error) {
		logService.warn('[paradis-simulator] could not list devices after the simulator setting changed', error);
	}
	let dropped = 0;
	for (const attachment of ledger.listAttachments()) {
		const ios = attachment.deviceId.startsWith(PARADIS_SIMULATOR_DEVICE_ID_PREFIX);
		const androidDevice = attachment.deviceId.startsWith('android:');
		const unreachable = ios
			? !known || !known.has(attachment.deviceId)
			: androidDevice && !!known && androidListed() && !known.has(attachment.deviceId);
		if (unreachable) {
			ledger.detach(attachment.paneToken);
			dropped++;
		}
	}
	if (dropped) {
		logService.info(`[paradis-simulator] detached ${dropped} pane(s) from devices that are no longer listed after the simulator setting changed`);
	}
	return dropped;
}
