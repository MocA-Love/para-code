/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ParadisBrowserExtensionActionState,
	paradisActionColorToCss,
	paradisAnchorToScreen,
	paradisClampActionPopupSize,
	paradisIsAnchorRect,
	paradisParseActionColor,
	paradisPlaceActionPopup,
	paradisReadManifestActionDefaults,
} from '../../common/paradisBrowserExtensionAction.js';

suite('ParadisBrowserExtensionAction common', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a tab value beats the global one, null falls back, and a navigation forgets the tab', () => {
		const state = new ParadisBrowserExtensionActionState(paradisReadManifestActionDefaults({ action: { default_title: 'Fill', default_popup: '/popup.html', default_icon: 'icon.png' } }, 'Sample'));
		state.set('badgeText', 'all');
		state.set('badgeText', '3', 7);
		state.set('title', 'Tab title', 7);
		const tab = state.get(7);
		const other = state.get(8);
		state.set('title', null, 7);
		const titleCleared = state.get(7).title;
		const forgot = state.forgetTab(7);
		state.set('badgeText', null);
		assert.deepStrictEqual({ tab: [tab.badgeText, tab.title, tab.popup, tab.icon], other: other.badgeText, titleCleared, forgot, afterForget: state.get(7).badgeText, forgetAgain: state.forgetTab(7) }, {
			tab: ['3', 'Tab title', 'popup.html', { kind: 'path', paths: { '16': 'icon.png' } }],
			other: 'all',
			titleCleared: 'Fill',
			forgot: true,
			afterForget: '',
			forgetAgain: false,
		});
	});

	test('reads MV2 browser_action and falls back to the extension icons and name', () => {
		assert.deepStrictEqual(paradisReadManifestActionDefaults({ browser_action: {}, icons: { '16': 'a.png', '48': 'b.png' } }, 'Old'), {
			title: 'Old', popup: '', badgeText: '', badgeBackgroundColor: null, badgeTextColor: null, enabled: true, icon: { kind: 'path', paths: { '16': 'a.png', '48': 'b.png' } },
		});
	});

	test('parses colors the way chrome.action does', () => {
		assert.deepStrictEqual([
			paradisParseActionColor('#f00'),
			paradisParseActionColor('#11223380'),
			paradisParseActionColor('rgba(10, 20, 30, 0.5)'),
			paradisParseActionColor([300, -1, 5, 255]),
			paradisParseActionColor('red'),
			paradisParseActionColor([1, 2, 3]),
			paradisActionColorToCss([255, 0, 0, 128]),
		], [
			[255, 0, 0, 255],
			[17, 34, 51, 128],
			[10, 20, 30, 128],
			[255, 0, 5, 255],
			undefined,
			undefined,
			'rgba(255, 0, 0, 0.502)',
		]);
	});

	test('places the popup under the button, inside the work area, and above it when there is no room', () => {
		const workArea = { x: 0, y: 0, width: 1000, height: 700 };
		const button = paradisAnchorToScreen({ x: 900, y: 10, width: 22, height: 22 }, { x: 50, y: 30, width: 950, height: 670 }, 1.25);
		assert.deepStrictEqual({
			button,
			below: paradisPlaceActionPopup(button, { width: 300, height: 400 }, workArea),
			above: paradisPlaceActionPopup({ x: 400, y: 600, width: 22, height: 22 }, { width: 300, height: 400 }, workArea),
			clamped: paradisClampActionPopupSize({ width: 2000, height: Number.NaN }),
			anchors: [paradisIsAnchorRect({ x: 1, y: 2, width: 3, height: 4 }), paradisIsAnchorRect({ x: 1, y: 2, width: -3, height: 4 }), paradisIsAnchorRect({ x: '1', y: 2, width: 3, height: 4 })],
		}, {
			button: { x: 1175, y: 43, width: 28, height: 28 },
			// 右端は作業領域に収める
			below: { x: 700, y: 73, width: 300, height: 400 },
			above: { x: 122, y: 198, width: 300, height: 400 },
			clamped: { width: 800, height: 25 },
			anchors: [true, false, false],
		});
	});
});
