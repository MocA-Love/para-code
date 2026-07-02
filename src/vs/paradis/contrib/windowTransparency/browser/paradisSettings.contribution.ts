/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// Paradis独自設定の集約セクション。将来的にこのセクションへ他のParadis独自設定も追加していく想定のため、
// title/id は共通の 'paradis' とし、各機能はプロパティのプレフィックス（例: paradis.window.*）で区別する。
const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Paradis"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		'paradis.window.transparency.enabled': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.window.transparency.enabled', "Controls whether the workbench background is made translucent so the desktop shows through. Only the workbench chrome (editor, side bar, panel, title bar, etc.) becomes translucent; dialogs, menus and notifications stay opaque. The integrated terminal renders on a GPU surface and stays opaque. Changing this requires reloading the window to take effect.")
		},
		'paradis.window.transparency.opacity': {
			type: 'number',
			default: 0.9,
			minimum: 0.3,
			maximum: 1,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('paradis.window.transparency.opacity', "Controls the opacity of the workbench background when {0} is enabled. Accepts any decimal between `0.3` and `1` (for example `0.95`) for fine-grained control; values closer to `1` are more opaque. Only backgrounds are affected, so text stays fully readable. Changes apply immediately without reloading.", '`#paradis.window.transparency.enabled#`')
		}
	}
});
