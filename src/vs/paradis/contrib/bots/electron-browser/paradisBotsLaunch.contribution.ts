/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のターミナルを、ウィンドウの側で起動する・閉じる。paradis.electron-browser.contribution.ts から読み込む。
//
// - 開く（コマンド `paradis.bots.open`、引数は Bot の id）: このウィンドウにもうその Bot のペインがあれば前に出す。
//   無ければ shared process に起動を頼み（requestLaunch）、返った専用フォルダを cwd に今のスペースのエディタへ
//   エージェントを起動して、そのペインのトークンを知らせる（reportLaunch）。起動できなければ番号を捨てる。
// - 止める: shared process の止める依頼（onDidRequestStop）に載ったトークンのハッシュと、このウィンドウの生きた
//   ペインのトークンのハッシュを照らし、合ったターミナルを閉じる。トークンの値はウィンドウの外へ出さない。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisLaunchedAgentTerminal, paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisBotInstancesInWindow } from '../browser/paradisBotPaneHash.js';
import { IParadisBotsService, IParadisBotStopRequest } from '../common/paradisBotsApi.js';

export const PARADIS_BOTS_OPEN_COMMAND = 'paradis.bots.open';

function findInstance(terminalService: ITerminalService, terminalGroupService: ITerminalGroupService, instanceId: number): ITerminalInstance | undefined {
	return paradisCollectAllTerminalInstances(terminalService, terminalGroupService).find(instance => instance.instanceId === instanceId);
}

/** 起動の途中の Bot（同じ Bot を続けて押されても 2 つ起動しない）。 */
const opening = new Set<string>();

/** Bot を開く。このウィンドウにペインがあれば前に出し、無ければ起動する。 */
export async function paradisOpenBot(accessor: ServicesAccessor, botId: string): Promise<void> {
	const botsService = accessor.get(IParadisBotsService);
	const paneTokenService = accessor.get(IParadisPaneTokenService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const instantiationService = accessor.get(IInstantiationService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const notificationService = accessor.get(INotificationService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const logService = accessor.get(ILogService);

	if (opening.has(botId)) {
		return;
	}
	opening.add(botId);
	try {
		const existing = (await paradisBotInstancesInWindow(paneTokenService, await botsService.paneHashesOf(botId)))
			.map(instanceId => findInstance(terminalService, terminalGroupService, instanceId))
			.find(instance => instance !== undefined && !instance.isDisposed);
		if (existing !== undefined) {
			await terminalService.focusInstance(existing);
			return;
		}
		// 専用フォルダはこの PC にある。SSH のウィンドウで開くと、接続先のシェルでそのパスを cwd にしてしまう
		if (environmentService.remoteAuthority !== undefined) {
			notificationService.info(localize('paradisBots.openRemote', "Open the bot from a local window. Its home folder is on this computer."));
			return;
		}
		const launch = await botsService.requestLaunch(botId, 'chat');
		if (!launch.ok) {
			notificationService.warn(localize('paradisBots.launchRefused', "Could not start the bot: {0}", launch.message));
			return;
		}
		let launched: IParadisLaunchedAgentTerminal | undefined;
		try {
			launched = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri: URI.file(launch.value.cwd),
				stateKey: switchService.activeStateKey,
				agentId: launch.value.agent,
				...(launch.value.modelId !== undefined ? { modelId: launch.value.modelId } : {}),
				...(launch.value.effortId !== undefined ? { effortId: launch.value.effortId } : {}),
				...(launch.value.permissionId !== undefined ? { permissionId: launch.value.permissionId } : {}),
				...(launch.value.extraFlags !== undefined ? { extraFlags: launch.value.extraFlags } : {}),
			});
		} catch (error) {
			logService.error('[paradisBots] starting the bot terminal failed', error);
		}
		if (launched?.paneToken === undefined) {
			await botsService.cancelLaunch(launch.value.launchId);
			notificationService.warn(localize('paradisBots.launchFailed', "Could not start the terminal for the bot."));
			return;
		}
		if (!await botsService.reportLaunch(launch.value.launchId, launched.paneToken)) {
			// 結び付けを断られた（番号の期限切れなど）。Bot の道具が使えないターミナルを残さない
			findInstance(terminalService, terminalGroupService, launched.instanceId)?.dispose(TerminalExitReason.User);
			notificationService.warn(localize('paradisBots.reportRefused', "Could not connect the terminal to the bot. Try again."));
		}
	} finally {
		opening.delete(botId);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: PARADIS_BOTS_OPEN_COMMAND, title: localize2('paradisBots.open', "Open Bot"), f1: false });
	}
	run(accessor: ServicesAccessor, botId: unknown): Promise<void> {
		return typeof botId === 'string' && botId.length > 0 ? paradisOpenBot(accessor, botId) : Promise.resolve();
	}
});

/** 止める依頼を受けて、このウィンドウにあるその Bot のターミナルを閉じる。 */
class ParadisBotsStopContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisBotsStop';

	constructor(
		@IParadisBotsService botsService: IParadisBotsService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(botsService.onDidRequestStop(request => {
			this.stop(request).catch(error => this.logService.warn('[paradisBots] stopping the bot terminals failed', error));
		}));
	}

	private async stop(request: IParadisBotStopRequest): Promise<void> {
		for (const instanceId of await paradisBotInstancesInWindow(this.paneTokenService, request.paneHashes)) {
			const instance = findInstance(this.terminalService, this.terminalGroupService, instanceId);
			if (instance !== undefined && !instance.isDisposed) {
				// 確認のダイアログは出さない（止めると決めたのは利用者で、閉じるのは Bot のターミナルだけ）
				instance.dispose(TerminalExitReason.User);
			}
		}
	}
}

registerWorkbenchContribution2(ParadisBotsStopContribution.ID, ParadisBotsStopContribution, WorkbenchPhase.AfterRestored);
