/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ViewPaneContainer } from '../../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer } from '../../../../../workbench/common/views.js';
import { workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';

suite('ViewPaneContainer view sizes (Para Code)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('laying the container out again does not overwrite the sizes chosen by dragging', () => {
		const savedSizes: unknown[] = [];
		const container = new class extends mock<ViewContainer>() { override readonly id = 'paradis.test.viewContainer'; };
		const model = new class extends mock<IViewContainerModel>() {
			override readonly visibleViewDescriptors = [];
			override setSizes(sizes: readonly { id: string; size: number }[]): void { savedSizes.push(sizes); }
		};
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IViewDescriptorService, new class extends mock<IViewDescriptorService>() {
			override getViewContainerById() { return container; }
			override getViewContainerModel() { return model; }
		});
		const viewPaneContainer = store.add(instantiationService.createInstance(ViewPaneContainer, container.id, { mergeViewWithContainerWhenSingleView: false }));

		// 1 回目は保存してある大きさを戻すだけ。2 回目以降（ウィンドウの大きさの変更、ビューの出し入れの後）も保存しない。
		viewPaneContainer.layout(new Dimension(300, 600));
		viewPaneContainer.layout(new Dimension(300, 400));
		viewPaneContainer.layout(new Dimension(300, 800));
		assert.deepStrictEqual(savedSizes, []);
	});
});
