/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ChatConfiguration } from '../../../../../workbench/contrib/chat/common/constants.js';
import { MenuSettings, MenuStyleConfiguration } from '../../../../../platform/window/common/window.js';
import '../../browser/paradisDefaultSettings.contribution.js';

suite('Paradis default settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// The overrides are plain strings; an upstream rename would silently turn them into no-ops.
	test('turns off the Copilot CLI command and the signed-out welcome sign-in button by default', () => {
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();
		assert.deepStrictEqual({
			copilotCliCommand: overrides.get(ChatConfiguration.CopilotCliCommandEnabled)?.value,
			welcomePageSignIn: overrides.get(ChatConfiguration.WelcomePageSignInEnabled)?.value,
		}, {
			copilotCliCommand: false,
			welcomePageSignIn: false,
		});
	});

	// macOS stable defaults to native menus upstream, which hide the theme colors and the fork's menu icons.
	// Other platforms keep upstream's default (inherit), so a native title bar keeps its native menu bar.
	test('draws the in-app menus with the theme by default on macOS only', () => {
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();
		assert.strictEqual(overrides.get(MenuSettings.MenuStyle)?.value, isMacintosh ? MenuStyleConfiguration.CUSTOM : undefined);
	});
});
