/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH などで繋いだ先のペインで動く OpenCode 互換 CLI の名乗りを、接続先で確かめる側。
//
// hook は接続先から手元の shared process へ届くが、名乗った pid の実行ファイル（/proc/<pid>/exe）と DB の場所を
// 確かめられるのは接続先のマシンだけ。shared process には接続先へ繋ぐ口が無いので、接続先に繋いでいるこのウィンドウが
// 頼みを取りに行き、接続先の REH サーバーのセッション履歴のチャネル（verifyOpenCodeCli）で確かめて、結果を返す。
// 書き込みはしない（確かめるだけ）。

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_SESSION_RESUME_CHANNEL } from '../common/paradisSessionResume.js';

/** 頼みを取りに行く間隔。名乗りは会話を始めたときに 1 回なので、数秒遅れても困らない。 */
const POLL_INTERVAL_MS = 2000;

interface IVerificationRequest {
	readonly id: string;
	readonly pid: number;
	readonly command: string;
	readonly databasePath?: string;
}

class ParadisRemoteOpenCodeCliVerifier extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'paradis.remoteOpenCodeCliVerifier';

	private running = false;

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const authority = environmentService.remoteAuthority;
		if (authority === undefined) {
			return;
		}
		this._register(disposableWindowInterval(mainWindow, () => { void this.verify(authority.toLowerCase()); }, POLL_INTERVAL_MS));
	}

	private async verify(authority: string): Promise<void> {
		const connection = this.remoteAgentService.getConnection();
		if (this.running || connection === null || connection.remoteAuthority.toLowerCase() !== authority) {
			return;
		}
		this.running = true;
		try {
			const sharedChannel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			const requests = await sharedChannel.call<readonly IVerificationRequest[]>('takeOpenCodeCliVerifications', [authority]);
			for (const request of requests.slice(0, 8)) {
				const result = await connection.getChannel(PARADIS_SESSION_RESUME_CHANNEL)
					.call<unknown>('verifyOpenCodeCli', [{ pid: request.pid, command: request.command, ...(request.databasePath !== undefined ? { databasePath: request.databasePath } : {}) }])
					.catch(() => undefined);
				await sharedChannel.call('reportOpenCodeCliVerification', [request.id, result ?? null]);
			}
		} catch (error) {
			this.logService.trace('[ParadisRemoteOpenCodeCliVerifier] verification failed', error);
		} finally {
			this.running = false;
		}
	}
}

registerWorkbenchContribution2(ParadisRemoteOpenCodeCliVerifier.ID, ParadisRemoteOpenCodeCliVerifier, WorkbenchPhase.AfterRestored);
