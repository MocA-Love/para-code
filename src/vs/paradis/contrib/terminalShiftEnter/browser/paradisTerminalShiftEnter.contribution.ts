/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize } from '../../../../nls.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../platform/accessibility/common/accessibility.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { GeneralShellType, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { TerminalContextKeys, TerminalContextKeyStrings } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { registerSendSequenceKeybinding } from '../../../../workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.js';

const PARADIS_TERMINAL_SHIFT_ENTER_SETTING = 'paradis.terminal.shiftEnterNewline';

// Paradis独自設定の集約セクション（windowTransparency の paradisSettings.contribution.ts と同じ id/title に
// 揃えることで、設定UI上は1つの「Para Code」セクションにマージされる）。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_TERMINAL_SHIFT_ENTER_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.terminal.shiftEnterNewline', "統合ターミナルで `Shift+Enter` を押したとき、`Alt+Enter` と同じシーケンス（`ESC`+`CR`）を送信します。Claude Code や Codex などの TUI では送信ではなく改行として扱われるようになります。素のシェルプロンプトでは `Shift+Enter` が Enter として機能しなくなる点に注意してください。")
		}
	}
});

// upstreamの sendSequence contribution が pwsh + シェル統合 + win32InputMode の組み合わせで
// 同じ Shift+Enter に PSReadLine 向けバインド（\x1b[24~c, AddLine）を登録しているため、
// その条件が成立する場合はこちらが引く（同 weight での load-order 依存の衝突を避ける）。
const pwshAddLineBindingActive = ContextKeyExpr.and(
	ContextKeyExpr.equals(TerminalContextKeyStrings.ShellType, GeneralShellType.PowerShell),
	TerminalContextKeys.terminalShellIntegrationEnabled,
	ContextKeyExpr.equals(`config.${TerminalSettingId.EnableWin32InputMode}`, true)
);

// Shift+Enter -> ESC+CR（Alt+Enterと同じバイト列）。Claude Code / Codex 等のTUIが改行と解釈する。
registerSendSequenceKeybinding('\x1b\r', {
	when: ContextKeyExpr.and(TerminalContextKeys.focus, ContextKeyExpr.equals(`config.${PARADIS_TERMINAL_SHIFT_ENTER_SETTING}`, true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.negate(), pwshAddLineBindingActive?.negate()),
	primary: KeyMod.Shift | KeyCode.Enter
});
