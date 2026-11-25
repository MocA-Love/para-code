/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインでエージェント（Claude Code・Codex）が起動されたら、そのコマンド行とシェルの pid を、ターミナルのあるマシン
// （手元なら shared process、SSH の窓なら REH サーバー）へ知らせて、会話ごとの台帳に控えさせる。
//
// 知らせるのは、hook がそのペインの会話 ID を報告したとき（状態スナップショットの paneSessions）。起動した時点では
// 会話 ID がまだ無い。`/clear` や分岐で ID が替わったら、その ID でもう一度知らせる。コマンド行はシェル統合が報告した
// 実行中のコマンドで、利用者が手で打った起動も Para Code が打ち込んだ起動も同じ経路で届く。シェル統合の無いペインは
// コマンド行が分からないので控えない。許可リストで絞るのは受けた側（paradisAgentLaunchLedger.ts）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentPaneSession } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { paradisAgentLaunchesToRecord } from '../common/paradisAgentLaunchProfile.js';
import { PARADIS_SESSION_RESUME_CHANNEL } from '../common/paradisSessionResume.js';

class ParadisAgentLaunchCapture extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentLaunchCapture';

	/** 知らせ済みの `ペイントークン\n会話 ID`。 */
	private readonly sent = new Set<string>();

	constructor(
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this.record(outcome.snapshot.paneSessions ?? []);
			}
		}));
	}

	private record(sessions: readonly IParadisAgentPaneSession[]): void {
		const launches = paradisAgentLaunchesToRecord(sessions, this.sent, token => {
			const instanceId = this.paneTokenService.getInstanceForToken(token);
			const instance = instanceId === undefined ? undefined : this.terminalService.getInstanceFromId(instanceId);
			return instance === undefined ? undefined : {
				commandLine: instance.capabilities.get(TerminalCapability.CommandDetection)?.executingCommand,
				shellPid: instance.processId,
				remote: instance.remoteAuthority !== undefined,
			};
		});
		for (const { remote, ...request } of launches) {
			const channel: IChannel | undefined = remote
				? this.remoteAgentService.getConnection()?.getChannel(PARADIS_SESSION_RESUME_CHANNEL)
				: this.sharedProcessService.getChannel(PARADIS_SESSION_RESUME_CHANNEL);
			// 古い REH サーバーにはこの口が無い。控えられないだけで、再開は従来どおりのコマンドになる
			channel?.call('recordAgentLaunch', [request]).catch(error => this.logService.debug('[ParadisAgentLaunchCapture] could not record the agent launch', error));
		}
	}
}

registerWorkbenchContribution2(ParadisAgentLaunchCapture.ID, ParadisAgentLaunchCapture, WorkbenchPhase.AfterRestored);
