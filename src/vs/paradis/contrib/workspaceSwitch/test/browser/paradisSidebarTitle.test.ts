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
import { PARADIS_WORKSPACES_VIEW_ID } from '../../browser/paradisWorkspacesView.js';

suite('ParadisSidebarTitle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('hides the title row only for the spaces view alone under a top activity bar', () => {
		const repositories = 'workbench.view.paradisWorkspaces.repositories';
		assert.deepStrictEqual([
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', [repositories], true),
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', [repositories], false), // default・bottom・hidden
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', [repositories, 'outline'], true), // 別のビューを同じ入れ物へ入れた
			paradisShouldHideSidebarTitle('workbench.view.paradisWorkspaces', ['outline'], true), // リポジトリを出し、ほかのビューだけが残った
			paradisShouldHideSidebarTitle('workbench.view.explorer', [repositories], true),
			paradisShouldHideSidebarTitle(undefined, [], true),
		], [true, false, false, false, false, false]);
		// 判定に使う id が実際のビューの id と食い違っていないこと
		assert.strictEqual(PARADIS_WORKSPACES_VIEW_ID, repositories);
	});

	test('gives a zero title height, marks the part and relayouts when the active container or its views change', () => {
		const onDidOpen = store.add(new Emitter<IPaneComposite>());
		const onDidAddViews = store.add(new Emitter<IView[]>());
		const element = mainWindow.document.createElement('div');
		const views: IView[] = [{ id: 'workbench.view.paradisWorkspaces.repositories' } as IView];
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
		views.push({ id: 'outline' } as IView);
		onDidAddViews.fire([]);
		const twoViews = snapshot();

		assert.deepStrictEqual({ explorer, spaces, twoViews }, {
			explorer: { height: undefined, marked: false, relayouts: 0 },
			spaces: { height: 0, marked: true, relayouts: 1 },
			twoViews: { height: undefined, marked: false, relayouts: 2 },
		});
	});
});
