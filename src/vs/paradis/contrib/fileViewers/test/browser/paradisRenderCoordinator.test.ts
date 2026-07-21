/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { strictEqual, rejects } from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisRenderCoordinator, runParadisRenderWithRetries } from '../../browser/paradisRenderCoordinator.js';

suite('ParadisRenderCoordinator', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('serializes renders and coalesces requests received during an active render', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		let executions = 0;
		const coordinator = disposables.add(new ParadisRenderCoordinator(async () => {
			executions++;
			if (executions === 1) {
				firstStarted.complete();
				await releaseFirst.p;
			}
		}));

		const first = coordinator.request();
		await firstStarted.p;
		const second = coordinator.request();
		const third = coordinator.request();

		strictEqual(executions, 1);
		releaseFirst.complete();
		await Promise.all([first, second, third]);
		strictEqual(executions, 2);
	});

	test('continues with a pending render after an active render fails', async () => {
		const firstStarted = new DeferredPromise<void>();
		const releaseFirst = new DeferredPromise<void>();
		let executions = 0;
		const expectedError = new Error('first render failed');
		const coordinator = disposables.add(new ParadisRenderCoordinator(async () => {
			executions++;
			if (executions === 1) {
				firstStarted.complete();
				await releaseFirst.p;
				throw expectedError;
			}
		}));

		const first = coordinator.request();
		await firstStarted.p;
		const second = coordinator.request();
		releaseFirst.complete();

		await rejects(first, error => error === expectedError);
		await second;
		strictEqual(executions, 2);
	});

	test('rejects active and pending callers when disposed', async () => {
		const started = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		const finished = new DeferredPromise<void>();
		const coordinator = disposables.add(new ParadisRenderCoordinator(async () => {
			started.complete();
			try {
				await release.p;
			} finally {
				finished.complete();
			}
		}));

		const active = coordinator.request();
		await started.p;
		const pending = coordinator.request();
		coordinator.dispose();

		await Promise.all([
			rejects(active, error => error instanceof Error && error.name === 'Canceled'),
			rejects(pending, error => error instanceof Error && error.name === 'Canceled'),
		]);
		release.complete();
		await finished.p;
	});

	test('retries presentation until it succeeds', async () => {
		let attempts = 0;
		const result = await runParadisRenderWithRetries(3, async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error(`attempt ${attempts}`);
			}
			return 'loaded';
		});

		strictEqual(result, 'loaded');
		strictEqual(attempts, 3);
	});

	test('throws the final presentation error after exhausting retries', async () => {
		let attempts = 0;
		await rejects(
			runParadisRenderWithRetries(3, async () => {
				attempts++;
				throw new Error(`attempt ${attempts}`);
			}),
			(error: Error) => error.message === 'attempt 3'
		);
		strictEqual(attempts, 3);
	});
});
