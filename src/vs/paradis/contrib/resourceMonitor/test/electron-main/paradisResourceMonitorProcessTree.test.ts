/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getParadisSubtreePids, getParadisSubtreeResources, IParadisProcessInfo, IParadisProcessSnapshot } from '../../electron-main/paradisResourceMonitorProcessTree.js';

function createSnapshot(processes: readonly IParadisProcessInfo[], children: readonly (readonly [number, number[]])[]): IParadisProcessSnapshot {
	return {
		byPid: new Map(processes.map(process => [process.pid, process])),
		childrenOf: new Map(children),
	};
}

suite('ParadisResourceMonitorProcessTree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('visits each existing PID once across duplicate edges and cycles', () => {
		const snapshot = createSnapshot([
			{ pid: 10, ppid: 0, cpu: 1, memory: 100 },
			{ pid: 11, ppid: 10, cpu: 2, memory: 200 },
			{ pid: 12, ppid: 11, cpu: 3, memory: 300 },
		], [
			[10, [11, 11]],
			[11, [12]],
			[12, [10]],
		]);

		assert.deepStrictEqual(getParadisSubtreePids(snapshot, 10).sort((a, b) => a - b), [10, 11, 12]);
	});

	test('defensively continues to existing descendants across a missing intermediate PID in a partial snapshot', () => {
		const partialSnapshot = createSnapshot([
			{ pid: 10, ppid: 0, cpu: 1, memory: 100 },
			{ pid: 12, ppid: 99, cpu: 3, memory: 300 },
		], [
			[10, [99]],
			[99, [12]],
		]);

		assert.deepStrictEqual(getParadisSubtreePids(partialSnapshot, 10).sort((a, b) => a - b), [10, 12]);
	});

	test('returns an empty result when the requested root is absent', () => {
		const snapshot = createSnapshot([], []);

		assert.deepStrictEqual(getParadisSubtreePids(snapshot, 404), []);
		assert.deepStrictEqual(getParadisSubtreeResources(snapshot, 404), { cpu: 0, memory: 0 });
	});

	test('sums CPU and memory for the unique reachable subtree', () => {
		const snapshot = createSnapshot([
			{ pid: 20, ppid: 0, cpu: 12.5, memory: 1_024 },
			{ pid: 21, ppid: 20, cpu: 7.25, memory: 2_048 },
			{ pid: 22, ppid: 20, cpu: 0.25, memory: 4_096 },
			{ pid: 30, ppid: 0, cpu: 99, memory: 65_536 },
		], [
			[20, [21, 22, 22]],
			[22, [20]],
		]);

		assert.deepStrictEqual(getParadisSubtreeResources(snapshot, 20), {
			cpu: 20,
			memory: 7_168,
		});
	});
});
