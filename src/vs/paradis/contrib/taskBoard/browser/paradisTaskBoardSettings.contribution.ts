/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの接続口の設定。実体は shared process（taskBoard/node）で、生の値を読む。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING } from '../common/paradisTaskBoardBridge.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_TASK_BOARD_BRIDGE_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.taskBoard.bridge.enabled', "タスクボードが、この PC でエージェントを起動し、質問や許可に答えられるようにします。つなげるのは、Para Code が起動したタスクボードだけです。オフにすると、タスクボードからエージェントを動かせません。"),
		},
	},
});
