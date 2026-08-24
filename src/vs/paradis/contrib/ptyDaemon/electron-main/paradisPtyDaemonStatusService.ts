/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// この PC の常駐ターミナルの状態を画面へ渡す。main プロセス側。
//
// ここが main に居るのは、**台帳を読めるのが main だけ**だから。renderer はサンドボックスの
// 中に居てファイルもプロセスも触れない。
//
// **集める中身は持たない。** 実体は `node/paradisDaemonStatusCollector.ts` で、接続先(REH)の
// 常駐を答える側 (`node/paradisPtyDaemonStatusServer.ts`) と共有している。ここが持つのは
// 「この PC ではどこを見るか」だけ。
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
import {
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	PARADIS_PTY_DAEMON_CHANNEL,
	paradisDisabledDaemonStatus,
} from '../common/paradisPtyDaemonStatus.js';
import { IParadisDaemonLedgerScope, ParadisDaemonStatusCollector } from '../node/paradisDaemonStatusCollector.js';
import { paradisActiveDaemonLedger, paradisAllDaemonLedgers, paradisAnyDaemonEnabled } from './paradisPtyHostStarterFactory.js';

/** 立て直すのに必要な、ターミナル側の見え方。 */
export interface IParadisDaemonPtyAccess {
	restartPtyHost(): Promise<void>;
}

export class ParadisPtyDaemonStatusService extends Disposable implements IParadisPtyDaemonStatusService {

	private readonly collector: ParadisDaemonStatusCollector;

	constructor(
		private readonly pty: IParadisDaemonPtyAccess,
		private readonly configurationService: IConfigurationService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly productService: IProductService,
		logService: ILogService,
	) {
		super();
		this.collector = this._register(new ParadisDaemonStatusCollector(logService));
	}

	/**
	 * この PC で見る台帳。
	 *
	 * **切り替えの途中では両方見る。** 旧い常駐が端末を抱えたまま走っている状態で新しい方へ
	 * 切り替えると、片方しか見ていないと旧い常駐は状態パネルにも出ず、止める手立ても無くなる。
	 */
	private scope(): IParadisDaemonLedgerScope {
		return {
			ledgerDirs: paradisAllDaemonLedgers(this.configurationService, this.environmentMainService, this.productService),
			activeBuildKey: paradisActiveDaemonLedger(this.configurationService, this.environmentMainService, this.productService).buildKey,
		};
	}

	async getStatus(): Promise<IParadisPtyDaemonStatus> {
		// **どちらの常駐でも同じ答えを返す。** 片方しか見ないと、新しい方を選んだ人には
		// 「動いていない」と見え、終了時に残すかの判断がそこで false に倒れて全部畳まれる。
		if (!paradisAnyDaemonEnabled(this.configurationService)) {
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
