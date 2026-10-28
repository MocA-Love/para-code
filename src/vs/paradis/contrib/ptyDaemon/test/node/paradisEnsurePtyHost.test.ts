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
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisPtyHostDaemonEnv, paradisSpawnDaemon } from '../../node/paradisEnsurePtyHost.js';

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
