/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_WORKSPACES_VIEW_ID } from '../../workspaceSwitch/browser/paradisWorkspacesView.js';
import { ParadisSessionResumeEditor } from './paradisSessionResumeEditor.js';
import { ParadisSessionResumeInput, ParadisSessionResumeInputSerializer, PARADIS_SESSION_RESUME_EDITOR_ID, PARADIS_SESSION_RESUME_INPUT_TYPE_ID } from './paradisSessionResumeInput.js';

export const PARADIS_SHOW_SESSION_RESUME_COMMAND_ID = 'paradis.sessionResume.show';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisSessionResumeEditor,
		PARADIS_SESSION_RESUME_EDITOR_ID,
		localize('paradis.sessionResume.editorName', "セッション履歴"),
	),
	[new SyncDescriptor(ParadisSessionResumeInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_SESSION_RESUME_INPUT_TYPE_ID,
	ParadisSessionResumeInputSerializer,
);

registerAction2(class ShowParadisSessionResumeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SHOW_SESSION_RESUME_COMMAND_ID,
			title: localize2('paradis.sessionResume.show', "エージェントのセッション履歴を開く"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(ParadisSessionResumeInput.instance, { pinned: true });
	}
});

// 採用した入口: Workspaces 見出し。space行を汚さず、どのspaceの履歴も横断する機能だと伝わる。
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: {
		id: PARADIS_SHOW_SESSION_RESUME_COMMAND_ID,
		title: localize2('paradis.sessionResume.viewTitle', "セッション履歴を開く"),
		icon: Codicon.history,
	},
	when: ContextKeyExpr.equals('view', PARADIS_WORKSPACES_VIEW_ID),
	group: 'navigation',
	order: -1,
});
