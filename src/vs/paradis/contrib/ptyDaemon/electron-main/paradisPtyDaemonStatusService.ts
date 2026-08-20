/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの状態を集めて画面へ渡す。main プロセス側。
//
// ここが main に居るのは、**台帳を読めるのが main だけ**だから。renderer はサンドボックスの
// 中に居てファイルもプロセスも触れない。逆にターミナルの一覧は renderer からも取れるが、
// 「どの常駐が抱えているのか」は main しか結び付けられないので、両方ここで揃える。
//
// 止める・立て直すもここに置く。**どちらも抱えているターミナルを全部失う操作**なので、
// 確認は画面側の仕事にして、こちらは言われたことだけをする（確認をここに置くと、
// コマンドや将来の別経路から確認なしで呼べてしまう）。

import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import {
	IParadisForeignDaemonInfo,
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	PARADIS_PTY_DAEMON_CHANNEL,
	paradisGroupTerminalsBySpace,
} from '../common/paradisPtyDaemonStatus.js';
import { IParadisPtyDaemonRecord } from '../common/paradisPtyDaemonPolicy.js';
import { paradisReadDaemonRecords } from '../node/paradisPtyDaemonLedger.js';
import { paradisPtyDaemonPathsFor } from './paradisPtyHostStarterFactory.js';
import { PARADIS_PTY_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';

/** 状態を集めるのに必要な、ターミナル側の見え方。 */
export interface IParadisDaemonPtyAccess {
	listProcesses(): Promise<IProcessDetails[]>;
	restartPtyHost(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	try {
		// シグナル 0 は送らずに存在だけ確かめる。権限が無い相手は EPERM になるが、
		// 「居る」ことは分かるので生存として扱う。
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === 'EPERM';
	}
}

export class ParadisPtyDaemonStatusService extends Disposable implements IParadisPtyDaemonStatusService {

	constructor(
		private readonly pty: IParadisDaemonPtyAccess,
		private readonly configurationService: IConfigurationService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly productService: IProductService,
		private readonly logService: ILogService,
	) {
		super();
	}

	async getStatus(): Promise<IParadisPtyDaemonStatus> {
		const enabled = this.configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) === true;
		if (!enabled) {
			return { enabled: false, running: false, pid: undefined, buildId: undefined, startedAt: undefined, terminalCount: 0, spaces: [], foreign: [] };
		}

		const paths = paradisPtyDaemonPathsFor(this.environmentMainService, this.productService);
		const records = await paradisReadDaemonRecords(paths.ledgerDir);
		const own = records.find(record => record.buildKey === paths.buildKey && isProcessAlive(record.pid));

		let terminals: IProcessDetails[] = [];
		try {
			terminals = await this.pty.listProcesses();
		} catch (error) {
			// 一覧が取れないのは、繋がっていないか常駐が固まっているとき。本数を 0 と書かずに
			// 空のまま返し、`running` で状態を語らせる。
			this.logService.trace('[ParadisPtyDaemon] could not list terminals for the status entry', error);
		}

		return {
			enabled: true,
			running: own !== undefined,
			pid: own?.pid,
			buildId: own?.buildId,
			startedAt: own?.startedAt,
			terminalCount: terminals.length,
			spaces: paradisGroupTerminalsBySpace(terminals),
			foreign: await this.describeForeign(records, paths.buildKey),
		};
	}

	/**
	 * 別ビルドの常駐を説明する。
	 *
	 * 本数までは踏み込まない。聞くには繋ぐ必要があり、繋ぐと相手のクライアント数が増えて
	 * **アイドル終了の待ち時間が延びる**（自分から終わろうとしていた常駐を、様子を見ただけで
	 * 引き止めることになる）。画面に必要なのは「残っている」ことと、いつからかだけ。
	 */
	private async describeForeign(records: readonly IParadisPtyDaemonRecord[], ownBuildKey: string): Promise<IParadisForeignDaemonInfo[]> {
		const foreign: IParadisForeignDaemonInfo[] = [];
		for (const record of records) {
			if (record.buildKey === ownBuildKey || !isProcessAlive(record.pid)) {
				continue;
			}
			foreign.push({
				pid: record.pid,
				buildId: record.buildId,
				startedAt: record.startedAt,
				terminalCount: undefined,
			});
		}
		return foreign;
	}

	async restart(): Promise<void> {
		await this.stop();
		// 明示的に繋ぎ直す。放っておいても次にターミナルを開いた時点で立ち上がるが、
		// 「立て直す」と言われた以上、押した時点で立っていてほしい。
		await this.pty.restartPtyHost();
	}

	async stop(): Promise<void> {
		const status = await this.getStatus();
		if (status.pid === undefined) {
			return;
		}
		this.terminate(status.pid);
	}

	async stopForeign(pid: number): Promise<void> {
		this.terminate(pid);
	}

	/**
	 * 常駐へ終了を頼む。
	 *
	 * `SIGKILL` は使わない。常駐は終わる前に台帳とソケットを片付けるので、そこを飛ばすと
	 * 次の起動が「居ない常駐」を探しに行くことになる。応答しない相手はそのまま残すが、
	 * それは画面に出ているので、ユーザーが次の手を選べる。
	 */
	private terminate(pid: number): void {
		try {
			process.kill(pid, 'SIGTERM');
			this.logService.info(`[ParadisPtyDaemon] asked the daemon at pid ${pid} to stop`);
		} catch (error) {
			this.logService.warn(`[ParadisPtyDaemon] could not stop the daemon at pid ${pid}`, error);
		}
	}
}

/** `app.ts` から1行で呼べる登録。 */
export function paradisRegisterPtyDaemonStatus(
	server: { registerChannel(name: string, channel: IServerChannel<string>): void },
	pty: IParadisDaemonPtyAccess,
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
	logService: ILogService,
): IDisposable {
	const store = new DisposableStore();
	const service = store.add(new ParadisPtyDaemonStatusService(pty, configurationService, environmentMainService, productService, logService));
	server.registerChannel(PARADIS_PTY_DAEMON_CHANNEL, ProxyChannel.fromService<string>(service, store));
	return store;
}
