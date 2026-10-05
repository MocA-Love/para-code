/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileAuthorityLanes } from '../../common/paradisMobileAuthorityLanes.js';

suite('ParadisMobileAuthorityLanes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs the same key in order, lets other keys pass a stuck task, and forgets empty keys', async () => {
		const lanes = new ParadisMobileAuthorityLanes();
		const log: string[] = [];
		let unblock!: () => void;
		const stuck = lanes.run('renderer:1', () => new Promise<void>(resolve => { unblock = resolve; }).then(() => { log.push('renderer:1 first'); }));
		const queued = lanes.run('renderer:1', async () => { log.push('renderer:1 second'); });
		const other = lanes.run('terminal:a', async () => { log.push('terminal:a'); });
		await other;
		await new Promise(resolve => setTimeout(resolve, 0));
		const whileStuck = { log: [...log], pending: lanes.pending('renderer:1'), total: lanes.pendingTotal };
		unblock();
		await Promise.all([stuck, queued]);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({ whileStuck, log, total: lanes.pendingTotal, pending: lanes.pending('renderer:1') }, {
			whileStuck: { log: ['terminal:a'], pending: 2, total: 2 },
			log: ['terminal:a', 'renderer:1 first', 'renderer:1 second'],
			total: 0,
			pending: 0,
		});
	});

	test('keeps going after a failed task and refuses work over the per-key limit before running it', async () => {
		const lanes = new ParadisMobileAuthorityLanes();
		let unblock!: () => void;
		const failing = lanes.run('k', () => new Promise<void>((_resolve, reject) => { unblock = () => reject(new Error('boom')); }));
		const second = lanes.tryRun('k', async () => 'second', 2);
		const refused = lanes.tryRun('k', async () => 'third', 2);
		await new Promise(resolve => setTimeout(resolve, 0));
		unblock();

		assert.deepStrictEqual({
			failing: await failing.then(() => 'ok', error => (error as Error).message),
			second: await second,
			refused,
		}, { failing: 'boom', second: 'second', refused: undefined });
	});
});
