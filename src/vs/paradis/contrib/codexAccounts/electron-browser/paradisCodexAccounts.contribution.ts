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
// SSH の接続先を開いているウィンドウでは、接続先（REH）の選択を受ける。選択は接続先のホームを指すので、
// 渡す先も接続先で動くターミナルだけにする（paradisPaneTokenService.ts）。

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
import { IParadisCodexAccountsState, IParadisCodexHome, IParadisCodexPaneProcess, paradisCodexLaunchHomeFor, paradisLooksLikeRunningCodex, paradisRunningCodexHome } from '../common/paradisCodexAccounts.js';
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
		@IParadisCodexLaunchHomeService private readonly launchHomeService: IParadisCodexLaunchHomeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
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
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IParadisCodexLaunchHomeService private readonly launchHomeService: IParadisCodexLaunchHomeService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.client = instantiationService.createInstance(ParadisCodexAccountsClient);
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
		const panes: { readonly token: string; readonly instance: ITerminalInstance }[] = [];
		for (const { instanceId, token } of this.paneTokenService.listPaneTokens()) {
			const instance = this.terminalService.getInstanceFromId(instanceId);
			// 選択が効くのは、このウィンドウの選択の持ち主（手元か接続先）で動くターミナルだけ。接続先の
			// ウィンドウで手元に開いたターミナル（その逆も）は数えない（pid も別のマシンのもの）。
			if (instance && instance.remoteAuthority === this.environmentService.remoteAuthority) {
				panes.push({ token, instance });
			}
		}
		const running = await this.panesRunningCodex(panes.map(pane => pane.instance));
		let count = 0;
		const previousHomes = new Set<string | undefined>();
		for (const { token, instance } of panes) {
			if (!running.has(instance)) {
				continue;
			}
			const home = paradisRunningCodexHome(running.get(instance), this.launchHomeService.getPaneHome(token), previous);
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

	/**
	 * Codex が動いているペイン。シェル統合の実行中コマンドとプロセス名で分かるものに加え、分からないもの
	 * （再接続したペイン、npm 版の `node`、`echo …; codex` のような行）はシェルの子孫を shared process の
	 * プロセス表で調べる。調べられなければ画面側で分かった分だけにする。
	 */
	private async panesRunningCodex(instances: readonly ITerminalInstance[]): Promise<Map<ITerminalInstance, IParadisCodexPaneProcess | undefined>> {
		const running = new Map<ITerminalInstance, IParadisCodexPaneProcess | undefined>();
		const byShellPid = new Map<number, ITerminalInstance>();
		for (const instance of instances) {
			const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
			if (paradisLooksLikeRunningCodex(commandDetection?.executingCommand, instance.processName)) {
				running.set(instance, undefined);
			}
			// 画面側で分かったペインも渡す（動いている Codex の実際のホームを読むため）
			if (instance.processId !== undefined && instance.processId > 0) {
				byShellPid.set(instance.processId, instance);
			}
		}
		// 渡されるのはこのウィンドウの選択の持ち主で動くペインだけ（呼び出し側）なので、pid はクライアントが
		// 問い合わせる先（手元なら shared process、接続先なら REH）のマシンのもの
		if (byShellPid.size > 0) {
			try {
				for (const found of await this.client.shellsRunningCodex([...byShellPid.keys()])) {
					const instance = byShellPid.get(found.shellPid);
					if (instance) {
						running.set(instance, found);
					}
				}
			} catch (error) {
				this.logService.warn('[ParadisCodexAccounts] could not check the terminal processes for Codex', error);
			}
		}
		return running;
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
