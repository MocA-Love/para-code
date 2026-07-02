/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Rendered / Raw を切り替えるエディタタイトルバーのアクション。
// - Show Source: Rendered ビューア表示中に、同じリソースを通常のテキストエディタ（override='default'）で開き直す。
// - Show Preview: 対象拡張子のテキストエディタ表示中に、対応する Rendered ビューアで開き直す。
// 2 つのアクションで Superset の [Rendered | Raw] トグル相当の往復を実現する。

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_EDITOR_ASSOCIATION } from '../../../../workbench/common/editor.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../../workbench/common/contextkeys.js';
import { TEXT_FILE_EDITOR_ID } from '../../../../workbench/contrib/files/common/files.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import {
	PARADIS_HTML_EDITOR_ID,
	PARADIS_HTML_EXTENSIONS,
	PARADIS_MARKDOWN_EDITOR_ID,
	PARADIS_MARKDOWN_EXTENSIONS,
	isParadisHtmlResource,
} from './paradisFileViewers.js';

const SUPPORTED_EXTENSIONS = [...PARADIS_MARKDOWN_EXTENSIONS, ...PARADIS_HTML_EXTENSIONS];

/** 対象拡張子（.md/.markdown/.html/.htm）のいずれかにマッチする when 式。 */
const supportedExtensionContext = ContextKeyExpr.or(
	...SUPPORTED_EXTENSIONS.map(ext => ResourceContextKey.Extension.isEqualTo(ext))
);

/** いずれかの Rendered ビューアがアクティブなときにマッチする when 式。 */
const renderedEditorActiveContext = ContextKeyExpr.or(
	ActiveEditorContext.isEqualTo(PARADIS_MARKDOWN_EDITOR_ID),
	ActiveEditorContext.isEqualTo(PARADIS_HTML_EDITOR_ID)
);

class ParadisShowSourceAction extends Action2 {
	static readonly ID = 'paradis.fileViewer.showSource';

	constructor() {
		super({
			id: ParadisShowSourceAction.ID,
			title: localize2('paradis.fileViewer.showSource', "Show Source"),
			icon: Codicon.code,
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: renderedEditorActiveContext
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const resource = editorService.activeEditor?.resource;
		if (!resource) {
			return;
		}
		const group = editorService.activeEditorPane?.group;
		await editorService.openEditor({
			resource,
			options: { override: DEFAULT_EDITOR_ASSOCIATION.id }
		}, group);
	}
}

class ParadisShowPreviewAction extends Action2 {
	static readonly ID = 'paradis.fileViewer.showPreview';

	constructor() {
		super({
			id: ParadisShowPreviewAction.ID,
			title: localize2('paradis.fileViewer.showPreview', "Show Preview"),
			icon: Codicon.openPreview,
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(
					ActiveEditorContext.isEqualTo(TEXT_FILE_EDITOR_ID),
					supportedExtensionContext
				)
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const resource = editorService.activeEditor?.resource;
		if (!resource) {
			return;
		}
		const group = editorService.activeEditorPane?.group;
		const override = isParadisHtmlResource(resource) ? PARADIS_HTML_EDITOR_ID : PARADIS_MARKDOWN_EDITOR_ID;
		await editorService.openEditor({
			resource,
			options: { override }
		}, group);
	}
}

/** Rendered/Raw トグルのアクションを登録する（Markdown/HTML 両ビューアで共有）。 */
export function registerParadisFileViewerActions(): void {
	registerAction2(ParadisShowSourceAction);
	registerAction2(ParadisShowPreviewAction);
}
