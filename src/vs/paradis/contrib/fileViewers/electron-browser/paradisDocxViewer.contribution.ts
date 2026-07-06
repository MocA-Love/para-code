/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)ビューア(vendored docx-preview 依存)の登録入り口。paradis.electron-browser.contribution.ts から import。
// exclusive 登録により、標準のバイナリ警告(BinaryFileEditor)より優先して .docx をレンダリング表示する。
// docx の差分表示は非対応(createDiffEditorInput を登録しないため標準のバイナリ差分にフォールバックする)。

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
import { ParadisDocxInput, ParadisDocxInputSerializer } from './paradisDocxInput.js';
import {
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

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_DOCX_INPUT_TYPE_ID,
	ParadisDocxInputSerializer
);

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
					canSupportResource: resource =>
						(resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) && isParadisDocxResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisDocxInput, resource),
						options
					})
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisDocxViewerResolverContribution.ID, ParadisDocxViewerResolverContribution, WorkbenchPhase.BlockStartup);
