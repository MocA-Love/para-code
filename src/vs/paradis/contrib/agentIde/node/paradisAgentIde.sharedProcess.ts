/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で IDE 操作ツール（O1）とスキルの設置（O4）を立ち上げる。
// `paradis.sharedProcess.contribution.ts` から副作用 import される。

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING,
	PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING,
	PARADIS_AGENT_IDE_SKILLS_CHANNEL,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
} from '../common/paradisAgentIde.js';
import { ParadisAgentIdeSkillsChannel, paradisAgentIdeSkillTargets } from './paradisAgentIdeSkills.js';
import { ParadisAgentIdeToolProvider } from './paradisAgentIdeToolProvider.js';

ParadisSharedProcessContributions.register('agentIde', ({ server, accessor }) => {
	const configurationService = accessor.get(IConfigurationService);
	const logService = accessor.get(ILogService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const store = new DisposableStore();
	// 設定のスキーマは画面側でしか登録されないので、ここでは生の値を読んで既定（オフ・同じスペース）へ倒す
	const provider = new ParadisAgentIdeToolProvider({
		actionsEnabled: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING)),
		actionScope: () => paradisAgentIdeActionScope(configurationService.getValue(PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING)),
		readOtherSpaces: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_READ_OTHER_SPACES_SETTING)),
		shellCommands: () => paradisAgentIdeActionsAllowed(configurationService.getValue(PARADIS_AGENT_IDE_ALLOW_SHELL_COMMANDS_SETTING)),
	}, logService);
	store.add(paradisRegisterMcpToolProvider(provider));
	// `CLAUDE_CONFIG_DIR` はログインシェルの環境から読む（スキル管理画面と同じ。GUI 起動の process.env には無いことがある）
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisAgentIdeSkills', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	server.registerChannel(PARADIS_AGENT_IDE_SKILLS_CHANNEL, new ParadisAgentIdeSkillsChannel(async () => paradisAgentIdeSkillTargets(await shellEnv.getEnv())));
	return store;
});
