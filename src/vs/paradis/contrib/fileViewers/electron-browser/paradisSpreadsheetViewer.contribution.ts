/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分(Electron/shared process 依存)の登録入り口。paradis.electron-browser.contribution.ts から import。
// 通常オープン(createEditorInput)と SCM の差分オープン(createDiffEditorInput)の両方を横取りする。
// 差分は VS Code 標準の DiffEditor(テキスト前提)では扱えないため、独自の差分 EditorPane に載せ替える。

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import { ParadisSpreadsheetEditor } from './paradisSpreadsheetEditor.js';
import { ParadisSpreadsheetDiffEditor } from './paradisSpreadsheetDiffEditor.js';
import {
	ParadisSpreadsheetDiffInput,
	ParadisSpreadsheetDiffInputSerializer,
	ParadisSpreadsheetInput,
	ParadisSpreadsheetInputSerializer,
} from './paradisSpreadsheetInput.js';
import {
	PARADIS_SPREADSHEET_DIFF_EDITOR_ID,
	PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID,
	PARADIS_SPREADSHEET_EDITOR_ID,
	PARADIS_SPREADSHEET_EXTENSIONS,
	PARADIS_SPREADSHEET_INPUT_TYPE_ID,
	isParadisSpreadsheetResource,
	paradisGlobForExtension,
} from '../browser/paradisFileViewers.js';

const SPREADSHEET_LABEL = localize('paradis.spreadsheet', "Spreadsheet");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisSpreadsheetEditor, PARADIS_SPREADSHEET_EDITOR_ID, SPREADSHEET_LABEL),
	[new SyncDescriptor(ParadisSpreadsheetInput)]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisSpreadsheetDiffEditor, PARADIS_SPREADSHEET_DIFF_EDITOR_ID, localize('paradis.spreadsheetDiff', "Spreadsheet Diff")),
	[new SyncDescriptor(ParadisSpreadsheetDiffInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_SPREADSHEET_INPUT_TYPE_ID,
	ParadisSpreadsheetInputSerializer
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID,
	ParadisSpreadsheetDiffInputSerializer
);

// 差分の旧版は git: スキーム(git拡張のreadonly FSプロバイダ)で渡ってくるため、canSupportResource で許可する必要がある。
const SUPPORTED_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote, 'git']);

class ParadisSpreadsheetViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.spreadsheetViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const ext of PARADIS_SPREADSHEET_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_SPREADSHEET_EDITOR_ID,
					label: SPREADSHEET_LABEL,
					// exclusive: バイナリ(.xlsx)を常にビューアで開く。差分解決では両サイド(file:/git:)が同一 editor に解決される必要があるため優先度も統一。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					canSupportResource: resource => SUPPORTED_SCHEMES.has(resource.scheme) && isParadisSpreadsheetResource(resource),
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisSpreadsheetInput, resource),
						options
					}),
					createDiffEditorInput: diffEditorInput => {
						const original = diffEditorInput.original.resource;
						const modified = diffEditorInput.modified.resource;
						if (!original || !modified) {
							throw new Error('Paradis spreadsheet diff requires both original and modified resources');
						}
						return {
							editor: instantiationService.createInstance(ParadisSpreadsheetDiffInput, original, modified, diffEditorInput.label)
						};
					}
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisSpreadsheetViewerResolverContribution.ID, ParadisSpreadsheetViewerResolverContribution, WorkbenchPhase.BlockStartup);
