/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IKeybindingRule, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

const PARADIS_WORKSPACE_SWITCH_KEYBINDING_WEIGHT = KeybindingWeight.ExternalExtension + 1000;

export function paradisWorkspaceSwitchKeybinding(index: number): Omit<IKeybindingRule, 'id'> {
	const digit = KeyCode.Digit0 + index;
	return {
		weight: PARADIS_WORKSPACE_SWITCH_KEYBINDING_WEIGHT,
		primary: KeyMod.CtrlCmd | KeyMod.Alt | digit,
		mac: {
			primary: KeyMod.WinCtrl | digit,
			secondary: [KeyMod.CtrlCmd | KeyMod.WinCtrl | digit],
		},
	};
}
