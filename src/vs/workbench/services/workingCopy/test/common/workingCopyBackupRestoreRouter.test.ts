/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkingCopyBackupRestoreDecision, WorkingCopyBackupRestoreRouter } from '../../common/workingCopyBackupRestoreRouter.js';

suite('WorkingCopyBackupRestoreRouter', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const identifier = { resource: URI.file('/workspace/file.txt'), typeId: 'test' };

	test('restores by default and defers when any provider vetoes', async () => {
		const router = disposables.add(new WorkingCopyBackupRestoreRouter());
		assert.strictEqual(await router.route(identifier), WorkingCopyBackupRestoreDecision.Restore);

		disposables.add(router.registerProvider({
			route: candidate => candidate.typeId === 'test'
				? WorkingCopyBackupRestoreDecision.Defer
				: WorkingCopyBackupRestoreDecision.Restore
		}));

		assert.strictEqual(await router.route(identifier), WorkingCopyBackupRestoreDecision.Defer);
	});

	test('requestRestore is serialized and awaits registered restorers', async () => {
		const router = disposables.add(new WorkingCopyBackupRestoreRouter());
		const calls: number[] = [];
		disposables.add(router.registerRestorer(async () => {
			calls.push(1);
			await Promise.resolve();
		}));

		await Promise.all([router.requestRestore(), router.requestRestore()]);
		assert.deepStrictEqual(calls, [1, 1]);
	});
});
