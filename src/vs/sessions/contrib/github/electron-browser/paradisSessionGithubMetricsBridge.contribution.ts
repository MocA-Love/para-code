/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Agent Sessionsウィンドウ自身のGitHub API呼び出し（sessionGithubRequestGate.ts、browser層）を
// GitHub API Usageダッシュボード（src/vs/paradis/contrib/githubMetrics、shared process側）へ転送する橋渡し。
// sessionGithubRequestGate.ts は renderer(browser層)なので shared process の callLog を直接叩けない。
// electron-browser層のこのcontributionだけが ISharedProcessService を持てるため、
// paradisSetGithubCallTransport() でIPC転送関数を差し込む（web版Agent Sessionsではこのファイルが
// ロードされないため、転送先未設定のまま=no-opになる。paradisRecordRemoteGithubCall側で安全に処理される）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisGithubCallEvent,
	paradisSetGithubCallTransport,
	PARADIS_GITHUB_METRICS_CHANNEL,
} from '../../../../paradis/contrib/githubMetrics/common/paradisGithubMetrics.js';

export class ParadisSessionGithubMetricsBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.sessionGithubMetricsBridge';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
	) {
		super();

		// 転送先は常に手元の shared process にする。Agent Sessions ウィンドウの GitHub API 呼び出しは
		// 接続先ではなくこのマシンから出ていくので、記録もこのマシンに置くのが実態に合う。
		// 割り切りとして、SSH 接続中のウィンドウのダッシュボードは接続先の集計を見るため、
		// ここで記録した分はそちらには出てこない(両方を足すには集計のマージが要る)。
		const channel = sharedProcessService.getChannel(PARADIS_GITHUB_METRICS_CHANNEL);
		paradisSetGithubCallTransport((event: IParadisGithubCallEvent) => {
			channel.call('recordCall', [event]).catch(() => {
				// 計測の欠落はダッシュボードの精度が下がるだけなので、失敗を握りつぶす
			});
		});
		this._register({ dispose: () => paradisSetGithubCallTransport(undefined) });
	}
}

registerWorkbenchContribution2(ParadisSessionGithubMetricsBridge.ID, ParadisSessionGithubMetricsBridge, WorkbenchPhase.AfterRestored);
