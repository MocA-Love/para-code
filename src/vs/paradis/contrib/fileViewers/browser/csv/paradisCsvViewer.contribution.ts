/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV / TSV ビューア（web/desktop 両対応）の登録入り口。paradis.common.contribution.ts から import される。
// EditorPane / シリアライザ / 設定 / EditorResolver をここで登録する。
//
// 差分とマージは登録しない（createDiffEditorInput / createMergeEditorInput を持たない）ので、resolver が
// このビューアを飛ばして従来どおりテキストの差分・マージエディタで開く。

import { Schemas } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { paradisGlobForExtension } from '../paradisFileViewers.js';
import { ParadisCsvFileEditor } from './paradisCsvFileEditor.js';
import {
	isParadisCsvResource,
	isParadisCsvTextModePreferred,
	PARADIS_CSV_EDITOR_ID,
	PARADIS_CSV_EXTENSIONS,
	PARADIS_CSV_INPUT_TYPE_ID,
	PARADIS_CSV_VIEWER_ENABLED_KEY,
	ParadisCsvFileInput,
	ParadisCsvFileInputSerializer,
} from './paradisCsvFileInput.js';

const CSV_VIEWER_LABEL = localize('paradis.csvViewer', "CSV の表");

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_CSV_VIEWER_ENABLED_KEY]: {
			type: 'boolean',
			default: true,
			description: localize('paradis.csvViewer.enabled', "CSV / TSV ファイルを表で開きます。オフにすると従来どおりテキストエディタで開きます。表示中の「表 | テキスト」でいつでも切り替えられ、テキストを選んだファイルは次もテキストで開きます。"),
		},
	},
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisCsvFileEditor, PARADIS_CSV_EDITOR_ID, CSV_VIEWER_LABEL),
	[new SyncDescriptor(ParadisCsvFileInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_CSV_INPUT_TYPE_ID,
	ParadisCsvFileInputSerializer
);

const SUPPORTED_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote]);

class ParadisCsvViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.csvViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
	) {
		for (const ext of PARADIS_CSV_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(ext),
				{
					id: PARADIS_CSV_EDITOR_ID,
					label: CSV_VIEWER_LABEL,
					// exclusive: 他の fork ビューア（Markdown / Excel）と同じく、拡張機能の custom editor や
					// 残っている editorAssociations より確実に優先させる。テキストに戻したい場合は設定で切る。
					priority: RegisteredEditorPriority.exclusive
				},
				{
					canSupportResource: resource =>
						SUPPORTED_SCHEMES.has(resource.scheme)
						&& isParadisCsvResource(resource)
						&& configurationService.getValue<boolean>(PARADIS_CSV_VIEWER_ENABLED_KEY) !== false,
					singlePerResource: true
				},
				{
					createEditorInput: ({ resource, options }) => {
						const input = instantiationService.createInstance(ParadisCsvFileInput, resource);
						if (isParadisCsvTextModePreferred(storageService, resource)) {
							input.setCsvViewMode('text');
						}
						return { editor: input, options };
					}
				}
			);
		}
	}
}

registerWorkbenchContribution2(ParadisCsvViewerResolverContribution.ID, ParadisCsvViewerResolverContribution, WorkbenchPhase.BlockStartup);
