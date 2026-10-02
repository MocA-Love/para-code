/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IActionViewItem } from '../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../base/common/actions.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { paradisCreateGlobalActivityViewItem, paradisGlobalActivityActions, registerParadisGlobalActivityEntry } from '../../browser/paradisGlobalActivitySlot.js';

suite('Paradis global activity slot', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('creates actions and view items only for registered entries, and forgets them when unregistered', () => {
		const created: string[] = [];
		const viewItem = {} as IActionViewItem;
		const registration = registerParadisGlobalActivityEntry({
			id: 'paradis.test.slot',
			createViewItem: (_instantiationService, options) => {
				created.push(String((options as { readonly marker?: string }).marker));
				return viewItem;
			},
		});
		const instantiationService = {} as IInstantiationService;
		const compositeOptions = { marker: 'composite', draggable: false };
		const actions = store.add(new DisposableStore());
		const ids = paradisGlobalActivityActions(actions).map(action => action.id);
		const known = paradisCreateGlobalActivityViewItem(store.add(new Action('paradis.test.slot')), instantiationService, compositeOptions);
		const unknown = paradisCreateGlobalActivityViewItem(store.add(new Action('workbench.actions.manage')), instantiationService, {});
		registration.dispose();
		const afterDispose = paradisGlobalActivityActions(actions).map(action => action.id);

		assert.deepStrictEqual({ ids: ids.filter(id => id === 'paradis.test.slot'), known: known === viewItem, unknown, created, afterDispose: afterDispose.filter(id => id === 'paradis.test.slot') }, {
			ids: ['paradis.test.slot'],
			known: true,
			unknown: undefined,
			created: ['composite'],
			afterDispose: [],
		});
	});
});
