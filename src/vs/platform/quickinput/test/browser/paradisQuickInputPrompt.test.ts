/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IInputBox, IQuickInput, QuickInputType } from '../../common/quickInput.js';
import { paradisQuickInputNoValidationMessage, paradisSetQuickInputKeyHintsPresent } from '../../browser/paradisQuickInputPrompt.js';

suite('paradisQuickInputPrompt', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const upstream = 'Name (Press \'Enter\' to confirm or \'Escape\' to cancel)';
	const input = (options: Partial<Pick<IInputBox, 'prompt' | 'anchor' | 'ignoreFocusOut'>>, type = QuickInputType.InputBox) =>
		({ type, anchor: undefined, ignoreFocusOut: false, ...options }) as unknown as IQuickInput;

	test('the centered input box shows only its prompt while the key hints are present', () => {
		const message = (target: IQuickInput) => paradisQuickInputNoValidationMessage(target, upstream);
		const withoutHints = message(input({ prompt: 'Name' }));
		store.add(paradisSetQuickInputKeyHintsPresent());
		assert.deepStrictEqual({
			prompt: message(input({ prompt: 'Name' })),
			noPrompt: message(input({})),
			anchored: message(input({ prompt: 'Name', anchor: { x: 0, y: 0 } })),
			ignoreFocusOut: message(input({ prompt: 'Name', ignoreFocusOut: true })),
			quickPick: message(input({}, QuickInputType.QuickPick)),
			withoutHints,
		}, {
			prompt: 'Name',
			noPrompt: undefined,
			anchored: upstream,
			ignoreFocusOut: upstream,
			quickPick: upstream,
			withoutHints: upstream,
		});
	});
});
