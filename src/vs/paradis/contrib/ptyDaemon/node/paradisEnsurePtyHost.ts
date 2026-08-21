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
import { closeSync, mkdirSync, openSync } from 'fs';
import { createConnection } from 'net';
import { timeout } from '../../../../base/common/async.js';
import { dirname, join } from '../../../../base/common/path.js';
import { removeDangerousEnvVariables } from '../../../../base/common/processes.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Client as SocketClient } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisPtyHostPaths } from '../common/paradisPtyHostPaths.js';
import { IParadisPtyHost, PARADIS_PTY_HOST_CHANNEL, PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';

/** 1回の接続試行を待つ上限。 */
const CONNECT_TIMEOUT = 2_000;

/** 起こしてから待つ上限。ここを過ぎたら常駐を諦めて、今までどおりアプリの中で動かす。 */
const STARTUP_TIMEOUT = 10_000;

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
		return undefined;
	}

	const existing = await paradisConnect(paths.socketPath);
	if (existing) {
		logService.info(`[ParadisPtyHost] joined the daemon already serving ${paths.socketPath}`);
		return existing;
	}

	paradisSpawnDaemon(options);

	const deadline = Date.now() + STARTUP_TIMEOUT;
	while (Date.now() < deadline) {
		await timeout(RETRY_INTERVAL);
		const connection = await paradisConnect(paths.socketPath);
		if (connection) {
			logService.info(`[ParadisPtyHost] started a daemon at ${paths.socketPath}`);
			return connection;
		}
	}

	logService.error(`[ParadisPtyHost] the daemon did not come up at ${paths.socketPath}; terminals will run in this process`);
	return undefined;
}

async function paradisConnect(socketPath: string): Promise<IParadisPtyHostConnection | undefined> {
	const socket = await paradisOpenSocket(socketPath);
	if (!socket) {
		return undefined;
	}
	const client = SocketClient.fromSocket(socket, 'paradis-pty-host');
	const host = ProxyChannel.toService<IParadisPtyHost>(client.getChannel(PARADIS_PTY_HOST_CHANNEL));
	try {
		const greeting = await host.hello();
		if (greeting.protocolVersion !== PARADIS_PTY_PROTOCOL_VERSION) {
			// 名前で分けているので本来ここへは来ない。来たなら名前の付け方が壊れているので、
			// **話を合わせようとせずに離れる**。
			client.dispose();
			return undefined;
		}
	} catch {
		client.dispose();
		return undefined;
	}
	// **入れ物に入れて返す。** `IParadisPtyHost` は `ProxyChannel` の `Proxy` で、`then` にも
	// 関数を返すため、`Promise` の解決値にすると thenable と見なされて永久に返らなくなる
	// (`paradisPtyDaemonControlClient.ts` の冒頭に経緯がある)。
	return { host, client };
}

function paradisOpenSocket(socketPath: string): Promise<NodeSocket | undefined> {
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
		socket.once('connect', () => done(new NodeSocket(socket, 'paradis-pty-host')));
		socket.once('error', () => done(undefined));
	});
}

/**
 * 常駐を起こす。**切り離して起こす。**
 *
 * 親が消えても生き残らなければ意味が無いので、プロセスグループを分け、標準入出力は握らない。
 * ただし**捨てもしない**。前の常駐で、標準出力を捨てたせいで起動できない理由が一切残らず、
 * 「ターミナルが開かない」という症状だけを見て何時間も溶かしたことがある。
 */
function paradisSpawnDaemon(options: IParadisEnsurePtyHostOptions): void {
	const { paths, launch, logService } = options;
	let stdio: 'ignore' | number = 'ignore';
	try {
		mkdirSync(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
		stdio = openSync(join(dirname(paths.socketPath), 'startup.log'), 'a');
	} catch (error) {
		logService.warn('[ParadisPtyHost] could not open the startup log; the daemon will start without one', error);
	}

	const env = { ...process.env, ...launch.env };
	// 親の生死を見て自分を殺す仕掛けが動くと、常駐にならない。
	delete env['VSCODE_PARENT_PID'];
	delete env['VSCODE_PIPE_LOGGING'];
	removeDangerousEnvVariables(env);

	const child = spawn(launch.execPath, [...launch.args], {
		detached: true,
		stdio: ['ignore', stdio, stdio],
		env,
	});
	child.unref();
	if (typeof stdio === 'number') {
		closeSync(stdio);
	}
}
