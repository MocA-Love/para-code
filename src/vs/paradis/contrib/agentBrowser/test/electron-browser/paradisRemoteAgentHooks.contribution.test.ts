/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisRemoteAgentHooksController, paradisMergeRemoteClaudeMcpJson } from '../../electron-browser/paradisRemoteAgentHooks.contribution.js';

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
