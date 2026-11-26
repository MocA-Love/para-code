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
// - エージェントの管理の道具（start_bot・remove_bot）から呼ばれるチャネル {@link PARADIS_BOTS_WINDOW_CHANNEL}。
//   道具からの起動は利用者のフォーカスを奪わず（裏のタブ）、削除は利用者の確認を通す。

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisDialogService, paradisNotifyConfirmation } from '../../confirmDialog/browser/paradisDialogService.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisLaunchedAgentTerminal, paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisBotInstancesInWindow } from '../browser/paradisBotPaneHash.js';
import { IParadisBotsService, IParadisBotStopRequest, PARADIS_BOTS_WINDOW_CHANNEL, ParadisBotsWindowResult } from '../common/paradisBotsApi.js';

export const PARADIS_BOTS_OPEN_COMMAND = 'paradis.bots.open';

function findInstance(terminalService: ITerminalService, terminalGroupService: ITerminalGroupService, instanceId: number): ITerminalInstance | undefined {
	return paradisCollectAllTerminalInstances(terminalService, terminalGroupService).find(instance => instance.instanceId === instanceId);
}

/** 起動の途中の Bot（同じ Bot を続けて押されても 2 つ起動しない）。 */
const opening = new Set<string>();

/** 開いた結果。`running` はもうこのウィンドウで動いていた（前に出したかは `focused`）。 */
export type ParadisOpenBotResult =
	| { readonly ok: true; readonly state: 'running' | 'started'; readonly focused: boolean }
	| { readonly ok: false; readonly error: string };

/**
 * Bot を開く。このウィンドウにペインがあればそれを使い、無ければ起動する。
 * @param fromAgent エージェントの道具（start_bot）から。前に出さず、利用者の入力を奪わない裏のタブで起動する
 */
export async function paradisOpenBot(accessor: ServicesAccessor, botId: string, fromAgent = false): Promise<ParadisOpenBotResult> {
	const botsService = accessor.get(IParadisBotsService);
	const paneTokenService = accessor.get(IParadisPaneTokenService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const instantiationService = accessor.get(IInstantiationService);
	const switchService = accessor.get(IParadisWorkspaceSwitchService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const logService = accessor.get(ILogService);

	if (opening.has(botId)) {
		return { ok: false, error: 'Para Code is already starting this bot.' };
	}
	opening.add(botId);
	try {
		const existing = (await paradisBotInstancesInWindow(paneTokenService, await botsService.paneHashesOf(botId)))
			.map(instanceId => findInstance(terminalService, terminalGroupService, instanceId))
			.find(instance => instance !== undefined && !instance.isDisposed);
		if (existing !== undefined) {
			if (!fromAgent) {
				await terminalService.focusInstance(existing);
			}
			return { ok: true, state: 'running', focused: !fromAgent };
		}
		// 専用フォルダはこの PC にある。SSH のウィンドウで開くと、接続先のシェルでそのパスを cwd にしてしまう
		if (environmentService.remoteAuthority !== undefined) {
			return { ok: false, error: 'remote' };
		}
		const launch = await botsService.requestLaunch(botId, 'chat');
		if (!launch.ok) {
			return { ok: false, error: `${launch.message} (${launch.code})` };
		}
		const stateKey = switchService.activeStateKey;
		let launched: IParadisLaunchedAgentTerminal | undefined;
		try {
			launched = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri: URI.file(launch.value.cwd),
				stateKey,
				agentId: launch.value.agent,
				...(launch.value.modelId !== undefined ? { modelId: launch.value.modelId } : {}),
				...(launch.value.effortId !== undefined ? { effortId: launch.value.effortId } : {}),
				...(launch.value.permissionId !== undefined ? { permissionId: launch.value.permissionId } : {}),
				...(launch.value.extraFlags !== undefined ? { extraFlags: launch.value.extraFlags } : {}),
				// 裏のタブで開くにはスペースが要る（スペースを使っていないウィンドウでは、今のウィンドウに開く）
				...(fromAgent && stateKey !== undefined ? { preserveFocus: true } : {}),
			});
		} catch (error) {
			logService.error('[paradisBots] starting the bot terminal failed', error);
		}
		if (launched?.paneToken === undefined) {
			await botsService.cancelLaunch(launch.value.launchId);
			return { ok: false, error: 'Para Code could not start the terminal for the bot.' };
		}
		if (!await botsService.reportLaunch(launch.value.launchId, launched.paneToken)) {
			// 結び付けを断られた（番号の期限切れなど）。Bot の道具が使えないターミナルを残さない
			findInstance(terminalService, terminalGroupService, launched.instanceId)?.dispose(TerminalExitReason.User);
			return { ok: false, error: 'Para Code could not connect the terminal to the bot. Try again.' };
		}
		return { ok: true, state: 'started', focused: !(fromAgent && stateKey !== undefined) };
	} finally {
		opening.delete(botId);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: PARADIS_BOTS_OPEN_COMMAND, title: localize2('paradisBots.open', "Open Bot"), f1: false });
	}
	async run(accessor: ServicesAccessor, botId: unknown): Promise<void> {
		if (typeof botId !== 'string' || botId.length === 0) {
			return;
		}
		const notificationService = accessor.get(INotificationService);
		const result = await paradisOpenBot(accessor, botId);
		if (!result.ok) {
			notificationService.warn(result.error === 'remote'
				// allow-any-unicode-next-line
				? localize('paradisBots.openRemote', "Bot はこの PC のウィンドウで開いてください。Bot のフォルダはこの PC にあります。")
				// allow-any-unicode-next-line
				: localize('paradisBots.openFailed', "Bot を起動できませんでした。もう一度試してください。"));
		}
	}
});

/** エージェントの管理の道具から呼ばれる、このウィンドウの窓口。引数は `[呼び出し元のペイントークン, Bot の id, …]`。 */
class ParadisBotsWindowChannel implements IServerChannel {

	/** 削除の確認を出している間は、次の依頼を断る（確認を重ねない）。 */
	private pendingRemoval = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) { }

	listen<T>(): Event<T> {
		throw new Error('no events');
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const callerToken = typeof args[0] === 'string' ? args[0] : '';
		const botId = typeof args[1] === 'string' ? args[1] : '';
		switch (command) {
			case 'start': return await this.start(botId) as T;
			case 'confirmRemove': return this.confirmRemove(callerToken, botId, typeof args[2] === 'string' ? args[2] : '') as T;
		}
		throw new Error(`unknown command ${command}`);
	}

	private async start(botId: string): Promise<ParadisBotsWindowResult> {
		const result = await this.instantiationService.invokeFunction(paradisOpenBot, botId, true);
		if (!result.ok) {
			return { ok: false, error: result.error === 'remote' ? 'This Para Code window is connected over SSH, and a bot runs on this computer. Ask the user to open the bot from a local window.' : result.error };
		}
		return { ok: true, data: { state: result.state } };
	}

	private confirmRemove(callerToken: string, botId: string, botName: string): ParadisBotsWindowResult {
		if (this.pendingRemoval) {
			return { ok: false, error: 'Para Code is already asking the user about another removal. Wait until they answer.' };
		}
		const instanceId = this.paneTokenService.getInstanceForToken(callerToken);
		const caller = instanceId !== undefined ? findInstance(this.terminalService, this.terminalGroupService, instanceId)?.title : undefined;
		// 確認を待つと道具の呼び出しが時間切れになるので、出したところで返す（remove_space と同じ）
		this.pendingRemoval = true;
		this.askAndRemove(botId, botName, caller ?? '')
			.catch(error => this.logService.warn('[paradisBots] removing a bot failed', error))
			.finally(() => { this.pendingRemoval = false; });
		return { ok: true, data: { requested: true } };
	}

	private async askAndRemove(botId: string, botName: string, caller: string): Promise<void> {
		// エージェントの依頼は窓が後ろにあっても来るので、Dock で知らせる（フォーカスは奪わない）
		paradisNotifyConfirmation(this.hostService, getActiveWindow());
		const { confirmed } = await this.paradisDialogService.confirm({
			destructive: true,
			type: 'warning',
			// allow-any-unicode-next-line
			message: localize('paradisBots.removeConfirm', "Bot「{0}」を削除しますか？", botName),
			// allow-any-unicode-next-line
			detail: localize('paradisBots.removeAgentRequest', "この削除は、あなたではなくターミナル「{0}」のエージェントからの依頼です。\n\nBot の作業項目は消えます。専用フォルダ（人格メモと記憶）は残ります。", caller),
			// allow-any-unicode-next-line
			primaryButton: localize('paradisBots.removeAction', "削除"),
		});
		if (confirmed) {
			await this.botsService.removeBot(botId);
		}
	}
}

/** 止める依頼を受けて、このウィンドウにあるその Bot のターミナルを閉じる。管理の道具の窓口も登録する。 */
class ParadisBotsWindowContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisBotsWindow';

	constructor(
		@IParadisBotsService botsService: IParadisBotsService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_BOTS_WINDOW_CHANNEL, instantiationService.createInstance(ParadisBotsWindowChannel));
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

registerWorkbenchContribution2(ParadisBotsWindowContribution.ID, ParadisBotsWindowContribution, WorkbenchPhase.AfterRestored);
