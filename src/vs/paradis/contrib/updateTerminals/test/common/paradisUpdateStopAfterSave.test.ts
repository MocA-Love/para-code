/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TitleEventSource } from '../../../../../platform/terminal/common/terminal.js';
import { IWillShutdownEventDefaultJoiner, ShutdownReason } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import {
	IParadisRemoteUpdateStopHost,
	IParadisUpdateStopShutdownEvent,
	PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY,
	ParadisRemoteUpdateStop,
	ParadisUpdateCarryOverReader,
	paradisDescribeUpdateCarryOver,
	paradisParseUpdateCarryOver,
	paradisSerializeUpdateCarryOver,
	paradisUpdateCarryOverFolderPath,
} from '../../common/paradisUpdateStopAfterSave.js';
import { paradisClearUpdateQuitApproved, paradisMarkUpdateQuitApproved } from '../../common/paradisUpdateTerminals.js';

const JOINER: IWillShutdownEventDefaultJoiner = { id: 'test', label: 'test' };

suite('paradisUpdateStopAfterSave', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => paradisClearUpdateQuitApproved());

	/** 偽のウィンドウ。止めた番号と、出来事の順番を記録する。 */
	function createHost(steps: string[], live: number[], shouldStop = true): IParadisRemoteUpdateStopHost {
		return {
			shouldStop: () => shouldStop,
			collectIds: async () => [...live, 90],
			liveIds: () => live,
			recordCarryOver: () => steps.push('record carry-over'),
			forgetCarryOver: () => steps.push('forget carry-over'),
			stop: async ids => {
				steps.push(`stop ${ids.join(',')}`);
				return ids.length;
			},
		};
	}

	/** 偽の lifecycle。UI の状態の保存（`desktop.main.ts`）が先に合図を受け取る並びを作る。 */
	function createLifecycle(steps: string[]) {
		const onWillShutdown = store.add(new Emitter<IParadisUpdateStopShutdownEvent>());
		store.add(onWillShutdown.event(() => steps.push('save UI state')));
		return {
			onWillShutdown,
			async shutdown(reason = ShutdownReason.QUIT): Promise<void> {
				const joined: Promise<void>[] = [];
				onWillShutdown.fire({ reason, join: promise => joined.push(promise) });
				await Promise.all(joined);
			},
		};
	}

	test('stops the terminals only after the UI state is saved, using the ids taken when the button was pressed', async () => {
		const steps: string[] = [];
		const live = [1, 2];
		const stop = new ParadisRemoteUpdateStop(createHost(steps, live));
		const lifecycle = createLifecycle(steps);
		store.add(lifecycle.onWillShutdown.event(event => {
			if (!stop.joinOnShutdown(event, JOINER, async stopping => { await stopping; })) {
				steps.push('not armed');
			}
		}));

		paradisMarkUpdateQuitApproved(Date.now());
		await stop.arm();
		steps.push('pressed');
		// 終了処理の中では端末が先に片付けられ、一覧から消えていることがある。押した後に開いた端末（3）は
		// 一覧に残っていれば足す。
		live.splice(0, live.length, 3);
		await lifecycle.shutdown();

		assert.deepStrictEqual(steps, [
			'record carry-over',
			'pressed',
			'save UI state',
			'stop 1,2,90,3',
		]);
	});

	test('does not stop when the update was cancelled, the quit was vetoed, or the window keeps its terminals', async () => {
		const run = async (options: { shouldStop?: boolean; approved?: boolean; disarm?: boolean; reason?: ShutdownReason }) => {
			const steps: string[] = [];
			const stop = new ParadisRemoteUpdateStop(createHost(steps, [1], options.shouldStop ?? true));
			const lifecycle = createLifecycle(steps);
			const listener = lifecycle.onWillShutdown.event(event => steps.push(`joined ${stop.joinOnShutdown(event, JOINER, async stopping => { await stopping; })}`));
			if (options.approved !== false) {
				paradisMarkUpdateQuitApproved(Date.now());
			}
			await stop.arm();
			if (options.disarm) {
				stop.disarm();
			}
			await lifecycle.shutdown(options.reason);
			listener.dispose();
			paradisClearUpdateQuitApproved();
			return steps;
		};
		assert.deepStrictEqual({
			cancelled: await run({ disarm: true }),
			approvalGone: await run({ approved: false }),
			// 設定が `never`、または接続先の常駐の中（更新をまたいで繋ぎ直す）
			keeps: await run({ shouldStop: false }),
			// 合図が生きている間でも、アプリの終了でなければ止めない（別のウィンドウが終了を取り消した、
			// 更新が黙って失敗した後に、ウィンドウを閉じた・再読み込みした）
			closed: await run({ reason: ShutdownReason.CLOSE }),
			reloaded: await run({ reason: ShutdownReason.RELOAD }),
			loaded: await run({ reason: ShutdownReason.LOAD }),
		}, {
			cancelled: ['record carry-over', 'forget carry-over', 'save UI state', 'joined false'],
			approvalGone: ['record carry-over', 'save UI state', 'forget carry-over', 'joined false'],
			keeps: ['save UI state', 'joined false'],
			closed: ['record carry-over', 'save UI state', 'forget carry-over', 'joined false'],
			reloaded: ['record carry-over', 'save UI state', 'forget carry-over', 'joined false'],
			loaded: ['record carry-over', 'save UI state', 'forget carry-over', 'joined false'],
		});
	});

	test('carries over the working folder, and the name only when a person gave it', () => {
		const now = 1_000_000;
		const terminals = [
			paradisDescribeUpdateCarryOver({ shellIntegrationNonce: 'renamed', cwd: '/home/example/app', persistentTitle: 'build', persistentTitleSource: TitleEventSource.Api }),
			paradisDescribeUpdateCarryOver({ shellIntegrationNonce: 'agent', cwd: '/home/example/web', persistentTitle: 'Claude · fix the tests', persistentTitleSource: TitleEventSource.Sequence }),
			paradisDescribeUpdateCarryOver({ shellIntegrationNonce: 'fresh', persistentTitle: 'zsh', persistentTitleSource: TitleEventSource.Process }),
			paradisDescribeUpdateCarryOver({ shellIntegrationNonce: '', cwd: '/tmp', persistentTitle: 'x', persistentTitleSource: TitleEventSource.Api }),
		].filter(entry => entry !== undefined);
		const raw = paradisSerializeUpdateCarryOver('ssh-remote+host', 'old-commit', terminals, now);
		assert.deepStrictEqual({
			read: [...paradisParseUpdateCarryOver(raw, 'ssh-remote+host', 'new-commit', now + 60_000).values()],
			otherHost: paradisParseUpdateCarryOver(raw, 'ssh-remote+other', 'new-commit', now).size,
			local: paradisParseUpdateCarryOver(raw, undefined, 'new-commit', now).size,
			stale: paradisParseUpdateCarryOver(raw, 'ssh-remote+host', 'new-commit', now + 25 * 60 * 60 * 1000).size,
			broken: paradisParseUpdateCarryOver('{', 'ssh-remote+host', 'new-commit', now).size,
			// 版が変わっていない（更新されずに閉じた・再読み込みした）
			notUpdated: paradisParseUpdateCarryOver(raw, 'ssh-remote+host', 'old-commit', now).size,
			folders: [paradisUpdateCarryOverFolderPath('/home/example/app'), paradisUpdateCarryOverFolderPath('C:\\Users\\example\\app')],
		}, {
			read: [
				{ nonce: 'renamed', cwd: '/home/example/app', name: 'build' },
				{ nonce: 'agent', cwd: '/home/example/web' },
				{ nonce: 'fresh' },
			],
			otherHost: 0,
			local: 0,
			stale: 0,
			broken: 0,
			notUpdated: 0,
			folders: ['/home/example/app', '/C:/Users/example/app'],
		});
	});

	test('reads the carry-over once at startup and hands it out only once per tab, early, for the same host, and only to folders that still exist', async () => {
		const now = 1_000_000;
		const storage = store.add(new InMemoryStorageService());
		storage.store(PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY, paradisSerializeUpdateCarryOver('ssh-remote+host', 'old-commit', [
			{ nonce: 'kept', cwd: '/home/example/app', name: 'build' },
			{ nonce: 'gone', cwd: '/home/example/removed' },
			{ nonce: 'late', cwd: '/home/example/app' },
		], now), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const reader = ParadisUpdateCarryOverReader.read(storage, 'ssh-remote+host', 'new-commit', now);
		const logService = store.add(new NullLogService());
		const probed: string[] = [];
		const probe = {
			stat: async (resource: URI) => {
				probed.push(resource.toString());
				if (resource.path === '/home/example/removed') {
					throw new Error('not found');
				}
				return { isDirectory: true };
			},
		};
		const resolve = async (nonce: string, remoteAuthority: string | undefined, at = now + 1_000) => {
			const carryOver = await reader?.resolve({ instanceId: 1, nonce, remoteAuthority }, probe, logService, at);
			return carryOver === undefined ? undefined : { cwd: carryOver.cwd?.toString(), name: carryOver.name };
		};
		assert.deepStrictEqual({
			removedFromStorage: storage.get(PARADIS_UPDATE_CARRY_OVER_STORAGE_KEY, StorageScope.WORKSPACE),
			otherHost: await resolve('kept', 'ssh-remote+other'),
			kept: await resolve('kept', 'ssh-remote+host'),
			again: await resolve('kept', 'ssh-remote+host'),
			gone: await resolve('gone', 'ssh-remote+host'),
			late: await resolve('late', 'ssh-remote+host', now + 6 * 60 * 1000),
			probed,
			nothingToRead: ParadisUpdateCarryOverReader.read(storage, 'ssh-remote+host', 'new-commit', now),
		}, {
			removedFromStorage: undefined,
			otherHost: undefined,
			kept: { cwd: 'vscode-remote://ssh-remote%2Bhost/home/example/app', name: 'build' },
			again: undefined,
			gone: { cwd: undefined, name: undefined },
			// 起動から 5 分を過ぎて起こし直されたシェルには当てない
			late: undefined,
			probed: ['vscode-remote://ssh-remote%2Bhost/home/example/app', 'vscode-remote://ssh-remote%2Bhost/home/example/removed'],
			nothingToRead: undefined,
		});
	});
});
