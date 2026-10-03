/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率のエディタのタブの登録（エディタ・復元・開くコマンド）。
// paradis.electron-browser.contribution.ts から読み込まれる（手元の値は shared process に聞くので Electron 専用）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisSystemUsageEditor } from './paradisSystemUsageEditor.js';
import {
	PARADIS_SYSTEM_USAGE_EDITOR_ID,
	PARADIS_SYSTEM_USAGE_INPUT_TYPE_ID,
	PARADIS_SYSTEM_USAGE_OPEN_COMMAND_ID,
	ParadisSystemUsageEditorInput,
	ParadisSystemUsageEditorInputSerializer,
} from './paradisSystemUsageEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisSystemUsageEditor, PARADIS_SYSTEM_USAGE_EDITOR_ID, localize('paradis.systemUsage.editorName', "システムの使用率")),
	[new SyncDescriptor(ParadisSystemUsageEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PARADIS_SYSTEM_USAGE_INPUT_TYPE_ID, ParadisSystemUsageEditorInputSerializer);

registerAction2(class ParadisOpenSystemUsageAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SYSTEM_USAGE_OPEN_COMMAND_ID,
			title: localize2('paradis.systemUsage.open', "システムの使用率を開く"),
			category: localize2('paradis.systemUsage.category', "Para Code"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, machineId?: unknown): Promise<void> {
		const input = ParadisSystemUsageEditorInput.instance;
		if (machineId === 'local' || machineId === 'remote') {
			input.requestMachine(machineId);
		}
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
	}
});
