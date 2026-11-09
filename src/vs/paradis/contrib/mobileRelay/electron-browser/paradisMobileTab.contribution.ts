/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「モバイル」のタブの登録（エディタ・復元・開くコマンド）。「タスク」のタブ（paradisTasks.contribution.ts）と同じ作り。
// paradis.electron-browser.contribution.ts から読み込まれる（リレーは shared process にあるので Electron 専用）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisMobileEditor } from './paradisMobileEditor.js';
import { PARADIS_MOBILE_EDITOR_ID, PARADIS_MOBILE_INPUT_TYPE_ID, PARADIS_MOBILE_OPEN_COMMAND_ID, ParadisMobileEditorInput, ParadisMobileEditorInputSerializer } from './paradisMobileEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisMobileEditor, PARADIS_MOBILE_EDITOR_ID, localize('paradis.mobile.editorName', "モバイル")),
	[new SyncDescriptor(ParadisMobileEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PARADIS_MOBILE_INPUT_TYPE_ID, ParadisMobileEditorInputSerializer);

registerAction2(class ParadisOpenMobileAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_MOBILE_OPEN_COMMAND_ID,
			title: localize2('paradis.mobile.open', "モバイルを開く"),
			category: localize2('paradis.mobile.category', "Para Code"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(ParadisMobileEditorInput.instance, { pinned: true });
	}
});
