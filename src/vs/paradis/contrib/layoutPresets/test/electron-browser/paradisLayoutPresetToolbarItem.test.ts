/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Action } from '../../../../../base/common/actions.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextViewDelegate, IContextViewService, IOpenContextView } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ParadisLayoutPresetToolbarItem } from '../../electron-browser/paradisLayoutPresetPopover.js';

suite('ParadisLayoutPresetToolbarItem', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens again on the next click after the popover closed itself', async () => {
		const delegates: IContextViewDelegate[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IContextViewService, upcastPartial<IContextViewService>({
			showContextView: (delegate: IContextViewDelegate): IOpenContextView => {
				delegates.push(delegate);
				return { close: () => delegate.onHide?.() };
			},
		}));
		const item = store.add(instantiationService.createInstance(ParadisLayoutPresetToolbarItem, store.add(new Action('paradis.test.layoutPresets')), undefined));
		item.render(document.createElement('div'));

		await item.onClick(new MouseEvent('click'));
		// 外側のクリックや Esc で、ポップオーバー側が閉じた
		delegates[0].onHide?.();
		await item.onClick(new MouseEvent('click'));

		assert.strictEqual(delegates.length, 2);
	});
});
