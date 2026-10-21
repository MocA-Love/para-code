/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAppendStderrTail, paradisDevtoolsArgsCarryUid, paradisDevtoolsRecycleReason, paradisParseV8FatalStderr, paradisReadProcessRssMib } from '../../node/paradisDevtoolsChildHealth.js';

suite('paradisDevtoolsChildHealth', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only the kind and the heap figures from the V8 fatal lines', () => {
		const stderr = [
			'some private line /Users/example/project token=abc',
			'<--- Last few GCs --->',
			'[71190:0x130008000]  11920000 ms: Mark-Compact 3990.0 (4100.2) -> 3980.5 (4101.0) MB, pooled: 0 MB, 1200.10 / 0.00 ms',
			'[71190:0x130008000]  11921000 ms: Mark-Compact 4049.2 (4130.5) -> 4033.1 (4131.0) MB, pooled: 0 MB, 1234.56 / 0.00 ms  (average mu = 0.1) allocation failure',
			'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
		].join('\n');
		assert.deepStrictEqual({
			heapLimit: paradisParseV8FatalStderr(stderr),
			ineffective: paradisParseV8FatalStderr('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'),
			notOutOfMemory: paradisParseV8FatalStderr('Error: something else\n    at /Users/example/x.js:1:1'),
		}, {
			heapLimit: { kind: 'heap-limit', heapBeforeMib: 4049, heapAfterMib: 4033 },
			ineffective: { kind: 'ineffective-mark-compacts' },
			notOutOfMemory: undefined,
		});
	});

	test('keeps only the end of stderr', () => {
		const tail = paradisAppendStderrTail('a'.repeat(16 * 1024), 'END');
		assert.deepStrictEqual({ length: tail.length, end: tail.endsWith('END') }, { length: 16 * 1024, end: true });
	});

	test('recycles for memory first, then age, then the number of calls', () => {
		const limits = { rssMib: 1000, ageMs: 100, calls: 10 };
		assert.deepStrictEqual([
			paradisDevtoolsRecycleReason({ rssMib: 1000, ageMs: 100, calls: 10 }, limits),
			paradisDevtoolsRecycleReason({ rssMib: undefined, ageMs: 100, calls: 10 }, limits),
			paradisDevtoolsRecycleReason({ rssMib: 10, ageMs: 1, calls: 10 }, limits),
			paradisDevtoolsRecycleReason({ rssMib: 10, ageMs: 1, calls: 1 }, limits),
		], ['memory', 'age', 'calls', undefined]);
	});

	test('finds the uids in the arguments of the input tools', () => {
		assert.deepStrictEqual([
			paradisDevtoolsArgsCarryUid({ uid: '1_2' }),
			paradisDevtoolsArgsCarryUid({ from_uid: '1_2', to_uid: '1_3' }),
			paradisDevtoolsArgsCarryUid({ elements: [{ uid: '1_2', value: 'x' }] }),
			paradisDevtoolsArgsCarryUid({ function: '() => 1', args: [] }),
			paradisDevtoolsArgsCarryUid({ uid: '' }),
			paradisDevtoolsArgsCarryUid(undefined),
		], [true, true, true, false, false, false]);
	});

	test('reads the RSS in MiB from ps, and gives up on Windows or a failure', async () => {
		assert.deepStrictEqual([
			await paradisReadProcessRssMib(42, 'darwin', async () => '  2097152\n'),
			await paradisReadProcessRssMib(42, 'linux', async () => { throw new Error('no ps'); }),
			await paradisReadProcessRssMib(42, 'win32', async () => '2097152'),
			await paradisReadProcessRssMib(undefined, 'linux', async () => '2097152'),
		], [2048, undefined, undefined, undefined]);
	});
});
