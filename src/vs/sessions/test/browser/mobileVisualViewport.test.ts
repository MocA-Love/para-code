/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Dimension } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { getMobileViewportDimension, MobileVisualViewport } from '../../browser/parts/mobile/mobileVisualViewport.js';

suite('Sessions - Mobile Visual Viewport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('constrains phone layout to the visible viewport height', () => {
		const layoutViewport = new Dimension(412, 915);

		assert.deepStrictEqual([
			getMobileViewportDimension(layoutViewport, { height: 515 }),
			getMobileViewportDimension(layoutViewport, { height: 980 }),
			getMobileViewportDimension(layoutViewport, undefined),
		], [
			new Dimension(412, 515),
			new Dimension(412, 915),
			layoutViewport,
		]);
	});

	// PARA-PATCH test: scroll-only passes (panning while zoomed in, scrolling with the keyboard
	// open) move the visual viewport without resizing it, so they must not relayout the workbench.
	test('does not report a change when the visual viewport only scrolls', function () {
		const visualViewport = mainWindow.visualViewport;
		if (!visualViewport) {
			this.skip();
		}
		const viewport = new MobileVisualViewport(new MockContextKeyService(), upcastPartial<ILayoutService>({ mainContainer: mainWindow.document.createElement('div') }));
		let changes = 0;
		const listener = viewport.onDidChangeVisualViewport(() => changes++);
		visualViewport.dispatchEvent(new Event('scroll'));
		visualViewport.dispatchEvent(new Event('resize'));
		listener.dispose();
		viewport.dispose();

		assert.strictEqual(changes, 0);
	});
});
