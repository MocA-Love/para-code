/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 薄い常駐に繋ぐ。居なければ起こす。
//
// **ここが node レイヤーに居るのが肝。** ローカルでは pty ホスト（アプリの中の別プロセス）が、
// SSH ではリモートのサーバーが、まったく同じこの道を通る。Electron の口を一切使っていないので、
// 両方で同じコードが動く。前の常駐は main プロセスから起こしており、Electron に縛られていた
// ぶんリモートへ持っていけなかった。
//
// **すでに居るなら起こさない。** これが「更新をまたいで繋ぎ直せる」の実体で、新しいアプリが
// 古いアプリの残した常駐を見つけて繋ぐ、というだけのこと。名前が protocol の版だけで決まるので
// (`paradisPtyHostPaths.ts`)、ビルドが違っても同じ名前に辿り着く。

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { createConnection } from 'net';
import { timeout } from '../../../../base/common/async.js';
import { dirname, join } from '../../../../base/common/path.js';
import { removeDangerousEnvVariables } from '../../../../base/common/processes.js';
import { Promises } from '../../../../base/node/pfs.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { paradisAuthenticateDaemon } from './paradisPtyDaemonAuth.js';
import { paradisReadDaemonRecords } from './paradisPtyDaemonLedger.js';
import { IParadisPtyHost, PARADIS_PTY_HOST_CHANNEL, paradisPtyHostClientId, PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';

/** 1回の接続試行を待つ上限。 */
const CONNECT_TIMEOUT = 2_000;

/** 起こしてから待つ上限。ここを過ぎたら常駐を諦めて、今までどおりアプリの中で動かす。 */
const STARTUP_TIMEOUT = 10_000;

/** 起動ログの上限。超えたら捨てて始め直す（常駐を起こすたびに追記されるため）。 */
const STARTUP_LOG_LIMIT = 1024 * 1024;

/** 起こした後に繋ぎ直しを試す間隔。 */
const RETRY_INTERVAL = 100;

export interface IParadisEnsurePtyHostOptions {
	readonly paths: IParadisPtyHostPaths;
	/** 常駐として起動するための実行ファイルと引数。呼び出し側の形（Electron / 素の node）に依存する。 */
	readonly launch: { readonly execPath: string; readonly args: readonly string[]; readonly env: { readonly [key: string]: string } };
	readonly logService: ILogService;
}

export interface IParadisPtyHostConnection {
	readonly host: IParadisPtyHost;
	readonly client: SocketClient<string>;
	/** この pty ホストの名札。接続の名乗りと `attach` で同じものを使う。 */
	readonly viewer: string;
}

/**
 * 常駐に繋ぐ。**繋げなければ undefined**。
 *
 * undefined を返す（例外を投げない）のは、常駐が使えないことがターミナルを使えないことに
 * なってはいけないため。呼び出し側は今までどおりアプリの中で pty を起こす道へ落とす。
 */
export async function paradisEnsurePtyHost(options: IParadisEnsurePtyHostOptions): Promise<IParadisPtyHostConnection | undefined> {
	const { paths, logService } = options;

	if (paths.socketPathTooLong) {
		// **握り潰さない。** 超えていると bind は必ず失敗し、症状は「毎回ターミナルが作り直される」
		// だけになって原因に辿り着けない。
		logService.error(`[ParadisPtyHost] socket path is too long for this platform: ${paths.socketPath}`);
		reportParadisDiagnosticError('owned', 'pty-daemon', 'socket-path-too-long', new Error('socket path too long'), undefined, 'warning');
		return undefined;
	}

	const existing = await paradisConnect(paths);
	if (existing.ok) {
		logService.info(`[ParadisPtyHost] joined the daemon already serving ${paths.socketPath}`);
		return existing.connection;
	}

	const daemon = await paradisSpawnDaemon(options);

	const deadline = Date.now() + STARTUP_TIMEOUT;
	let last: ParadisPtyHostConnectFailure = existing.failure;
	let attempts = 0;
	while (Date.now() < deadline) {
		await timeout(RETRY_INTERVAL);
		attempts++;
		const attempt = await paradisConnect(paths);
		if (attempt.ok) {
			logService.info(`[ParadisPtyHost] started a daemon at ${paths.socketPath}`);
			return attempt.connection;
		}
		last = attempt.failure;
	}

	const child = daemon?.state() ?? { state: 'spawn-failed' as const };
	logService.error(`[ParadisPtyHost] the daemon did not come up at ${paths.socketPath}; terminals will run in this process (before spawn: ${existing.failure}, last try: ${last}, tries: ${attempts}, daemon process: ${child.state}${child.exitCode !== undefined ? ` code ${child.exitCode}` : ''}${child.signal !== undefined ? ` ${child.signal}` : ''})`);
	// 原因の区別は operation に入れる。pty host の報告は窓へ件数だけで中継され、extra は届かない
	// （`paradisRelayedDiagnostics.ts`）。どちらも決まった語だけ（Sentry の PARA-CODE-DESKTOP-MR）
	reportParadisDiagnosticError('owned', 'pty-daemon', `not-up:${child.state}:${last}`, new Error('the daemon did not come up'), {
		safe_before_spawn: existing.failure,
		safe_last_try: last,
		safe_tries: attempts,
		safe_daemon_state: child.state,
		...(child.exitCode !== undefined ? { safe_exit_code: child.exitCode } : {}),
		...(child.signal !== undefined ? { safe_exit_signal: child.signal } : {}),
	}, 'warning');
	return undefined;
}

/**
 * 常駐に繋げなかった理由。どれも決まった語（Sentry の operation に入る）。
 * - `no-socket`: ソケットのファイルが無い（常駐がまだ bind していない、または居ない）
 * - `refused`: ファイルはあるが誰も受けていない（前の常駐が消えて残ったソケット）
 * - `timeout`: 繋ぐのに 2 秒以上かかった
 * - `error`: そのほかの接続のエラー
 * - `no-record`: 繋がったが台帳にこのソケットの記録が無い（起こした直後、または台帳を書けていない）
 * - `refused-identity`: 合言葉で名乗れなかった
 * - `hello-failed`: 名乗った後の最初の問い合わせが失敗した
 * - `protocol-mismatch`: protocol の版が違った
 */
type ParadisPtyHostConnectFailure = 'no-socket' | 'refused' | 'timeout' | 'error' | 'no-record' | 'refused-identity' | 'hello-failed' | 'protocol-mismatch';

/** 起こした常駐のプロセスの今の様子。 */
export interface IParadisSpawnedDaemonState {
	/** `running`: まだ終わっていない。`exited`: 終了コードで終わった。`signaled`: シグナルで終わった。`spawn-failed`: 起こせなかった。 */
	readonly state: 'running' | 'exited' | 'signaled' | 'spawn-failed';
	readonly exitCode?: number;
	/** `SIGKILL` などの名前（Node の決まった名前だけ）。 */
	readonly signal?: string;
}

/** 起こした常駐のプロセス。様子は呼んだ時点のもの。 */
export interface IParadisSpawnedDaemon {
	state(): IParadisSpawnedDaemonState;
}

/**
 * 常駐の身元を確かめてから繋ぐ。
 *
 * **繋がることは身元の証明にならない。** 向こうにあるのは任意のシェルを起こせる口と全打鍵なので、
 * 繋げた時点でそのユーザーとして任意コード実行になる。置き場所の 0700 だけを頼りにせず、
 * 台帳にしか書かれていない合言葉で確かめる（旧い常駐と同じ扱い。**片方だけ薄くしない**）。
 */
async function paradisConnect(paths: IParadisPtyHostPaths): Promise<{ readonly ok: true; readonly connection: IParadisPtyHostConnection } | { readonly ok: false; readonly failure: ParadisPtyHostConnectFailure }> {
	const opened = await paradisOpenSocket(paths.socketPath);
	if (!opened.ok) {
		return opened;
	}
	const socket = opened.socket;
	const viewer = paradisPtyHostClientId();
	const client = SocketClient.fromSocket(socket, viewer);
	const record = (await paradisReadDaemonRecords(paths.ledgerDir)).find(entry => entry.socketPath === paths.socketPath);
	if (!record || !await paradisAuthenticateDaemon(client, record.token)) {
		// 台帳がまだ無い（起こした直後）か、名乗れない相手。どちらも繋がない。
		client.dispose();
		return { ok: false, failure: record ? 'refused-identity' : 'no-record' };
	}
	const host = ProxyChannel.toService<IParadisPtyHost>(client.getChannel(PARADIS_PTY_HOST_CHANNEL));
	try {
		const greeting = await host.hello();
		if (greeting.protocolVersion !== PARADIS_PTY_PROTOCOL_VERSION) {
			// 名前で分けているので本来ここへは来ない。来たなら名前の付け方が壊れているので、
			// **話を合わせようとせずに離れる**。
			client.dispose();
			return { ok: false, failure: 'protocol-mismatch' };
		}
	} catch {
		client.dispose();
		return { ok: false, failure: 'hello-failed' };
	}
	// **入れ物に入れて返す。** `IParadisPtyHost` は `ProxyChannel` の `Proxy` で、`then` にも
	// 関数を返すため、`Promise` の解決値にすると thenable と見なされて永久に返らなくなる
	// (`paradisPtyDaemonControlClient.ts` の冒頭に経緯がある)。
	return { ok: true, connection: { host, client, viewer } };
}

type ParadisOpenedSocket = { readonly ok: true; readonly socket: NodeSocket } | { readonly ok: false; readonly failure: 'no-socket' | 'refused' | 'timeout' | 'error' };

function paradisOpenSocket(socketPath: string): Promise<ParadisOpenedSocket> {
	return new Promise(resolve => {
		let settled = false;
		const done = (result: ParadisOpenedSocket) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (!result.ok) {
				socket.destroy();
			}
			resolve(result);
		};
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => done({ ok: false, failure: 'timeout' }), CONNECT_TIMEOUT);
		socket.once('connect', () => done({ ok: true, socket: new NodeSocket(socket, 'paradis-pty-host') }));
		socket.once('error', (error: NodeJS.ErrnoException) => done({ ok: false, failure: error.code === 'ENOENT' ? 'no-socket' : error.code === 'ECONNREFUSED' ? 'refused' : 'error' }));
	});
}

/**
 * 常駐へ渡す環境を作る。
 *
 * 切り出してあるのは、**ここの間違いがいちばん辿りにくい形で出る**ため（常駐が上がらない、
 * あるいは常駐の先のシェルだけ足元が違う）。値の判断だけを見られるようにしておく。
 */
export function paradisPtyHostDaemonEnv(
	base: { readonly [key: string]: string | undefined },
	extra: { readonly [key: string]: string },
	/** Electron の中で動いているか。テストで差し替える。 */
	inElectron: boolean = !!process.versions.electron,
): { [key: string]: string | undefined } {
	const env: { [key: string]: string | undefined } = { ...base, ...extra };
	if (inElectron) {
		// **これが無いと node ではなく Electron アプリとして起きる。** ローカルでの実行ファイルは
		// Para Code 本体なので、付け忘れると2つ目の Para Code が起動しようとして常駐は上がらず、
		// 10秒待って縮退する。main の env にも入っていないので、ここで必ず付ける。
		env.ELECTRON_RUN_AS_NODE = '1';
	} else {
		// **接続先（REH）は素の node なので付けてはいけない。** bootstrap-esm.ts はこの変数を見て
		// Electron の中だと判断し、'fs' を Electron にしか無い 'node:original-fs' へ向ける。素の node では
		// ERR_UNKNOWN_BUILTIN_MODULE で常駐が起きず、SSH 先の「更新をまたいで繋ぎ直す」が一度も効かなかった。
		delete env.ELECTRON_RUN_AS_NODE;
	}
	// 親の生死を見て自分を殺す仕掛けが動くと、常駐にならない。
	delete env.VSCODE_PARENT_PID;
	delete env.VSCODE_PIPE_LOGGING;
	paradisUndoSnapEnv(env);
	removeDangerousEnvVariables(env);
	return env;
}

/**
 * Snap の中で書き換えられた環境変数を、元の値へ戻す。
 *
 * Snap は `LD_LIBRARY_PATH` などを自分のものへ差し替え、元の値を `*_VSCODE_SNAP_ORIG` に
 * 退避する。そのまま渡すと、**常駐から起きるシェルまで Snap のライブラリパスが伝わり**、
 * 利用者が起動したコマンドが Snap の中の共有ライブラリを掴む。アプリの中で起こしていた頃は
 * 起動側が同じ手当てをしていたので、経路を分けた以上こちらでも要る。
 *
 * `electron-main` の実装を使わないのは、この関数がローカルでもリモートでも同じ道を通るため。
 * 見ているのは自分に渡ってきた env だけなので、素の node でも成立する。
 */
function paradisUndoSnapEnv(env: { [key: string]: string | undefined }): void {
	for (const key of Object.keys(env)) {
		if (!key.endsWith('_VSCODE_SNAP_ORIG')) {
			continue;
		}
		const original = key.slice(0, -'_VSCODE_SNAP_ORIG'.length);
		const saved = env[key];
		if (saved) {
			env[original] = saved;
		} else {
			// 退避が空なら、Snap に入る前はその変数自体が無かったということ。
			delete env[original];
		}
		delete env[key];
	}
}

/**
 * 常駐を起こす。**切り離して起こす。**
 *
 * 親が消えても生き残らなければ意味が無いので、プロセスグループを分け、標準入出力は握らない。
 * ただし**捨てもしない**。前の常駐で、標準出力を捨てたせいで起動できない理由が一切残らず、
 * 「ターミナルが開かない」という症状だけを見て何時間も溶かしたことがある。
 *
 * export しているのは、起動に失敗してもプロセスが落ちないことをテストで確かめるため。
 */
export async function paradisSpawnDaemon(options: IParadisEnsurePtyHostOptions): Promise<IParadisSpawnedDaemon | undefined> {
	const { paths, launch, logService } = options;
	let stdio: 'ignore' | number = 'ignore';
	try {
		await fs.mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
		const log = join(dirname(paths.socketPath), 'startup.log');
		// 起こすたびに追記され続けるので、大きくなったら捨てて始め直す。**残す側に倒す**のは、
		// ここが「常駐が上がらない理由」を書く唯一の場所だから（前の内容より直近が重要）。
		try {
			if ((await fs.stat(log)).size > STARTUP_LOG_LIMIT) {
				await fs.rm(log, { force: true });
			}
		} catch {
			// まだ無い。
		}
		stdio = await Promises.open(log, 'a');
	} catch (error) {
		logService.warn('[ParadisPtyHost] could not open the startup log; the daemon will start without one', error);
	}

	const env = paradisPtyHostDaemonEnv(process.env, launch.env);

	const child = spawn(launch.execPath, [...launch.args], {
		detached: true,
		stdio: ['ignore', stdio, stdio],
		env,
	});
	// 起動の失敗（実行ファイルが無い等）は次のティックの 'error' で届く。受け手が無いとこのプロセスごと落ちるので、
	// 閉じるのを待つより前に付ける。落とさずに記録し、呼び出し側の接続待ちが時間切れになってアプリの中の pty へ落ちる。
	let state: IParadisSpawnedDaemonState = { state: 'running' };
	child.on('error', error => {
		state = { state: 'spawn-failed' };
		logService.error('[ParadisPtyHost] failed to spawn the daemon process', error);
		reportParadisDiagnosticError('owned', 'pty-daemon', 'spawn-failed', error, undefined, 'warning');
	});
	// 起きなかったときの報告に、常駐のプロセスが途中で終わったかを載せる（Sentry の PARA-CODE-DESKTOP-MR）。
	// 常駐は切り離してあるので、ふつうはこの通知は来ない
	child.once('exit', (code, signal) => {
		if (state.state === 'spawn-failed') {
			return;
		}
		state = signal !== null
			? { state: 'signaled', ...(/^SIG[A-Z0-9]{1,12}$/.test(signal) ? { signal } : {}) }
			: { state: 'exited', ...(code !== null ? { exitCode: code } : {}) };
	});
	child.unref();
	if (typeof stdio === 'number') {
		await Promises.close(stdio);
	}
	return { state: () => state };
}
