/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF ビューア(vendored pdf.js 依存)の登録入り口。paradis.electron-browser.contribution.ts から import。
// exclusive 登録により、標準のバイナリ警告(BinaryFileEditor)より優先して PDF をレンダリング表示する。
// PDF の差分表示は非対応(createDiffEditorInput を登録しないため標準のバイナリ差分にフォールバックする)。

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { ParadisPdfFileEditor } from './paradisPdfFileEditor.js';
import { ParadisPdfInput, ParadisPdfInputSerializer } from './paradisPdfInput.js';
import {
	PARADIS_PDF_EDITOR_ID,
	PARADIS_PDF_EXTENSIONS,
	PARADIS_PDF_INPUT_TYPE_ID,
	isParadisPdfResource,
	paradisGlobForExtension,
} from '../browser/paradisFileViewers.js';

// allow-any-unicode-next-line
const PDF_LABEL = localize('paradis.pdfPreview', "PDF プレビュー");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisPdfFileEditor, PARADIS_PDF_EDITOR_ID, PDF_LABEL),
	[new SyncDescriptor(ParadisPdfInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_PDF_INPUT_TYPE_ID,
	ParadisPdfInputSerializer
);

class ParadisPdfViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.pdfViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const ext of PARADIS_PDF_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_PDF_EDITOR_ID,
					label: PDF_LABEL,
					// exclusive: バイナリ(.pdf)を常にビューアで開く(Excel ビューアと同じ扱い)。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					canSupportResource: resource =>
						(resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) && isParadisPdfResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisPdfInput, resource),
						options
					})
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisPdfViewerResolverContribution.ID, ParadisPdfViewerResolverContribution, WorkbenchPhase.BlockStartup);
