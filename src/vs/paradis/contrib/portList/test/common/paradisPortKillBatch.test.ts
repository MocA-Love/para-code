/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPortEntry } from '../../common/paradisPortList.js';
import { executeParadisPortKillBatch } from '../../common/paradisPortKillBatch.js';

suite('Paradis port kill batch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const entries: IParadisPortEntry[] = [
		{ port: 3000, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
		{ port: 3001, proto: 'TCP', pid: 10, processName: 'node', address: '127.0.0.1', risky: false },
		{ port: 4000, proto: 'TCP', pid: 20, processName: 'python', address: '127.0.0.1', risky: false },
	];

	test('collects once, rejects stale/protected requests, and signals a PID once', async () => {
		let collections = 0;
		const signalled: number[] = [];
		const result = await executeParadisPortKillBatch(
			[entries[0], entries[1], entries[2], { port: 9999, pid: 30, processName: 'stale' }],
			async () => { collections++; return entries; },
			new Set([20]),
			pid => { signalled.push(pid); },
		);
		assert.strictEqual(collections, 1);
		assert.deepStrictEqual(signalled, [10]);
		assert.deepStrictEqual(result, { failed: 2 });
	});

	test('counts every request in a PID group when its single signal fails', async () => {
		const attempts: number[] = [];
		const result = await executeParadisPortKillBatch(
			[entries[0], entries[1]],
			async () => entries,
			new Set(),
			pid => { attempts.push(pid); throw new Error('signal failed'); },
		);
		assert.deepStrictEqual(attempts, [10]);
		assert.deepStrictEqual(result, { failed: 2 });
	});

	test('treats malformed IPC values as failures without signalling them', async () => {
		const signalled: number[] = [];
		const result = await executeParadisPortKillBatch(
			[undefined, { pid: -1, port: 3000, processName: 'node' }, { pid: 10, port: 0, processName: 'node' }],
			async () => entries,
			new Set(),
			pid => { signalled.push(pid); },
		);
		assert.deepStrictEqual(signalled, []);
		assert.deepStrictEqual(result, { failed: 3 });
	});
});
