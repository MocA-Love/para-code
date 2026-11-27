/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileOpResults } from '../../common/paradisMobileOpResults.js';

suite('Paradis mobile op results', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じ端末の同じ opId には 1 回目の返事を返し（成功なら duplicate を足す）、別の端末・期限切れ・例外の後はやり直す', async () => {
		let now = 0;
		const results = new ParadisMobileOpResults(() => now, 2, 100);
		let runs = 0;
		const ok = async () => { runs++; return { t: 'x', applied: true }; };
		const refused = async () => { runs++; return { error: 'busy', code: 'busy' }; };
		const replies = [
			await results.run('phone-a', 'op-1', ok),
			await results.run('phone-a', 'op-1', ok),
			await results.run('phone-b', 'op-1', ok),
			await results.run('phone-a', 'op-2', refused),
			await results.run('phone-a', 'op-2', ok),
		];
		await results.run('phone-a', 'op-3', async () => { throw new Error('boom'); }).catch(() => undefined);
		const afterThrow = await results.run('phone-a', 'op-3', ok);
		now = 200;
		const afterExpiry = await results.run('phone-a', 'op-1', ok);
		assert.deepStrictEqual({ replies, afterThrow, afterExpiry, runs }, {
			replies: [
				{ t: 'x', applied: true },
				{ t: 'x', applied: true, duplicate: true },
				{ t: 'x', applied: true },
				{ error: 'busy', code: 'busy' },
				{ error: 'busy', code: 'busy' },
			],
			afterThrow: { t: 'x', applied: true },
			afterExpiry: { t: 'x', applied: true },
			runs: 5,
		});
	});
});
