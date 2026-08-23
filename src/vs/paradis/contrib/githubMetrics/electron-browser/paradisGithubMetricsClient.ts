/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から GitHub 利用状況チャネルを呼ぶクライアント。
// 収集・集計はチャネルの向こう側が持つので、ここは薄い呼び出しラッパーに留める。

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisGithubMetricsSnapshot, PARADIS_GITHUB_METRICS_CHANNEL } from '../common/paradisGithubMetrics.js';

export const PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED = 'paradis.githubMetrics.statusBar.enabled';
/** 開いているダッシュボードが自分で取り直す間隔（秒、0 = 手動のみ）。 */
export const PARADIS_GITHUB_METRICS_SETTING_REFRESH_INTERVAL = 'paradis.githubMetrics.refreshIntervalSeconds';

export class ParadisGithubMetricsClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) { }

	/**
	 * 数字を集めているマシン。接続していない間は undefined。
	 *
	 * remoteAuthority は `<種別>+<接続先>` の形なので、種別は一律で落とす。SSH だけを決め打ちで
	 * 剥がすと、WSL(`wsl+Ubuntu`)や dev container(`dev-container+...`)で種別が表に出てしまう。
	 */
	get remoteHostLabel(): string | undefined {
		return this.remoteAgentService.getConnection()?.remoteAuthority.replace(/^[^+]+\+/, '');
	}

	private get channel(): IChannel {
		// SSH で繋いでいる間、Para Code の gh 呼び出しは接続先で走り、記録の受け口も接続先の
		// プロセスにしかない。手元の shared process に聞くとその分がまるごと抜けて0件に見えるため、
		// 繋いでいる先へ聞く（同じチャネルを REH 側にも生やしてある）。レート枠も gh の認証情報も
		// 接続先のものなので、枠の残りも同じ向き先から取るのが筋が通る。
		const remoteConnection = this.remoteAgentService.getConnection();
		if (remoteConnection) {
			return remoteConnection.getChannel(PARADIS_GITHUB_METRICS_CHANNEL);
		}
		return this.sharedProcessService.getChannel(PARADIS_GITHUB_METRICS_CHANNEL);
	}

	/**
	 * 最新のスナップショットを取得する。`force` のときだけレート枠を取り直す
	 * （通常はチャネル側の最短間隔に従う）。
	 */
	getSnapshot(force = false): Promise<IParadisGithubMetricsSnapshot> {
		return this.channel.call<IParadisGithubMetricsSnapshot>('getSnapshot', [{ force }]);
	}
}
