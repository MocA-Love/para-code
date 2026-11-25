/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../../base/common/uri.js';
import { paradisHostPathFor } from '../../../../common/paradisHostPath.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisWorktreeGitHost, paradisChannelHostResolver, paradisCollectPerWorktree, paradisGithubReferenceResolver, paradisWorktreeGitHostResolver, paradisWorktreeGitWriteHostResolver } from '../../electron-browser/paradisWorktreeGitChannelClient.js';
import { ParadisGithubReferenceLookup } from '../../../../common/paradisIssueDetection.js';

const CHANNEL_NAME = 'testChannel';
const REMOTE_AUTHORITY = 'ssh-remote+host';

suite('paradisChannelHostResolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const localChannel = { call: async () => undefined };
	const remoteChannel = { call: async () => undefined };

	function createAccessor(connected: boolean, authority = REMOTE_AUTHORITY): ServicesAccessor {
		const sharedProcessService = { getChannel: () => localChannel } as unknown as ISharedProcessService;
		const remoteAgentService = {
			getConnection: () => connected ? { remoteAuthority: authority, getChannel: () => remoteChannel } : null,
		} as unknown as IRemoteAgentService;
		return {
			get: (id: unknown) => id === ISharedProcessService ? sharedProcessService : remoteAgentService,
		} as ServicesAccessor;
	}

	test('a file resource always goes to the local channel regardless of unresolved mode', () => {
		for (const unresolved of ['local', 'reject'] as const) {
			const resolve = paradisChannelHostResolver(createAccessor(true), CHANNEL_NAME, unresolved);
			assert.strictEqual(resolve(URI.file('/repo'))?.channel, localChannel);
		}
	});

	test('a vscode-remote resource matching the connected authority always goes to the remote channel', () => {
		for (const unresolved of ['local', 'reject'] as const) {
			const resolve = paradisChannelHostResolver(createAccessor(true), CHANNEL_NAME, unresolved);
			assert.strictEqual(resolve(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`))?.channel, remoteChannel);
		}
	});

	test(`'local' (default): an unresolvable vscode-remote resource falls back to the local channel`, () => {
		const disconnected = paradisChannelHostResolver(createAccessor(false), CHANNEL_NAME);
		assert.strictEqual(disconnected(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`))?.channel, localChannel);

		const wrongHost = paradisChannelHostResolver(createAccessor(true), CHANNEL_NAME, 'local');
		assert.strictEqual(wrongHost(URI.parse('vscode-remote://ssh-remote+other/repo'))?.channel, localChannel);
	});

	test(`'reject': an unresolvable vscode-remote resource returns undefined instead of falling back to local — CRITICAL guard against running a write against an unrelated local repository that happens to share the same absolute path`, () => {
		const disconnected = paradisChannelHostResolver(createAccessor(false), CHANNEL_NAME, 'reject');
		assert.strictEqual(disconnected(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`)), undefined);

		const wrongHost = paradisChannelHostResolver(createAccessor(true), CHANNEL_NAME, 'reject');
		assert.strictEqual(wrongHost(URI.parse('vscode-remote://ssh-remote+other/repo')), undefined);
	});

	test('path() uses fsPath for the local host and the raw POSIX path for the remote host', () => {
		const resolve = paradisChannelHostResolver(createAccessor(true), CHANNEL_NAME, 'reject');
		const local = resolve(URI.file('/repo'))!;
		const remote = resolve(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`))!;
		assert.strictEqual(local.path(URI.file('/repo')), URI.file('/repo').fsPath);
		assert.strictEqual(remote.path(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`)), '/repo');
	});

	test('paradisWorktreeGitHostResolver is always resolved (never undefined) — it keeps the original read-only fallback behavior', () => {
		const resolve = paradisWorktreeGitHostResolver(createAccessor(true));
		assert.strictEqual(resolve(URI.parse('vscode-remote://ssh-remote+other/repo')).channel, localChannel);
	});

	test('a non-file, non-vscode-remote scheme is never treated as local — only file/vscode-remote have a confirmed machine', () => {
		const untitled = URI.parse('untitled:Untitled-1');
		for (const connected of [false, true]) {
			// 'local' モードでは、旧実装同様に手元へ流れる（読み取り専用の縮退運用）
			const localMode = paradisChannelHostResolver(createAccessor(connected), CHANNEL_NAME, 'local');
			assert.strictEqual(localMode(untitled)?.channel, localChannel, `connected=${connected}`);
			// 'reject' モードでは、file 以外は local へ倒さない（W2回帰: vscode-vfs 等の
			// 非ファイルスキームが素通りで手元 git 実行に使われることを防ぐ）
			const rejectMode = paradisChannelHostResolver(createAccessor(connected), CHANNEL_NAME, 'reject');
			assert.strictEqual(rejectMode(untitled), undefined, `connected=${connected}`);
		}
	});

	test('paradisWorktreeGitWriteHostResolver rejects an unresolvable resource instead of running the write against local', () => {
		const resolve = paradisWorktreeGitWriteHostResolver(createAccessor(true));
		assert.strictEqual(resolve(URI.parse('vscode-remote://ssh-remote+other/repo')), undefined);
		assert.strictEqual(resolve(URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/repo`))?.channel, remoteChannel);
		assert.strictEqual(resolve(URI.file('/repo'))?.channel, localChannel);
	});
});

suite('paradisCollectPerWorktree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Q471: 54 か所を一度に投げず、同時に走る git を上限までに抑える
	test('runs at most the given number of calls at once and still returns every result', async () => {
		let running = 0;
		let maxRunning = 0;
		const gates: DeferredPromise<void>[] = [];
		const channel = {
			call: async <T>(_command: string, args?: unknown): Promise<T> => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				const gate = new DeferredPromise<void>();
				gates.push(gate);
				await gate.p;
				running--;
				return { path: (args as unknown[])[0] } as T;
			},
			listen: () => { throw new Error('not used'); },
		} as unknown as IChannel;
		const host: IParadisWorktreeGitHost = { channel, path: resource => paradisHostPathFor(resource, 'local') };
		const resources = Array.from({ length: 10 }, (_, index) => URI.file(`/repo-${index}`));

		const collecting = paradisCollectPerWorktree<{ path: string }>(resources, () => host, 'getDiffStat', undefined, 4);
		await timeout(0);
		const startedFirst = gates.length;
		for (let index = 0; index < resources.length; index++) {
			gates[index].complete();
			await timeout(0);
		}
		const result = await collecting;

		assert.deepStrictEqual({ startedFirst, maxRunning, count: Object.keys(result).length }, { startedFirst: 4, maxRunning: 4, count: 10 });
	});

	// SSH の再接続中などでチャネルが例外を投げた対象は、値の無い対象と見分けられるようにする
	test('a call that throws is returned as the failed value when one is given', async () => {
		const channel = {
			call: async <T>(_command: string, args?: unknown): Promise<T> => {
				if ((args as string[])[0] === '/down') {
					throw new Error('Connection got disposed.');
				}
				return { insertions: 1, deletions: 0 } as T;
			},
			listen: () => { throw new Error('not used'); },
		} as unknown as IChannel;
		const host: IParadisWorktreeGitHost = { channel, path: resource => paradisHostPathFor(resource, 'local') };
		const resources = [URI.file('/up'), URI.file('/down')];
		const failed = { insertions: 0, deletions: 0, failed: true as const };

		assert.deepStrictEqual({
			withFailedValue: await paradisCollectPerWorktree(resources, () => host, 'getDiffStat', undefined, 4, failed),
			withoutFailedValue: await paradisCollectPerWorktree(resources, () => host, 'getDiffStat'),
		}, {
			withFailedValue: { [URI.file('/up').fsPath]: { insertions: 1, deletions: 0 }, [URI.file('/down').fsPath]: failed },
			withoutFailedValue: { [URI.file('/up').fsPath]: { insertions: 1, deletions: 0 } },
		});
	});
});

suite('paradisGithubReferenceResolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const URL = 'https://github.com/acme/app/issues/2236';
	const ok: ParadisGithubReferenceLookup = { kind: 'ok', info: { kind: 'issue', owner: 'acme', repo: 'app', number: 2236, title: 'Mapping is off', url: URL, state: 'open' } };

	/** 手元と接続先の gh の答え（関数なら投げられる）を決めて、どちらへ何を渡したかを集める。 */
	function createResolver(answers: { readonly local: ParadisGithubReferenceLookup | (() => never); readonly remote?: ParadisGithubReferenceLookup | (() => never) }) {
		const calls: string[] = [];
		const channel = (side: 'local' | 'remote', answer: ParadisGithubReferenceLookup | (() => never)) => ({
			call: async (command: string, args: readonly string[]) => {
				calls.push(`${side} ${command} ${args.join(' ')}`);
				return typeof answer === 'function' ? answer() : answer;
			},
		}) as unknown as IChannel;
		const remote = answers.remote;
		const accessor = {
			get: (id: unknown) => id === ISharedProcessService
				? { getChannel: () => channel('local', answers.local) }
				: { getConnection: () => remote !== undefined ? { remoteAuthority: REMOTE_AUTHORITY, getChannel: () => channel('remote', remote) } : null },
		} as ServicesAccessor;
		return { resolve: paradisGithubReferenceResolver(accessor), calls };
	}

	const remoteRepository = URI.parse(`vscode-remote://${REMOTE_AUTHORITY}/home/dev/app`);

	test('asks the gh on the machine that has the repository, with its path there', async () => {
		const local = createResolver({ local: ok, remote: ok });
		const remote = createResolver({ local: ok, remote: ok });

		assert.deepStrictEqual({
			local: [(await local.resolve(URI.file('/repo'), URL)).via, local.calls],
			remote: [(await remote.resolve(remoteRepository, URL)).via, remote.calls],
		}, {
			local: ['local', [`local lookupGithubReference ${URL} ${URI.file('/repo').fsPath}`]],
			remote: ['remote', [`remote lookupGithubReference ${URL} /home/dev/app`]],
		});
	});

	test('falls back to the local gh, without the remote path, when the remote one fails for any reason', async () => {
		const noGh = createResolver({ local: ok, remote: { kind: 'failed', reason: 'noGh' } });
		const oldHost = createResolver({ local: ok, remote: () => { throw new Error('Method not found: lookupGithubReference'); } });
		const both = createResolver({ local: { kind: 'failed', reason: 'noGh' }, remote: { kind: 'failed', reason: 'notFound' } });
		// 別のホストの古い登録: どのマシンの物か決められないので、パスなしで手元の gh
		const otherHost = createResolver({ local: ok, remote: ok });

		assert.deepStrictEqual({
			noGh: [await noGh.resolve(remoteRepository, URL), noGh.calls],
			oldHost: [(await oldHost.resolve(remoteRepository, URL)).via, oldHost.calls.length],
			both: await both.resolve(remoteRepository, URL),
			otherHost: [(await otherHost.resolve(URI.parse('vscode-remote://ssh-remote+other/repo'), URL)).via, otherHost.calls],
		}, {
			noGh: [{ ...ok, via: 'local' }, [`remote lookupGithubReference ${URL} /home/dev/app`, `local lookupGithubReference ${URL}`]],
			oldHost: ['local', 2],
			// 両方で駄目なら、手がかりの多い理由を見せる
			both: { kind: 'failed', reason: 'notFound', via: 'local' },
			otherHost: ['local', [`local lookupGithubReference ${URL}`]],
		});
	});
});
