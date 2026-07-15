/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';

suite('Paradis editor split configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suiteSetup(async () => {
		(globalThis as typeof globalThis & { MouseEvent: typeof MouseEvent }).MouseEvent ??= class { } as unknown as typeof MouseEvent;
		await import('../../browser/paradisWorkspaceSwitch.contribution.js');
	});

	test('registers openTerminalOnSplit as a default-off window boolean setting', () => {
		const property = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
			.getConfigurationProperties()['paradis.editor.openTerminalOnSplit'];

		assert.ok(property);
		assert.strictEqual(property.type, 'boolean');
		assert.strictEqual(property.default, false);
		assert.strictEqual(property.scope, ConfigurationScope.WINDOW);
	});
});
