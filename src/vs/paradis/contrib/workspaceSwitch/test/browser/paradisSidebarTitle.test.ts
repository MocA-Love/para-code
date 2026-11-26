/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IPaneComposite } from '../../../../../workbench/common/panecomposite.js';
import { IView, IViewPaneContainer } from '../../../../../workbench/common/views.js';
import { ParadisSidebarTitle, paradisShouldHideSidebarTitle } from '../../browser/paradisSidebarTitle.js';

suite('ParadisSidebarTitle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('hides the title row only for the spaces view alone under a top activity bar', () => {
		assert.deepStrictEqual([
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', 1, true),
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', 1, false), // default・bottom・hidden
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', 2, true), // 別のビューを同じ入れ物へ入れた
			paradisShouldHideSidebarTitle('workbench.view.explorer', 1, true),
			paradisShouldHideSidebarTitle(undefined, 0, true),
		], [true, false, false, false, false]);
	});

	test('gives a zero title height, marks the part and relayouts when the active container or its views change', () => {
		const onDidOpen = store.add(new Emitter<IPaneComposite>());
		const onDidAddViews = store.add(new Emitter<IView[]>());
		const element = mainWindow.document.createElement('div');
		const views: IView[] = [{} as IView];
		const container = { views, onDidAddViews: onDidAddViews.event, onDidRemoveViews: store.add(new Emitter<IView[]>()).event } as Partial<IViewPaneContainer> as IViewPaneContainer;
		const composite = (id: string) => ({ getId: () => id, getViewPaneContainer: () => container }) as Partial<IPaneComposite> as IPaneComposite;
		let active = composite('workbench.view.explorer');
		let relayouts = 0;
		const title = store.add(new ParadisSidebarTitle({ element, onDidPaneCompositeOpen: onDidOpen.event, getActivePaneComposite: () => active }, () => true, () => relayouts++));
		const titleHeight = title.withTitleHeight({ hasTitle: true }).titleHeight!;
		const snapshot = () => ({ height: titleHeight(), marked: element.classList.contains('paradis-sidebar-title-hidden'), relayouts });

		const explorer = snapshot();
		active = composite('workbench.view.paradisWorkspaces');
		onDidOpen.fire(active);
		const spaces = snapshot();
		views.push({} as IView);
		onDidAddViews.fire([]);
		const twoViews = snapshot();

		assert.deepStrictEqual({ explorer, spaces, twoViews }, {
			explorer: { height: undefined, marked: false, relayouts: 0 },
			spaces: { height: 0, marked: true, relayouts: 1 },
			twoViews: { height: undefined, marked: false, relayouts: 2 },
		});
	});
});
