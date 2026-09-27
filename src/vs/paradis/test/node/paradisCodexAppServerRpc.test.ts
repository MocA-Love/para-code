/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { ParadisCodexRpcMethodNotFoundError, paradisIsCodexAuthError, paradisStartCodexAppServerRpc } from '../../node/paradisCodexAppServerRpc.js';

// 本物の codex は使わない。改行区切り JSON-RPC を話す小さな偽物を node で動かす。
(isWindows ? suite.skip : suite)('Paradis Codex app-server RPC', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-rpc-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function fakeCodex(script: string): string {
		// Electron 上のテストでも動くよう、実行中の Node（Electron なら Node として）で JS を動かす
		// sh の入口を置く。shebang に実行ファイルのパスを直接書くと、空白を含むパスで起動できない。
		const scriptFile = join(root, 'fake-codex.js');
		writeFileSync(scriptFile, script);
		const file = join(root, 'codex');
		writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath.replace(/'/g, `'\\''`)}' '${scriptFile}' "$@"\n`);
		chmodSync(file, 0o755);
		return file;
	}

	test('initializes, answers requests and turns app-server errors into rejections', async () => {
		const command = fakeCodex(`
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	if (message.id === undefined) { return; }
	if (message.method === 'initialize') { process.stdout.write(JSON.stringify({ id: message.id, result: { home: process.env.CODEX_HOME, client: message.params.clientInfo.name } }) + '\\n'); return; }
	if (message.method === 'echo') { process.stdout.write(JSON.stringify({ method: 'noise' }) + '\\n' + JSON.stringify({ id: message.id, result: message.params }) + '\\n'); return; }
	process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } }) + '\\n');
});
`);
		const rpc = await paradisStartCodexAppServerRpc(command, { ...process.env, CODEX_HOME: join(root, 'home') }, new NullLogService(), 'test-client');
		try {
			const echoed = await rpc.request('echo', { value: 1 }, 5_000);
			const failure = await rpc.request('account/rateLimits/read', {}, 5_000).then(() => undefined, error => error);
			assert.deepStrictEqual({ echoed, auth: paradisIsCodexAuthError(failure) }, { echoed: { value: 1 }, auth: true });
		} finally {
			rpc.dispose();
		}
	});

	// hook の信頼とモデル一覧が使う指定（CODEX_HOME の上書き・作業ディレクトリ・clientInfo.title）と、
	// 「メソッドが無い」の見分け。codex 0.155.1 は知らないメソッドに -32600 の「unknown variant」で答える。
	test('passes the Codex home, working directory and title, and tells a missing method apart', async () => {
		const command = fakeCodex(`
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	if (message.id === undefined) { return; }
	if (message.method === 'initialize') { globalThis.clientInfo = message.params.clientInfo; process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n'); return; }
	if (message.method === 'whoami') { process.stdout.write(JSON.stringify({ id: message.id, result: { home: process.env.CODEX_HOME, cwd: process.cwd(), args: process.argv.slice(2), jsonrpc: message.jsonrpc, clientInfo: globalThis.clientInfo } }) + '\\n'); return; }
	if (message.method === 'old/method') { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'method not found' } }) + '\\n'); return; }
	process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'Invalid request: unknown variant \\u0060' + message.method + '\\u0060' } }) + '\\n');
});
`);
		const home = join(root, 'codex-2');
		const cwd = join(root, 'work');
		mkdirSync(cwd);
		const rpc = await paradisStartCodexAppServerRpc(command, { ...process.env, CODEX_HOME: join(root, 'other') }, new NullLogService(), 'test-client', { codexHome: home, cwd, clientTitle: 'Para Code' });
		try {
			const whoami = await rpc.request('whoami', {});
			const failures = await Promise.all(['old/method', 'hooks/list', 'config/read'].map(method => rpc.request(method, {}).then(() => undefined, (error: Error) => error instanceof ParadisCodexRpcMethodNotFoundError ? error.method : 'other')));
			assert.deepStrictEqual({ whoami, failures }, {
				whoami: { home, cwd: realpathSync(cwd), args: ['-s', 'read-only', '-a', 'never', 'app-server'], jsonrpc: '2.0', clientInfo: { name: 'test-client', title: 'Para Code', version: '1.0.0' } },
				failures: ['old/method', 'hooks/list', 'config/read'],
			});
		} finally {
			rpc.dispose();
		}
	});

	// 終わった app-server への要求は時間切れを待たずに断り、破棄したら待っている要求もその場で断る。
	test('rejects requests right away after the app-server exits or the session is disposed', async () => {
		const command = fakeCodex(`
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	if (message.method === 'initialize') { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n'); return; }
	if (message.method === 'quit') { process.exit(3); }
	// それ以外には答えない
});
`);
		const exiting = await paradisStartCodexAppServerRpc(command, process.env, new NullLogService());
		const quit = await exiting.request('quit', {}, 5_000).then(() => 'answered', (error: Error) => error.message);
		const started = Date.now();
		const afterExit = await exiting.request('hooks/list', {}, 5_000).then(() => 'answered', (error: Error) => error.message);
		const afterExitMs = Date.now() - started;
		exiting.dispose();

		const waiting = await paradisStartCodexAppServerRpc(command, process.env, new NullLogService());
		const pending = waiting.request('hooks/list', {}, 5_000).then(() => 'answered', (error: Error) => error.message);
		waiting.dispose();
		assert.deepStrictEqual({
			quit: quit.startsWith('codex app-server exited'),
			afterExit: afterExit.startsWith('codex app-server exited'),
			fast: afterExitMs < 1_000,
			pending: await pending,
		}, { quit: true, afterExit: true, fast: true, pending: 'codex app-server session disposed' });
	});

	test('reports the exit code of an app-server that dies during initialize', async () => {
		const command = fakeCodex(`process.exit(2);`);
		const failure = await paradisStartCodexAppServerRpc(command, process.env, new NullLogService()).then(() => undefined, error => error) as Error & { exitCode?: number };
		// 文言の頭は limitsMonitor の Sentry 用の分類（classifyCodexRpcFailure の 'exited'）が見ている。
		assert.deepStrictEqual({ exited: failure.message.startsWith('codex app-server exited'), exitCode: failure.exitCode }, { exited: true, exitCode: 2 });
	});
});
