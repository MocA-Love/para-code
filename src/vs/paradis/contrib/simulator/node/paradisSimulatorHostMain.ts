/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのホストの子プロセスの入口（macOS だけで起こす）。shared process の
// `paradisSimulatorHostProcess.ts` が `bootstrap-fork` + `VSCODE_ESM_ENTRYPOINT` で起こす
// （pty host と同じ起こし方。配布版で serve-sim が import する `ws` を `node_modules.asar` から
// 解決できるよう、asar の解決は `bootstrap-esm` が先に登録する）。
//
// 手順: stdin の 1 行目で token とソケットのパスを受ける → 同梱の serve-sim のミドルウェアを読む →
// Unix ソケットで待ち受ける → stdout へ準備できた印を 1 行出す。stdin が閉じたら（shared process が
// 止めた・落ちた）終わる。shared process の生死は `VSCODE_PARENT_PID` でも `bootstrap-fork` が見る。
//
// ネイティブのアドオン（serve-sim-native.node）が落ちても、巻き込まれるのはこのプロセスだけで、
// 台帳と MCP を持つ shared process は残る。

import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { IParadisSimulatorHostHandshake, PARADIS_SIMULATOR_HOST_READY } from '../common/paradisSimulator.js';
import { PARADIS_SERVE_SIM_DIR, PARADIS_SERVE_SIM_MIDDLEWARE, paradisPrepareServeSimDir } from './paradisServeSimDist.js';
import { IParadisSimulatorMiddleware, paradisStartSimulatorHostServer } from './paradisSimulatorHostServer.js';

interface IServeSimMiddlewareModule {
	simMiddleware(options: {
		basePath: string;
		authToken: string;
		allowExec: false;
		proxyHelpers: boolean;
		serveSimBin: string;
	}): IParadisSimulatorMiddleware;
}

function log(message: string, error?: unknown): void {
	const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? '' : `: ${String(error)}`;
	try {
		process.stderr.write(`[paradis-simulator-host] ${message}${detail}\n`);
	} catch {
		// 出し先が閉じていれば黙る
	}
}

function readHandshake(): Promise<IParadisSimulatorHostHandshake> {
	return new Promise((resolve, reject) => {
		let buffered = '';
		const onData = (chunk: Buffer) => {
			buffered += chunk.toString('utf8');
			const newline = buffered.indexOf('\n');
			if (newline === -1) {
				if (buffered.length > 64 * 1024) {
					reject(new Error('handshake too long'));
				}
				return;
			}
			process.stdin.off('data', onData);
			try {
				const parsed = JSON.parse(buffered.slice(0, newline)) as Partial<IParadisSimulatorHostHandshake>;
				if (typeof parsed.token !== 'string' || parsed.token.length < 32 || typeof parsed.socketPath !== 'string' || !parsed.socketPath) {
					throw new Error('handshake is missing the token or the socket path');
				}
				resolve({ token: parsed.token, socketPath: parsed.socketPath });
			} catch (error) {
				reject(error);
			}
		};
		process.stdin.on('data', onData);
		process.stdin.once('end', () => reject(new Error('stdin closed before the handshake')));
	});
}

async function main(): Promise<void> {
	const handshake = await readHandshake();
	// 自分の TMPDIR は shared process が用意した専用のフォルダ（serve-sim の状態のフォルダ `$TMPDIR/serve-sim/` を
	// 利用者の serve-sim や Orca と共有しないため）
	const serveSimDir = await paradisPrepareServeSimDir(FileAccess.asFileUri(PARADIS_SERVE_SIM_DIR).fsPath, tmpdir());
	const serveSim = await import(pathToFileURL(join(serveSimDir, PARADIS_SERVE_SIM_MIDDLEWARE)).href) as IServeSimMiddlewareModule;
	const middleware = serveSim.simMiddleware({
		basePath: '',
		authToken: handshake.token,
		allowExec: false,
		proxyHelpers: true,
		// 権限・カメラの host RPC は許可の一覧の外なので届かないが、万一の時に利用者の PATH の serve-sim を
		// 起こさないよう、無いパスを渡しておく
		serveSimBin: join(tmpdir(), 'serve-sim-cli-is-not-used'),
	});
	const server = await paradisStartSimulatorHostServer({ socketPath: handshake.socketPath, token: handshake.token, middleware, onError: log });

	let closing = false;
	const shutdown = (reason: string) => {
		if (closing) {
			return;
		}
		closing = true;
		log(`shutting down (${reason})`);
		// 端末のセッション（ネイティブの映像・HID）はこのプロセスと一緒に終わる
		const exit = setTimeout(() => process.exit(0), 2000);
		server.close().finally(() => {
			clearTimeout(exit);
			process.exit(0);
		});
	};
	process.stdin.once('end', () => shutdown('stdin closed'));
	process.stdin.once('close', () => shutdown('stdin closed'));
	process.once('SIGTERM', () => shutdown('SIGTERM'));
	process.stdout.write(`${PARADIS_SIMULATOR_HOST_READY}\n`);
}

main().catch(error => {
	log('failed to start', error);
	process.exit(1);
});
