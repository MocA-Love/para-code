/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナル(pty デーモン)を起こして繋ぐ。`ElectronPtyHostStarter` の置き換え。
//
// upstream の起こし方 (`UtilityProcess`) は、アプリが終われば必ず道連れになる。ここでやるのは
// **道連れにならない起こし方**で、違いは3つしかない。
//
//  1. `child_process.fork` ではなく `spawn` に `detached` を付ける。プロセスグループが分かれる
//     ので、アプリを終わらせるシグナルが届かない
//  2. `VSCODE_PARENT_PID` を**渡さない**。渡すと `bootstrap-fork.ts` が5秒ごとに親の生死を見て
//     自分を殺す。ここが一番の落とし穴で、渡したままだとアプリ終了の5秒後に静かに全部消える
//  3. 標準入出力を切り離す。繋いだままだと、アプリの終了時に閉じたパイプへ書いて落ちる
//
// 繋ぎ方は、常駐が既に居ればそれへ繋ぐだけ。居なければ起こしてから繋ぐ。**起こす前に必ず一度
// 繋ぎに行く**のは、同じ常駐へ2つ目を起こさないため (2つ立つと、ウィンドウごとに見える
// ターミナルが変わり、しかもどちらも正常に見える)。

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { createConnection } from 'net';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { removeDangerousEnvVariables } from '../../../../base/common/processes.js';
import { IChannel, IChannelClient, getDelayedChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IReconnectConstants } from '../../../../platform/terminal/common/terminal.js';
import { IPtyHostConnection, IPtyHostStarter } from '../../../../platform/terminal/node/ptyHost.js';
import { UtilityProcess } from '../../../../platform/utilityProcess/electron-main/utilityProcess.js';
import { IpcMainEvent } from 'electron';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisPtyDaemonPaths } from '../common/paradisPtyDaemonPaths.js';
import { paradisPtyDaemonEnv, PARADIS_PTY_DAEMON_LEDGER, PARADIS_PTY_DAEMON_SOCKET } from '../common/paradisPtyDaemonEnv.js';
import { PARADIS_DAEMON_TERMINAL_GRACE_TIME } from '../common/paradisPtyDaemonPolicy.js';
import { paradisAuthenticateDaemon } from '../node/paradisPtyDaemonAuth.js';
import { paradisReadDaemonRecords } from '../node/paradisPtyDaemonLedger.js';

/** 起こしてから繋がるまで待つ上限。ここを超えたら常駐は諦める。 */
const CONNECT_TIMEOUT = 20_000;

/** 繋ぎ直しの間隔。常駐が listen を始めるまでの数百ミリ秒を埋めるだけなので短くてよい。 */
const CONNECT_RETRY_DELAY = 100;

/** 橋渡しプロセスの入口。ビルドのエントリ一覧 (build/buildfile.ts) にも同じ名前が要る。 */
const BRIDGE_ENTRY_POINT = 'vs/paradis/contrib/ptyDaemon/node/paradisPtyDaemonBridgeMain';

/**
 * 名乗り合いに失敗したあと、次に試すまで待つ時間。
 *
 * 失敗の意味は「その名前を別の誰かが持っている」で、繋ぎ直しても同じ相手に当たる。すぐ
 * やり直すと、繋ぐ→拒む→やり直すの空回りになるので間を置く。永久に諦めないのは、常駐が
 * 入れ替わる途中に当たっただけ、という可能性を残すため。
 */
const AUTH_FAILURE_COOLDOWN = 30_000;

function paradisTryConnect(socketPath: string): Promise<NodeSocket | undefined> {
	return new Promise<NodeSocket | undefined>(resolve => {
		let settled = false;
		const done = (result: NodeSocket | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (!result) {
				socket.destroy();
			}
			resolve(result);
		};
		const socket = createConnection({ path: socketPath });
		socket.once('connect', () => done(new NodeSocket(socket, 'paradis-pty-daemon')));
		socket.once('error', () => done(undefined));
	});
}

export class ParadisDaemonPtyHostStarter extends Disposable implements IPtyHostStarter {

	private readonly _onRequestConnection = this._register(new Emitter<void>());
	readonly onRequestConnection = this._onRequestConnection.event;
	private readonly _onWillShutdown = this._register(new Emitter<void>());
	readonly onWillShutdown = this._onWillShutdown.event;

	/** ウィンドウ用の橋渡し。状態を持たないので、アプリと一緒に死んでよい。 */
	private bridge: UtilityProcess | undefined;

	/**
	 * 常駐が応答するようになるまでの約束。main もウィンドウもこれを待ってから繋ぐ。
	 *
	 * ウィンドウ側がこれを待たないと、**ターミナルの操作が黙って固まる**。橋は繋がらなければ
	 * ポートを閉じるが、renderer はポートを受け取った時点で `_directProxy` を完成させてしまう
	 * (`localTerminalBackend.ts`)。閉じた口の向こうからは返事が来ないので、以後の呼び出しが
	 * 返らなくなる。
	 */
	private daemonReady: Promise<void> | undefined;

	/** 最後に名乗り合いを断られた時刻。空回りを止めるためだけに持つ。 */
	private lastAuthFailureAt = 0;

	constructor(
		private readonly reconnectConstants: IReconnectConstants,
		private readonly paths: IParadisPtyDaemonPaths,
		private readonly buildId: string,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.lifecycleMainService.onWillShutdown(() => this._onWillShutdown.fire()));
		validatedIpcMain.on('vscode:createPtyHostMessageChannel', (e, nonce) => this.onWindowConnection(e, nonce));
		this._register(toDisposable(() => validatedIpcMain.removeHandler('vscode:createPtyHostMessageChannel')));
	}

	start(): IPtyHostConnection {
		// 繋ぎ直し (常駐が落ちた後の立て直し) では、前回の「もう起きている」を持ち越さない。
		this.daemonReady = undefined;
		const store = new DisposableStore();
		const onDidProcessExit = store.add(new Emitter<{ code: number; signal: string }>());

		// 繋がるまでの間に来た呼び出しは、繋がってから流れる。`PtyHostService` は start() が
		// 同期で返ることを前提にしているので、待たせるならこの形しかない。
		const connecting = this.connect().then(client => {
			store.add(client);
			// 常駐が落ちた・繋がりが切れた。`PtyHostService` はこれを見て起こし直すので、次に
			// ターミナルを開いたときに常駐が立て直る。
			store.add(client.onDidDispose(() => onDidProcessExit.fire({ code: 1, signal: '' })));
			return client;
		});
		connecting.catch(error => {
			this.logService.error('[ParadisPtyDaemon] could not reach the daemon', error);
			reportParadisDiagnosticError('owned', 'pty-daemon', 'not-ready', error);
			onDidProcessExit.fire({ code: 1, signal: '' });
		});

		const client: IChannelClient = {
			getChannel: <T extends IChannel>(channelName: string): T => getDelayedChannel<T>(connecting.then(c => c.getChannel<T>(channelName))),
		};

		return { client, store, onDidProcessExit: onDidProcessExit.event };
	}

	/** 既に居ればそれへ、居なければ起こしてから繋ぐ。 */
	private async connect(): Promise<SocketClient<string>> {
		await this.ensureDaemonReady();
		const socket = await paradisTryConnect(this.paths.socketPath);
		if (!socket) {
			throw new Error(`the pty daemon stopped answering on ${this.paths.socketPath}`);
		}
		const client = SocketClient.fromSocket(socket, 'main');
		if (!await this.isGenuine(client)) {
			client.dispose();
			this.lastAuthFailureAt = Date.now();
			// **繋がったことを身元だと思わない。** ソケットの名前は他のユーザーにも計算でき、
			// 先に作った側が持ち主になる。偽物へ繋ぐと、ターミナルの環境変数一式と全打鍵が
			// そのまま渡る。確かめられない相手は使わない。
			throw new Error(`whatever is listening on ${this.paths.socketPath} is not this build's pty daemon`);
		}
		return client;
	}

	/**
	 * 繋いだ相手が本物か。台帳に置いた身元を、流さずに示し合って確かめる。
	 *
	 * 台帳が読めない・自分のビルドの記録が無いときは確かめようがないので false。ここを
	 * 「読めないから通す」にすると、確かめる仕組み自体が無いのと同じになる。
	 */
	private async isGenuine(client: SocketClient<string>): Promise<boolean> {
		const records = await paradisReadDaemonRecords(this.paths.ledgerDir);
		const own = records.find(record => record.buildKey === this.paths.buildKey);
		if (!own) {
			this.logService.warn(`[ParadisPtyDaemon] no ledger entry for this build; cannot tell who is on ${this.paths.socketPath}`);
			return false;
		}
		return paradisAuthenticateDaemon(client, own.token);
	}

	/**
	 * 常駐が応答する状態にする。何度呼んでも起こすのは1回。
	 *
	 * 失敗したら約束を捨てる。捨てないと、一度の失敗 (起動が間に合わなかった等) がそのまま
	 * 焼き付いて、以後どのウィンドウも二度と繋がらなくなる。
	 */
	private ensureDaemonReady(): Promise<void> {
		if (!this.daemonReady) {
			const attempt = this.startDaemonIfNeeded();
			this.daemonReady = attempt;
			attempt.catch(() => {
				if (this.daemonReady === attempt) {
					this.daemonReady = undefined;
				}
			});
		}
		return this.daemonReady;
	}

	private async startDaemonIfNeeded(): Promise<void> {
		if (Date.now() - this.lastAuthFailureAt < AUTH_FAILURE_COOLDOWN) {
			throw new Error(`not retrying ${this.paths.socketPath} yet; the last handshake was refused`);
		}
		const existing = await paradisTryConnect(this.paths.socketPath);
		if (existing) {
			existing.dispose();
			this.logService.info(`[ParadisPtyDaemon] joined the daemon already running at ${this.paths.socketPath}`);
			return;
		}

		this.spawnDaemon();

		const deadline = Date.now() + CONNECT_TIMEOUT;
		for (; ;) {
			await new Promise<void>(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY));
			const socket = await paradisTryConnect(this.paths.socketPath);
			if (socket) {
				socket.dispose();
				this.logService.info(`[ParadisPtyDaemon] started a daemon at ${this.paths.socketPath}`);
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error(`the pty daemon did not answer on ${this.paths.socketPath}`);
			}
		}
	}

	/**
	 * 常駐の出力を書き出す先を開く。開けなければ捨てる（起動そのものは止めない）。
	 *
	 * ここに出るのは、**ログの仕組みが立ち上がる前に落ちたとき**の理由だけ。常駐が動き出せば
	 * 通常のログへ書くので、このファイルはほとんど空のままになる。空でないときは、起動に
	 * 失敗しているということ。
	 */
	private openDaemonLog(): number | 'ignore' {
		try {
			const dir = this.environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath;
			mkdirSync(dir, { recursive: true });
			return openSync(join(dir, 'paradis-ptydaemon-startup.log'), 'a');
		} catch (error) {
			this.logService.warn('[ParadisPtyDaemon] could not open a startup log for the daemon', error);
			return 'ignore';
		}
	}

	/**
	 * 常駐を起こす。**アプリの寿命から外す**のがここの仕事のすべて。
	 *
	 * `unref()` まで済ませて、以後は一切面倒を見ない。起きたかどうかは繋いで確かめる
	 * (起動の成否をプロセスの側から知ろうとすると、それだけで親子の縁が残る)。
	 */
	private spawnDaemon(): void {
		const env: { [key: string]: string | undefined } = {
			...process.env,
			...paradisPtyDaemonEnv(this.paths, this.buildId),
			ELECTRON_RUN_AS_NODE: '1',
			VSCODE_ESM_ENTRYPOINT: 'vs/platform/terminal/node/ptyHostMain',
			// 接続先 (SSH) と同じ長さ。ローカルには `--reconnection-grace-time` に相当する
			// 利用者の指定が無い (あれはサーバー側の引数で、こちらは
			// `LocalReconnectConstants.GraceTime` の 60 秒固定) ので、上書きしている指定は無い。
			VSCODE_RECONNECT_GRACE_TIME: String(PARADIS_DAEMON_TERMINAL_GRACE_TIME),
			VSCODE_RECONNECT_SHORT_GRACE_TIME: String(this.reconnectConstants.shortGraceTime),
			VSCODE_RECONNECT_SCROLLBACK: String(this.reconnectConstants.scrollback),
		};
		// これが残っていると `bootstrap-fork.ts` が5秒ごとに親を見て自分を殺す。常駐にする以上、
		// 親が死ぬのは異常ではなく普通のことなので、監視そのものを渡さない。
		delete env['VSCODE_PARENT_PID'];
		// ログをパイプで親へ返す仕掛けも外す。受け取る親がもう居ない。
		delete env['VSCODE_PIPE_LOGGING'];
		// upstream が fork するときに通している前処理 (`DEBUG` と `NODE_OPTIONS` を落とす)。
		// アプリの中で動く pty host では「起動が壊れる」程度の話だが、常駐では意味が変わる。
		// `.envrc` などから `NODE_OPTIONS=--inspect=…` が紛れ込むと、**アプリを終了した後も
		// 開いたままのデバッガポート**になる。
		removeDangerousEnvVariables(env);

		const logHandle = this.openDaemonLog();

		// Snap の Linux では、アプリの起動時に注入されたライブラリパスがそのまま子へ伝わり、
		// そこから起きるシェルにまで波及する。upstream の `ElectronPtyHostStarter` と同じ手順で、
		// 渡す間だけ外す。
		this.environmentMainService.unsetSnapExportedVariables();
		const child = spawn(process.execPath, [
			FileAccess.asFileUri('bootstrap-fork').fsPath,
			'--type=ptyHost',
			'--logsPath', this.environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath,
			// **必ず渡す。** 常駐は自分の `--user-data-dir` から置き場所を計算し直して、渡された
			// ものと一致するかを確かめる (環境変数だけで任意の場所に居座らせないため)。渡さないと
			// 常駐だけが既定の場所を見るので、`--user-data-dir` を使っている構成 (開発ビルド、
			// ポータブル、明示指定) では毎回一致せず、常駐が起動を拒み続ける。
			'--user-data-dir', this.environmentMainService.userDataPath,
		], {
			detached: true,
			// 標準出力を捨てない。ここを捨てると、ログの仕組みが立つ前に落ちた常駐が**何も
			// 残さずに消える**。起動しない理由が「ターミナルが開かない」以外に何も出てこない
			// という、一番調べにくい形になる。
			stdio: ['ignore', logHandle, logHandle],
			env,
		});
		this.environmentMainService.restoreSnapExportedVariables();
		// 渡し終えたら親側の口は閉じる。開いたままだと、常駐が死んでもこちらが掴み続ける。
		if (logHandle !== 'ignore') {
			try {
				closeSync(logHandle);
			} catch {
				// 閉じられなくても起動には関わらない。
			}
		}
		child.on('error', error => {
			this.logService.error('[ParadisPtyDaemon] failed to spawn the daemon process', error);
			reportParadisDiagnosticError('owned', 'pty-daemon', 'spawn-failed', error);
		});
		child.unref();
	}

	/**
	 * ウィンドウからの直結要求。橋渡しプロセスのポートを渡す。
	 *
	 * 渡すのは常駐そのものへの口ではなく橋への口だが、ウィンドウから見た形は upstream と同じ
	 * なので、`localTerminalBackend.ts` 側には手を入れずに済む。
	 */
	private onWindowConnection(e: IpcMainEvent, nonce: string): void {
		this._onRequestConnection.fire();
		void this.postBridgePort(e, nonce);
	}

	/**
	 * 橋のポートを渡す。**常駐が応答するようになってから**渡す。
	 *
	 * 先に渡すと、橋は繋ぎ先が無いのでポートを閉じるが、renderer は受け取った時点で直結の
	 * proxy を完成させてしまい、以後ターミナルの操作が返らなくなる。届かなかったときは渡さない
	 * (渡さなければ renderer は `_localPtyService` 側で動き続ける)。
	 */
	private async postBridgePort(e: IpcMainEvent, nonce: string): Promise<void> {
		try {
			await this.ensureDaemonReady();
		} catch (error) {
			this.logService.error('[ParadisPtyDaemon] not handing a port to the window; the daemon never answered', error);
			reportParadisDiagnosticError('owned', 'pty-daemon', 'not-ready', error);
			return;
		}
		if (this._store.isDisposed || e.sender.isDestroyed()) {
			return;
		}
		const port = this.ensureBridge().connect();
		if (e.sender.isDestroyed()) {
			port.close();
			return;
		}
		e.sender.postMessage('vscode:createPtyHostMessageChannelResult', nonce, [port]);
	}

	private ensureBridge(): UtilityProcess {
		if (this.bridge) {
			return this.bridge;
		}
		const env: { [key: string]: string } = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === 'string') {
				env[key] = value;
			}
		}
		env[PARADIS_PTY_DAEMON_SOCKET] = this.paths.socketPath;
		// 橋も相手が本物かを確かめる。token は台帳から読むので、その場所を渡す
		// (token そのものを環境変数で渡すと、`ps` から見えるプラットフォームがある)。
		env[PARADIS_PTY_DAEMON_LEDGER] = this.paths.ledgerFile;
		env['VSCODE_ESM_ENTRYPOINT'] = BRIDGE_ENTRY_POINT;

		const bridge = new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService);
		bridge.start({
			type: 'paradisPtyDaemonBridge',
			name: 'pty-daemon-bridge',
			entryPoint: BRIDGE_ENTRY_POINT,
			env,
		});
		this._register(bridge.onExit(() => {
			if (this.bridge === bridge) {
				this.bridge = undefined;
			}
		}));
		this.bridge = bridge;
		return bridge;
	}

	override dispose(): void {
		// 橋は捨てるが常駐は残す。ここで常駐まで止めると、アプリを閉じた瞬間に
		// ターミナルが全部消えることになり、常駐にした意味が無くなる。
		this.bridge?.kill();
		this.bridge?.dispose();
		this.bridge = undefined;
		super.dispose();
	}
}
