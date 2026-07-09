/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IKeybindingRule } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

// User keybindings are resolved separately after defaults. Within the default tier, reserve the
// highest safe weight so a large extension contribution cannot shadow Para Code's primary shortcut.
const PARADIS_WORKSPACE_SWITCH_KEYBINDING_WEIGHT = Number.MAX_SAFE_INTEGER;

export function paradisWorkspaceSwitchCommandId(index: number): string {
	return `paradis.workspaceSwitch.switchToRepository${index}`;
}

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
