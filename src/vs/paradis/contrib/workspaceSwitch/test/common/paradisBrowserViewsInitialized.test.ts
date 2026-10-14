/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisWhenBrowserViewsInitialized } from '../../common/paradisBrowserViewsInitialized.js';

suite('ParadisBrowserViewsInitialized', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function settle(action: (ready: DeferredPromise<void>, lifetime: { dispose(): void }) => Promise<void> | void): Promise<boolean> {
		const ready = new DeferredPromise<void>();
		const bridge = paradisWhenBrowserViewsInitialized(ready.p);
		store.add(bridge.lifetime);
		await action(ready, bridge.lifetime);
		return bridge.whenInitialized;
	}

	test('resolves true on the snapshot, false when building it threw or the owner went away first, and never rejects', async () => {
		assert.deepStrictEqual({
			snapshot: await settle(ready => ready.complete()),
			snapshotError: await settle(ready => ready.error(new Error('model creation failed'))),
			disposedFirst: await settle((_ready, lifetime) => lifetime.dispose()),
			disposedAfterSnapshot: await settle(async (ready, lifetime) => { await ready.complete(); lifetime.dispose(); }),
		}, {
			snapshot: true,
			snapshotError: false,
			disposedFirst: false,
			disposedAfterSnapshot: true,
		});
	});
});
