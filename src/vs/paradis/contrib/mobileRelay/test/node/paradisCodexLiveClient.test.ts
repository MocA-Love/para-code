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
}

async function createFakeAppServer(testRoot: string, name: string, loadedThreads: readonly string[]): Promise<IFakeAppServer> {
	const { createServer } = await import('http');
	const socketPath = join(testRoot, `${name}.sock`);
	const resumedThreads: string[] = [];
	const server: Server = createServer();
	const webSockets = new WebSocketServer({ noServer: true });
	server.on('upgrade', (request, socket, head) => webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection, request)));
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
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		resumedThreads,
		async [Symbol.asyncDispose]() {
			for (const connection of webSockets.clients) {
				connection.terminate();
			}
			webSockets.close();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
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
});
