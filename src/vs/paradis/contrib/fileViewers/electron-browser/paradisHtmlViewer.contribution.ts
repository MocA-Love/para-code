/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML レンダリングビューア（Electron webview 依存）の登録入り口。
// paradis.electron-browser.contribution.ts から import される。
// Rendered/Raw トグルのアクションは Markdown 側（paradisFileViewerActions）で共通登録済み。

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { ParadisHtmlFileEditor } from './paradisHtmlFileEditor.js';
import { ParadisHtmlFileInput, ParadisHtmlFileInputSerializer } from './paradisHtmlFileInput.js';
import { ParadisFileDiffInput } from '../browser/paradisFileDiffInput.js';
import { PARADIS_HTML_EDITOR_ID, PARADIS_HTML_EXTENSIONS, PARADIS_HTML_INPUT_TYPE_ID, isParadisHtmlResource, paradisGlobForExtension } from '../browser/paradisFileViewers.js';

const HTML_PREVIEW_LABEL = localize('paradis.htmlPreview', "HTML Preview");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ParadisHtmlFileEditor,
		PARADIS_HTML_EDITOR_ID,
		HTML_PREVIEW_LABEL
	),
	[
		new SyncDescriptor(ParadisHtmlFileInput)
	]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_HTML_INPUT_TYPE_ID,
	ParadisHtmlFileInputSerializer
);

class ParadisHtmlViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.htmlViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const ext of PARADIS_HTML_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_HTML_EDITOR_ID,
					label: HTML_PREVIEW_LABEL,
					// exclusive: ユーザーの workbench.editorAssociations より確実に優先させ、常にRenderedで開く（Superset同等）。
					// Markdown 側と挙動を揃える。Raw への切替は Show Source アクション(override='default')で機能する。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					// git: は差分オープン(SCM の Open Changes)の旧版スキーム(Markdown 側と同じ扱い)。
					canSupportResource: resource =>
						(resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote || resource.scheme === 'git') && isParadisHtmlResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisHtmlFileInput, resource),
						options
					}),
					// 差分は MD/HTML 共用のテキスト差分ペイン(pane/シリアライザは Markdown 側 contribution で登録済み)で開く。
					createDiffEditorInput: diffEditorInput => {
						const original = diffEditorInput.original.resource;
						const modified = diffEditorInput.modified.resource;
						if (!original || !modified) {
							throw new Error('Para Code file diff requires both original and modified resources');
						}
						return {
							editor: instantiationService.createInstance(ParadisFileDiffInput, original, modified, diffEditorInput.label)
						};
					}
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisHtmlViewerResolverContribution.ID, ParadisHtmlViewerResolverContribution, WorkbenchPhase.BlockStartup);
