/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAppendStderrTail, paradisDevtoolsRecycleReason, paradisNewUidTag, paradisParseV8FatalStderr, paradisReadProcessRssMib, paradisTagChildUids, paradisTagSnapshotFileText, paradisUntagUids } from '../../node/paradisDevtoolsChildHealth.js';

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

	test('marks the uids a child answers with, in text and in structured content, without touching other text', () => {
		const result = {
			content: [{ type: 'text', text: '## Latest page snapshot\nuid=2_4 button "Pay 3_5"\n  uid=2_5 StaticText "uid=x"\nElement uid "2_9" not found. Element with uid 2_8 no longer exists.' }],
			structuredContent: { snapshot: { id: '2_4', children: [{ id: '2_5', name: '3_5' }] }, snapshotFilePath: '/tmp/a_1' },
		};
		assert.deepStrictEqual(paradisTagChildUids(result, 'k3f9'), {
			content: [{ type: 'text', text: '## Latest page snapshot\nuid=k3f9.2_4 button "Pay 3_5"\n  uid=k3f9.2_5 StaticText "uid=x"\nElement uid "k3f9.2_9" not found. Element with uid k3f9.2_8 no longer exists.' }],
			structuredContent: { snapshot: { id: 'k3f9.2_4', children: [{ id: 'k3f9.2_5', name: '3_5' }] }, snapshotFilePath: '/tmp/a_1' },
		});
		assert.strictEqual(paradisTagSnapshotFileText('uid=1_1 main\n  uid=1_2 link "uid=1_9"', 'k3f9'), 'uid=k3f9.1_1 main\n  uid=k3f9.1_2 link "uid=k3f9.1_9"');
	});

	test('takes the mark off the uids of this child anywhere in the arguments, calls an earlier mark stale, and leaves marks it never gave alone', () => {
		const issued = ['a000', 'k3f9'];
		assert.deepStrictEqual([
			paradisUntagUids({ uid: 'k3f9.2_4', value: '3_5' }, 'k3f9', issued),
			paradisUntagUids({ function: '(a, b) => 1', args: ['k3f9.2_4', 'k3f9.2_5'] }, 'k3f9', issued),
			paradisUntagUids({ root: 'k3f9.2_4' }, 'k3f9', issued),
			paradisUntagUids({ elements: [{ uid: 'a000.2_4', value: 'x' }] }, 'k3f9', issued),
			paradisUntagUids({ uid: 'k3f9.2_4' }, undefined, issued),
			paradisUntagUids({ uid: '2_4', text: 'k3f9 2_4' }, 'k3f9', issued),
			paradisUntagUids({ uid: 'k3f9.2_4', value: 'ver1.2_3', text: 'test.10_2' }, 'k3f9', issued),
		], [
			{ value: { uid: '2_4', value: '3_5' }, stale: false },
			{ value: { function: '(a, b) => 1', args: ['2_4', '2_5'] }, stale: false },
			{ value: { root: '2_4' }, stale: false },
			{ value: { elements: [{ uid: 'a000.2_4', value: 'x' }] }, stale: true },
			{ value: { uid: 'k3f9.2_4' }, stale: true },
			{ value: { uid: '2_4', text: 'k3f9 2_4' }, stale: false },
			{ value: { uid: '2_4', value: 'ver1.2_3', text: 'test.10_2' }, stale: false },
		]);
	});

	test('gives the next child a different mark', () => {
		const sequence = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
		const tags = [paradisNewUidTag([], () => 0), paradisNewUidTag(['aaaa'], () => sequence.shift() ?? 0)];
		assert.deepStrictEqual({ tags, shape: tags.every(tag => /^[a-z][a-z0-9]{3}$/.test(tag)) }, { tags: ['aaaa', 'nsss'], shape: true });
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
