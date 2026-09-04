/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { TerminalSendSequenceCommandId } from '../../../../../workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.js';
import '../../browser/paradisTerminalShiftEnter.contribution.js';
import { PARADIS_TERMINAL_SHIFT_ENTER_SETTING } from '../../common/paradisTerminalShiftEnter.js';

suite('Paradis terminal Shift+Enter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers an enabled-by-default application setting', () => {
		const property = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
			.getConfigurationProperties()[PARADIS_TERMINAL_SHIFT_ENTER_SETTING];

		assert.ok(property);
		assert.strictEqual(property.type, 'boolean');
		assert.strictEqual(property.default, true);
	});

	test('sends ESC+CR only under the Para setting and terminal safety contexts', () => {
		const shiftEnter = decodeKeybinding(KeyMod.Shift | KeyCode.Enter, OS)?.getHashCode();
		const rule = KeybindingsRegistry.getDefaultKeybindings().find(item =>
			item.command === TerminalSendSequenceCommandId.SendSequence
			&& (item.commandArgs as { readonly text?: unknown } | undefined)?.text === '\x1b\r'
			&& item.keybinding?.getHashCode() === shiftEnter
		);

		assert.ok(rule);
		const when = rule.when?.serialize() ?? '';
		assert.match(when, new RegExp(`config\\.${PARADIS_TERMINAL_SHIFT_ENTER_SETTING}`));
		assert.match(when, /terminalFocus/);
		assert.match(when, /accessibilityModeEnabled/);
		assert.match(when, /terminalShellType/);
	});
});
