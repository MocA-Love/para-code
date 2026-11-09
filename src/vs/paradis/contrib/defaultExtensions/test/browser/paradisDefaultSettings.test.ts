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
import { template } from '../../../../../base/common/labels.js';
import { PARADIS_WINDOW_TITLE, PARADIS_WINDOW_TITLE_MAC } from '../../browser/paradisDefaultSettings.contribution.js';

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

	// Quick input moved to the upper middle of the window (Q593), so the command center is off and the
	// window title shows what it used to show. In SSH windows ${rootName} already carries "[SSH: host]"
	// (the remote extension's workspaceSuffix), so the title must not add ${remoteName} on top of it.
	test('hides the command center and leads the window title with the workspace name, without repeating the remote host', () => {
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();
		const render = (titleTemplate: string, rootName: string, profileName: string) => template(titleTemplate, {
			rootName, profileName, appName: 'Para Code', activeEditorShort: 'file.ts', remoteName: 'SSH: example-host', separator: { label: ' - ' }
		});
		assert.deepStrictEqual({
			commandCenter: overrides.get('window.commandCenter')?.value,
			titleIsOneOfOurs: [PARADIS_WINDOW_TITLE_MAC, PARADIS_WINDOW_TITLE].includes(overrides.get('window.title')?.value as string),
			macLocal: render(PARADIS_WINDOW_TITLE_MAC, 'para (Workspace)', ''),
			macSsh: render(PARADIS_WINDOW_TITLE_MAC, 'para (Workspace) [SSH: example-host]', ''),
			macProfile: render(PARADIS_WINDOW_TITLE_MAC, 'para (Workspace)', 'Work'),
			otherSsh: render(PARADIS_WINDOW_TITLE, 'para (Workspace) [SSH: example-host]', ''),
		}, {
			commandCenter: false,
			titleIsOneOfOurs: true,
			macLocal: 'para (Workspace)',
			macSsh: 'para (Workspace) [SSH: example-host]',
			macProfile: 'para (Workspace) - Work',
			otherSsh: 'para (Workspace) [SSH: example-host] - Para Code',
		});
	});
});
