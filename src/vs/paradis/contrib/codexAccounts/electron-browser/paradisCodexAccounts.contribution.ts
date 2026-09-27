/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント切替を、このウィンドウへ反映する。
//
//  - shared process の選択（全ウィンドウ共通）を受けて、新しく開くターミナルへ渡す CODEX_HOME を
//    更新する（paradisCodexLaunchHomeService.ts）
//  - 切り替わったとき、このウィンドウに前のアカウントのまま動いている Codex があれば、通常の通知を
//    1回だけ出す（入力は止めない・再起動もしない。対象は Codex だけ。止めると作業の邪魔になるため）
//
// SSH の接続先を開いているウィンドウでは何もしない（選択はこの PC のホームを指すため）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisCodexLaunchHomeService } from '../browser/paradisCodexLaunchHomeService.js';
import { IParadisCodexAccountsState, IParadisCodexHome, paradisCodexLaunchHomeFor, paradisLooksLikeRunningCodex } from '../common/paradisCodexAccounts.js';
import { ParadisCodexAccountsClient } from './paradisCodexAccountsClient.js';
// 使用量パネルへ差し込む Codex の部品（ParadisLimitsPanelContributions へ登録する副作用 import）。
// パネル側（limitsMonitor）からは読み込まない（差し込み口の依存を一方向に保つ）。
import './paradisCodexAccountActions.js';

/**
 * shared process の選択を、新しく開くターミナルへ渡す CODEX_HOME に反映する。
 *
 * 起動の最初期（BlockStartup）に作り、返事を待たずにすぐ問い合わせる。復元で開き直すターミナルが
 * 返事より先に開くと既定のホームで開いてしまうので、できるだけ早く届くようにする（間に合わなかった
 * ターミナルは {@link ParadisCodexAccountsNotifications} が知らせる）。
 */
class ParadisCodexAccountsSync extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisCodexAccountsSync';

	private lastRevision = -1;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IParadisCodexLaunchHomeService private readonly launchHomeService: IParadisCodexLaunchHomeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		if (environmentService.remoteAuthority !== undefined) {
			return;
		}
		const client = instantiationService.createInstance(ParadisCodexAccountsClient);
		this._register(client.onDidChangeState(state => this.apply(state)));
		client.getState().then(state => this.apply(state), error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
		});
	}

	private apply(state: IParadisCodexAccountsState): void {
		// 起動時の読み取りと切替の通知が前後して届いても、古い方で上書きしない。
		if (state.selection.revision < this.lastRevision) {
			return;
		}
		this.lastRevision = state.selection.revision;
		this.launchHomeService.setLaunchHome(paradisCodexLaunchHomeFor(state));
	}
}

/**
 * 選択の反映に合わせて、このウィンドウのターミナルについて知らせる。
 *  - 切り替えたとき: 前のアカウントのまま動いている Codex があれば1回だけ
 *  - 初めて選択が届いたとき: それより前に開いた（既定のホームで開いた）ターミナルがあれば1回だけ
 */
class ParadisCodexAccountsNotifications extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisCodexAccountsNotifications';

	private readonly client: ParadisCodexAccountsClient;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IParadisCodexLaunchHomeService private readonly launchHomeService: IParadisCodexLaunchHomeService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisCodexAccountsClient);
		if (environmentService.remoteAuthority !== undefined) {
			return;
		}
		this._register(this.launchHomeService.onDidChangeLaunchHome(change => {
			if (change.initial) {
				void this.notifyPanesOpenedBeforeSync(change.next);
			} else if (change.previous !== change.next) {
				void this.notifyPanesOnPreviousAccount(change.previous, change.next);
			}
		}));
		// 選択がこの contribution より先に届いていた。
		if (this.launchHomeService.synced) {
			void this.notifyPanesOpenedBeforeSync(this.launchHomeService.getLaunchHome());
		}
	}

	private async readState(): Promise<IParadisCodexAccountsState | undefined> {
		try {
			return await this.client.getState();
		} catch (error) {
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
			return undefined;
		}
	}

	private async notifyPanesOpenedBeforeSync(next: string | undefined): Promise<void> {
		if (next === undefined) {
			return;
		}
		let count = 0;
		for (const { token } of this.paneTokenService.listPaneTokens()) {
			const paneHome = this.launchHomeService.getPaneHome(token);
			if (paneHome.known && paneHome.beforeSync && paneHome.homePath !== next) {
				count++;
			}
		}
		if (count === 0) {
			return;
		}
		const state = await this.readState();
		this.notificationService.info(localize('paradis.codexAccounts.openedBeforeSync', "起動直後に開いたターミナル {0} 個は、選んでいる Codex のアカウント（{1}）ではなく既定のアカウントで開いています。そこで Codex を使うときは、新しいターミナルを開いてください。", count, state ? accountName(state, next) : next));
	}

	private async notifyPanesOnPreviousAccount(previous: string | undefined, next: string | undefined): Promise<void> {
		let count = 0;
		const previousHomes = new Set<string | undefined>();
		for (const { instanceId, token } of this.paneTokenService.listPaneTokens()) {
			const instance = this.terminalService.getInstanceFromId(instanceId);
			if (!instance || !this.isRunningCodex(instance)) {
				continue;
			}
			// 開いたときのホームが分からない（再接続した）ペインは、切替の直前の選択で開いたものとみなす。
			const paneHome = this.launchHomeService.getPaneHome(token);
			const home = paneHome.known ? paneHome.homePath : previous;
			if (home === next) {
				continue;
			}
			count++;
			previousHomes.add(home);
		}
		if (count === 0) {
			return;
		}
		const state = await this.readState();
		const nextName = state ? accountName(state, next) : next ?? localize('paradis.codexAccounts.defaultHome', "既定のアカウント");
		const previousName = state && previousHomes.size === 1 ? accountName(state, [...previousHomes][0]) : undefined;
		this.notificationService.info(previousName !== undefined
			? localize('paradis.codexAccounts.switchedWithRunning', "Codex のアカウントを {0} に切り替えました。開いている Codex {1} 個は前のアカウント（{2}）のまま動いています。新しく開いたターミナルから切り替わります。", nextName, count, previousName)
			: localize('paradis.codexAccounts.switchedWithRunningMixed', "Codex のアカウントを {0} に切り替えました。開いている Codex {1} 個は前のアカウントのまま動いています。新しく開いたターミナルから切り替わります。", nextName, count));
	}

	private isRunningCodex(instance: ITerminalInstance): boolean {
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		return paradisLooksLikeRunningCodex(commandDetection?.executingCommand, instance.processName);
	}
}

function accountName(state: IParadisCodexAccountsState, homePath: string | undefined): string {
	const home: IParadisCodexHome | undefined = homePath === undefined
		? state.homes.find(candidate => candidate.isDefault)
		: state.homes.find(candidate => candidate.homePath === homePath);
	return home?.email ?? home?.label ?? homePath ?? localize('paradis.codexAccounts.defaultHome', "既定のアカウント");
}

registerWorkbenchContribution2(ParadisCodexAccountsSync.ID, ParadisCodexAccountsSync, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ParadisCodexAccountsNotifications.ID, ParadisCodexAccountsNotifications, WorkbenchPhase.AfterRestored);
