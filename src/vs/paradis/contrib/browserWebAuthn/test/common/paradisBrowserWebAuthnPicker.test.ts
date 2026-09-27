/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisWebAuthnAccountPicker, paradisPrepareWebAuthnAccountPicker } from '../../common/paradisBrowserWebAuthn.js';

suite('ParadisBrowserWebAuthnPicker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('アカウント選択向けの文言にし、探索中の表示を消す', () => {
		const picker: IParadisWebAuthnAccountPicker = { title: 'example.com wants to connect to a USB device', placeholder: 'Select a device to connect to', busy: true };
		paradisPrepareWebAuthnAccountPicker(picker, 'example.com');
		assert.deepStrictEqual(picker, {
			title: 'example.com にログインするパスキーのアカウントを選択',
			placeholder: '使うアカウントを選んでください',
			busy: false,
		});
	});
});
