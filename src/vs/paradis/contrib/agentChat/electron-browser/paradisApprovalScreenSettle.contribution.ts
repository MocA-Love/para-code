/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のペインが許可待ちのまま、許可の確認が画面から消えて作業を続けている（ターミナルのキーで答えた）のを
// 見つけ、shared process へ伝える（判断は ParadisApprovalScreenSettle）。状態の取り直し（約 2 秒ごと）のたびに見る。
// 伝える先は 2 つ: 中継の承認（画面で見た承認に答えた印を付ける）と、ペインの状態（許可待ちを作業中へ戻す）。

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshot, PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { PARADIS_MOBILE_RELAY_CHANNEL } from '../../mobileRelay/common/paradisMobileRelay.js';
import { IParadisAgentChatSource } from '../common/paradisAgentChat.js';
import { ParadisAgentChatSession } from '../browser/paradisAgentChatSession.js';
import { IParadisApprovalSettlePane, IParadisApprovalSettleTargets, ParadisApprovalScreenSettle, paradisNotifyApprovalSettlement } from '../browser/paradisApprovalScreenSettle.js';
import { paradisVisibleTerminalText } from '../browser/paradisAgentTuiInput.js';

class ParadisApprovalScreenSettleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.approvalScreenSettle';

	private readonly settle = new ParadisApprovalScreenSettle();
	private readonly source: IParadisAgentChatSource;
	/** 許可待ちのペインの会話の写し（表に出ている承認を読むため。許可待ちでなくなったら捨てる）。 */
	private readonly sessions = this._register(new DisposableMap<string, ParadisAgentChatSession>());
	private checking = false;

	constructor(
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.source = ProxyChannel.toService<IParadisAgentChatSource>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined && !this.checking) {
				this.checking = true;
				this.check(outcome.snapshot)
					.catch(error => this.logService.warn('[paradisApprovalScreenSettle] check failed', error))
					.finally(() => this.checking = false);
			}
		}));
	}

	private async check(snapshot: IParadisAgentStatusSnapshot): Promise<void> {
		// Codex だけ（Claude Code は許可したツールの PostToolUse がすぐ届き、mod の経路もある）
		const codex = new Set((snapshot.paneSessions ?? []).filter(session => session.agent === 'codex').map(session => session.token));
		let instances: readonly ITerminalInstance[] | undefined;
		const waiting = snapshot.paneStatuses.filter(pane => pane.status === 'permission' && codex.has(pane.token)).flatMap(pane => {
			const instanceId = this.paneTokenService.getInstanceForToken(pane.token);
			if (instanceId === undefined) {
				return []; // このウィンドウのペインではない
			}
			instances ??= paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService);
			const instance = instances.find(candidate => candidate.instanceId === instanceId);
			return instance !== undefined ? [{ pane, instance }] : [];
		});
		for (const token of [...this.sessions.keys()]) {
			if (!waiting.some(({ pane }) => pane.token === token)) {
				this.sessions.deleteAndDispose(token);
			}
		}
		const panes: IParadisApprovalSettlePane[] = await Promise.all(waiting.map(async ({ pane, instance }) => {
			let session = this.sessions.get(pane.token);
			if (session === undefined) {
				session = new ParadisAgentChatSession(pane.token, this.source, this.logService);
				this.sessions.set(pane.token, session);
			}
			await session.refresh().catch(error => this.logService.trace('[paradisApprovalScreenSettle] could not read the pending approval', String(error)));
			const interaction = session.state?.interaction;
			// 画面は承認を読んだ後に読む（読んだ承認より古い画面で、その承認を見たことにしない）
			return {
				token: pane.token,
				since: pane.changedAt,
				screen: instance.isDisposed ? undefined : paradisVisibleTerminalText(instance),
				...(interaction?.kind === 'approval' ? { approval: { id: interaction.id, ...(interaction.detail !== undefined ? { detail: interaction.detail } : {}) } } : {}),
			};
		}));
		if (this._store.isDisposed) {
			return;
		}
		const targets: IParadisApprovalSettleTargets = {
			// 古い shared process（口が無い）なら残りが分からないので、残っているとみなす
			settleApprovals: async (token, interactionIds) => await this.source.settleAgentChatApprovalsOffScreen?.(token, interactionIds) ?? true,
			settlePane: (token, since) => this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<boolean>('settlePanePermissionOffScreen', [token, since]),
			onError: (what, error) => this.logService.warn(`[paradisApprovalScreenSettle] could not settle the ${what} answered in the terminal`, error),
		};
		for (const settlement of this.settle.update(panes)) {
			await paradisNotifyApprovalSettlement(settlement, targets);
		}
	}
}

registerWorkbenchContribution2(ParadisApprovalScreenSettleContribution.ID, ParadisApprovalScreenSettleContribution, WorkbenchPhase.AfterRestored);
