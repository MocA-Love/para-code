/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IProgressService, ProgressLocation } from '../../../platform/progress/common/progress.js';
import { paradisWithSettledProgress } from '../../common/paradisSettledProgress.js';

suite('paradisWithSettledProgress', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** upstream の通知の進行表示と同じく、渡された promise から派生させたものを捨てる進行表示。拒否が渡ると数える。 */
	function leakyProgressService(rejections: unknown[]): IProgressService {
		return {
			withProgress: (_options: unknown, task: (progress: { report(): void }) => Promise<unknown>) => {
				const promise = task({ report: () => { } });
				promise.catch(error => rejections.push(error));
				return promise;
			},
		} as unknown as IProgressService;
	}

	test('hands the progress a promise that never rejects and rethrows the failure to the caller', async () => {
		const rejections: unknown[] = [];
		const failure = new Error('git refused');
		const caught = await paradisWithSettledProgress(leakyProgressService(rejections), { location: ProgressLocation.Notification }, async () => { throw failure; }).then(() => undefined, error => error);
		const value = await paradisWithSettledProgress(leakyProgressService(rejections), { location: ProgressLocation.Notification }, async () => 42);
		assert.deepStrictEqual({ caught, value, rejections }, { caught: failure, value: 42, rejections: [] });
	});
});
