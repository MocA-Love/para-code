/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisResumeSession } from '../../common/paradisSessionResume.js';
import { IParadisResumeSpaceWithUri, ParadisSessionResumeClient } from '../../electron-browser/paradisSessionResumeClient.js';

suite('ParadisSessionResumeClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	class RecordingChannel implements IChannel {
		readonly calls: { command: string; args: unknown }[] = [];
		result: unknown = [];
		// list() の途中経過を制御したいテスト用。積んでおくと、次の call() はこれが解決するまで待つ。
		private readonly pending: DeferredPromise<unknown>[] = [];

		queueDeferredCall(): DeferredPromise<unknown> {
			const deferred = new DeferredPromise<unknown>();
			this.pending.push(deferred);
			return deferred;
		}

		call<T>(command: string, arg?: unknown): Promise<T> {
			this.calls.push({ command, args: arg });
			const deferred = this.pending.shift();
			if (deferred) {
				return deferred.p as Promise<T>;
			}
			return Promise.resolve(this.result as T);
		}

		listen<T>(): Event<T> {
			throw new Error('not used');
		}
	}

	function session(id: string, updatedAt = 1): IParadisResumeSession {
		return {
			catalogId: `catalog-${id}`, id, agent: 'claude', title: id, preview: id, cwd: '/x',
			spaceStateKey: 's', spaceName: 'S', currentSpace: true, updatedAt, archived: false,
		};
	}

	function createSharedProcessService(channel: IChannel): ISharedProcessService {
		return { getChannel: () => channel } as unknown as ISharedProcessService;
	}

	function createRemoteAgentService(connection: IRemoteAgentConnection | null): IRemoteAgentService {
		return { getConnection: () => connection } as unknown as IRemoteAgentService;
	}

	function createClient(local: IChannel, remote?: IRemoteAgentConnection | null): ParadisSessionResumeClient {
		return new ParadisSessionResumeClient(createSharedProcessService(local), createRemoteAgentService(remote ?? null), new NullLogService());
	}

	function localSpace(name: string): IParadisResumeSpaceWithUri {
		return { stateKey: `local-${name}`, name, uri: URI.file(`/home/local/${name}`), current: false };
	}

	function remoteSpace(name: string, authority: string): IParadisResumeSpaceWithUri {
		return { stateKey: `remote-${name}`, name, uri: URI.from({ scheme: 'vscode-remote', authority, path: `/home/remote/${name}` }), current: false };
	}

	test('sends local spaces to the local channel and drops a vscode-remote space when there is no remote connection', async () => {
		const local = new RecordingChannel();
		const client = createClient(local);

		await client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] });

		assert.strictEqual(local.calls.length, 1);
		const [request] = local.calls[0].args as [{ spaces: { cwd: string }[] }];
		// remoteSpace は問い合わせ先が無いので、手元へ落とさずそのままスキップする
		assert.deepStrictEqual(request.spaces.map(space => space.cwd), [URI.file('/home/local/a').fsPath]);
	});

	test('splits spaces between local and remote channels by scheme and authority, using OS-correct cwd', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);

		await client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] });

		assert.strictEqual(local.calls.length, 1);
		assert.strictEqual(remote.calls.length, 1);
		const [localRequest] = local.calls[0].args as [{ spaces: { cwd: string }[] }];
		const [remoteRequest] = remote.calls[0].args as [{ spaces: { cwd: string }[] }];
		assert.deepStrictEqual(localRequest.spaces.map(space => space.cwd), [URI.file('/home/local/a').fsPath]);
		assert.deepStrictEqual(remoteRequest.spaces.map(space => space.cwd), ['/home/remote/b']);
	});

	test('queries neither channel for a vscode-remote space from a different authority than the connection', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);

		await client.list({ spaces: [remoteSpace('other', 'ssh-remote+other-host')] });

		assert.strictEqual(remote.calls.length, 0);
		assert.strictEqual(local.calls.length, 0);
	});

	test('routes preview and search for a catalogId back to the channel that listed it, never the other machine', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);
		local.result = [session('local-one')];
		remote.result = [session('remote-one')];

		await client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] });
		local.calls.length = 0;
		remote.calls.length = 0;
		local.result = [];
		remote.result = [];

		await client.preview('catalog-local-one');
		await client.preview('catalog-remote-one');
		const searchResults = await client.search('term', ['catalog-local-one', 'catalog-remote-one', 'catalog-unknown']);

		assert.deepStrictEqual(local.calls.map(call => call.command), ['preview', 'search']);
		assert.deepStrictEqual(remote.calls.map(call => call.command), ['preview', 'search']);
		assert.deepStrictEqual(local.calls[1].args, ['term', ['catalog-local-one']]);
		assert.deepStrictEqual(remote.calls[1].args, ['term', ['catalog-remote-one']]);
		// unknown catalogIds (not from the latest list) are dropped rather than guessed at
		assert.strictEqual(searchResults.length, 0);
	});

	test('rejects preview for a catalogId that was never listed, instead of guessing the local machine', async () => {
		const local = new RecordingChannel();
		const client = createClient(local);

		await assert.rejects(client.preview('catalog-stale'), /no longer available/);

		assert.strictEqual(local.calls.length, 0);
	});

	test('keeps the previous list result available to preview while a new list() is still in flight', async () => {
		const local = new RecordingChannel();
		const client = createClient(local);
		local.result = [session('one')];
		await client.list({ spaces: [localSpace('a')] });
		local.result = [session('two')];
		const stalled = local.queueDeferredCall();

		const inFlightList = client.list({ spaces: [localSpace('a')] });
		// list() の応答がまだ返っていない間は、直前の list() の catalogId が引き続き引ける
		await client.preview('catalog-one');
		assert.strictEqual(local.calls.at(-1)?.command, 'preview');

		stalled.complete([session('two')]);
		await inFlightList;
	});

	test('keeps the previous catalogHost when a list() call rejects', async () => {
		const local = new RecordingChannel();
		const client = createClient(local);
		local.result = [session('one')];
		await client.list({ spaces: [localSpace('a')] });

		const stalled = local.queueDeferredCall();
		const rejectedList = client.list({ spaces: [localSpace('a')] });
		stalled.error(new Error('transient failure'));
		await assert.rejects(rejectedList);

		await client.preview('catalog-one');
		assert.strictEqual(local.calls.at(-1)?.command, 'preview');
	});

	test('returns results from the machine that succeeded when the other machine fails to list', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);
		local.result = [session('local-one')];
		const failing = remote.queueDeferredCall();
		failing.error(new Error('remote unreachable'));

		const sessions = await client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] });

		assert.deepStrictEqual(sessions.map(candidate => candidate.id), ['local-one']);
	});

	test('throws only when both machines fail to list', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);
		local.queueDeferredCall().error(new Error('local unreachable'));
		remote.queueDeferredCall().error(new Error('remote unreachable'));

		await assert.rejects(client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] }));
	});

	test('merges local and remote results in updatedAt-descending order', async () => {
		const local = new RecordingChannel();
		const remote = new RecordingChannel();
		const connection = { remoteAuthority: 'ssh-remote+host', getChannel: () => remote } as unknown as IRemoteAgentConnection;
		const client = createClient(local, connection);
		local.result = [session('local-old', 1), session('local-new', 30)];
		remote.result = [session('remote-mid', 20)];

		const sessions = await client.list({ spaces: [localSpace('a'), remoteSpace('b', 'ssh-remote+host')] });

		assert.deepStrictEqual(sessions.map(candidate => candidate.id), ['local-new', 'remote-mid', 'local-old']);
	});
});
