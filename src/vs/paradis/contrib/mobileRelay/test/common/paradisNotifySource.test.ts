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
			{ instanceId: 1, stateKey: 'space-a', status: 'working', previousStatus: 'working' },
			{ instanceId: 2, stateKey: 'space-a', status: 'permission', previousStatus: 'working' },
			{ instanceId: 3, stateKey: 'space-b', status: 'review', previousStatus: undefined },
			{ instanceId: 4, stateKey: 'space-a', status: 'review', previousStatus: 'working' },
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

	test('同じ状態のペインが2つあれば、今回その状態へ変わった方を選ぶ', () => {
		const candidates = [
			{ instanceId: 1, stateKey: 'space-a', status: 'review', previousStatus: 'review' },
			{ instanceId: 2, stateKey: 'space-a', status: 'review', previousStatus: 'working' },
		];
		assert.deepStrictEqual(
			[paradisPickNotifyInstance(candidates, 'space-a', 'review'), paradisPickNotifyInstance(candidates.slice(0, 1), 'space-a', 'review')],
			[2, 1],
		);
	});
});
