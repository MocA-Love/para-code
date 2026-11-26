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

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisRevealNotifiedPane } from '../../notifications/electron-browser/paradisNotificationReveal.js';
import { paradisBotInstancesInWindow, paradisFindBotPane } from '../browser/paradisBotPaneHash.js';
import { paradisBotTabTitle, paradisRunBotLaunch } from '../common/paradisBotLaunchSteps.js';
import { IParadisBotRevealRequest, IParadisBotsService, IParadisBotStopRequest, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';

export const PARADIS_BOTS_OPEN_COMMAND = 'paradis.bots.open';

/**
 * タブ名の雛形を Bot の名前にする（固定の名前にするとエージェントのタイトルの購読が止まるため、雛形で付ける）。
 * terminalInstance.ts の PARA-PATCH でエージェントの CLI のタイトルが雛形より先に立つので、エージェントが動いている間は
 * エージェントの出すタイトルが、動いていない間（起動の直後・終わった後）は Bot の名前がタブに出る。
 */
function paradisNameBotTab(instance: ITerminalInstance | undefined, name: string): void {
	if (instance === undefined || instance.isDisposed) {
		return;
	}
	const title = paradisBotTabTitle(name);
	if (instance.shellLaunchConfig.titleTemplate === title) {
		return;
	}
	instance.shellLaunchConfig.titleTemplate = title;
	// 利用者が手で付けた名前（固定タイトル）があればそちらを残す。無ければラベルを計算し直させる
	// （paradisPresetService.ts と同じやり方。rename(undefined) は固定タイトルが無い端末では再計算だけ）
	if (!instance.staticTitle) {
		void instance.rename(undefined);
	}
}

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
	const terminalScopeService = accessor.get(IParadisTerminalScopeService);
	const hostService = accessor.get(IHostService);
	const notificationService = accessor.get(INotificationService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	const logService = accessor.get(ILogService);

	if (opening.has(botId)) {
		return;
	}
	opening.add(botId);
	try {
		// 待避中（別のスペース）のペインも探す。見つからずに今のスペースで 2 つ目を起動しないため
		const existing = await paradisFindBotPane({
			paneTokenService,
			findInstance: instanceId => findInstance(terminalService, terminalGroupService, instanceId),
			stateKeyOf: instanceId => terminalScopeService.getStateKeyForInstance(instanceId),
		}, await botsService.paneHashesOf(botId));
		if (existing !== undefined) {
			// そのペインのスペースへ切り替えてから前に出す（通知のクリックと同じ動き）
			await paradisRevealNotifiedPane({ hostService, terminalService, workspaceSwitchService: switchService }, existing.stateKey, existing.instanceId);
			return;
		}
		// 専用フォルダはこの PC にある。SSH のウィンドウで開くと、接続先のシェルでそのパスを cwd にしてしまう
		if (environmentService.remoteAuthority !== undefined) {
			notificationService.info(localize('paradisBots.openRemote', "Open the bot from a local window. Its home folder is on this computer."));
			return;
		}
		const launch = await botsService.requestLaunch(botId, 'chat');
		// 会話は 1 つの Bot に 1 つだけ。別のウィンドウで開いている（そのウィンドウが前に出る）・起動している途中
		if (!launch.ok && launch.code === 'already_open') {
			await botsService.requestReveal(botId);
			notificationService.info(localize('paradisBots.alreadyOpen', "This bot is already open in another window. That window shows it now."));
			return;
		}
		if (!launch.ok && launch.code === 'launching') {
			notificationService.info(localize('paradisBots.launching', "This bot is starting in another window."));
			return;
		}
		if (!launch.ok) {
			notificationService.warn(localize('paradisBots.launchRefused', "Could not start the bot: {0}", launch.message));
			return;
		}
		// コマンドを送る前にペインを報告する（エージェントの MCP の接続より先に、Bot の道具が出るように）
		const outcome = await paradisRunBotLaunch({
			reportLaunch: (launchId, paneToken) => botsService.reportLaunch(launchId, paneToken),
			cancelLaunch: launchId => botsService.cancelLaunch(launchId),
			launchAgent: async beforeCommand => {
				try {
					return await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
						rootUri: URI.file(launch.value.cwd),
						stateKey: switchService.activeStateKey,
						agentId: launch.value.agent,
						...(launch.value.modelId !== undefined ? { modelId: launch.value.modelId } : {}),
						...(launch.value.effortId !== undefined ? { effortId: launch.value.effortId } : {}),
						...(launch.value.permissionId !== undefined ? { permissionId: launch.value.permissionId } : {}),
						...(launch.value.extraFlags !== undefined ? { extraFlags: launch.value.extraFlags } : {}),
						beforeCommand,
					});
				} catch (error) {
					logService.error('[paradisBots] starting the bot terminal failed', error);
					throw error;
				}
			},
			nameTab: instanceId => paradisNameBotTab(findInstance(terminalService, terminalGroupService, instanceId), launch.value.name),
		}, launch.value.launchId);
		if (!outcome.ok) {
			notificationService.warn(outcome.reason === 'refused'
				? localize('paradisBots.reportRefused', "Could not connect the terminal to the bot. Try again.")
				: localize('paradisBots.launchFailed', "Could not start the terminal for the bot."));
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

/**
 * 止める依頼を受けて、このウィンドウにあるその Bot のターミナルを閉じる。別のウィンドウから開こうとした Bot のペインを前に出す。
 * Bot のタブ名を合わせる。Bot の機能の窓口（shared process へのつなぎ）は、設定がオンになるまで作らない。
 */
class ParadisBotsWindowWorker extends Disposable {

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
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(botsService.onDidRequestStop(request => {
			this.stop(request).catch(error => this.logService.warn('[paradisBots] stopping the bot terminals failed', error));
		}));
		this._register(botsService.onDidRequestReveal(request => {
			this.reveal(request).catch(error => this.logService.warn('[paradisBots] showing the bot terminal failed', error));
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

	/** このウィンドウにその Bot のペインがあれば、そのスペースへ切り替えて前に出す（通知のクリックと同じ動き）。 */
	private async reveal(request: IParadisBotRevealRequest): Promise<void> {
		const existing = await paradisFindBotPane({
			paneTokenService: this.paneTokenService,
			findInstance: instanceId => findInstance(this.terminalService, this.terminalGroupService, instanceId),
			stateKeyOf: instanceId => this.terminalScopeService.getStateKeyForInstance(instanceId),
		}, request.paneHashes);
		if (existing !== undefined) {
			await paradisRevealNotifiedPane({ hostService: this.hostService, terminalService: this.terminalService, workspaceSwitchService: this.switchService }, existing.stateKey, existing.instanceId);
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

/** 設定 `paradis.bots.enabled` がオンの間だけ {@link ParadisBotsWindowWorker} を置く（オフなら Bot の窓口を作らない）。 */
class ParadisBotsStopContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisBotsStop';

	private readonly worker = this._register(new MutableDisposable<ParadisBotsWindowWorker>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.apply();
			}
		}));
		this.apply();
	}

	private apply(): void {
		if (this.configurationService.getValue(PARADIS_BOTS_ENABLED_SETTING) !== true) {
			this.worker.clear();
		} else if (this.worker.value === undefined) {
			this.worker.value = this.instantiationService.createInstance(ParadisBotsWindowWorker);
		}
	}
}

registerWorkbenchContribution2(ParadisBotsStopContribution.ID, ParadisBotsStopContribution, WorkbenchPhase.AfterRestored);
