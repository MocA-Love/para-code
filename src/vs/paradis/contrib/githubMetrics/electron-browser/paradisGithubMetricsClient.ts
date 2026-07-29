/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の GitHub 利用状況チャネルを呼ぶクライアント。
// 収集・集計は shared process 側が持つので、ここは薄い呼び出しラッパーに留める。

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisGithubMetricsSnapshot, PARADIS_GITHUB_METRICS_CHANNEL } from '../common/paradisGithubMetrics.js';

export const PARADIS_GITHUB_METRICS_SETTING_STATUS_BAR_ENABLED = 'paradis.githubMetrics.statusBar.enabled';

export class ParadisGithubMetricsClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) { }

	/**
	 * 最新のスナップショットを取得する。`force` のときだけレート枠を取り直す
	 * （通常は shared process 側の最短間隔に従う）。
	 */
	getSnapshot(force = false): Promise<IParadisGithubMetricsSnapshot> {
		return this.sharedProcessService
			.getChannel(PARADIS_GITHUB_METRICS_CHANNEL)
			.call<IParadisGithubMetricsSnapshot>('getSnapshot', [{ force }]);
	}
}
