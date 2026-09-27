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

class ParadisCodexAccountsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisCodexAccounts';

	private lastRevision = -1;

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
		if (environmentService.remoteAuthority !== undefined) {
			return;
		}
		const client = instantiationService.createInstance(ParadisCodexAccountsClient);
		this._register(client.onDidChangeState(state => this.apply(state, true)));
		client.getState().then(state => this.apply(state, false), error => {
			this.logService.warn('[ParadisCodexAccounts] failed to read the Codex account selection', error);
		});
	}

	private apply(state: IParadisCodexAccountsState, changed: boolean): void {
		// 起動時の読み取りと切替の通知が前後して届いても、古い方で上書きしない。
		if (state.selection.revision < this.lastRevision) {
			return;
		}
		this.lastRevision = state.selection.revision;
		const previous = this.launchHomeService.getLaunchHome();
		const next = paradisCodexLaunchHomeFor(state);
		this.launchHomeService.setLaunchHome(next);
		if (changed && previous !== next) {
			this.notifyPanesOnPreviousAccount(previous, next, state);
		}
	}

	private notifyPanesOnPreviousAccount(previous: string | undefined, next: string | undefined, state: IParadisCodexAccountsState): void {
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
		const nextName = accountName(state, next);
		const previousName = previousHomes.size === 1 ? accountName(state, [...previousHomes][0]) : undefined;
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

registerWorkbenchContribution2(ParadisCodexAccountsContribution.ID, ParadisCodexAccountsContribution, WorkbenchPhase.AfterRestored);
