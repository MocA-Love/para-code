/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 休止（G-03）の設定。読むのは terminalResumeBanner の contribution（electron-browser）。

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PARADIS_AGENT_HIBERNATION_DEFAULT_IDLE_MINUTES, PARADIS_AGENT_HIBERNATION_ENABLED_SETTING, PARADIS_AGENT_HIBERNATION_IDLE_MINUTES_SETTING, PARADIS_AGENT_HIBERNATION_MAX_IDLE_MINUTES, PARADIS_AGENT_HIBERNATION_MIN_IDLE_MINUTES } from '../common/paradisAgentHibernation.js';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_AGENT_HIBERNATION_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			tags: ['experimental'],
			markdownDescription: localize('paradis.agentHibernation.enabled', "（試験的）作業を終えて放ってある Claude Code・Codex を、`#paradis.agentHibernation.idleMinutes#` の分だけたったら止めてメモリを空けます。タブはそのまま残り、タブを開くと同じ会話で自動的に再開します。作業中・許可待ち・質問中のもの、SSH の窓のもの、タスクボードのものは止めません。")
		},
		[PARADIS_AGENT_HIBERNATION_IDLE_MINUTES_SETTING]: {
			type: 'number',
			default: PARADIS_AGENT_HIBERNATION_DEFAULT_IDLE_MINUTES,
			minimum: PARADIS_AGENT_HIBERNATION_MIN_IDLE_MINUTES,
			maximum: PARADIS_AGENT_HIBERNATION_MAX_IDLE_MINUTES,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('paradis.agentHibernation.idleMinutes', "作業を終えてから止めるまでの分（1〜1440）。タブを見たり入力したりすると、そこから数え直します。")
		}
	}
});
