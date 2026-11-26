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
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisDialogService, paradisNotifyConfirmation } from '../../confirmDialog/browser/paradisDialogService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisBotChangeDetail } from '../browser/paradisBotChangeDetail.js';
import { paradisRevealNotifiedPane } from '../../notifications/electron-browser/paradisNotificationReveal.js';
import { paradisBotInstancesInWindow, paradisFindBotPane } from '../browser/paradisBotPaneHash.js';
import { paradisFindBotTerminalInstance, paradisLaunchBotTerminal, paradisNameBotTab } from './paradisBotTerminalLaunch.js';
import { IParadisBotChangeRequest, paradisApplyBotChange } from '../common/paradisBotManageTools.js';
import { IParadisBotsService, IParadisBotStopRequest, PARADIS_BOTS_WINDOW_CHANNEL, ParadisBotsWindowResult } from '../common/paradisBotsApi.js';

export const PARADIS_BOTS_OPEN_COMMAND = 'paradis.bots.open';

const findInstance = paradisFindBotTerminalInstance;

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
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const hostService = accessor.get(IHostService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);

	if (opening.has(botId)) {
		return { ok: false, error: 'Para Code is already starting this bot.' };
	}
	opening.add(botId);
	try {
		// 待避中（別のスペース）のペインも探す。見つからずに今のスペースで 2 つ目を起動しないため
		const existing = await paradisFindBotPane({
			paneTokenService,
			findInstance: instanceId => findInstance(terminalService, terminalGroupService, instanceId),
			stateKeyOf: instanceId => terminalScopeService.getStateKeyForInstance(instanceId),
		}, await botsService.paneHashesOf(botId, 'chat'));
		if (existing !== undefined) {
			if (!fromAgent) {
				// そのペインのスペースへ切り替えてから前に出す（通知のクリックと同じ動き）
				await paradisRevealNotifiedPane({ hostService, terminalService, workspaceSwitchService: switchService }, existing.stateKey, existing.instanceId);
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
		// 裏のタブで開くにはスペースが要る（スペースを使っていないウィンドウでは、今のウィンドウに開く）
		const outcome = await instantiationService.invokeFunction(paradisLaunchBotTerminal, launch.value, { stateKey, background: fromAgent });
		if (!outcome.ok) {
			return { ok: false, error: outcome.reason === 'refused' ? 'Para Code could not connect the terminal to the bot. Try again.' : 'Para Code could not start the terminal for the bot.' };
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

	/** 削除・設定の変更の確認を出している間は、次の依頼を断る（確認を重ねない）。 */
	private pendingConfirmation = false;

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
			case 'confirmChange': return this.confirmChange(callerToken, args[1]) as T;
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

	private callerTitle(callerToken: string): string {
		const instanceId = this.paneTokenService.getInstanceForToken(callerToken);
		return (instanceId !== undefined ? findInstance(this.terminalService, this.terminalGroupService, instanceId)?.title : undefined) ?? '';
	}

	/** 確認を待つと道具の呼び出しが時間切れになるので、出したところで返す（remove_space と同じ）。 */
	private ask(work: () => Promise<void>): ParadisBotsWindowResult {
		if (this.pendingConfirmation) {
			return { ok: false, error: 'Para Code is already asking the user about another bot change or removal. Wait until they answer.' };
		}
		this.pendingConfirmation = true;
		work()
			.catch(error => this.logService.warn('[paradisBots] a confirmed bot change failed', error))
			.finally(() => { this.pendingConfirmation = false; });
		return { ok: true, data: { requested: true } };
	}

	private confirmRemove(callerToken: string, botId: string, botName: string): ParadisBotsWindowResult {
		const caller = this.callerTitle(callerToken);
		return this.ask(() => this.askAndRemove(botId, botName, caller));
	}

	private confirmChange(callerToken: string, value: unknown): ParadisBotsWindowResult {
		const request = value as IParadisBotChangeRequest | undefined;
		if (!request || typeof request !== 'object' || typeof request.botId !== 'string' || typeof request.botName !== 'string' || !Array.isArray(request.changes) || typeof request.patch !== 'object') {
			return { ok: false, error: 'Para Code could not read the change.' };
		}
		const caller = this.callerTitle(callerToken);
		return this.ask(() => this.askAndChange(request, caller));
	}

	private async askAndChange(request: IParadisBotChangeRequest, caller: string): Promise<void> {
		paradisNotifyConfirmation(this.hostService, getActiveWindow());
		const { confirmed } = await this.paradisDialogService.confirm({
			type: 'warning',
			// allow-any-unicode-next-line
			message: localize('paradisBots.changeConfirm', "Bot「{0}」の設定を変えますか？", request.botName),
			detail: paradisBotChangeDetail(request, caller),
			// allow-any-unicode-next-line
			primaryButton: localize('paradisBots.changeAction', "変える"),
		});
		if (!confirmed) {
			return;
		}
		const applied = await paradisApplyBotChange(this.botsService, request);
		if (!applied.ok) {
			this.logService.warn(`[paradisBots] the confirmed change was not applied: ${applied.code}`);
		}
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

	/** 前回タブ名を合わせたときの Bot の名前と様子（変わったときだけ合わせ直す）。 */
	private namedSignature = '';
	private readonly nameScheduler = this._register(new RunOnceScheduler(() => {
		this.nameTabs().catch(error => this.logService.warn('[paradisBots] naming the bot tabs failed', error));
	}, 500));

	constructor(
		@IParadisBotsService private readonly botsService: IParadisBotsService,
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
		// 起動し直した後に戻ったペインと、Bot の名前を変えたときも、タブ名を Bot の名前に合わせる
		this._register(botsService.onDidChange(() => this.nameScheduler.schedule()));
		this.nameScheduler.schedule();
	}

	private async nameTabs(): Promise<void> {
		const bots = this.botsService.snapshot.bots;
		const signature = JSON.stringify(bots.map(bot => [bot.id, bot.name, bot.activity]));
		if (signature === this.namedSignature) {
			return;
		}
		this.namedSignature = signature;
		for (const bot of bots) {
			if (bot.activity === 'stopped') {
				continue;
			}
			for (const instanceId of await paradisBotInstancesInWindow(this.paneTokenService, await this.botsService.paneHashesOf(bot.id))) {
				paradisNameBotTab(findInstance(this.terminalService, this.terminalGroupService, instanceId), bot.name);
			}
		}
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
