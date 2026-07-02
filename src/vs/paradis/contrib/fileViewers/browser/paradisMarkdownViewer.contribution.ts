/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown レンダリングビューア（web/desktop 両対応）の登録入り口。
// paradis.common.contribution.ts から import される。EditorPane / シリアライザ / EditorResolver /
// Rendered-Raw トグルアクションをここで登録する。

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { ParadisMarkdownFileEditor } from './paradisMarkdownFileEditor.js';
import { ParadisMarkdownFileInput, ParadisMarkdownFileInputSerializer } from './paradisFileViewerInput.js';
import { registerParadisFileViewerActions } from './paradisFileViewerActions.js';
import { PARADIS_MARKDOWN_EDITOR_ID, PARADIS_MARKDOWN_EXTENSIONS, PARADIS_MARKDOWN_INPUT_TYPE_ID, isParadisMarkdownResource, paradisGlobForExtension } from './paradisFileViewers.js';

// allow-any-unicode-next-line
const MARKDOWN_PREVIEW_LABEL = localize('paradis.markdownPreview', "Markdown プレビュー");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisMarkdownFileEditor,
		PARADIS_MARKDOWN_EDITOR_ID,
		MARKDOWN_PREVIEW_LABEL
	),
	[
		new SyncDescriptor(ParadisMarkdownFileInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_MARKDOWN_INPUT_TYPE_ID,
	ParadisMarkdownFileInputSerializer
);

class ParadisMarkdownViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.markdownViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const ext of PARADIS_MARKDOWN_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_MARKDOWN_EDITOR_ID,
					label: MARKDOWN_PREVIEW_LABEL,
					// exclusive: 標準markdown拡張が登録する *.md 用 custom editor（vscode.markdown.preview.editor 等）や
					// ユーザーの workbench.editorAssociations("*.md" 指定)より確実に優先させ、常にRenderedで開く（Superset同等）。
					// Raw への切替は Show Source アクションが override='default'(id指定)で開き直すため exclusive でも機能する。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					canSupportResource: resource =>
						(resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) && isParadisMarkdownResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisMarkdownFileInput, resource),
						options
					})
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisMarkdownViewerResolverContribution.ID, ParadisMarkdownViewerResolverContribution, WorkbenchPhase.BlockStartup);

registerParadisFileViewerActions();
