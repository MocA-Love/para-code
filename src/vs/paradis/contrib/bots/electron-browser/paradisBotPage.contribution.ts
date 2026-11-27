/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページ（paradisBotPage.ts）を、エディタのターミナルへの重ね合わせの口に登録する。
// paradis.electron-browser.contribution.ts から読み込む。設定 paradis.bots.enabled がオフの間は登録せず、Bot の
// サービスにも触れない（オフにしたら外す。開いているタブの帯は、ページが自分で外す）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisRegisterEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisBotPaneTokenHashInWindow } from '../browser/paradisBotPaneHash.js';
import { IParadisBotPaneResolver, ParadisBotPage } from '../browser/paradisBotPage.js';
import { IParadisBotPatrolPort } from '../browser/paradisBotPatrol.js';
import { IParadisBotTasksPort, paradisRegisterBotTasksPort } from '../browser/paradisBotTasks.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { localize } from '../../../../nls.js';
import { IParadisBotPatrolInput } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { IParadisScheduledRunsClient } from '../../scheduledRuns/electron-browser/paradisScheduledRunsClient.js';
import { IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';

/** どのペインが Bot のものかを、ペインのトークンのハッシュで照らす。Bot ごとのハッシュは台帳が変わるまで使い回す。 */
class ParadisBotPaneResolver extends Disposable implements IParadisBotPaneResolver {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private hashes: Promise<ReadonlyMap<string, readonly string[]>> | undefined;
	/** 見回りのペインのハッシュ（{@link hashes} と一緒に読み直す）。 */
	private patrolHashes: Promise<ReadonlySet<string>> | undefined;

	constructor(
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();
		const changed = () => {
			this.hashes = undefined;
			this.patrolHashes = undefined;
			this._onDidChange.fire();
		};
		this._register(this.botsService.onDidChange(changed));
		this._register(this.paneTokenService.onDidChange(changed));
	}

	private botHashes(): Promise<ReadonlyMap<string, readonly string[]>> {
		this.hashes ??= (async () => {
			const map = new Map<string, readonly string[]>();
			for (const bot of this.botsService.snapshot.bots) {
				map.set(bot.id, await this.botsService.paneHashesOf(bot.id));
			}
			return map;
		})();
		return this.hashes;
	}

	private patrolPaneHashes(): Promise<ReadonlySet<string>> {
		this.patrolHashes ??= (async () => {
			const set = new Set<string>();
			for (const bot of this.botsService.snapshot.bots) {
				for (const hash of await this.botsService.paneHashesOf(bot.id, 'patrol')) {
					set.add(hash);
				}
			}
			return set;
		})();
		return this.patrolHashes;
	}

	async isPatrolPane(instanceId: number): Promise<boolean> {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		return token !== undefined && (await this.patrolPaneHashes()).has(await paradisBotPaneTokenHashInWindow(token));
	}

	async botFor(instanceId: number): Promise<string | undefined> {
		const token = this.paneTokenService.getTokenForInstance(instanceId);
		if (token === undefined) {
			return undefined;
		}
		const hash = await paradisBotPaneTokenHashInWindow(token);
		for (const [botId, hashes] of await this.botHashes()) {
			if (hashes.includes(hash)) {
				return botId;
			}
		}
		return undefined;
	}
}

/**
 * 見回りの口（定期実行の口を、Bot のページが読む形へ）。更新は定期実行と Bot の台帳の両方の知らせで読み直す。
 * 設定がオンになってから作る（作るまで定期実行の口にも Bot のサービスにも触れない）。
 */
class ParadisBotPatrolPort extends Disposable implements IParadisBotPatrolPort {

	readonly onDidChange: Event<void>;
	readonly tasks: IParadisBotTasksPort;

	constructor(
		@IParadisScheduledRunsClient private readonly scheduledRunsClient: IParadisScheduledRunsClient,
		@IParadisBotsService botsService: IParadisBotsService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
	) {
		super();
		this.onDidChange = Event.any(this.scheduledRunsClient.onDidChange, botsService.onDidChange);
		const client = this.scheduledRunsClient;
		this.tasks = {
			get: botId => client.getBotTasks(botId),
			set: (botId, input) => client.setBotTask(botId, input),
			remove: (botId, id) => client.deleteBotTask(botId, id),
			setEnabled: (id, enabled) => client.setEnabled(id, enabled),
			runNow: id => client.runNow(id),
			stop: runId => client.stop(runId),
			confirmBotTools: async (name, tools) => (await this.paradisDialogService.confirm(tools === 'readWeb' ? {
				message: localize('paradis.botTasks.confirmReadWeb', "定期実行「{0}」に手元のファイルを読ませますか?", name),
				detail: localize('paradis.botTasks.confirmReadWebDetail', "誰も見ていない時刻に、Bot のフォルダのファイルと Web の両方を使います。読んだページの文に誘導されて、手元のファイルの中身が Web へ送られるおそれがあります。調べて知らせるだけなら「Web だけ」で足ります。"),
				primaryButton: localize('paradis.botTasks.confirmReadWebAction', "読む＋Web にする"),
			} : {
				message: localize('paradis.botTasks.confirmBotTools', "定期実行「{0}」を Bot の権限で動かしますか?", name),
				detail: localize('paradis.botTasks.confirmBotToolsDetail', "誰も見ていない時刻に、会話と同じ権限で動きます。Web から読んだ文に誘導されて、ファイルの書き換えやコマンドを使うおそれがあります。調べて知らせるだけなら「Web だけ」で足ります。"),
				primaryButton: localize('paradis.botTasks.confirmBotToolsAction', "Bot の権限で動かす"),
			})).confirmed,
			confirmRemove: async name => (await this.paradisDialogService.confirm({
				message: localize('paradis.botTasks.confirmRemove', "定期実行「{0}」を消しますか?", name),
				primaryButton: localize('paradis.botTasks.confirmRemoveAction', "消す"),
			})).confirmed,
		};
	}

	get(botId: string) {
		return this.scheduledRunsClient.getBotPatrol(botId);
	}

	set(botId: string, input: IParadisBotPatrolInput) {
		return this.scheduledRunsClient.setBotPatrol(botId, input);
	}

	runNow(botId: string) {
		return this.scheduledRunsClient.runBotPatrolNow(botId);
	}
}

/** 設定がオンの間だけ、ページを重ね合わせの口へ登録する。 */
class ParadisBotPageContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisBotPage';

	private readonly registration = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.update();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.update();
			}
		}));
	}

	private update(): void {
		const enabled = this.configurationService.getValue<boolean>(PARADIS_BOTS_ENABLED_SETTING) === true;
		if (!enabled) {
			this.registration.clear();
			return;
		}
		if (this.registration.value !== undefined) {
			return;
		}
		const resolver = this.instantiationService.createInstance(ParadisBotPaneResolver);
		const patrol = this.instantiationService.createInstance(ParadisBotPatrolPort);
		const tasksRegistration = paradisRegisterBotTasksPort(patrol.tasks);
		const overlay = paradisRegisterEditorTerminalOverlay(container => this.instantiationService.createInstance(ParadisBotPage, container, resolver, patrol, undefined));
		this.registration.value = {
			dispose: () => {
				overlay.dispose();
				tasksRegistration.dispose();
				patrol.dispose();
				resolver.dispose();
			},
		};
	}
}

registerWorkbenchContribution2(ParadisBotPageContribution.ID, ParadisBotPageContribution, WorkbenchPhase.AfterRestored);
