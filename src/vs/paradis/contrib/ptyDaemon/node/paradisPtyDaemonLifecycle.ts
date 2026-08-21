/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルが、自分の寿命を管理するところ。
//
// アプリの中で動く pty host には寿命の管理が要らない。親が死ねば一緒に死ぬからで、居座りようが
// ない。常駐にした時点でその保証が無くなるので、**自分がいつ終わるかを自分で決める**必要が
// できる。ここがその1箇所。
//
// 終わり方は3つある。
//
//  1. 誰にも使われないまま時間が経った → 自分から終わる
//  2. 外から止められた (UI の「停止」、更新後の掃除、OS のシャットダウン) → 片付けて終わる
//  3. 抱えているターミナルが猶予時間を過ぎた → `ptyService` が個別に片付け、やがて 1 になる
//
// どの終わり方でも**必ず台帳から名前を消す**。消し損ねると、次に起動したアプリが居ない常駐を
// 探しに行き、繋がらないまま「応答しない常駐」としてユーザーに見せてしまう。害はないが、
// 何度も出れば嘘を言っているのと同じになる。

import { promises as fs } from 'fs';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IPtyService } from '../../../../platform/terminal/common/terminal.js';
import { IParadisPtyDaemonEnv } from '../common/paradisPtyDaemonEnv.js';
import { IParadisPtyDaemonControl, IParadisPtyDaemonDescription, PARADIS_PTY_DAEMON_AUTH_CHANNEL, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../common/paradisPtyDaemonControl.js';
import { ParadisPtyDaemonAuth, paradisCreateDaemonToken } from './paradisPtyDaemonAuth.js';
import { paradisShouldDaemonExit } from '../common/paradisPtyDaemonPolicy.js';
import { paradisRemoveDaemonRecord, paradisWriteDaemonRecord } from './paradisPtyDaemonLedger.js';

/** 終わり時を見に行く間隔。判断そのものは軽いので、細かく刻む意味は無い。 */
const CHECK_INTERVAL = 60_000;

/** 常駐が使う、サーバー側の見え方。繋がりを数えるのと、制御の口を出すのに要る。 */
export interface IParadisDaemonConnections {
	readonly connections: readonly unknown[];
	readonly onDidAddConnection: Event<unknown>;
	readonly onDidRemoveConnection: Event<unknown>;
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

export interface IParadisPtyDaemonLifecycleOptions {
	readonly env: IParadisPtyDaemonEnv;
	readonly connections: IParadisDaemonConnections;
	/**
	 * 常駐が抱えているものを数える相手。
	 *
	 * `paradisListHeldTerminals` は `PtyService` の fork 追加分 (upstream の `listProcesses` は
	 * 繋がっていないものしか返さない)。無い場合に備えて任意にしてあるが、実際には
	 * `ptyHostMain.ts` が実体を渡すので必ず在る。
	 */
	readonly ptyService: IPtyService & { paradisListHeldTerminals?(): Promise<{ workspaceName: string }[]> };
	readonly logService: ILogService;
	/** 終わるときに呼ぶ。既定は `process.exit`。テストでは差し替える。 */
	readonly exit?: () => void;
	readonly now?: () => number;
}

export class ParadisPtyDaemonLifecycle extends Disposable implements IParadisPtyDaemonControl {

	private idleSince: number;
	private startedAt = 0;
	private exiting = false;

	/**
	 * この常駐の身元。**台帳にしか書かない**（引数やプロセス一覧に出さない）。
	 *
	 * 環境変数で渡さないのは、`ps` や `/proc` から他のユーザーに見えるプラットフォームが
	 * あるため。台帳なら 0600 で守れる。
	 */
	private readonly token = paradisCreateDaemonToken();

	constructor(private readonly options: IParadisPtyDaemonLifecycleOptions) {
		super();
		this.idleSince = this.now();

		// 外から止めるための口。**pid ではなくここへ繋いで頼んでもらう**ため、常駐の側が
		// 用意する (理由は paradisPtyDaemonControl.ts)。
		const channelStore = this._register(new DisposableStore());
		options.connections.registerChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL, ProxyChannel.fromService<string>(this, channelStore));
		// 名乗り合う口。繋ぎに来た側はここを通ってから本題に入る。
		options.connections.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, ProxyChannel.fromService<string>(new ParadisPtyDaemonAuth(this.token), channelStore));

		this._register(options.connections.onDidAddConnection(() => this.onConnectionsChanged()));
		this._register(options.connections.onDidRemoveConnection(() => this.onConnectionsChanged()));

		const timer = setInterval(() => void this.checkIdle(), CHECK_INTERVAL);
		this._register(toDisposable(() => clearInterval(timer)));

		for (const signal of ['SIGTERM', 'SIGINT'] as const) {
			const handler = () => void this.shutdown(`signal ${signal}`);
			process.on(signal, handler);
			this._register(toDisposable(() => process.removeListener(signal, handler)));
		}
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	/** 台帳へ名乗る。ここに失敗したら常駐を続けない (誰にも見つけてもらえないため)。 */
	async announce(): Promise<void> {
		this.startedAt = this.now();
		await paradisWriteDaemonRecord(this.options.env.ledgerFile, {
			pid: process.pid,
			socketPath: this.options.env.socketPath,
			buildId: this.options.env.buildId,
			buildKey: this.options.env.buildKey,
			startedAt: this.startedAt,
			token: this.token,
		});
		this.options.logService.info(`[ParadisPtyDaemon] listening on ${this.options.env.socketPath} (${this.options.env.buildId})`);
	}

	private onConnectionsChanged(): void {
		// 最後の1つが切れた時点から数え直す。繋がっている間は待ち時間が進まない。
		if (this.options.connections.connections.length === 0) {
			this.idleSince = this.now();
		}
	}

	/** 自分について答える。繋がった時点で身元は証明されているので、確認ではなく表示のため。 */
	async describe(): Promise<IParadisPtyDaemonDescription> {
		let terminals: { workspaceName: string }[] = [];
		try {
			terminals = await this.heldTerminals();
		} catch {
			// 数えられないなら 0 とは言わずに…と言いたいところだが、ここは表示専用なので
			// 空を返して構わない。判断に使う `checkIdle` は別で、そちらは数えられないと動かない。
		}
		return {
			pid: process.pid,
			buildId: this.options.env.buildId,
			startedAt: this.startedAt,
			terminals: terminals.map(terminal => ({ workspaceName: terminal.workspaceName })),
		};
	}

	/**
	 * 抱えているターミナル。**繋がっているものも含める。**
	 *
	 * `listProcesses()` へ落ちるのは、fork の追加分が無い相手を渡された場合だけ。そのときは
	 * 繋がっていないものしか数えられないが、何も数えられないよりはよい。
	 */
	private async heldTerminals(): Promise<{ workspaceName: string }[]> {
		const pty = this.options.ptyService;
		return pty.paradisListHeldTerminals ? pty.paradisListHeldTerminals() : pty.listProcesses();
	}

	private async checkIdle(): Promise<void> {
		if (this.exiting) {
			return;
		}
		let terminalCount: number;
		try {
			terminalCount = (await this.heldTerminals()).length;
		} catch (error) {
			// 数えられないなら、抱えているものが分からないということ。分からないまま終わらない。
			this.options.logService.warn('[ParadisPtyDaemon] could not count terminals', error);
			return;
		}
		const state = {
			terminalCount,
			clientCount: this.options.connections.connections.length,
			idleSince: this.idleSince,
		};
		if (paradisShouldDaemonExit(state, this.now())) {
			await this.shutdown('idle');
		}
	}

	/**
	 * 片付けて終わる。
	 *
	 * 台帳とソケットを先に消してから抱えているものを片付ける。逆にすると、片付けている間
	 * (シェルの終了を待つ間) に新しいウィンドウが台帳を見て繋ぎに来る余地が残る。
	 */
	async shutdown(reason: string = 'asked to stop'): Promise<void> {
		if (this.exiting) {
			return;
		}
		this.exiting = true;
		this.options.logService.info(`[ParadisPtyDaemon] shutting down (${reason})`);
		await paradisRemoveDaemonRecord(this.options.env.ledgerFile);
		try {
			await fs.unlink(this.options.env.socketPath);
		} catch {
			// Windows の名前付きパイプには実体が無い。unix でも既に消えていることがある。
		}
		this.dispose();
		(this.options.exit ?? (() => process.exit(0)))();
	}
}

/** {@link ParadisPtyDaemonLifecycle} を起こす。`ptyHostMain.ts` から1行で呼べる形。 */
export function paradisRunPtyDaemonLifecycle(options: IParadisPtyDaemonLifecycleOptions): ParadisPtyDaemonLifecycle {
	const lifecycle = new ParadisPtyDaemonLifecycle(options);
	lifecycle.announce().catch(error => {
		options.logService.error('[ParadisPtyDaemon] could not write the ledger; standing down', error);
		void lifecycle.shutdown('ledger write failed');
	});
	return lifecycle;
}
