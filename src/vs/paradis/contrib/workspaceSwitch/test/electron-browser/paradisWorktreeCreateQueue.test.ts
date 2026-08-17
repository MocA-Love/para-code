/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisRepositoryTaskSequencer } from '../../electron-browser/paradisWorktreeCreateQueue.js';

suite('ParadisRepositoryTaskSequencer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('serializes tasks in one repository and releases the settled tail', async () => {
		const sequencer = new ParadisRepositoryTaskSequencer();
		const started: string[] = [];
		let resolveFirst!: () => void;
		const firstCanFinish = new Promise<void>(resolve => { resolveFirst = resolve; });
		let resolveSecond!: () => void;
		const secondCanFinish = new Promise<void>(resolve => { resolveSecond = resolve; });
		let signalFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
		let signalSecondStarted!: () => void;
		const secondStarted = new Promise<void>(resolve => { signalSecondStarted = resolve; });

		const first = sequencer.queue('repository-1', async () => {
			started.push('first');
			signalFirstStarted();
			await firstCanFinish;
		});
		const second = sequencer.queue('repository-1', async () => {
			started.push('second');
			signalSecondStarted();
			await secondCanFinish;
		});

		await firstStarted;
		assert.deepStrictEqual(started, ['first']);

		resolveFirst();
		await secondStarted;
		assert.deepStrictEqual(started, ['first', 'second']);
		assert.strictEqual((Reflect.get(sequencer, 'repositoryChains') as Map<string, Promise<void>>).size, 1);

		resolveSecond();
		await Promise.all([first, second]);
		assert.strictEqual((Reflect.get(sequencer, 'repositoryChains') as Map<string, Promise<void>>).size, 0);
	});

	test('runs a following task after a preceding task rejects', async () => {
		const sequencer = new ParadisRepositoryTaskSequencer();
		const first = sequencer.queue('repository-1', async () => {
			throw new Error('preceding task failed');
		});
		let secondRan = false;
		const second = sequencer.queue('repository-1', async () => {
			secondRan = true;
		});

		await assert.rejects(first, /preceding task failed/);
		await second;
		assert.strictEqual(secondRan, true);
	});

	test('starts tasks in different repositories concurrently', async () => {
		const sequencer = new ParadisRepositoryTaskSequencer();
		const started: string[] = [];
		let resolveFirst!: () => void;
		const firstCanFinish = new Promise<void>(resolve => { resolveFirst = resolve; });
		let resolveSecond!: () => void;
		const secondCanFinish = new Promise<void>(resolve => { resolveSecond = resolve; });
		let signalFirstStarted!: () => void;
		const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
		let signalSecondStarted!: () => void;
		const secondStarted = new Promise<void>(resolve => { signalSecondStarted = resolve; });

		const first = sequencer.queue('repository-1', async () => {
			started.push('first');
			signalFirstStarted();
			await firstCanFinish;
		});
		const second = sequencer.queue('repository-2', async () => {
			started.push('second');
			signalSecondStarted();
			await secondCanFinish;
		});

		await Promise.all([firstStarted, secondStarted]);
		assert.deepStrictEqual(started.sort(), ['first', 'second']);

		resolveFirst();
		resolveSecond();
		await Promise.all([first, second]);
	});
});
