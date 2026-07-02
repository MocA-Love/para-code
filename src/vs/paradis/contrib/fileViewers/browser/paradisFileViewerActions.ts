/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Rendered / Raw を切り替えるエディタタイトルバーのアクション。
// 単一ペイン内蔵方式のため、エディタを開き直さずアクティブなビューアペインの内部モードを切り替える。
// ペイン内トグルと役割は重複するが、タイトルバーからの操作としても残す。

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ParadisFileViewerMode } from './paradisFileViewerInput.js';
import { ParadisRenderedFileEditor } from './paradisRenderedFileEditor.js';
import { PARADIS_HTML_EDITOR_ID, PARADIS_MARKDOWN_EDITOR_ID } from './paradisFileViewers.js';

/** いずれかのビューアペインがアクティブなときにマッチする when 式。 */
const viewerEditorActiveContext = ContextKeyExpr.or(
	ActiveEditorContext.isEqualTo(PARADIS_MARKDOWN_EDITOR_ID),
	ActiveEditorContext.isEqualTo(PARADIS_HTML_EDITOR_ID)
);

function setActiveViewerMode(accessor: ServicesAccessor, mode: ParadisFileViewerMode): void {
	const pane = accessor.get(IEditorService).activeEditorPane;
	if (pane instanceof ParadisRenderedFileEditor) {
		pane.setViewMode(mode);
	}
}

class ParadisShowSourceAction extends Action2 {
	static readonly ID = 'paradis.fileViewer.showSource';

	constructor() {
		super({
			id: ParadisShowSourceAction.ID,
			title: localize2('paradis.fileViewer.showSource', "Show Source"),
			icon: Codicon.code,
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 1, when: viewerEditorActiveContext }]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		setActiveViewerMode(accessor, 'raw');
	}
}

class ParadisShowPreviewAction extends Action2 {
	static readonly ID = 'paradis.fileViewer.showPreview';

	constructor() {
		super({
			id: ParadisShowPreviewAction.ID,
			title: localize2('paradis.fileViewer.showPreview', "Show Preview"),
			icon: Codicon.openPreview,
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: 1, when: viewerEditorActiveContext }]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		setActiveViewerMode(accessor, 'rendered');
	}
}

/** Rendered/Raw トグルのアクションを登録する（Markdown/HTML 両ビューアで共有）。 */
export function registerParadisFileViewerActions(): void {
	registerAction2(ParadisShowSourceAction);
	registerAction2(ParadisShowPreviewAction);
}
