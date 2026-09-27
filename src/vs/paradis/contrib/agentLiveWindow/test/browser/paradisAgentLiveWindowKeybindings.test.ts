/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { KeyChord, KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyExpr, ContextKeyExpression, ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindings, KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import {
	PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID,
	PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID,
	ParadisAgentLiveWindowFocusContext,
} from '../../common/paradisAgentLiveWindow.js';
import '../../browser/paradisAgentLiveWindowKeybindings.js';

/**
 * upstream の既定キーバインドの写し。いずれもライブウィンドウから押すとメインウィンドウの
 * エディタを閉じる。定義は editorCommands.ts / editorActions.ts / terminalActions.ts と同じ
 * (テストのためだけに upstream の登録処理全体を走らせると、共有のレジストリを汚すため)。
 */
const UPSTREAM_RULES: readonly (IKeybindings & { readonly id: string; readonly when?: ContextKeyExpression })[] = [
	{ id: 'workbench.action.closeActiveEditor', primary: KeyMod.CtrlCmd | KeyCode.KeyW, win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] } },
	{ id: 'workbench.action.terminal.killEditor', primary: KeyMod.CtrlCmd | KeyCode.KeyW, win: { primary: KeyMod.CtrlCmd | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyCode.KeyW] }, when: ContextKeyExpr.and(ContextKeyExpr.has('terminalFocus'), ContextKeyExpr.has('terminalEditorFocus')) },
	{ id: 'workbench.action.closeEditorsInGroup', primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyW) },
	{ id: 'workbench.action.closeAllEditors', primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyW) },
	{ id: 'workbench.action.closeAllGroups', primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW) },
	{ id: 'workbench.action.closeUnmodifiedEditors', primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyU) },
	{ id: 'workbench.action.closeOtherEditors', mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT } },
	{ id: 'workbench.action.closeWindow', mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW }, linux: { primary: KeyMod.Alt | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW] }, win: { primary: KeyMod.Alt | KeyCode.F4, secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW] } },
];

const OWN_COMMANDS = new Set([PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID, PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID]);

function createResolver(store: DisposableStore, os: OperatingSystem): KeybindingResolver {
	const upstreamIds = new Set<string>();
	for (const { id, when, ...keybindings } of UPSTREAM_RULES) {
		upstreamIds.add(id);
		store.add(KeybindingsRegistry.registerKeybindingRule({ id, when, weight: KeybindingWeight.WorkbenchContrib, ...keybindings }));
	}
	const items: ResolvedKeybindingItem[] = [];
	for (const item of KeybindingsRegistry.getDefaultKeybindingsForOS(os)) {
		if (!item.keybinding || !(upstreamIds.has(item.command ?? '') || OWN_COMMANDS.has(item.command ?? ''))) {
			continue;
		}
		for (const resolved of USLayoutResolvedKeybinding.resolveKeybinding(item.keybinding, os)) {
			items.push(new ResolvedKeybindingItem(resolved, item.command, item.commandArgs, item.when ?? undefined, true, null, false));
		}
	}
	return new KeybindingResolver(items, [], () => { });
}

/** キーを順に押したときに実行されるコマンド。何にも当たらなければ undefined。 */
function dispatch(resolver: KeybindingResolver, os: OperatingSystem, keybinding: number, contextValues: Record<string, boolean>): string | null | undefined {
	const decoded = decodeKeybinding(keybinding, os);
	assert.ok(decoded);
	const [resolved] = USLayoutResolvedKeybinding.resolveKeybinding(decoded, os);
	assert.ok(resolved);
	const chords = resolved.getDispatchChords();
	const context: IContext = { getValue: <T extends ContextKeyValue>(key: string) => contextValues[key] as T | undefined };
	const pressed: string[] = [];
	for (const chord of chords) {
		assert.ok(chord);
		const result = resolver.resolve(context, pressed, chord);
		if (result.kind === ResultKind.KbFound) {
			return result.commandId;
		}
		if (result.kind === ResultKind.NoMatchingKb) {
			return undefined;
		}
		pressed.push(chord);
	}
	return undefined;
}

const OS_LABELS: Record<OperatingSystem, string> = {
	[OperatingSystem.Macintosh]: 'mac',
	[OperatingSystem.Windows]: 'win',
	[OperatingSystem.Linux]: 'linux',
};

interface IScenario {
	readonly os: OperatingSystem;
	readonly keybinding: number;
}

const SCENARIOS: readonly IScenario[] = [
	{ os: OperatingSystem.Macintosh, keybinding: KeyMod.CtrlCmd | KeyCode.KeyW },
	{ os: OperatingSystem.Windows, keybinding: KeyMod.CtrlCmd | KeyCode.F4 },
	{ os: OperatingSystem.Windows, keybinding: KeyMod.CtrlCmd | KeyCode.KeyW },
	{ os: OperatingSystem.Linux, keybinding: KeyMod.CtrlCmd | KeyCode.KeyW },
	{ os: OperatingSystem.Macintosh, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyW) },
	{ os: OperatingSystem.Macintosh, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyW) },
	{ os: OperatingSystem.Macintosh, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW) },
	{ os: OperatingSystem.Macintosh, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyU) },
	{ os: OperatingSystem.Macintosh, keybinding: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT },
	{ os: OperatingSystem.Windows, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyW) },
	{ os: OperatingSystem.Linux, keybinding: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyU) },
	{ os: OperatingSystem.Macintosh, keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
	{ os: OperatingSystem.Windows, keybinding: KeyMod.Alt | KeyCode.F4 },
	{ os: OperatingSystem.Linux, keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW },
];

function runScenarios(contextValues: Record<string, boolean>): string[] {
	const store = new DisposableStore();
	try {
		const resolvers = new Map<OperatingSystem, KeybindingResolver>();
		return SCENARIOS.map(({ os, keybinding }) => {
			let resolver = resolvers.get(os);
			if (!resolver) {
				resolver = createResolver(store, os);
				resolvers.set(os, resolver);
			}
			return `${OS_LABELS[os]} ${keybinding}: ${dispatch(resolver, os, keybinding, contextValues)}`;
		});
	} finally {
		store.dispose();
	}
}

function expected(commands: readonly string[]): string[] {
	return SCENARIOS.map(({ os, keybinding }, index) => `${OS_LABELS[os]} ${keybinding}: ${commands[index]}`);
}

suite('Paradis agent live window keybindings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('closes the live window and swallows editor-closing shortcuts while the key target is inside it', () => {
		const close = PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID;
		const block = PARADIS_AGENT_LIVE_BLOCK_EDITOR_SHORTCUT_COMMAND_ID;
		assert.deepStrictEqual(
			runScenarios({ [ParadisAgentLiveWindowFocusContext.key]: true }),
			expected([close, close, close, close, block, block, block, block, block, block, block, close, close, close]),
		);
	});

	test('wins over the terminal editor close binding that main-window terminal focus would select', () => {
		assert.deepStrictEqual(
			runScenarios({ [ParadisAgentLiveWindowFocusContext.key]: true, terminalFocus: true, terminalEditorFocus: true }).slice(0, 4),
			expected(Array(4).fill(PARADIS_AGENT_LIVE_CLOSE_COMMAND_ID)).slice(0, 4),
		);
	});

	test('leaves the upstream bindings untouched outside the live window', () => {
		assert.deepStrictEqual(
			runScenarios({}),
			expected([
				'workbench.action.closeActiveEditor',
				'workbench.action.closeActiveEditor',
				'workbench.action.closeActiveEditor',
				'workbench.action.closeActiveEditor',
				'workbench.action.closeEditorsInGroup',
				'workbench.action.closeAllEditors',
				'workbench.action.closeAllGroups',
				'workbench.action.closeUnmodifiedEditors',
				'workbench.action.closeOtherEditors',
				'workbench.action.closeAllEditors',
				'workbench.action.closeUnmodifiedEditors',
				'workbench.action.closeWindow',
				'workbench.action.closeWindow',
				'workbench.action.closeWindow',
			]),
		);
	});
});
