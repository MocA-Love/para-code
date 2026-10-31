/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';

suite('Paradis files.watcherExclude defaults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const registeredDefaultsBeforeImport = new Set(configurationRegistry.getRegisteredDefaultConfigurations());
	let standInSchema: IConfigurationNode | undefined;

	suiteSetup(async () => {
		// The upstream schema lives in files.contribution, which cannot be loaded in unit tests
		// (it registers a second file editor factory). The workbench registers it before the Para Code
		// defaults, so register a stand-in object schema first when it is not already present.
		if (!configurationRegistry.getConfigurationProperties()['files.watcherExclude']) {
			standInSchema = {
				id: 'paradisWatcherExcludeTest',
				properties: {
					'files.watcherExclude': {
						type: 'object',
						default: { 'paradis-test-existing/**': true }
					}
				}
			};
			configurationRegistry.registerConfiguration(standInSchema);
		}
		await import('../../browser/paradisWatcherExcludeDefaults.contribution.js');
	});

	suiteTeardown(() => {
		const defaultsAddedByImport = configurationRegistry.getRegisteredDefaultConfigurations()
			.filter(defaultConfiguration => !registeredDefaultsBeforeImport.has(defaultConfiguration));
		configurationRegistry.deregisterDefaultConfigurations(defaultsAddedByImport);
		if (standInSchema) {
			configurationRegistry.deregisterConfigurations([standInSchema]);
		}
	});

	test('keeps the existing defaults and adds node_modules and .venv', () => {
		const property = configurationRegistry.getConfigurationProperties()['files.watcherExclude'];
		const existingDefault = property.defaultDefaultValue as Record<string, boolean>;
		assert.deepStrictEqual({
			hasExistingDefault: Object.keys(existingDefault).length > 0,
			default: property.default,
		}, {
			hasExistingDefault: true,
			default: {
				...existingDefault,
				'**/node_modules/*/**': true,
				'**/.venv/**': true,
			},
		});
	});
});
