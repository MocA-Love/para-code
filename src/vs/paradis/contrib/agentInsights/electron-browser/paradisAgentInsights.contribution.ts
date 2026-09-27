/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
import { IParadisAgentInsightsService, IParadisAgentPaneInsightSource } from '../common/paradisAgentInsights.js';

/** 変化の知らせを取りこぼしたときの保険。知らせが届いていれば、これより早く更新される。 */
const SAFETY_REFRESH_INTERVAL = 10_000;
/** 知らせやペインの増減をまとめる間隔。 */
const REFRESH_DELAY = 150;

/**
 * shared process のモバイル中継が読んでいるペインの様子（サブエージェント・最後の発言・
 * 待っている内容・プロンプトキャッシュ）を、このウィンドウのペインの分だけ取ってきて
 * {@link IParadisAgentInsightsService} へ書き込む。
 *
 * 取得先はモバイル中継のチャネルだが、読むだけでモバイルへは何も送らない。モバイル連携を
 * 無効にしていても中継サービス自体は shared process で動いているので、そのまま引ける。
 */
class ParadisAgentInsightsPoller extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentInsightsPoller';

	private readonly source: IParadisAgentPaneInsightSource;
	private readonly refreshScheduler: RunOnceScheduler;
	private generation = 0;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentInsightsService private readonly insightsService: IParadisAgentInsightsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.source = ProxyChannel.toService<IParadisAgentPaneInsightSource>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this.refreshScheduler = this._register(new RunOnceScheduler(() => this.refresh(), REFRESH_DELAY));
		this._register(this.source.onDidChangeAgentPaneInsights(() => this.refreshScheduler.schedule()));
		this._register(this.paneTokenService.onDidChange(() => this.refreshScheduler.schedule()));
		const safety = this._register(new IntervalTimer());
		safety.cancelAndSet(() => this.refreshScheduler.schedule(), SAFETY_REFRESH_INTERVAL);
		this.refreshScheduler.schedule();
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		const tokens = this.paneTokenService.listPaneTokens().map(entry => entry.token);
		try {
			const insights = tokens.length > 0 ? await this.source.getAgentPaneInsights(tokens) : [];
			// 取りに行っている間に次の取得が始まっていたら、古い結果で上書きしない。
			if (generation === this.generation && !this._store.isDisposed) {
				this.insightsService.setInsights(insights);
			}
		} catch (error) {
			this.logService.trace('[paradisAgentInsights] refresh failed', String(error));
		}
	}
}

registerWorkbenchContribution2(ParadisAgentInsightsPoller.ID, ParadisAgentInsightsPoller, WorkbenchPhase.AfterRestored);
