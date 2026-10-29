/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisShortcutMatchesKey } from '../../electron-browser/paradisBrowserExtensionToolbar.js';

suite('ParadisBrowserExtensionToolbar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches a key from the page against an extension shortcut', () => {
		const binding = (key: string, modifiers: { control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }) => ({ key, control: false, meta: false, alt: false, shift: false, ...modifiers });
		const event = (key: string, code: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
		assert.deepStrictEqual([
			paradisShortcutMatchesKey(binding('L', { control: true, shift: true }), event('L', 'KeyL', { ctrlKey: true, shiftKey: true })),
			// Option で key が変わっても、押したキー（code）で比べる
			paradisShortcutMatchesKey(binding('L', { alt: true }), event('¬', 'KeyL', { altKey: true })),
			paradisShortcutMatchesKey(binding('5', { control: true }), event('5', 'Digit5', { ctrlKey: true })),
			// 修飾キーが 1 つでも違えば別
			paradisShortcutMatchesKey(binding('L', { control: true, shift: true }), event('L', 'KeyL', { ctrlKey: true })),
			paradisShortcutMatchesKey(binding('L', { meta: true }), event('l', 'KeyL', { ctrlKey: true })),
			paradisShortcutMatchesKey(binding('Comma', { alt: true }), event(',', 'Comma', { altKey: true })),
			paradisShortcutMatchesKey(binding('Up', { alt: true }), event('ArrowUp', 'ArrowUp', { altKey: true })),
		], [true, true, true, false, false, true, true]);
	});
});
