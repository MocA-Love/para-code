/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// このウィンドウのペインについて、通知の台帳と手元の様子を突き合わせる係。
//
// - 開いているペインを台帳へ知らせる（件数は開いているペインだけを数えるため）
// - ペインの状態を台帳へ知らせる（答えた・確認した通知を既読にするため）
// - ペインへフォーカスしたら、そのペインの通知を既読にする
// - 受信箱やメニューバーで行が押され、そのペインがこのウィンドウにあれば移動する

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { paradisRevealNotifiedPane } from '../../notifications/electron-browser/paradisNotificationReveal.js';
import { paradisIsWorkbenchWindowFocused } from '../../workspaceSwitch/browser/paradisWindowFocus.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisInboxPaneStatus, IParadisInboxRevealRequest, IParadisNotificationInboxService, paradisInboxPaneKey } from '../common/paradisNotificationInbox.js';

/** 接続の出入りと食い違ったときの保険。開いているペインをこの間隔でも知らせ直す。 */
const LIVE_PANES_REFRESH_INTERVAL = 30_000;
/** ペインの増減をまとめる間隔。 */
const LIVE_PANES_DELAY = 200;

class ParadisNotificationInboxSync extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisNotificationInboxSync';

	private statusSignature = '';

	constructor(
		@IParadisNotificationInboxService private readonly inboxService: IParadisNotificationInboxService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisAgentStatusSnapshotService snapshotService: IParadisAgentStatusSnapshotService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const livePanes = this._register(new RunOnceScheduler(() => {
			void this.inboxService.setLivePanes(this.paneTokenService.listPaneTokens().map(entry => paradisInboxPaneKey(entry.token)));
		}, LIVE_PANES_DELAY));
		this._register(this.paneTokenService.onDidChange(() => livePanes.schedule()));
		this._register(new IntervalTimer()).cancelAndSet(() => livePanes.schedule(), LIVE_PANES_REFRESH_INTERVAL);
		livePanes.schedule();

		this._register(snapshotService.subscribe(outcome => {
			if (outcome.snapshot !== undefined) {
				this.syncStatuses(outcome.snapshot.paneStatuses);
			}
		}));

		this._register(this.terminalService.onDidFocusInstance(instance => {
			if (!paradisIsWorkbenchWindowFocused()) {
				return;
			}
			const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
			const paneKey = token !== undefined ? paradisInboxPaneKey(token) : undefined;
			if (paneKey !== undefined && this.hasUnread(paneKey)) {
				void this.inboxService.markPanesRead([paneKey]);
			}
		}));

		this._register(this.inboxService.onDidRequestReveal(request => this.reveal(request)));
	}

	private syncStatuses(statuses: readonly { readonly token: string; readonly status: IParadisInboxPaneStatus['status'] }[]): void {
		const statusByToken = new Map(statuses.map(status => [status.token, status.status]));
		// このウィンドウのペインだけ。状態に出てこない（待機中の）ペインは undefined として送る。
		const owned: IParadisInboxPaneStatus[] = this.paneTokenService.listPaneTokens()
			.map(entry => ({ paneKey: paradisInboxPaneKey(entry.token), status: statusByToken.get(entry.token) }))
			.sort((a, b) => a.paneKey.localeCompare(b.paneKey));
		const signature = JSON.stringify(owned);
		if (signature === this.statusSignature) {
			return;
		}
		this.statusSignature = signature;
		void this.inboxService.syncPaneStatuses(owned);
	}

	private hasUnread(paneKey: string): boolean {
		return this.inboxService.snapshot.entries.some(entry => entry.paneKey === paneKey && !entry.read);
	}

	private reveal(request: IParadisInboxRevealRequest): void {
		const token = this.paneTokenService.listPaneTokens().find(entry => paradisInboxPaneKey(entry.token) === request.paneKey)?.token;
		const instanceId = token !== undefined ? this.paneTokenService.getInstanceForToken(token) : undefined;
		if (instanceId === undefined) {
			return; // 別のウィンドウのペイン（そちらのウィンドウが受け取る）
		}
		// スペースは記録した時点から動いていることがある（worktree の付け替えなど）ので引き直す。
		const stateKey = this.terminalScopeService.getStateKeyForInstance(instanceId) ?? request.stateKey;
		paradisRevealNotifiedPane({
			hostService: this.hostService,
			terminalService: this.terminalService,
			workspaceSwitchService: this.workspaceSwitchService,
		}, stateKey, instanceId).catch(error => {
			this.logService.warn('[paradisNotificationInbox] failed to reveal the pane', error);
		});
	}
}

registerWorkbenchContribution2(ParadisNotificationInboxSync.ID, ParadisNotificationInboxSync, WorkbenchPhase.AfterRestored);
