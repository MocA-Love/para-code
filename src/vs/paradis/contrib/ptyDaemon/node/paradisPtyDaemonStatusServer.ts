/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先(REH)の常駐ターミナルの状態を、繋いでいるクライアントへ答える。
//
// **接続先のウィンドウが見るのはここ。** そのウィンドウのターミナルはこの機械の pty で動いて
// いて、抱えているのもこの機械の常駐なので、状態も操作もこちら側に無ければ噛み合わない。
// この PC 側の口 (`electron-main/paradisPtyDaemonStatusService.ts`) と同じチャネル名・同じ
// インターフェースにしてあるので、クライアントは**繋ぎ先を選ぶだけ**で済む。
//
// 集める中身は `paradisDaemonStatusCollector.ts` と共有している。違うのは2つだけ。
//  - 有効かどうかの判断。**サーバーには薄い常駐しか無い**（アプリの pty ホストごと常駐に
//    する方は Electron の main が起こすもので、こちらには経路が無い）
//  - 見る台帳が1つだけ。上と同じ理由で、もう片方は存在し得ない
//
// **この機械には複数のクライアントが繋がり得る。** 止める・立て直すは、他のウィンドウ
// （他の人のことさえある）のターミナルも一緒に終わらせる。ここで拒むのではなく、押す前に
// そう見えるようにするのが画面側の務めで、文言は `common/paradisPtyDaemonScope.ts` にある。

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IPCServer, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import { ParadisPtyHostPlatform, paradisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';
import {
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	PARADIS_PTY_DAEMON_CHANNEL,
	paradisDisabledDaemonStatus,
} from '../common/paradisPtyDaemonStatus.js';
import { IParadisDaemonLedgerScope, ParadisDaemonStatusCollector } from './paradisDaemonStatusCollector.js';

/** 立て直すのに必要な、ターミナル側の見え方。 */
export interface IParadisServerDaemonPtyAccess {
	restartPtyHost(): Promise<void>;
}

function currentPlatform(): ParadisPtyHostPlatform {
	return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

export class ParadisPtyDaemonStatusServerService implements IParadisPtyDaemonStatusService {

	constructor(
		private readonly collector: ParadisDaemonStatusCollector,
		private readonly pty: IParadisServerDaemonPtyAccess,
		private readonly configurationService: IConfigurationService,
		private readonly stateDir: string,
	) { }

	private scope(): IParadisDaemonLedgerScope {
		const paths = paradisPtyHostPaths({ stateDir: this.stateDir, platform: currentPlatform() });
		return { ledgerDirs: [paths.ledgerDir], activeBuildKey: `v${PARADIS_PTY_PROTOCOL_VERSION}` };
	}

	async getStatus(): Promise<IParadisPtyDaemonStatus> {
		if (this.configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) !== true) {
			return paradisDisabledDaemonStatus();
		}
		return this.collector.collect(this.scope());
	}

	async restart(): Promise<void> {
		await this.stop();
		// 明示的に繋ぎ直す。放っておいても次にターミナルを開いた時点で立ち上がるが、
		// 「立て直す」と言われた以上、押した時点で立っていてほしい。
		await this.pty.restartPtyHost();
	}

	async stop(): Promise<void> {
		await this.collector.stopActive(this.scope());
	}

	async stopForeign(pid: number): Promise<void> {
		await this.collector.stopForeign(this.scope(), pid);
	}
}

/** `serverServices.ts` の PARA-PATCH 点から1行で呼べる登録。 */
export function registerParadisPtyDaemonStatusForServer<TContext>(
	server: IPCServer<TContext>,
	pty: IParadisServerDaemonPtyAccess,
	configurationService: IConfigurationService,
	stateDir: string,
	logService: ILogService,
): IDisposable {
	const store = new DisposableStore();
	const collector = store.add(new ParadisDaemonStatusCollector(logService));
	const service = new ParadisPtyDaemonStatusServerService(collector, pty, configurationService, stateDir);
	server.registerChannel(PARADIS_PTY_DAEMON_CHANNEL, ProxyChannel.fromService<TContext>(service, store));
	return store;
}
