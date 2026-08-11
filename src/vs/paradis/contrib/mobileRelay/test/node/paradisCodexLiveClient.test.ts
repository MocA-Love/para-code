/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { WebSocketServer } from 'ws';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCodexDaemonEvent, ParadisCodexLiveClient } from '../../node/paradisCodexLiveClient.js';

interface IFakeAppServer extends AsyncDisposable {
	readonly socketPath: string;
	readonly resumedThreads: readonly string[];
	readonly rejectedUpgrades: readonly (string | undefined)[];
}

/**
 * `paneToken` を渡すとWindows方式（loopback TCP + Bearer認証 + endpointファイル）で待ち受け、
 * 省略時は従来のUnix socket方式で待ち受ける偽app-server。
 */
async function createFakeAppServer(testRoot: string, name: string, loadedThreads: readonly string[], paneToken?: string): Promise<IFakeAppServer> {
	const { createServer } = await import('http');
	const resumedThreads: string[] = [];
	const rejectedUpgrades: (string | undefined)[] = [];
	const server: Server = createServer();
	const webSockets = new WebSocketServer({ noServer: true });
	server.on('upgrade', (request, socket, head) => {
		if (paneToken !== undefined && request.headers['authorization'] !== `Bearer ${paneToken}`) {
			rejectedUpgrades.push(request.headers['authorization']);
			socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
			return;
		}
		webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection, request));
	});
	webSockets.on('connection', connection => connection.on('message', data => {
		const message = JSON.parse(data.toString()) as { readonly id?: number; readonly method?: string; readonly params?: { readonly threadId?: string } };
		if (message.id === undefined) {
			return;
		}
		let result: unknown = {};
		if (message.method === 'thread/loaded/list') {
			result = { data: loadedThreads };
		} else if (message.method === 'thread/resume') {
			if (message.params?.threadId !== undefined) {
				resumedThreads.push(message.params.threadId);
			}
			result = { model: 'gpt-5', reasoningEffort: 'high' };
		} else if (message.method === 'model/list') {
			result = {
				data: [{
					id: `${name}-model`, model: `${name}-model`, displayName: `${name} model`, description: '',
					defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
				}],
			};
		} else if (message.method === 'thread/read') {
			result = { thread: { turns: [{ items: [{ type: 'agentMessage', text: `${name}:${message.params?.threadId}` }] }] } };
		}
		connection.send(JSON.stringify({ id: message.id, result }));
		if (message.method === 'thread/resume' && message.params?.threadId !== undefined) {
			connection.send(JSON.stringify({ method: 'item/started', params: { threadId: message.params.threadId, item: { type: 'reasoning' } } }));
		}
	}));
	let socketPath: string;
	if (paneToken !== undefined) {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const address = server.address();
		assert.ok(address !== null && typeof address === 'object');
		socketPath = join(testRoot, 'pcx', `${paneToken}.endpoint.json`);
		await fs.mkdir(join(testRoot, 'pcx'), { recursive: true });
		await fs.writeFile(socketPath, JSON.stringify({ port: address.port, pid: process.pid, ownerPid: process.pid }));
	} else {
		socketPath = join(testRoot, `${name}.sock`);
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, resolve);
		});
	}
	return {
		socketPath,
		resumedThreads,
		rejectedUpgrades,
		async [Symbol.asyncDispose]() {
			for (const connection of webSockets.clients) {
				connection.terminate();
			}
			webSockets.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/**
 * 確実に存在しないpidを得る。定数を書くと、その番号が実在した環境で「生きている」と読まれて
 * テストが静かに無意味になるため、自分で起動して終了を見届けた子のpidを使う。
 */
async function exitedProcessId(): Promise<number> {
	const { spawn } = await import('child_process');
	const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
	await new Promise<void>(resolve => child.once('exit', () => resolve()));
	assert.ok(child.pid !== undefined);
	return child.pid;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate() && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.ok(predicate(), 'condition did not become true');
}

suite('ParadisCodexLiveClient', function () {
	this.timeout(5_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('routes each Mobile thread to its pane app-server socket', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-live-'));
		await using first = await createFakeAppServer(testRoot, 'first', ['thread-1']);
		await using second = await createFakeAppServer(testRoot, 'second', ['thread-1', 'thread-2']);
		const events: IParadisCodexDaemonEvent[] = [];
		const client = new ParadisCodexLiveClient(event => events.push(event), new NullLogService());
		try {
			client.setThreads([
				{ threadId: 'thread-1', socketPath: first.socketPath },
				{ threadId: 'thread-2', socketPath: second.socketPath },
			]);
			client.setEnabled(true);
			await waitFor(() => client.isThreadReady('thread-1') && client.isThreadReady('thread-2'));

			assert.deepStrictEqual(first.resumedThreads, ['thread-1']);
			assert.deepStrictEqual(second.resumedThreads, ['thread-2']);
			assert.strictEqual((await client.listModels('thread-1'))[0].model, 'first-model');
			assert.strictEqual((await client.listModels('thread-2'))[0].model, 'second-model');
			assert.deepStrictEqual(events.map(event => [event.threadId, event.method]).sort(), [
				['thread-1', 'item/started'],
				['thread-2', 'item/started'],
			]);
			assert.deepStrictEqual(await client.readThreadMessages('child-2', 'thread-2'), [{ role: 'assistant', kind: 'text', text: 'second:child-2' }]);

			client.setThreads([{ threadId: 'thread-1', socketPath: second.socketPath }]);
			await waitFor(() => client.isThreadReady('thread-1'));
			assert.deepStrictEqual(second.resumedThreads, ['thread-2', 'thread-1']);
			assert.throws(() => client.readThreadMessages('child-2', 'thread-2'), /確認できません/);
			assert.deepStrictEqual(await client.readThreadMessages('child-1', 'thread-1'), [{ role: 'assistant', kind: 'text', text: 'second:child-1' }]);
		} finally {
			client.dispose();
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	test('connects to a Windows ws endpoint target with the pane token as Bearer auth', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-live-'));
		await using paneServer = await createFakeAppServer(testRoot, 'winpane', ['thread-9'], 'pane-token-w1');
		const events: IParadisCodexDaemonEvent[] = [];
		const client = new ParadisCodexLiveClient(event => events.push(event), new NullLogService());
		try {
			client.setThreads([{ threadId: 'thread-9', socketPath: paneServer.socketPath }]);
			client.setEnabled(true);
			await waitFor(() => client.isThreadReady('thread-9'));

			assert.deepStrictEqual(paneServer.resumedThreads, ['thread-9']);
			assert.deepStrictEqual(paneServer.rejectedUpgrades, []);
			assert.strictEqual((await client.listModels('thread-9'))[0].model, 'winpane-model');
		} finally {
			client.dispose();
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});

	/**
	 * Para Code が強制終了されるとランチャーの後片付け（EXIT trap）が走らず、`.sock` と `.pid`
	 * だけが残る。ペイントークンはターミナル復元時に引き継がれるので、再起動後のクライアントは
	 * その死骸を掴み続けて ECONNREFUSED を繰り返していた。
	 *
	 * 偽app-serverは**両方とも待ち受けたまま**にしてある。判定材料は `.pid` の生死だけなので、
	 * 死骸側が ready になったらガードが効いていないと分かる。
	 */
	test('skips a socket whose recorded owner is dead, but still connects when the pid is unknown or alive', async () => {
		const testRoot = await fs.mkdtemp(join(tmpdir(), 'paradis-codex-live-'));
		await using stale = await createFakeAppServer(testRoot, 'stale', ['thread-dead']);
		await using live = await createFakeAppServer(testRoot, 'live', ['thread-live']);
		await using unknown = await createFakeAppServer(testRoot, 'unknown', ['thread-unknown']);
		// Windows方式は pid の読み出し元が別ファイル・別フォーマット（endpoint.json 内）なので、
		// 死骸の判定も別経路になる。ここを踏まないと `isEndpointTarget` 側は素通りする。
		await using staleWin = await createFakeAppServer(testRoot, 'stalewin', ['thread-dead-win'], 'pane-token-dead');
		const client = new ParadisCodexLiveClient(() => { }, new NullLogService());
		try {
			const deadPid = await exitedProcessId();
			await fs.writeFile(`${stale.socketPath}.pid`, `${deadPid}\n`);
			await fs.writeFile(`${live.socketPath}.pid`, `${process.pid}\n`);
			const winRecord: unknown = JSON.parse(await fs.readFile(staleWin.socketPath, 'utf8'));
			await fs.writeFile(staleWin.socketPath, JSON.stringify({ ...winRecord as object, pid: deadPid }));
			// `unknown` には `.pid` を書かない。ランチャーは app-server を spawn してから pid を
			// 書き、ソケットを作るのは app-server 自身なので「ソケットは在るが pid はまだ」の
			// 一瞬が起こりうる。ここを死亡扱いにすると正常な起動を取りこぼす。
			client.setThreads([
				{ threadId: 'thread-dead', socketPath: stale.socketPath },
				{ threadId: 'thread-dead-win', socketPath: staleWin.socketPath },
				{ threadId: 'thread-live', socketPath: live.socketPath },
				{ threadId: 'thread-unknown', socketPath: unknown.socketPath },
			]);
			client.setEnabled(true);
			await waitFor(() => client.isThreadReady('thread-live') && client.isThreadReady('thread-unknown'));
			// 生きている側が揃った時点で死骸を見ると、「まだ繋がっていないだけ」でも通ってしまう。
			// 偽app-serverは待ち受けたままなので、猶予を与えても繋がらないことが判定になる。
			await new Promise(resolve => setTimeout(resolve, 100));

			assert.deepStrictEqual({
				stale: { ready: client.isThreadReady('thread-dead'), resumed: stale.resumedThreads },
				staleWin: { ready: client.isThreadReady('thread-dead-win'), resumed: staleWin.resumedThreads },
				live: { ready: client.isThreadReady('thread-live'), resumed: live.resumedThreads },
				unknown: { ready: client.isThreadReady('thread-unknown'), resumed: unknown.resumedThreads },
			}, {
				stale: { ready: false, resumed: [] },
				staleWin: { ready: false, resumed: [] },
				live: { ready: true, resumed: ['thread-live'] },
				unknown: { ready: true, resumed: ['thread-unknown'] },
			});
		} finally {
			client.dispose();
			await fs.rm(testRoot, { recursive: true, force: true });
		}
	});
});
