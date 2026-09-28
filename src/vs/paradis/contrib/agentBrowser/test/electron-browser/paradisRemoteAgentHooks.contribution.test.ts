/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisRemoteAgentHookFilesHost, ParadisRemoteAgentHookFiles, ParadisRemoteAgentHooksController, paradisMergeRemoteClaudeMcpJson } from '../../electron-browser/paradisRemoteAgentHooks.contribution.js';
import { paradisRollingBackupUri } from '../../../../common/paradisRollingFileBackupUri.js';

interface IDeferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function deferred(): IDeferred {
	let resolve!: () => void;
	const promise = new Promise<void>(complete => resolve = complete);
	return { promise, resolve };
}

suite('ParadisRemoteAgentHooksController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('stops retrying after the second installation succeeds', async () => {
		const events: string[] = [];
		const watching = deferred();
		let attempts = 0;
		const controller = store.add(new ParadisRemoteAgentHooksController(
			async () => {
				attempts++;
				events.push(`install:${attempts}`);
				return attempts === 2 ? 4100 : undefined;
			},
			async () => 4100,
			async delayMs => { events.push(`delay:${delayMs}`); },
			(_callback, intervalMs): IDisposable => {
				events.push(`interval:${intervalMs}`);
				watching.resolve();
				return toDisposable(() => undefined);
			},
			new NullLogService(),
		));

		await watching.promise;

		assert.deepStrictEqual(events, [
			'install:1',
			'delay:2000',
			'install:2',
			'interval:30000',
		]);
		controller.dispose();
	});

	test('exhausts all four production retry stages when installation keeps failing', async () => {
		const events: string[] = [];
		const exhausted = deferred();
		const controller = store.add(new ParadisRemoteAgentHooksController(
			async () => { events.push('install'); return undefined; },
			async () => 4100,
			async delayMs => { events.push(`delay:${delayMs}`); },
			() => toDisposable(() => undefined),
			{
				info: () => undefined,
				warn: () => { events.push('gave-up'); exhausted.resolve(); },
			},
		));

		await exhausted.promise;

		assert.deepStrictEqual(events, [
			'install',
			'delay:2000',
			'install',
			'delay:5000',
			'install',
			'delay:15000',
			'install',
			'gave-up',
		]);
		controller.dispose();
	});

	test('reinstalls only after the gateway port changes', async () => {
		let callback: (() => Promise<void>) | undefined;
		let installCount = 0;
		const watching = deferred();
		const endpoints = [4100, 4200, 4200];
		const controller = store.add(new ParadisRemoteAgentHooksController(
			async () => ++installCount === 1 ? 4100 : 4200,
			async () => endpoints.shift(),
			async () => undefined,
			(candidate, _intervalMs) => {
				callback = candidate;
				watching.resolve();
				return toDisposable(() => undefined);
			},
			new NullLogService(),
		));
		await watching.promise;

		await callback!();
		assert.strictEqual(installCount, 1);
		await callback!();
		assert.strictEqual(installCount, 2);
		await callback!();
		assert.strictEqual(installCount, 2);
		controller.dispose();
	});

	test('serializes overlapping polls so an older installation cannot overwrite a newer port', async () => {
		let callback: (() => Promise<void>) | undefined;
		let installCount = 0;
		let endpointReadCount = 0;
		const watching = deferred();
		const firstChangedInstall = deferred();
		const firstChangedInstallStarted = deferred();
		const endpoints = [4200, 4300, 4300];
		const controller = store.add(new ParadisRemoteAgentHooksController(
			async () => {
				installCount++;
				if (installCount === 1) {
					return 4100;
				}
				if (installCount === 2) {
					firstChangedInstallStarted.resolve();
					await firstChangedInstall.promise;
					return 4200;
				}
				return 4300;
			},
			async () => endpoints[endpointReadCount++],
			async () => undefined,
			candidate => {
				callback = candidate;
				watching.resolve();
				return toDisposable(() => undefined);
			},
			new NullLogService(),
		));
		await watching.promise;

		const olderPoll = callback!();
		await firstChangedInstallStarted.promise;
		await callback!();
		assert.deepStrictEqual({ installCount, endpointReadCount }, { installCount: 2, endpointReadCount: 1 });

		firstChangedInstall.resolve();
		await olderPoll;
		await callback!();
		await callback!();

		assert.deepStrictEqual({ installCount, endpointReadCount }, { installCount: 3, endpointReadCount: 3 });
		controller.dispose();
	});

	test('ignores an announced port until the first installation has settled', async () => {
		// 最初の導入は再試行の待ち時間を挟む。その間に「番号が変わった」が届いて割り込むと、
		// install() が二重に走って古い導入が新しい番号を上書きしうる
		const events: string[] = [];
		const announcements = store.add(new Emitter<number | undefined>());
		const watching = deferred();
		const insideFirstDelay = deferred();
		const releaseFirstDelay = deferred();
		let attempts = 0;
		const controller = store.add(new ParadisRemoteAgentHooksController(
			async () => {
				attempts++;
				events.push(`install:${attempts}`);
				return attempts === 2 ? 4200 : undefined;
			},
			async () => 4200,
			async delayMs => {
				events.push(`delay:${delayMs}`);
				insideFirstDelay.resolve();
				await releaseFirstDelay.promise;
			},
			(_callback, intervalMs): IDisposable => {
				events.push(`interval:${intervalMs}`);
				watching.resolve();
				return toDisposable(() => undefined);
			},
			new NullLogService(),
			announcements.event,
		));

		await insideFirstDelay.promise;
		announcements.fire(4200);
		releaseFirstDelay.resolve();
		await watching.promise;

		assert.deepStrictEqual(events, [
			'install:1',
			'delay:2000',
			'install:2',
			'interval:30000',
		]);
		controller.dispose();
	});

	test('does not poll or retry after disposal', async () => {
		let poll: (() => Promise<void>) | undefined;
		let installCount = 0;
		let endpointReadCount = 0;
		let intervalDisposeCount = 0;
		const retryDelay = deferred();
		const retryStarted = deferred();
		const retryController = store.add(new ParadisRemoteAgentHooksController(
			async () => { installCount++; return undefined; },
			async () => 4100,
			async () => { retryStarted.resolve(); await retryDelay.promise; },
			() => toDisposable(() => undefined),
			new NullLogService(),
		));
		await retryStarted.promise;
		retryController.dispose();
		retryDelay.resolve();
		await Promise.resolve();

		const watching = deferred();
		const pollController = store.add(new ParadisRemoteAgentHooksController(
			async () => 4100,
			async () => { endpointReadCount++; return 4100; },
			async () => undefined,
			callback => {
				poll = callback;
				watching.resolve();
				return toDisposable(() => intervalDisposeCount++);
			},
			new NullLogService(),
		));
		await watching.promise;
		pollController.dispose();
		await poll!();

		assert.deepStrictEqual(
			{ installCount, endpointReadCount, intervalDisposeCount },
			{ installCount: 1, endpointReadCount: 0, intervalDisposeCount: 1 },
		);
	});
});

suite('Paradis remote agent JSON merge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves Claude MCP settings and is idempotent', () => {
		const existing = JSON.stringify({
			model: 'keep-model',
			mcpServers: { existing: { command: 'keep-command' } },
		});

		const first = paradisMergeRemoteClaudeMcpJson(existing, 4100);
		const second = paradisMergeRemoteClaudeMcpJson(first, 4100);

		assert.deepStrictEqual(JSON.parse(first!), {
			model: 'keep-model',
			mcpServers: {
				existing: { command: 'keep-command' },
				'para-browser': {
					type: 'http',
					url: 'http://127.0.0.1:4100/',
					headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' },
				},
			},
		});
		assert.strictEqual(second, first);
	});

	test('leaves corrupt JSON untouched by declining to produce replacement content', () => {
		assert.deepStrictEqual({
			corrupt: paradisMergeRemoteClaudeMcpJson('{ corrupt', 4100),
			notAnObject: paradisMergeRemoteClaudeMcpJson('["not", "an", "object"]', 4100),
			nullRoot: paradisMergeRemoteClaudeMcpJson('null', 4100),
		}, {
			corrupt: undefined,
			notAnObject: undefined,
			nullRoot: undefined,
		});
	});
});

suite('ParadisRemoteAgentHookFiles', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const HOOKED = JSON.stringify({ hooks: { Stop: ['para-code'] } });
	const home = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/example' });
	const claudeSettings = joinPath(home, '.claude', 'settings.json');
	const codexHooks = joinPath(home, '.codex', 'hooks.json');

	function setup(disposables: DisposableStore, enabled: boolean) {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('vscode-remote', disposables.add(new InMemoryFileSystemProvider())));
		const state = {
			resolvedHome: home as URI | undefined,
			/** 設置の中身を組み立てる問い合わせを、ここが解決されるまで止める */
			buildGate: Promise.resolve(),
			/** 組み立ての問い合わせの最中に走らせる処理（その間の設定の切り替えを作る） */
			duringBuild: () => { },
			/** ここに入れたファイルは読めない */
			unreadable: new Set<string>(),
			calls: [] as string[],
		};
		const host: IParadisRemoteAgentHookFilesHost = {
			fileService: {
				exists: resource => fileService.exists(resource),
				writeFile: (resource, content) => fileService.writeFile(resource, content),
				copy: (source, target, overwrite) => fileService.copy(source, target, overwrite),
				realpath: resource => fileService.realpath(resource),
				stat: resource => fileService.stat(resource),
				readFile: resource => state.unreadable.has(resource.toString())
					? Promise.reject(new Error('permission denied'))
					: fileService.readFile(resource),
			},
			logService: new NullLogService(),
			remoteAuthority: 'ssh-remote+host',
			resolveHome: async () => state.resolvedHome,
			buildHooksJson: async cli => {
				state.calls.push(`build:${cli}`);
				await state.buildGate;
				state.duringBuild();
				return HOOKED;
			},
			buildRemovalJson: async current => {
				state.calls.push('remove');
				return current === HOOKED ? JSON.stringify({ hooks: {} }) : current;
			},
		};
		const read = async (file: URI) => (await fileService.readFile(file).catch(() => undefined))?.value.toString();
		return { files: new ParadisRemoteAgentHookFiles(host, enabled), fileService, state, read };
	}

	test('オフへの切り替えは走っている設置の後に回り、設置が古い判断で hook を残さない', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, state, read } = setup(disposables, true);
		let releaseBuild!: () => void;
		state.buildGate = new Promise(resolve => releaseBuild = resolve);

		const install = files.runExclusive(() => files.sync(home));
		while (!state.calls.includes('build:claude')) {
			await timeout(0);
		}
		const removal = files.setEnabled(false);
		releaseBuild();
		await Promise.all([install, removal]);

		assert.deepStrictEqual({
			claude: await read(claudeSettings),
			codex: await read(codexHooks),
			calls: state.calls,
			pending: files.pendingChange,
		}, {
			// 設置は組み立て後・書く直前にオフを見て Claude の分も書かない。取り外すものも残らない
			claude: undefined,
			codex: undefined,
			calls: ['build:claude'],
			pending: undefined,
		});
	});

	test('ホームが分からない間に切ったオフは保留し、次の周回で取り外す', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, fileService, state, read } = setup(disposables, true);
		await fileService.writeFile(claudeSettings, VSBuffer.fromString(HOOKED));
		state.resolvedHome = undefined;

		await files.setEnabled(false);
		const whileUnresolved = { claude: await read(claudeSettings), pending: files.pendingChange };
		state.resolvedHome = home;
		await files.retryPending();

		assert.deepStrictEqual({ whileUnresolved, claude: await read(claudeSettings), backup: await read(paradisRollingBackupUri(claudeSettings)), pending: files.pendingChange }, {
			whileUnresolved: { claude: HOOKED, pending: 'remove' },
			claude: JSON.stringify({ hooks: {} }),
			// 書き換える前の中身を隣へ1つ控える
			backup: HOOKED,
			pending: undefined,
		});
	});

	test('オフで起動しただけでは接続先の hook に触らない', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, fileService, state, read } = setup(disposables, false);
		await fileService.writeFile(claudeSettings, VSBuffer.fromString(HOOKED));

		await files.runExclusive(() => files.sync(home));

		assert.deepStrictEqual({ claude: await read(claudeSettings), calls: state.calls }, { claude: HOOKED, calls: [] });
	});

	test('組み立てている間に書き換えられたら、読み直した中身から組み立て直す', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, fileService, read } = setup(disposables, true);
		const file = joinPath(home, '.claude.json');
		await fileService.writeFile(file, VSBuffer.fromString('a'));
		const seen: (string | undefined)[] = [];

		await files.mergeJson(file, async current => {
			seen.push(current);
			if (seen.length === 1) {
				// 別の書き手（エージェント自身など）が割り込む
				await fileService.writeFile(file, VSBuffer.fromString('b'));
			}
			return `${current}+para`;
		});

		assert.deepStrictEqual({ seen, content: await read(file) }, { seen: ['a', 'b'], content: 'b+para' });
	});

	test('読めないファイルが残ったら取り外し待ちを消さず、読めるようになった周回で外す', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, fileService, state, read } = setup(disposables, true);
		await fileService.writeFile(claudeSettings, VSBuffer.fromString(HOOKED));
		await fileService.writeFile(codexHooks, VSBuffer.fromString(HOOKED));
		state.unreadable.add(claudeSettings.toString());

		await files.setEnabled(false);
		const whileUnreadable = { claude: await read(claudeSettings), codex: await read(codexHooks), pending: files.pendingChange };
		state.unreadable.clear();
		await files.retryPending();

		assert.deepStrictEqual({ whileUnreadable, claude: await read(claudeSettings), pending: files.pendingChange }, {
			whileUnreadable: { claude: HOOKED, codex: JSON.stringify({ hooks: {} }), pending: 'remove' },
			claude: JSON.stringify({ hooks: {} }),
			pending: undefined,
		});
	});

	test('組み立ての問い合わせの最中にオフへ切り替わったら、書く直前に気付いて置かない', async () => {
		const disposables = store.add(new DisposableStore());
		const { files, state, read } = setup(disposables, true);
		let removal: Promise<void> | undefined;
		state.duringBuild = () => {
			state.duringBuild = () => { };
			removal = files.setEnabled(false);
		};

		await files.runExclusive(() => files.sync(home));
		await removal;

		assert.deepStrictEqual({ claude: await read(claudeSettings), codex: await read(codexHooks), calls: state.calls, pending: files.pendingChange }, {
			claude: undefined,
			codex: undefined,
			calls: ['build:claude'],
			pending: undefined,
		});
	});
});
