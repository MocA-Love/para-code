/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsMobileBrowserKey, paradisMobileBrowserKeyEvents } from '../../common/paradisMobileBrowserKeys.js';

suite('Paradis mobile browser keys', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Enter は文字を伴う keyDown、ほかのキーは rawKeyDown で、macOS だけ編集の操作を添える', () => {
		assert.deepStrictEqual({
			enterMac: paradisMobileBrowserKeyEvents('Enter', undefined, true),
			backspaceMac: paradisMobileBrowserKeyEvents('Backspace', undefined, true),
			backspaceWin: paradisMobileBrowserKeyEvents('Backspace', undefined, false),
			shiftTabMac: paradisMobileBrowserKeyEvents('Tab', true, true),
			shiftLeftMac: paradisMobileBrowserKeyEvents('ArrowLeft', true, true)?.[0],
		}, {
			enterMac: [
				{ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, type: 'keyDown', text: '\r', unmodifiedText: '\r' },
				{ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, type: 'keyUp' },
			],
			backspaceMac: [
				{ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, type: 'rawKeyDown', commands: ['deleteBackward'] },
				{ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, type: 'keyUp' },
			],
			backspaceWin: [
				{ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, type: 'rawKeyDown' },
				{ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, type: 'keyUp' },
			],
			shiftTabMac: [
				{ key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8, type: 'rawKeyDown' },
				{ key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8, type: 'keyUp' },
			],
			shiftLeftMac: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8, type: 'rawKeyDown', commands: ['moveLeftAndModifySelection'] },
		});
	});

	test('許可リストに無い名前・文字列でない値・プロトタイプの名前は送らない。shift は true のときだけ効く', () => {
		assert.deepStrictEqual({
			unknown: ['a', 'F5', 'toString', '__proto__', 'constructor', 13, undefined, null, {}].map(value => paradisMobileBrowserKeyEvents(value, undefined, true)),
			isKey: ['Escape', 'escape', 'hasOwnProperty'].map(paradisIsMobileBrowserKey),
			truthyShift: paradisMobileBrowserKeyEvents('Escape', 'yes', false)?.[0].modifiers,
		}, {
			unknown: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
			isKey: [true, false, false],
			truthyShift: 0,
		});
	});
});
