/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ActiveEditorContext, EditorPartMultipleEditorGroupsContext } from '../../../../../workbench/common/contextkeys.js';
import { terminalEditorId } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TOGGLE_MAXIMIZE_EDITOR_GROUP } from '../../../../../workbench/browser/parts/editor/editorCommands.js';
import '../../browser/paradisTerminalEditorMenu.contribution.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

suite('ParadisTerminalEditorMenu', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('offers maximize / unmaximize only for terminals in the editor area', () => {
		const items = MenuRegistry.getMenuItems(MenuId.TerminalInstanceContext)
			.filter(isIMenuItem)
			.filter(item => item.command.id === TOGGLE_MAXIMIZE_EDITOR_GROUP);
		const visibleTitles = (values: Record<string, unknown>) => items
			.filter(item => item.when?.evaluate(context(values)) ?? true)
			.map(item => item.command.title);

		assert.deepStrictEqual({
			editorWithSplit: visibleTitles({ activeEditor: 'terminalEditor', editorPartMultipleEditorGroups: true }),
			editorMaximized: visibleTitles({ activeEditor: 'terminalEditor', editorPartMultipleEditorGroups: true, editorPartMaximizedEditorGroup: true }),
			editorSingleGroup: visibleTitles({ activeEditor: 'terminalEditor' }),
			textEditorGroup: visibleTitles({ activeEditor: 'workbench.editors.files.textFileEditor', editorPartMultipleEditorGroups: true }),
		}, {
			editorWithSplit: ['エディタグループを最大化'],
			editorMaximized: ['エディタグループの最大化を解除'],
			editorSingleGroup: [],
			textEditorGroup: [],
		});
	});

	test('hides the item in the panel terminal even while a terminal editor is active and the editor area is split', () => {
		// 実際のスコープの親子関係を作る: activeEditor はウィンドウ全体（ルート）のキー、
		// editorPartMultipleEditorGroups はエディタパートのスコープにだけあるキー。
		// パネルのターミナルのメニューはエディタパートの外（ルートの子）のスコープで評価される。
		const root = store.add(new ContextKeyService(new TestConfigurationService()));
		ActiveEditorContext.bindTo(root).set(terminalEditorId);
		const editorPart = store.add(root.createScoped(mainWindow.document.createElement('div')));
		EditorPartMultipleEditorGroupsContext.bindTo(editorPart).set(true);
		const terminalInEditor = store.add(editorPart.createScoped(mainWindow.document.createElement('div')));
		const terminalInPanel = store.add(root.createScoped(mainWindow.document.createElement('div')));
		const maximize = MenuRegistry.getMenuItems(MenuId.TerminalInstanceContext)
			.filter(isIMenuItem)
			.find(item => item.command.id === TOGGLE_MAXIMIZE_EDITOR_GROUP && item.order === 1 && item.when?.keys().includes(EditorPartMultipleEditorGroupsContext.key));

		assert.deepStrictEqual({
			editor: terminalInEditor.contextMatchesRules(maximize?.when),
			panel: terminalInPanel.contextMatchesRules(maximize?.when),
		}, {
			editor: true,
			panel: false,
		});
	});
});
