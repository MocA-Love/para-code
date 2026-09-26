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
import { TOGGLE_MAXIMIZE_EDITOR_GROUP } from '../../../../../workbench/browser/parts/editor/editorCommands.js';
import '../../browser/paradisTerminalEditorMenu.contribution.js';

function context(values: Record<string, unknown>): IContext {
	return { getValue: <T>(key: string) => values[key] as T };
}

suite('ParadisTerminalEditorMenu', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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
			// パネルのターミナルはエディタパートのスコープ外なので、エディタパートのキーが見えない
			panelWhileTerminalEditorActive: visibleTitles({ activeEditor: 'terminalEditor' }),
			textEditorGroup: visibleTitles({ activeEditor: 'workbench.editors.files.textFileEditor', editorPartMultipleEditorGroups: true }),
		}, {
			editorWithSplit: ['エディタグループを最大化'],
			editorMaximized: ['エディタグループの最大化を解除'],
			editorSingleGroup: [],
			panelWhileTerminalEditorActive: [],
			textEditorGroup: [],
		});
	});
});
