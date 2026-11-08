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
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { registerParadisDeviceLedger } from './paradisDeviceLedgerChannel.js';
import { ParadisMobileCanvasService } from './paradisDeviceLedger.js';
import { PARADIS_SIMULATOR_CHANNEL } from '../common/paradisSimulator.js';
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
	logService: ILogService,
	registerToolProvider: (provider: ParadisMobileCanvasService) => void,
): IParadisSimulatorRegistration {
	const store = new DisposableStore();
	const useServeSim = () => isMacintosh;

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
	const service = store.add(new ParadisSimulatorService(host, backend, isMacintosh, logService, deviceHub, { adb: android, scrcpy }));
	server.registerChannel(PARADIS_SIMULATOR_CHANNEL, new ParadisSimulatorChannel<string>(service));

	// モバイル端末⇔ターミナルペインのアタッチ台帳。ツールは para-browser の MCP サーバーへ相乗りさせるため、
	// エージェントCLI側に追加のMCP設定は要らない
	const router = new ParadisSimulatorDeviceRouter(deviceHost, android, useServeSim, useServeSim, logService);
	const { service: ledger, deviceOps } = registerParadisDeviceLedger(server, router, logService, registerToolProvider);
	ledger.setListNotice(() => router.androidNotice);
	store.add(ledger);
	const fold = new ParadisSimulatorFoldToolProvider(ledger, backend, deviceHost, deviceId => deviceOps.forgetScreenSize(deviceId), useServeSim, logService, deviceHub);
	store.add(paradisRegisterMcpToolProvider(fold));

	return { ledger, dispose: () => store.dispose() };
}
