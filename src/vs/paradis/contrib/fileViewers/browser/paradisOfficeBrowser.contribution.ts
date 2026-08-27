/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../workbench/services/editor/common/editorResolverService.js';
import {
	getParadisOfficeFormat,
	paradisGlobForExtension,
	type ParadisOfficeSemanticFormat,
} from './paradisFileViewers.js';
import { ParadisOfficeDiagnosticInput } from './paradisOfficeDiagnosticInput.js';
import { PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION, selectParadisOfficeBrowserInputMode, snapshotParadisOfficeContributionConfiguration } from './paradisOfficeConfiguration.js';

const OFFICE_BROWSER_LABEL = localize('paradis.office.browser.label', "Office Viewer");
const SUPPORTED_SCHEMES = new Set<string>(PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION.schemes);

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
		@IConfigurationService configurationService: IConfigurationService,
	) {
		for (const extension of PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION.extensions) {
			editorResolverService.registerEditor(
				paradisGlobForExtension(extension),
				{ id: PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION.editorId, label: OFFICE_BROWSER_LABEL, priority: RegisteredEditorPriority.exclusive },
				{
					canSupportResource: resource => SUPPORTED_SCHEMES.has(resource.scheme) && semanticFormat(resource) !== undefined,
					singlePerResource: true,
				},
				{
					createEditorInput: ({ resource, options }) => {
						const format = semanticFormat(resource)!;
						const configuration = snapshotParadisOfficeContributionConfiguration(configurationService);
						return {
							editor: instantiationService.createInstance(ParadisOfficeDiagnosticInput, resource, format, selectParadisOfficeBrowserInputMode(configuration, format)),
							options,
						};
					},
					createDiffEditorInput: diffInput => {
						const original = diffInput.original.resource;
						const modified = diffInput.modified.resource;
						if (!original || !modified) {
							throw new Error('Para Code Office diff requires both original and modified resources');
						}
						const format = semanticFormat(modified)!;
						const configuration = snapshotParadisOfficeContributionConfiguration(configurationService);
						return {
							editor: instantiationService.createInstance(
								ParadisOfficeDiagnosticInput,
								modified,
								format,
								selectParadisOfficeBrowserInputMode(configuration, format),
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
