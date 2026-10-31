/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓で、本家の Copilot のエージェントホスト（接続先で動く utility process と copilot-runtime）を
// 既定で起動しない。
//
// SSH の窓の IAgentHostService（EditorRemoteAgentHostServiceClient）は、IAgentHostEnablementService の
// enabled が true になると接続先へつなぎに行き、接続先のサーバーはそれを受けて初めてエージェントホストを
// 起動する（serverServices.ts の startMode: 'lazy'）。そこで enabled の元になる「この窓でエージェントホストを
// 動かせるか」を、SSH の窓では fork の設定で決める。upstream のファイルは触らず、
// 同じインターフェースの実装を後から registerSingleton して差し替える（登録は electron-browser 側）。
//
// upstream の enabled はコンストラクタで受けた真偽値から作られ、後から変えられない。
// そのため設定の変更は、窓を再読み込みしたときに効く（設定の説明にもそう書いている）。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AgentHostEnablementService } from '../../../../platform/agentHost/browser/agentHostEnablementService.js';
import { IManagedSettingsService } from '../../../../platform/policy/common/copilotManagedSettings.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING } from './paradisRemoteCopilotSettings.contribution.js';

/**
 * この窓でエージェントホストを動かしてよいか。
 *
 * SSH の窓（`ssh-remote+<host>`）だけを設定で絞る。手元の窓と、WSL・コンテナなど SSH 以外の
 * リモートは upstream のまま（本家の AI 機能の設定だけで決まる）。
 */
export function paradisAgentHostAllowedInWindow(remoteAuthority: string | undefined, enabledInSsh: boolean): boolean {
	if (remoteAuthority?.startsWith('ssh-remote+')) {
		return enabledInSsh;
	}
	return true;
}

/** upstream の BrowserAgentHostEnablementService の代わりに使う。SSH の窓では fork の設定も見る。 */
export class ParadisAgentHostEnablementService extends AgentHostEnablementService {
	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IManagedSettingsService managedSettingsService: IManagedSettingsService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super(
			paradisAgentHostAllowedInWindow(environmentService.remoteAuthority, configurationService.getValue<boolean>(PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING) === true),
			configurationService,
			contextKeyService,
			managedSettingsService,
		);
	}
}
