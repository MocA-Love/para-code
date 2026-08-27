/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Schemas } from '../../../../base/common/network.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import type { IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import {
	PARADIS_OFFICE_CONFIGURATION_PROPERTIES,
	snapshotParadisOfficeRuntimeConfiguration,
	type ParadisOfficeConfigurationReader,
	type ParadisOfficeRuntimeConfiguration,
} from '../common/paradisOfficeCapabilities.js';
import {
	PARADIS_DOCX_DIFF_EDITOR_ID,
	PARADIS_DOCX_DIFF_INPUT_TYPE_ID,
	PARADIS_DOCX_EDITOR_ID,
	PARADIS_DOCX_EXTENSIONS,
	PARADIS_DOCX_INPUT_TYPE_ID,
	PARADIS_OFFICE_BROWSER_EDITOR_ID,
	PARADIS_OFFICE_BROWSER_INPUT_TYPE_ID,
	PARADIS_OFFICE_SEMANTIC_EXTENSIONS,
	PARADIS_SPREADSHEET_DIFF_EDITOR_ID,
	PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID,
	PARADIS_SPREADSHEET_EDITOR_ID,
	PARADIS_SPREADSHEET_EXTENSIONS,
	PARADIS_SPREADSHEET_INPUT_TYPE_ID,
	type ParadisOfficeSemanticFormat,
} from './paradisFileViewers.js';

export const PARADIS_SPREADSHEET_VIEWER_REGISTRATION = Object.freeze({
	extensions: PARADIS_SPREADSHEET_EXTENSIONS,
	schemes: [Schemas.file, Schemas.vscodeRemote, 'git'] as const,
	editorId: PARADIS_SPREADSHEET_EDITOR_ID,
	diffEditorId: PARADIS_SPREADSHEET_DIFF_EDITOR_ID,
	inputTypeId: PARADIS_SPREADSHEET_INPUT_TYPE_ID,
	diffInputTypeId: PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID,
});

export const PARADIS_DOCX_VIEWER_REGISTRATION = Object.freeze({
	extensions: PARADIS_DOCX_EXTENSIONS,
	schemes: [Schemas.file, Schemas.vscodeRemote, 'git'] as const,
	editorId: PARADIS_DOCX_EDITOR_ID,
	diffEditorId: PARADIS_DOCX_DIFF_EDITOR_ID,
	inputTypeId: PARADIS_DOCX_INPUT_TYPE_ID,
	diffInputTypeId: PARADIS_DOCX_DIFF_INPUT_TYPE_ID,
});

export const PARADIS_OFFICE_BROWSER_VIEWER_REGISTRATION = Object.freeze({
	extensions: PARADIS_OFFICE_SEMANTIC_EXTENSIONS,
	schemes: [Schemas.file, Schemas.vscodeRemote, 'git'] as const,
	editorId: PARADIS_OFFICE_BROWSER_EDITOR_ID,
	inputTypeId: PARADIS_OFFICE_BROWSER_INPUT_TYPE_ID,
});

export type ParadisOfficeSerializerRegistration = readonly [
	inputTypeId: string,
	serializer: Parameters<IEditorFactoryRegistry['registerEditorSerializer']>[1],
];

/** Keeps stable input IDs and their serializer constructors paired at the registration boundary. */
export function registerParadisOfficeViewerSerializers(
	registry: Pick<IEditorFactoryRegistry, 'registerEditorSerializer'>,
	registrations: readonly ParadisOfficeSerializerRegistration[],
): void {
	for (const [inputTypeId, serializer] of registrations) {
		registry.registerEditorSerializer(inputTypeId, serializer);
	}
}

/** Captures configuration at the contribution boundary so later setting changes affect only new opens. */
export function snapshotParadisOfficeContributionConfiguration(configurationService: IConfigurationService): ParadisOfficeRuntimeConfiguration {
	const reader: ParadisOfficeConfigurationReader = {
		getValue: <T>(key: string) => configurationService.getValue<T>(key),
		inspect: <T>(key: string) => configurationService.inspect<T>(key) as IConfigurationValue<T> | undefined,
	};
	return snapshotParadisOfficeRuntimeConfiguration(reader);
}

export function selectParadisOfficeBrowserInputMode(
	configuration: ParadisOfficeRuntimeConfiguration,
	format: ParadisOfficeSemanticFormat,
): 'semantic' | 'diagnostic' {
	if (!configuration.platformBackend) {
		return 'diagnostic';
	}
	const semanticEnabled = format === 'xlsx' || format === 'xlsm' || format === 'xltx' || format === 'xltm'
		? configuration.semanticSpreadsheet
		: configuration.semanticWord;
	return configuration.engine !== 'legacy' && semanticEnabled ? 'semantic' : 'diagnostic';
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: { ...PARADIS_OFFICE_CONFIGURATION_PROPERTIES },
});
