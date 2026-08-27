/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import {
	PARADIS_OFFICE_BROWSER_EDITOR_ID,
	PARADIS_OFFICE_SEMANTIC_EXTENSIONS,
	getParadisOfficeFormat,
	paradisGlobForExtension,
	type ParadisOfficeSemanticFormat,
} from './paradisFileViewers.js';
import { ParadisOfficeDiagnosticInput } from './paradisOfficeDiagnosticInput.js';

const OFFICE_BROWSER_LABEL = localize('paradis.office.browser.label', "Office Viewer");
const SUPPORTED_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote, 'git']);

function semanticFormat(resource: import('../../../../base/common/uri.js').URI): ParadisOfficeSemanticFormat | undefined {
	const format = getParadisOfficeFormat(resource);
	return format === 'xlsx' || format === 'xlsm' || format === 'xltx' || format === 'xltm'
		|| format === 'docx' || format === 'docm' || format === 'dotx' || format === 'dotm'
		? format
		: undefined;
}

export class ParadisOfficeBrowserViewerResolverContribution implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.officeBrowserViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		for (const extension of PARADIS_OFFICE_SEMANTIC_EXTENSIONS) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(extension),
				{ id: PARADIS_OFFICE_BROWSER_EDITOR_ID, label: OFFICE_BROWSER_LABEL, priority: RegisteredEditorPriority.exclusive },
				{
					canSupportResource: resource => SUPPORTED_SCHEMES.has(resource.scheme) && semanticFormat(resource) !== undefined,
					singlePerResource: true,
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(ParadisOfficeDiagnosticInput, resource, semanticFormat(resource)!, 'semantic'),
						options,
					}),
					createDiffEditorInput: diffInput => {
						const original = diffInput.original.resource;
						const modified = diffInput.modified.resource;
						if (!original || !modified) {
							throw new Error('Para Code Office diff requires both original and modified resources');
						}
						return {
							editor: instantiationService.createInstance(
								ParadisOfficeDiagnosticInput,
								modified,
								semanticFormat(modified)!,
								'semantic',
								original,
								diffInput.label,
							),
						};
					},
				},
			);
		}
	}
}

registerWorkbenchContribution2(ParadisOfficeBrowserViewerResolverContribution.ID, ParadisOfficeBrowserViewerResolverContribution, WorkbenchPhase.BlockStartup);
