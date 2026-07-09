/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { createSimpleKeybinding, Keybinding, KeyCodeChord } from '../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingItem, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import { DEFAULT_COMMANDS_TO_SKIP_SHELL } from '../../../../../workbench/contrib/terminal/common/terminal.js';
import { paradisWorkspaceSwitchCommandId } from '../../common/paradisWorkspaceSwitchKeybindings.js';
import '../../browser/paradisWorkspaceSwitch.contribution.js';

const competingCommandId = 'test.paradis.workspaceSwitch.competingDefault';

function switchCommandId(index: number): string {
	return paradisWorkspaceSwitchCommandId(index);
}

function commandBindings(os: OperatingSystem, index: number): IKeybindingItem[] {
	return KeybindingsRegistry.getDefaultKeybindingsForOS(os)
		.filter(item => item.command === switchCommandId(index) && item.keybinding);
}

function assertDigitChord(item: IKeybindingItem, expected: {
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly keyCode: KeyCode;
}): void {
	assert.ok(item.keybinding);
	const chord = item.keybinding.chords[0];
	assert.ok(chord instanceof KeyCodeChord);
	assert.deepStrictEqual({
		ctrlKey: chord.ctrlKey,
		altKey: chord.altKey,
		metaKey: chord.metaKey,
		keyCode: chord.keyCode,
	}, expected);
}

suite('Paradis workspace switch keybindings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses Control+1..9 on macOS and retains Control+Command+1..9 as secondary', () => {
		for (let index = 1; index <= 9; index++) {
			const bindings = commandBindings(OperatingSystem.Macintosh, index);
			const primary = bindings.find(item => item.weight2 === 0);
			const secondary = bindings.find(item => item.weight2 === -1);
			assert.ok(primary);
			assert.ok(secondary);
			assertDigitChord(primary, {
				ctrlKey: true,
				altKey: false,
				metaKey: false,
				keyCode: KeyCode.Digit0 + index,
			});
			assertDigitChord(secondary, {
				ctrlKey: true,
				altKey: false,
				metaKey: true,
				keyCode: KeyCode.Digit0 + index,
			});
		}
	});

	test('keeps Ctrl+Alt+1..9 as the Linux primary binding', () => {
		for (let index = 1; index <= 9; index++) {
			const bindings = commandBindings(OperatingSystem.Linux, index);
			const primary = bindings.find(item => item.weight2 === 0);
			assert.ok(primary);
			assertDigitChord(primary, {
				ctrlKey: true,
				altKey: true,
				metaKey: false,
				keyCode: KeyCode.Digit0 + index,
			});
		}
	});

	test('keeps Ctrl+Alt+1..9 as the Windows primary binding', () => {
		for (let index = 1; index <= 9; index++) {
			const bindings = commandBindings(OperatingSystem.Windows, index);
			const primary = bindings.find(item => item.weight2 === 0);
			assert.ok(primary);
			assertDigitChord(primary, {
				ctrlKey: true,
				altKey: true,
				metaKey: false,
				keyCode: KeyCode.Digit0 + index,
			});
		}
	});

	test('keeps workspace shortcuts in VS Code when the terminal has focus', () => {
		assert.deepStrictEqual(
			Array.from({ length: 9 }, (_, index) => DEFAULT_COMMANDS_TO_SKIP_SHELL.includes(switchCommandId(index + 1))),
			Array.from({ length: 9 }, () => true),
		);
	});

	test('wins over an existing lower-priority default binding', () => {
		const competingRegistration = KeybindingsRegistry.registerKeybindingRule({
			id: competingCommandId,
			weight: Number.MAX_SAFE_INTEGER - 1,
			primary: KeyMod.CtrlCmd | KeyCode.Digit1,
			mac: { primary: KeyMod.WinCtrl | KeyCode.Digit1 },
		});
		try {
			const resolvedItems: ResolvedKeybindingItem[] = [];
			for (const item of KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Macintosh)) {
				if (!item.keybinding || (item.command !== competingCommandId && item.command !== switchCommandId(1))) {
					continue;
				}
				const resolved = USLayoutResolvedKeybinding.resolveKeybinding(item.keybinding, OperatingSystem.Macintosh)[0];
				assert.ok(resolved);
				resolvedItems.push(new ResolvedKeybindingItem(
					resolved,
					item.command,
					item.commandArgs,
					item.when ?? undefined,
					true,
					item.extensionId,
					item.isBuiltinExtension,
				));
			}

			const resolver = new KeybindingResolver(resolvedItems, [], () => { });
			const keypress = USLayoutResolvedKeybinding.getDispatchStr(createSimpleKeybinding(
				KeyMod.WinCtrl | KeyCode.Digit1,
				OperatingSystem.Macintosh,
			));
			assert.ok(keypress);
			const context: IContext = { getValue: () => undefined };
			const result = resolver.resolve(context, [], keypress);
			assert.ok(result.kind === ResultKind.KbFound);
			assert.strictEqual(result.commandId, switchCommandId(1));
		} finally {
			competingRegistration.dispose();
		}
	});

	test('allows a user keybinding to override the fork default', () => {
		const defaultBinding = commandBindings(OperatingSystem.Macintosh, 1).find(item => item.weight2 === 0);
		assert.ok(defaultBinding?.keybinding);
		const resolvedDefault = USLayoutResolvedKeybinding.resolveKeybinding(defaultBinding.keybinding, OperatingSystem.Macintosh)[0];
		const resolvedUser = USLayoutResolvedKeybinding.resolveKeybinding(
			new Keybinding([createSimpleKeybinding(KeyMod.WinCtrl | KeyCode.Digit1, OperatingSystem.Macintosh)]),
			OperatingSystem.Macintosh,
		)[0];
		assert.ok(resolvedDefault);
		assert.ok(resolvedUser);

		const resolver = new KeybindingResolver([
			new ResolvedKeybindingItem(resolvedDefault, switchCommandId(1), null, undefined, true, null, false),
		], [
			new ResolvedKeybindingItem(resolvedUser, competingCommandId, null, undefined, false, null, false),
		], () => { });
		const keypress = USLayoutResolvedKeybinding.getDispatchStr(createSimpleKeybinding(
			KeyMod.WinCtrl | KeyCode.Digit1,
			OperatingSystem.Macintosh,
		));
		assert.ok(keypress);
		const result = resolver.resolve({ getValue: () => undefined }, [], keypress);
		assert.ok(result.kind === ResultKind.KbFound);
		assert.strictEqual(result.commandId, competingCommandId);
	});
});
