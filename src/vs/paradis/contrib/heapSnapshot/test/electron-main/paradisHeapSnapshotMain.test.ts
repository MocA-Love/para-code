/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRegisterHeapSnapshot, ParadisHeapSnapshotMainService } from '../../electron-main/paradisHeapSnapshotCore.js';

type HeapSnapshotDependencies = ConstructorParameters<typeof ParadisHeapSnapshotMainService>[0];

function createDependencies(overrides: Partial<HeapSnapshotDependencies> = {}): HeapSnapshotDependencies {
	return {
		isLinux: false,
		userDataDirectory: () => '/user-data',
		temporaryDirectory: () => '/temporary',
		uptime: () => 123,
		heapSpaceStatistics: () => [{ space_name: 'old_space', space_used_size: 456 }],
		writeHeapSnapshot: () => { },
		stat: () => ({ size: 789 }),
		unlink: () => { },
		...overrides,
	};
}

suite('ParadisHeapSnapshotMain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects a write requested while another write is in progress', async () => {
		let nestedWrite: Promise<unknown> | undefined;
		const service = new ParadisHeapSnapshotMainService(createDependencies({
			writeHeapSnapshot: () => nestedWrite = service.writeSnapshot(),
		}));

		await service.writeSnapshot();

		assert.ok(nestedWrite);
		await assert.rejects(nestedWrite, /already being written/);
	});

	test('uses user data on Linux and the temporary directory elsewhere with uptime in the filename', async () => {
		const linuxPaths: string[] = [];
		const linuxService = new ParadisHeapSnapshotMainService(createDependencies({
			isLinux: true,
			writeHeapSnapshot: path => linuxPaths.push(path),
		}));
		const temporaryPaths: string[] = [];
		const temporaryService = new ParadisHeapSnapshotMainService(createDependencies({
			writeHeapSnapshot: path => temporaryPaths.push(path),
		}));

		await linuxService.writeSnapshot();
		await temporaryService.writeSnapshot();

		assert.match(linuxPaths[0], /^\/user-data\/para-code-main-.+-up2m\.heapsnapshot$/);
		assert.match(temporaryPaths[0], /^\/temporary\/para-code-main-.+-up2m\.heapsnapshot$/);
	});

	test('preserves the writer error and releases the lock when partial snapshot cleanup fails', async () => {
		let writes = 0;
		const service = new ParadisHeapSnapshotMainService(createDependencies({
			writeHeapSnapshot: () => {
				writes++;
				if (writes === 1) {
					throw new Error('disk full');
				}
			},
			unlink: () => {
				throw new Error('permission denied');
			},
		}));

		await assert.rejects(service.writeSnapshot(), /disk full/);
		const result = await service.writeSnapshot();

		assert.strictEqual(writes, 2);
		assert.strictEqual(result.path.startsWith('/temporary/para-code-main-'), true);
	});

	test('returns the stat size, old space usage, and uptime in a successful result', async () => {
		const service = new ParadisHeapSnapshotMainService(createDependencies({
			uptime: () => 42.5,
			heapSpaceStatistics: () => [{ space_name: 'old_space', space_used_size: 654_321 }],
			stat: () => ({ size: 987_654 }),
		}));

		const result = await service.writeSnapshot();

		assert.deepStrictEqual(
			{ bytes: result.bytes, oldSpaceUsed: result.oldSpaceUsed, uptimeMs: result.uptimeMs },
			{ bytes: 987_654, oldSpaceUsed: 654_321, uptimeMs: 42_500 },
		);
	});

	test('returns -1 bytes when the snapshot cannot be statted', async () => {
		const service = new ParadisHeapSnapshotMainService(createDependencies({
			stat: () => {
				throw new Error('not found');
			},
		}));

		const result = await service.writeSnapshot();

		assert.strictEqual(result.bytes, -1);
	});

	test('registers the existing heap snapshot channel', () => {
		const channels: string[] = [];
		const disposable = paradisRegisterHeapSnapshot({
			registerChannel: channelName => channels.push(channelName),
		}, new ParadisHeapSnapshotMainService(createDependencies()));

		disposable.dispose();

		assert.deepStrictEqual(channels, ['paradisHeapSnapshot']);
	});
});
