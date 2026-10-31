/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓で本家の Copilot のエージェントホストを動かすかの設定（既定はオフ）。
// 読むのは paradisRemoteCopilotEnablement.ts。デスクトップだけで読み込まれる（paradisRemoteCopilot.contribution.ts から）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** SSH の窓で本家の Copilot のエージェントホストを動かすか。既定はオフ。 */
export const PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING = 'paradis.remote.copilotAgentHost';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			description: localize('paradis.remote.copilotAgentHost', "SSH で接続した窓で、本家の Copilot のエージェント（接続先で動くエージェントホストと Copilot CLI の実行部品）を起動します。本家の AI 機能を止めているときはこの設定に関係なく動かず、本家の AI 機能を使っていても SSH の窓ではこの設定がオンのときだけ動きます。変更は窓を再読み込みすると反映されます。")
		}
	}
});
