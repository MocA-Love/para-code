/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisCursorOwners, paradisCursorOwnerId } from '../../node/paradisCursorOwners.js';

suite('Paradis cursor owners', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('each owner on a page gets its own color, default CLI names get numbers, and chosen names win', () => {
		const clock = 0;
		const owners = new ParadisCursorOwners(() => clock);
		const first = owners.resolve('pane-a', 'page', 'claude');
		const second = owners.resolve('pane-b', 'page', 'claude');
		const third = owners.resolve('pane-c', 'page', 'codex');
		const labelled = owners.setLabel('pane-b', '在庫確認');
		const renamed = owners.resolve('pane-b', 'page', 'claude');
		const otherPage = owners.resolve('pane-b', 'other', 'claude');
		assert.deepStrictEqual(
			{ first, second, third, labelled, renamed: renamed.name, otherPage: [otherPage.name, otherPage.color] },
			{
				first: { id: paradisCursorOwnerId('pane-a'), name: 'Claude', mark: 'C', color: '#d97757' },
				second: { id: paradisCursorOwnerId('pane-b'), name: 'Claude 2', mark: 'C', color: '#8250df' },
				third: { id: paradisCursorOwnerId('pane-c'), name: 'Codex', mark: 'X', color: '#bf3989' },
				labelled: { ok: true, label: '在庫確認', truncated: false },
				renamed: '在庫確認',
				otherPage: ['在庫確認', '#d97757'],
			},
		);
	});

	test('names change at most three times a minute, and a refused name falls back to the default', () => {
		let clock = 0;
		const owners = new ParadisCursorOwners(() => clock);
		const results = ['One', 'Two', 'Three', 'Four'].map(name => owners.setLabel('pane', name));
		clock += 61_000;
		const later = owners.setLabel('pane', 'https://example.com');
		assert.deepStrictEqual(
			{ last: results[3], later, shown: owners.resolve('pane', 'page', 'codex').name },
			{ last: { ok: true, label: 'Three', truncated: false, rateLimited: true }, later: { ok: false, rejected: 'contains a URL' }, shown: 'Codex' },
		);
	});
});
