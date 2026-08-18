/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';

export const PARADIS_REMOTE_AGENT_TUNNEL_SETTING = 'paradis.remote.agentReturnTunnel';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_REMOTE_AGENT_TUNNEL_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			description: localize('paradis.remote.agentReturnTunnel', "SSH で接続したとき、接続先で動くエージェントが手元の Para Code へ通知を返せるように経路を開きます。オフにすると、接続先への通知 hook / MCP 設定の設置ごと行われなくなり、実行状態のドットやモバイルのチャットミラーが出ません。")
		}
	}
});

/** SSH 接続先の戻りトンネルを shared process に開閉させる。 */
export class ParadisRemoteAgentTunnelController extends Disposable {

	constructor(
		remoteAuthority: string | undefined,
		enabled: boolean,
		private readonly channel: IChannel,
		private readonly logService: Pick<ILogService, 'info' | 'warn'>,
	) {
		super();
		if (!enabled || remoteAuthority === undefined || !remoteAuthority.startsWith('ssh-remote+')) {
			return;
		}
		const ensure = this.ensure(remoteAuthority);
		this._register(this.toDisposeTunnel(remoteAuthority, ensure));
	}

	private async ensure(remoteAuthority: string): Promise<void> {
		try {
			const port = await this.channel.call<number | undefined>('ensureRemoteAgentTunnel', [remoteAuthority]);
			this.logService.info(`[paradis] return tunnel for ${remoteAuthority}: ${port !== undefined ? `opened (port ${port})` : 'not available'}`);
		} catch (error) {
			this.logService.warn('[paradis] could not request the agent return tunnel', error);
		}
	}

	private toDisposeTunnel(remoteAuthority: string, ensure: Promise<void>) {
		return {
			dispose: () => {
				void ensure.then(() => this.channel.call('closeRemoteAgentTunnel', [remoteAuthority]))
					.catch(() => { /* 終了時なので届かなくてよい */ });
			}
		};
	}
}

/**
 * SSH 接続中のウィンドウで、接続先から手元のゲートウェイへ戻る経路を用意する。
 *
 * エージェントCLIの hook（実行状態のドット、モバイルのチャットミラー）も para-browser MCP も、
 * 手元の shared process が 127.0.0.1 で待つ HTTP を叩く作り。接続中はエージェントが接続先で
 * 動くのでその 127.0.0.1 は接続先自身を指してしまい、何も届かない。
 *
 * 実際に ssh を起こすのは shared process 側（renderer から子プロセスは作れない）。ここは
 * 「今どこへ繋がっているか」を伝えるだけに徹する。
 */
class ParadisRemoteAgentTunnel extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteAgentTunnel';

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const remoteAuthority = this.environmentService.remoteAuthority;
		if (remoteAuthority === undefined) {
			return;
		}
		this._register(new ParadisRemoteAgentTunnelController(
			remoteAuthority,
			this.configurationService.getValue<boolean>(PARADIS_REMOTE_AGENT_TUNNEL_SETTING),
			this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL),
			this.logService,
		));
	}
}

registerWorkbenchContribution2(ParadisRemoteAgentTunnel.ID, ParadisRemoteAgentTunnel, WorkbenchPhase.AfterRestored);
