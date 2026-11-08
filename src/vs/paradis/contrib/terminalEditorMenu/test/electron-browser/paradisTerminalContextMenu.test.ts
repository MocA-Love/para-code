/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { NullCommandService } from '../../../../../platform/commands/test/common/nullCommandService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyValue } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { setupTerminalMenus } from '../../../../../workbench/contrib/terminal/browser/terminalMenus.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisAgentStatusStore } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_TERMINAL_AGENT_RUNNING, ParadisTerminalContextMenuContribution } from '../../electron-browser/paradisTerminalContextMenu.contribution.js';
import '../../electron-browser/paradisTerminalAgentSession.contribution.js';

suite('Paradis terminal context menu (menus)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => setupTerminalMenus(store));

	function menuIds(menuId: MenuId, values: Record<string, ContextKeyValue>, arg?: unknown): string[][] {
		const contextKeyService = store.add(new ContextKeyService(new TestConfigurationService()));
		for (const [key, value] of Object.entries(values)) {
			contextKeyService.createKey(key, value);
		}
		const menuService = store.add(new MenuService(NullCommandService, new MockKeybindingService(), store.add(new InMemoryStorageService())));
		const menu = store.add(menuService.createMenu(menuId, contextKeyService));
		return menu.getActions({ shouldForwardArgs: true, arg }).map(([, actions]) => actions.map(action => action instanceof SubmenuItemAction
			? `${action.id} > ${action.actions.map(child => child.id).join(', ')}`
			: `${action.id}${action.enabled ? '' : ' (disabled)'}`));
	}

	const editorTerminal = {
		activeEditor: 'terminalEditor',
		terminalEditorFocus: true,
		terminalProcessSupported: true,
		terminalIsOpen: true,
	};

	test('adds the agent section only while an agent runs, and the terminal items in both cases', () => {
		assert.deepStrictEqual({
			agent: menuIds(MenuId.TerminalInstanceContext, { ...editorTerminal, paradisTerminalAgentRunning: true, terminalTextSelected: true }),
			shell: menuIds(MenuId.TerminalInstanceContext, editorTerminal),
		}, {
			agent: [
				['paradis.terminal.sendSelectionToAgent', 'paradis.terminal.handOffAgentSession', 'paradis.terminal.forkAgentSession (disabled)', 'paradis.terminal.copyContext', 'paradis.agentChat.toggle (disabled)'],
				['workbench.action.terminal.splitOrCreate', 'paradis.terminal.splitEditorDown', 'workbench.action.terminal.new'],
				['workbench.action.terminal.copySelection', 'workbench.action.terminal.copySelectionAsHtml', 'workbench.action.terminal.paste', 'workbench.action.terminal.selectAll'],
				['workbench.action.terminal.clear', 'paradis.terminal.resetInputModes'],
				['workbench.action.terminal.rename', 'paradis.editor.copyTabId'],
				['workbench.action.terminal.killViewOrEditor'],
				['workbench.action.terminal.sizeToContentWidth'],
			],
			shell: [
				['workbench.action.terminal.splitOrCreate', 'paradis.terminal.splitEditorDown', 'workbench.action.terminal.new'],
				['workbench.action.terminal.copySelection', 'workbench.action.terminal.copySelectionAsHtml', 'workbench.action.terminal.paste', 'workbench.action.terminal.selectAll'],
				['workbench.action.terminal.clear', 'paradis.terminal.resetInputModes'],
				['workbench.action.terminal.rename', 'paradis.editor.copyTabId'],
				['workbench.action.terminal.killViewOrEditor'],
				['workbench.action.terminal.sizeToContentWidth'],
			],
		});
	});

	test('keeps the editor-only items out of the panel terminal', () => {
		const ids = menuIds(MenuId.TerminalInstanceContext, { activeEditor: 'terminalEditor', terminalProcessSupported: true, terminalIsOpen: true, paradisTerminalAgentRunning: true }).flat();
		assert.deepStrictEqual(ids.filter(id => id.startsWith('paradis.')), ['paradis.terminal.sendSelectionToAgent (disabled)', 'paradis.terminal.handOffAgentSession', 'paradis.terminal.forkAgentSession (disabled)', 'paradis.terminal.copyContext', 'paradis.terminal.resetInputModes']);
	});

	test('adds the split submenu and the color submenu to terminal tabs only', () => {
		const forTab = (scheme: string) => menuIds(MenuId.EditorTitleContext, { resourceScheme: scheme, terminalProcessSupported: true }).flat().filter(id => id.includes('paradisTerminal'));
		assert.deepStrictEqual({
			terminal: forTab(Schemas.vscodeTerminal),
			file: forTab(Schemas.file),
		}, {
			terminal: [
				'submenuitem.paradisTerminalTabSplitSubmenu > paradis.terminal.splitEditorRight, paradis.terminal.splitEditorDown',
				'submenuitem.paradisTerminalTabColorSubmenu > paradis.terminal.tabColor.black, paradis.terminal.tabColor.red, paradis.terminal.tabColor.green, paradis.terminal.tabColor.yellow, paradis.terminal.tabColor.blue, paradis.terminal.tabColor.magenta, paradis.terminal.tabColor.cyan, paradis.terminal.tabColor.white, paradis.terminal.tabColor.none',
			],
			file: [],
		});
	});

	test('hides the agent section on the next right-click after the agent exits, without waiting for an event', () => {
		// claude が動いている最中のターミナル。hook の実績はある
		const state = { executingCommand: 'claude' as string | undefined, prompt: PromptInputState.Execute };
		const commandDetection = {
			get executingCommand() { return state.executingCommand; },
			promptInputModel: { get state() { return state.prompt; }, onDidStartInput: Event.None },
			onCommandExecuted: Event.None,
		};
		const instance = { instanceId: 7, capabilities: { get: (capability: TerminalCapability) => capability === TerminalCapability.CommandDetection ? commandDetection : undefined } } as unknown as ITerminalInstance;
		const multiplexer = { event: Event.None, dispose: () => { } };
		const activeChanged = store.add(new Emitter<ITerminalInstance | undefined>());
		const terminalService = {
			activeInstance: instance,
			onDidChangeActiveInstance: activeChanged.event,
			createOnInstanceCapabilityEvent: () => multiplexer,
		} as unknown as ITerminalService;
		const agentStatusStore = { onDidChangeAgentStatuses: Event.None, isAgentInstance: (id: number) => id === 7 } as unknown as IParadisAgentStatusStore;
		const contextKeyService = store.add(new ContextKeyService(new TestConfigurationService()));
		store.add(new ParadisTerminalContextMenuContribution(terminalService, agentStatusStore, contextKeyService));
		const running = () => contextKeyService.getContextKeyValue<boolean>(PARADIS_TERMINAL_AGENT_RUNNING.key);
		const whileRunning = running();

		// `exit` でシェルへ戻った。知らせは来ない（取りこぼした）まま、右クリックする
		state.executingCommand = undefined;
		state.prompt = PromptInputState.Input;
		const beforeRightClick = running();
		mainWindow.document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

		assert.deepStrictEqual({ whileRunning, beforeRightClick, afterRightClick: running() }, { whileRunning: true, beforeRightClick: true, afterRightClick: false });
	});
});
