/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSyncSelectOptions } from '../../browser/paradisSyncSelectOptions.js';

suite('paradisSyncSelectOptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const options = (...values: string[]) => values.map(value => ({ value, label: value === '' ? '(既定)' : value }));
	const snapshot = (select: HTMLSelectElement) => Array.from(select.options).map(option => `${option.value}=${option.textContent}`);

	test('同じ候補なら何も触らず、違うときは残る値の option を同じ要素のまま差分だけ入れ替える', () => {
		const select = mainWindow.document.createElement('select');
		paradisSyncSelectOptions(select, options('', 'opus', 'sonnet', 'haiku'));
		select.value = 'sonnet';
		const opus = select.options[1];
		const sonnet = select.options[2];

		const unchanged = paradisSyncSelectOptions(select, options('', 'opus', 'sonnet', 'haiku'));
		const changed = paradisSyncSelectOptions(select, [...options('', 'claude-fable-5-1', 'opus'), { value: 'sonnet', label: 'sonnet (Sonnet 5)' }]);

		assert.deepStrictEqual({
			unchanged,
			changed,
			options: snapshot(select),
			sameElements: select.options[2] === opus && select.options[3] === sonnet,
			selected: select.value,
		}, {
			unchanged: false,
			changed: true,
			options: ['=(既定)', 'claude-fable-5-1=claude-fable-5-1', 'opus=opus', 'sonnet=sonnet (Sonnet 5)'],
			sameElements: true,
			selected: 'sonnet',
		});
	});
});
