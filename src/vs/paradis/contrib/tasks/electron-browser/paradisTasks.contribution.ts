/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面の登録（エディタ・復元・開くコマンド）。
// paradis.electron-browser.contribution.ts から読み込まれる（GitHub は shared process の gh に頼むので Electron 専用）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisTasksEditor } from './paradisTasksEditor.js';
import { PARADIS_TASKS_EDITOR_ID, PARADIS_TASKS_INPUT_TYPE_ID, PARADIS_TASKS_OPEN_COMMAND_ID, ParadisTasksEditorInput, ParadisTasksEditorInputSerializer } from './paradisTasksEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisTasksEditor, PARADIS_TASKS_EDITOR_ID, localize('paradis.tasks.editorName', "タスク")),
	[new SyncDescriptor(ParadisTasksEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PARADIS_TASKS_INPUT_TYPE_ID, ParadisTasksEditorInputSerializer);

registerAction2(class ParadisOpenTasksAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_TASKS_OPEN_COMMAND_ID,
			title: localize2('paradis.tasks.open', "タスクを開く"),
			category: localize2('paradis.tasks.category', "Para Code"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(ParadisTasksEditorInput.instance, { pinned: true });
	}
});
