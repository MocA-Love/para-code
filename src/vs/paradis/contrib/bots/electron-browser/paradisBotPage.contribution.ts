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
import { IParadisScheduledRunsClient } from '../../scheduledRuns/electron-browser/paradisScheduledRunsClient.js';
import { IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';

/** どのペインが Bot のものかを、ペインのトークンのハッシュで照らす。Bot ごとのハッシュは台帳が変わるまで使い回す。 */
class ParadisBotPaneResolver extends Disposable implements IParadisBotPaneResolver {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private hashes: Promise<ReadonlyMap<string, readonly string[]>> | undefined;

	constructor(
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();
		const changed = () => {
			this.hashes = undefined;
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

/** 設定がオンの間だけ、ページを重ね合わせの口へ登録する。 */
class ParadisBotPageContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisBotPage';

	private readonly registration = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisScheduledRunsClient private readonly scheduledRunsClient: IParadisScheduledRunsClient,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
	) {
		super();
		this.update();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING)) {
				this.update();
			}
		}));
	}

	/** 見回りの口（定期実行の口を、Bot のページが読む形へ）。更新は定期実行と Bot の台帳の両方の知らせで読み直す。 */
	private patrolPort(): IParadisBotPatrolPort {
		return {
			onDidChange: Event.any(this.scheduledRunsClient.onDidChange, this.botsService.onDidChange),
			get: botId => this.scheduledRunsClient.getBotPatrol(botId),
			set: (botId, input) => this.scheduledRunsClient.setBotPatrol(botId, input),
			runNow: botId => this.scheduledRunsClient.runBotPatrolNow(botId),
		};
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
		const patrol = this.patrolPort();
		const overlay = paradisRegisterEditorTerminalOverlay(container => this.instantiationService.createInstance(ParadisBotPage, container, resolver, patrol));
		this.registration.value = {
			dispose: () => {
				overlay.dispose();
				resolver.dispose();
			},
		};
	}
}

registerWorkbenchContribution2(ParadisBotPageContribution.ID, ParadisBotPageContribution, WorkbenchPhase.AfterRestored);
