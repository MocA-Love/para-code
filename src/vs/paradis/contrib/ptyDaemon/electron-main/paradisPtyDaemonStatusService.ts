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

import { createConnection } from 'net';
import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { IParadisPtyDaemonControl, IParadisPtyDaemonDescription, PARADIS_PTY_DAEMON_CONTROL_CHANNEL } from '../common/paradisPtyDaemonControl.js';
import { paradisAuthenticateDaemon } from '../node/paradisPtyDaemonAuth.js';
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

/** 止めるときに常駐の応答を待つ上限。応答しない相手をいつまでも待たない。 */
const CONNECT_TIMEOUT = 2_000;

/** 状態を聞いたときの返事を待つ上限。閉じる処理には関わらないが、画面が凍るのを防ぐ。 */
const DESCRIBE_TIMEOUT = 3_000;

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

	/**
	 * 常駐へ繋いだままにする制御用の接続。
	 *
	 * 数を聞くたびに繋ぎ直さないのは、接続のたびに常駐側へ後始末されない `Protocol` が
	 * 溜まるため (`IPCServer` は切断時にチャネルは畳むが Protocol は畳まない)。30秒ごとに
	 * 増え続けるのは避ける。
	 */
	private control: { readonly client: SocketClient<string>; readonly service: IParadisPtyDaemonControl; readonly pid: number } | undefined;

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
			return { enabled: false, running: false, pid: undefined, buildId: undefined, startedAt: undefined, terminalCount: undefined, spaces: [], foreign: [] };
		}

		const paths = paradisPtyDaemonPathsFor(this.environmentMainService, this.productService);
		const records = await paradisReadDaemonRecords(paths.ledgerDir);
		const own = records.find(record => record.buildKey === paths.buildKey && isProcessAlive(record.pid));

		// **`listProcesses()` では数えられない。** あちらは `isOrphan` で絞るので、ウィンドウが
		// 繋がっているターミナル (つまり普通に使っている最中のもの) は1本も出てこない。常駐へ
		// 直接聞く。
		// **聞けなかったときは undefined のまま返す。** `[]` で初期化すると本数が 0 になり、
		// 受け取る側は「本当に0本」と区別できない。
		let terminals: readonly { readonly workspaceName: string }[] | undefined;
		if (own) {
			try {
				terminals = (await this.describeDaemon(own)).terminals;
			} catch (error) {
				// 繋がっていないか、常駐が固まっている。分からないままにする。
				this.logService.trace('[ParadisPtyDaemon] could not ask the daemon what it holds', error);
			}
		}

		return {
			enabled: true,
			running: own !== undefined,
			pid: own?.pid,
			buildId: own?.buildId,
			startedAt: own?.startedAt,
			terminalCount: terminals?.length,
			spaces: terminals ? paradisGroupTerminalsBySpace(terminals) : [],
			foreign: await this.describeForeign(records, paths.buildKey),
		};
	}

	/**
	 * 常駐に、いま何を抱えているかを聞く。接続は保ったまま使い回す。
	 *
	 * 返事にも上限を置く。繋ぐところだけ上限を付けても、**繋がったのに答えない**常駐
	 * (固まっている場合) には効かない。上限が無いと `getStatus()` が解決しないまま、
	 * 定期更新の待ちが積み上がってパネルが古い値で凍る。
	 */
	private async describeDaemon(record: IParadisPtyDaemonRecord): Promise<IParadisPtyDaemonDescription> {
		const control = await this.ensureControl(record);
		const described = await raceTimeout(control.describe(), DESCRIBE_TIMEOUT);
		if (!described) {
			throw new Error(`the daemon at ${record.socketPath} did not answer in time`);
		}
		return described;
	}

	/**
	 * 制御用の接続を用意する。相手が入れ替わっていたら繋ぎ直す。
	 *
	 * pid が変わったら別の常駐なので、前の接続は捨てる。名乗り合いも毎回通す (繋がることは
	 * 身元の証明にならない)。
	 */
	private async ensureControl(record: IParadisPtyDaemonRecord): Promise<IParadisPtyDaemonControl> {
		if (this.control && this.control.pid === record.pid) {
			return this.control.service;
		}
		this.disposeControl();

		const socket = await this.connect(record.socketPath);
		if (!socket) {
			throw new Error(`nothing answered at ${record.socketPath}`);
		}
		const client = SocketClient.fromSocket(socket, 'paradis-daemon-status');
		if (!await paradisAuthenticateDaemon(client, record.token)) {
			client.dispose();
			throw new Error(`whatever answers at ${record.socketPath} is not one of ours`);
		}
		const service = ProxyChannel.toService<IParadisPtyDaemonControl>(client.getChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL));
		this.control = { client, service, pid: record.pid };
		// 相手が落ちたら捨てる。掴んだままだと、次の常駐へ繋ぎ直さずに黙って失敗し続ける。
		client.onDidDispose(() => {
			if (this.control?.client === client) {
				this.control = undefined;
			}
		});
		return service;
	}

	private disposeControl(): void {
		this.control?.client.dispose();
		this.control = undefined;
	}

	override dispose(): void {
		this.disposeControl();
		super.dispose();
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
		const paths = paradisPtyDaemonPathsFor(this.environmentMainService, this.productService);
		const records = await paradisReadDaemonRecords(paths.ledgerDir);
		const own = records.find(record => record.buildKey === paths.buildKey);
		if (!own) {
			return;
		}
		await this.askToStop(own.socketPath, own.token);
	}

	/**
	 * 別ビルドの常駐を止める。
	 *
	 * 受け取った pid は**そのままでは使わない**。台帳を読み直して、その pid の record が今も
	 * あることを確かめ、繋ぎ先はその record が名乗るソケットにする。渡された番号をそのまま
	 * 信じると、呼び出し側の間違いや古い画面の情報で、関係のない相手に手を出すことになる。
	 */
	async stopForeign(pid: number): Promise<void> {
		const paths = paradisPtyDaemonPathsFor(this.environmentMainService, this.productService);
		const records = await paradisReadDaemonRecords(paths.ledgerDir);
		const record = records.find(candidate => candidate.pid === pid && candidate.buildKey !== paths.buildKey);
		if (!record) {
			this.logService.info(`[ParadisPtyDaemon] no ledger entry for pid ${pid} any more; nothing to stop`);
			return;
		}
		await this.askToStop(record.socketPath, record.token);
	}

	/**
	 * 常駐へ終了を頼む。**繋いで頼む。番号で殺さない。**
	 *
	 * 以前はここで台帳の pid へ `SIGTERM` を送っていたが、pid は身元ではない。常駐が異常終了
	 * すると台帳が残り、OS が pid を使い回すので、残った番号は無関係の生きたプロセスを指す
	 * (PC を再起動した後は特に起きやすい)。その状態で「停止」を押すと、進行中のビルドや
	 * ssh-agent が落ちる。繋がるかどうかそのものが身元の証明になるので、繋いで頼む。
	 *
	 * 繋がらない相手には**何もしない**。固まっているのか、番号が使い回されたのか、こちらからは
	 * 区別できない。区別できないものを殺してよい理由が無い (`paradisJudgeUnreachableDaemon`)。
	 */
	private async askToStop(socketPath: string, token: string): Promise<void> {
		const socket = await this.connect(socketPath);
		if (!socket) {
			this.logService.warn(`[ParadisPtyDaemon] nothing answered at ${socketPath}; leaving it alone`);
			return;
		}
		const client = SocketClient.fromSocket(socket, 'paradis-daemon-control');
		try {
			// 繋がっただけでは身元にならない。名乗り合いを通らない相手を止めに行かない
			// (その名前を持っているのが誰なのか、こちらには分からない)。
			if (!await paradisAuthenticateDaemon(client, token)) {
				this.logService.warn(`[ParadisPtyDaemon] whatever answers at ${socketPath} is not one of ours; leaving it alone`);
				return;
			}
			const control = ProxyChannel.toService<IParadisPtyDaemonControl>(client.getChannel(PARADIS_PTY_DAEMON_CONTROL_CHANNEL));
			// 返事は待てない。常駐は片付けてから `process.exit` するので、返事が返る前に
			// 接続が切れる。届いたことは、繋がった時点で分かっている。
			control.shutdown().catch(() => { });
			this.logService.info(`[ParadisPtyDaemon] asked the daemon at ${socketPath} to stop`);
		} finally {
			client.dispose();
		}
	}

	/** 常駐のソケットへ繋ぐ。応答しなければ undefined。 */
	private connect(socketPath: string): Promise<NodeSocket | undefined> {
		return new Promise<NodeSocket | undefined>(resolve => {
			let settled = false;
			const done = (result: NodeSocket | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (!result) {
					socket.destroy();
				}
				resolve(result);
			};
			const socket = createConnection({ path: socketPath });
			const timer = setTimeout(() => done(undefined), CONNECT_TIMEOUT);
			socket.once('connect', () => done(new NodeSocket(socket, 'paradis-daemon-control')));
			socket.once('error', () => done(undefined));
		});
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
