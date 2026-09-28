/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPickNotifyInstance } from '../../common/paradisNotifySource.js';

suite('paradisPickNotifyInstance', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じスペースに2つのエージェントがいても、状態が変わった方を送り主にする', () => {
		const candidates = [
			{ instanceId: 1, stateKey: 'space-a', status: 'working' },
			{ instanceId: 2, stateKey: 'space-a', status: 'permission' },
			{ instanceId: 3, stateKey: 'space-b', status: 'review' },
			{ instanceId: 4, stateKey: 'space-a', status: 'review' },
		];
		assert.deepStrictEqual(
			[
				paradisPickNotifyInstance(candidates, 'space-a', 'permission'),
				paradisPickNotifyInstance(candidates, 'space-a', 'review'),
				paradisPickNotifyInstance(candidates, 'space-b', 'review'),
				paradisPickNotifyInstance(candidates, 'space-b', 'permission'),
			],
			[2, 4, 3, undefined],
		);
	});
});
