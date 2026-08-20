/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)ビューア/差分(vendored docx-preview 依存)の登録入り口。paradis.electron-browser.contribution.ts から import。
// exclusive 登録により、標準のバイナリ警告(BinaryFileEditor)より優先して .docx をレンダリング表示する。
// 通常オープン(createEditorInput)と SCM の差分オープン(createDiffEditorInput)の両方を横取りする。

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { ParadisDocxFileEditor } from './paradisDocxFileEditor.js';
import { ParadisDocxDiffEditor } from './paradisDocxDiffEditor.js';
import {
	ParadisDocxDiffInput,
	ParadisDocxDiffInputSerializer,
	ParadisDocxInput,
	ParadisDocxInputSerializer,
} from './paradisDocxInput.js';
import {
	PARADIS_DOCX_DIFF_EDITOR_ID,
	PARADIS_DOCX_DIFF_INPUT_TYPE_ID,
	PARADIS_DOCX_EDITOR_ID,
	PARADIS_DOCX_EXTENSIONS,
	PARADIS_DOCX_INPUT_TYPE_ID,
	isParadisDocxResource,
	paradisGlobForExtension,
} from '../browser/paradisFileViewers.js';

// allow-any-unicode-next-line
const DOCX_LABEL = localize('paradis.docxPreview', "Word プレビュー");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisDocxFileEditor, PARADIS_DOCX_EDITOR_ID, DOCX_LABEL),
	[new SyncDescriptor(ParadisDocxInput)]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	// allow-any-unicode-next-line
	EditorPaneDescriptor.create(ParadisDocxDiffEditor, PARADIS_DOCX_DIFF_EDITOR_ID, localize('paradis.docxDiff', "Word 差分")),
	[new SyncDescriptor(ParadisDocxDiffInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_DOCX_INPUT_TYPE_ID,
	ParadisDocxInputSerializer
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_DOCX_DIFF_INPUT_TYPE_ID,
	ParadisDocxDiffInputSerializer
);

// 差分の旧版は git: スキーム(git拡張のreadonly FSプロバイダ)で渡ってくるため、canSupportResource で許可する必要がある。
// これが無いと editorResolverService が「両サイドが同じ editor に解決されない」と判断し、
// createDiffEditorInput は一度も呼ばれずに標準のバイナリ差分へフォールバックする。
const SUPPORTED_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote, 'git']);

class ParadisDocxViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.docxViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const ext of PARADIS_DOCX_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_DOCX_EDITOR_ID,
					label: DOCX_LABEL,
					// exclusive: バイナリ(.docx)を常にビューアで開く(PDF ビューアと同じ扱い)。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					canSupportResource: resource => SUPPORTED_SCHEMES.has(resource.scheme) && isParadisDocxResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisDocxInput, resource),
						options
					}),
					createDiffEditorInput: diffEditorInput => {
						const original = diffEditorInput.original.resource;
						const modified = diffEditorInput.modified.resource;
						if (!original || !modified) {
							throw new Error('Para Code docx diff requires both original and modified resources');
						}
						return {
							editor: instantiationService.createInstance(ParadisDocxDiffInput, original, modified, diffEditorInput.label)
						};
					}
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisDocxViewerResolverContribution.ID, ParadisDocxViewerResolverContribution, WorkbenchPhase.BlockStartup);
