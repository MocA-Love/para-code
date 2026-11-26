/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ParadisWorkspacesNav } from '../../browser/paradisWorkspacesNav.js';

const HEADING_COMMANDS = ['paradis.sessionResume.show', 'paradis.agentLiveWindow.open', 'paradis.workspaceSwitch.addRepository', 'paradis.workspaceSwitch.createWorktree'];

suite('ParadisWorkspacesNav', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('puts the session history button first in the projects heading and runs its command', () => {
		const executed: string[] = [];
		const container = createNav(store, executed, HEADING_COMMANDS);

		const buttons = headingButtons(container);
		buttons[0].click();
		buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

		assert.deepStrictEqual({
			buttons: buttons.map(button => ({ label: button.getAttribute('aria-label'), tabIndex: button.tabIndex, shown: button.style.display !== 'none', history: !!button.querySelector('.codicon-history') })),
			executed,
		}, {
			buttons: [
				{ label: 'セッション履歴を開く', tabIndex: 0, shown: true, history: true },
				{ label: 'エージェントの一覧を開く', tabIndex: 0, shown: true, history: false },
				{ label: '表示のオプション', tabIndex: 0, shown: true, history: false },
				{ label: 'リポジトリを追加...', tabIndex: 0, shown: true, history: false },
				{ label: '新しいワークツリースペース...', tabIndex: 0, shown: true, history: false },
			],
			executed: ['paradis.sessionResume.show', 'paradis.sessionResume.show'],
		});
	});

	test('hides the session history button where the command does not exist (web)', () => {
		const container = createNav(store, [], HEADING_COMMANDS.filter(id => id !== 'paradis.sessionResume.show'));

		assert.deepStrictEqual(headingButtons(container).map(button => button.style.display !== 'none'), [false, true, true, true, true]);
	});
});

function createNav(store: Pick<DisposableStore, 'add'>, executed: string[], commands: readonly string[]): HTMLElement {
	for (const id of commands) {
		if (!CommandsRegistry.getCommand(id)) {
			store.add(CommandsRegistry.registerCommand(id, () => { }));
		}
	}
	const container = mainWindow.document.createElement('div');
	mainWindow.document.body.appendChild(container);
	store.add({ dispose: () => container.remove() });

	const commandService: Partial<ICommandService> = {
		executeCommand: async <R>(id: string) => {
			executed.push(id);
			return undefined as R;
		},
	};
	store.add(new ParadisWorkspacesNav(
		container,
		{ openSearch: () => { }, agentCounts: () => ({ attention: 0, working: 0 }), onDidChangeAgentCounts: Event.None, optionsActions: () => [] },
		commandService as ICommandService,
		{} as Partial<IContextMenuService> as IContextMenuService,
		store.add(new InMemoryStorageService()),
		NullHoverService,
	));
	return container;
}

function headingButtons(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('.paradis-workspaces-heading-actions > .paradis-workspaces-heading-button')];
}
