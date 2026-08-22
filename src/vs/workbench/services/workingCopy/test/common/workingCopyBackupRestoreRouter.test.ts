/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

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

	test('requestRestore awaits registered restorers and serializes passes that start after a run', async () => {
		const router = disposables.add(new WorkingCopyBackupRestoreRouter());
		const calls: number[] = [];
		let gate = Promise.resolve();
		disposables.add(router.registerRestorer(async () => {
			calls.push(1);
			await gate;
		}));

		// 開始済みのパスの**後**に届いた要求は独立パスとして直列化される
		const first = router.requestRestore();
		await Promise.resolve();
		await Promise.resolve();
		gate = Promise.resolve();
		const second = router.requestRestore();
		assert.notStrictEqual(first, second, 'a request arriving after the pass began gets its own pass');
		await first;
		await second;
		assert.deepStrictEqual(calls, [1, 1]);
	});

	test('requestRestore coalesces requests that arrive before a pass starts', async () => {
		const router = disposables.add(new WorkingCopyBackupRestoreRouter());
		const calls: number[] = [];
		let release: (() => void) | undefined;
		let notifyStarted: (() => void) | undefined;
		let observedFlag = false;
		let flag = false;
		disposables.add(router.registerRestorer(async () => {
			calls.push(1);
			observedFlag = flag;
			notifyStarted?.();
			await new Promise<void>(resolve => { release = resolve; });
		}));

		// 同tickのバーストは1パスに合流する(ハンドラ登録+スペース切替が同tickに重なるケース)
		const firstStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
		const first = router.requestRestore();
		const joined = router.requestRestore();
		assert.strictEqual(joined, first, 'same-tick requests share the pending pass');
		await firstStarted;
		flag = true;

		release?.();
		await first;
		assert.strictEqual(observedFlag, false);

		// パス開始後に状態を変えて要求した場合は、その変更を観測する新しいパスが走る
		const secondStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
		const afterFlipPromise = router.requestRestore();
		await secondStarted;
		release?.();
		const afterFlip = await afterFlipPromise;
		assert.strictEqual(afterFlip, undefined);
		assert.ok(calls.length >= 2);
		assert.strictEqual(flag, true);
	});
});
