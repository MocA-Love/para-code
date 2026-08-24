/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisChangelogLifecycle } from '../../electron-browser/paradisChangelogLifecycle.js';

class TestModal {
	private readonly _onDidDispose = new Emitter<void>();
	readonly onDidDispose = this._onDidDispose.event;
	disposeCount = 0;
	beforeDispose: (() => void) | undefined;

	dispose(): void {
		if (this.disposeCount !== 0) {
			return;
		}
		this.disposeCount++;
		this.beforeDispose?.();
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}
}

suite('ParadisChangelogLifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reopen cancels the old fetch, disposes the old modal and keeps the new generation current', () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		const firstModal = new TestModal();
		const first = lifecycle.open(() => firstModal);
		firstModal.beforeDispose = () => assert.strictEqual(
			first.token.isCancellationRequested,
			true,
			'reopen must cancel the fetch before disposing its modal',
		);
		const secondModal = new TestModal();
		const second = lifecycle.open(() => secondModal);

		assert.strictEqual(first.token.isCancellationRequested, true);
		assert.strictEqual(firstModal.disposeCount, 1);
		assert.strictEqual(first.isCurrent(), false);
		assert.strictEqual(second.isCurrent(), true);

		first.finishFetch();
		assert.strictEqual(second.isCurrent(), true, 'an old finally must not clear the current generation');
		lifecycle.dispose();
		assert.strictEqual(second.token.isCancellationRequested, true);
		assert.strictEqual(secondModal.disposeCount, 1);
	});

	test('closing the modal cancels its current fetch and clears the generation', () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		const modal = new TestModal();
		const generation = lifecycle.open(() => modal);

		modal.dispose();

		assert.strictEqual(generation.token.isCancellationRequested, true);
		assert.strictEqual(generation.isCurrent(), false);
		lifecycle.dispose();
		assert.strictEqual(modal.disposeCount, 1);
	});

	test('a late result from the replaced generation cannot publish', async () => {
		const lifecycle = new ParadisChangelogLifecycle<TestModal>();
		let resolveFirst!: (value: string) => void;
		const firstResult = new Promise<string>(resolve => resolveFirst = resolve);
		const first = lifecycle.open(() => new TestModal());
		const published: string[] = [];
		const firstWork = firstResult
			.then(value => {
				if (first.isCurrent()) {
					published.push(value);
				}
			})
			.finally(() => first.finishFetch());

		const second = lifecycle.open(() => new TestModal());
		resolveFirst('stale');
		await firstWork;

		assert.deepStrictEqual(published, []);
		assert.strictEqual(second.isCurrent(), true);
		lifecycle.dispose();
	});
});
