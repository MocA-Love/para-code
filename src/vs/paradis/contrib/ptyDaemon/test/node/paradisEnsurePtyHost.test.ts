/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐へ渡す環境の作り方。
//
// **ここを間違えると、常駐から起きるシェルの足元が変わる。** しかも症状は「なぜかこのコマンドだけ
// 動かない」という、ターミナルの仕組みからは遠い形で出る。

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { serve } from '../../../../../base/parts/ipc/node/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisEnsurePtyHost, paradisHandshakeTimeoutFor, paradisPtyHostDaemonEnv, paradisSpawnDaemon, paradisUnresponsiveMarkFile } from '../../node/paradisEnsurePtyHost.js';
import { ParadisPtyDaemonAuth } from '../../node/paradisPtyDaemonAuth.js';
import { PARADIS_PTY_HOST_CHANNEL, PARADIS_PTY_PROTOCOL_VERSION } from '../../common/paradisPtyProtocol.js';
import { PARADIS_PTY_DAEMON_AUTH_CHANNEL } from '../../common/paradisPtyDaemonControl.js';
import { paradisDaemonRecordFile, paradisWriteDaemonRecord } from '../../node/paradisPtyDaemonLedger.js';

suite('ParadisEnsurePtyHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Electron の中では node として起こし、素の node（接続先）では付けない', () => {
		const local = paradisPtyHostDaemonEnv({}, { VSCODE_ESM_ENTRYPOINT: 'somewhere' }, true);
		const remote = paradisPtyHostDaemonEnv({ ELECTRON_RUN_AS_NODE: '1' }, { VSCODE_ESM_ENTRYPOINT: 'somewhere' }, false);

		assert.deepStrictEqual(
			{ local: [local.ELECTRON_RUN_AS_NODE, local.VSCODE_ESM_ENTRYPOINT], remote: [remote.ELECTRON_RUN_AS_NODE, remote.VSCODE_ESM_ENTRYPOINT] },
			// ローカルの実行ファイルは Para Code 本体なので、無いと2つ目のアプリが起きようとする。
			// 接続先で付けると bootstrap-esm が 'fs' を Electron 専用の 'node:original-fs' へ向け、常駐が起きない。
			{ local: ['1', 'somewhere'], remote: [undefined, 'somewhere'] },
		);
	});

	test('前の起動で答えなかった常駐（pid と起動時刻が同じ）だけ短く待つ。起こし直された常駐はいつもどおり待つ', () => {
		const record = { pid: 42, startedAt: 1000 };
		assert.deepStrictEqual({
			noMark: paradisHandshakeTimeoutFor(record, undefined, 30_000, 5_000),
			sameDaemon: paradisHandshakeTimeoutFor(record, { pid: 42, startedAt: 1000 }, 30_000, 5_000),
			restarted: paradisHandshakeTimeoutFor(record, { pid: 42, startedAt: 999 }, 30_000, 5_000),
			otherPid: paradisHandshakeTimeoutFor(record, { pid: 43, startedAt: 1000 }, 30_000, 5_000),
			noRecord: paradisHandshakeTimeoutFor(undefined, { pid: 42, startedAt: 1000 }, 30_000, 5_000),
		}, { noMark: 30_000, sameDaemon: 5_000, restarted: 30_000, otherPid: 30_000, noRecord: 30_000 });
	});

	test('親の生死を見て自分を殺す仕掛けは外す。外さないと常駐にならない', () => {
		const env = paradisPtyHostDaemonEnv({ VSCODE_PARENT_PID: '123', VSCODE_PIPE_LOGGING: 'true' }, {});

		assert.deepStrictEqual(
			{ parent: env.VSCODE_PARENT_PID, logging: env.VSCODE_PIPE_LOGGING },
			{ parent: undefined, logging: undefined },
		);
	});

	test('Snap が差し替えた変数は元へ戻す。常駐の先のシェルまで持ち込まない', () => {
		const env = paradisPtyHostDaemonEnv({
			LD_LIBRARY_PATH: '/snap/para-code/current/lib',
			LD_LIBRARY_PATH_VSCODE_SNAP_ORIG: '/usr/lib',
			GTK_PATH: '/snap/para-code/current/gtk',
			GTK_PATH_VSCODE_SNAP_ORIG: '',
		}, {});

		assert.deepStrictEqual(
			{ lib: env.LD_LIBRARY_PATH, gtk: env.GTK_PATH, leftovers: Object.keys(env).filter(key => key.endsWith('_VSCODE_SNAP_ORIG')) },
			{
				// 退避してあった元の値へ戻す。
				lib: '/usr/lib',
				// 退避が空なら、Snap に入る前はその変数自体が無かったということ。
				gtk: undefined,
				leftovers: [],
			},
		);
	});

	test('実行ファイルが無くても落ちない。起動の失敗は記録して、接続待ちの時間切れに任せる', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-ensure-pty-host-'));
		const errors: string[] = [];
		const logService = new class extends NullLogService {
			override error(message: string | Error): void {
				errors.push(String(message));
			}
		};
		try {
			const daemon = await paradisSpawnDaemon({
				paths: { socketPath: join(dir, 'pty.sock'), ledgerDir: dir, ledgerFile: join(dir, 'ledger.json'), socketPathTooLong: false },
				launch: { execPath: join(dir, 'missing-executable'), args: [], env: {} },
				logService,
			});
			// 'error' は spawn の次のティックで届く
			for (let i = 0; i < 100 && errors.length === 0; i++) {
				await timeout(10);
			}
			assert.deepStrictEqual({ errors, state: daemon?.state() }, { errors: ['[ParadisPtyHost] failed to spawn the daemon process'], state: { state: 'spawn-failed' } });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('起きなかったときの報告のために、常駐のプロセスが途中で終わったかと終了コードを返す', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-ensure-pty-host-'));
		try {
			const daemon = await paradisSpawnDaemon({
				paths: { socketPath: join(dir, 'pty.sock'), ledgerDir: dir, ledgerFile: join(dir, 'ledger.json'), socketPathTooLong: false },
				// Electron の中では ELECTRON_RUN_AS_NODE が付くので、どちらでも node として動く
				launch: { execPath: process.execPath, args: ['-e', 'process.exit(3)'], env: {} },
				logService: new NullLogService(),
			});
			for (let i = 0; i < 300 && daemon?.state().state === 'running'; i++) {
				await timeout(10);
			}
			assert.deepStrictEqual(daemon?.state(), { state: 'exited', exitCode: 3 });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

});

// 受理した接続ぶんの `Protocol` は `IPCServer` が畳まないので、リーク検査は外してある
// (`paradisPtyDaemonControlClient.test.ts` と同じ理由)。
// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test
suite('ParadisEnsurePtyHost handshake', () => {
	test('接続を受けるだけで名乗りに答えない常駐は、待ち続けずに諦める（アプリの中で動かす）', async function () {
		this.timeout(10_000);
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-ensure-pty-host-'));
		const socketPath = join(dir, 'pty.sock');
		// 固まった常駐の代わり。接続は受けるが、名乗り（合言葉）に答えない。
		const server = await serve(socketPath);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, { call: () => new Promise(() => { }), listen: () => Event.None });
		try {
			await paradisWriteDaemonRecord(paradisDaemonRecordFile(dir, 'test'), { pid: process.pid, socketPath, buildId: 'test', buildKey: 'test', startedAt: Date.now(), token: 'token' });
			const connection = await paradisEnsurePtyHost({
				paths: { socketPath, ledgerDir: dir, ledgerFile: join(dir, 'ledger.json'), socketPathTooLong: false },
				// 起こしには行かない（行ったら落ちる実行ファイル）
				launch: { execPath: join(dir, 'missing-executable'), args: [], env: {} },
				logService: new NullLogService(),
				handshakeTimeout: 200,
			});
			assert.strictEqual(connection, undefined);
		} finally {
			server.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	test('答えなかった常駐は殺さずに印を残し、次の起動からは短く待つ。答えたら印を消していつもどおり待つ', async function () {
		this.timeout(20_000);
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-ensure-pty-host-'));
		const socketPath = join(dir, 'pty.sock');
		const paths = { socketPath, ledgerDir: dir, ledgerFile: join(dir, 'ledger.json'), socketPathTooLong: false };
		const auth = new ParadisPtyDaemonAuth('token');
		// 固まった常駐の代わり。`stuck` のあいだは名乗り（合言葉）に答えない
		let stuck = true;
		const server = await serve(socketPath);
		server.registerChannel(PARADIS_PTY_DAEMON_AUTH_CHANNEL, {
			call: <T>(_ctx: string, command: string, arg?: unknown): Promise<T> => {
				const [nonce, proof] = arg as [string, string];
				return (stuck ? new Promise(() => { }) : command === 'authenticate' ? auth.authenticate(nonce, proof) : Promise.reject(new Error(command))) as Promise<T>;
			},
			listen: () => Event.None,
		});
		server.registerChannel(PARADIS_PTY_HOST_CHANNEL, {
			call: <T>(_ctx: string, command: string): Promise<T> => (command === 'hello' ? Promise.resolve({ protocolVersion: PARADIS_PTY_PROTOCOL_VERSION }) : Promise.reject(new Error(command))) as Promise<T>,
			listen: () => Event.None,
		});
		const ensure = () => paradisEnsurePtyHost({
			paths,
			// 起こしには行かない（行ったら落ちる実行ファイル）
			launch: { execPath: join(dir, 'missing-executable'), args: [], env: {} },
			logService: new NullLogService(),
			handshakeTimeout: 1_500,
			unresponsiveHandshakeTimeout: 100,
		});
		const markFile = paradisUnresponsiveMarkFile(paths);
		const readMark = () => fs.readFile(markFile, 'utf8').then(raw => JSON.parse(raw), () => undefined);
		try {
			await paradisWriteDaemonRecord(paradisDaemonRecordFile(dir, 'test'), { pid: process.pid, socketPath, buildId: 'test', buildKey: 'test', startedAt: 1234, token: 'token' });
			const first = await ensure();
			const markAfterFirst = await readMark();
			const startedAt = Date.now();
			const second = await ensure();
			const secondWaitedShort = Date.now() - startedAt < 1_000;
			stuck = false;
			const third = await ensure();
			third?.client.dispose();
			assert.deepStrictEqual({ first, markAfterFirst, second, secondWaitedShort, joined: !!third, markAfterJoin: await readMark() }, {
				first: undefined,
				markAfterFirst: { pid: process.pid, startedAt: 1234 },
				second: undefined,
				secondWaitedShort: true,
				joined: true,
				markAfterJoin: undefined,
			});
		} finally {
			server.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
