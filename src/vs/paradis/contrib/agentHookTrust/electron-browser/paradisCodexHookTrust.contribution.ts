/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex の hook の信頼を、初回だけ利用者に確かめてから自動で付ける（画面側）。
//
// 設定 `paradis.agentHooks.codexTrust` が `ask`（既定）の間、Para Code が置いた hook に信頼が
// 付いていなければ、通知で1回だけ確かめる。「信頼する」なら設定を `auto` にして、その場で付ける。
// 以後は shared process が、Para Code が hook を置き直すたびに自動で付ける。「信頼しない」なら
// `off` にして二度と聞かない。どちらも選ばずに通知を閉じたら、次の起動でまた聞く。

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, paradisAgentHooksEnabled } from '../../agentBrowser/common/paradisAgentHooks.js';
import {
	IParadisCodexHookTrustGrantResult,
	IParadisCodexHookTrustStatus,
	PARADIS_CODEX_HOOK_TRUST_CHANNEL,
	PARADIS_CODEX_HOOK_TRUST_SETTING,
	paradisCodexHookTrustMode,
} from '../common/paradisCodexHookTrust.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_CODEX_HOOK_TRUST_SETTING]: {
			type: 'string',
			enum: ['ask', 'auto', 'off'],
			enumDescriptions: [
				// allow-any-unicode-next-line
				localize('paradis.agentHooks.codexTrust.ask', "信頼が付いていない hook を見つけたら、一度だけ確かめます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentHooks.codexTrust.auto', "Para Code が設置した hook に、設置し直すたびに自動で信頼を付けます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentHooks.codexTrust.off', "信頼を付けません。Codex の画面で自分で信頼してください。"),
			],
			default: 'ask',
			// hooks.json と config.toml は PC 全体で1つなので、ワークスペースごとに変えられても意味が無い
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentHooks.codexTrust', "Codex は、hook を使う前に「この hook を信頼しますか」と確かめます。Para Code が状態通知のために設置した hook（`~/.codex/hooks.json` と、使用量パネルで追加した Codex のアカウントのホーム `~/.codex-2` など・`paradis.limitsMonitor.codexHomes` で足したホームの `hooks.json`）に、Para Code が代わりに信頼を付けるかどうかです。対象は Para Code が設置した hook だけで、あなた自身の hook の信頼は変えません。信頼はそれぞれのホームの Codex の設定（`config.toml`）に Codex 自身が書き込みます。"),
		}
	}
});

/** 通知に並べるイベント名の上限（長くなりすぎないように）。 */
const MAX_EVENTS_IN_MESSAGE = 6;

class ParadisCodexHookTrustPrompt extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.codexHookTrustPrompt';

	/** hook の自動設置（shared process）が先に済むのを待つ。起動直後の復元とも重ねない。 */
	private static readonly STARTUP_DELAY_MS = 15_000;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.run().catch(error => this.logService.warn('[ParadisCodexHookTrust] could not check the Codex hook trust', error));
	}

	private get mode() {
		return paradisCodexHookTrustMode(this.configurationService.getValue(PARADIS_CODEX_HOOK_TRUST_SETTING));
	}

	private async run(): Promise<void> {
		if (this.mode !== 'ask') {
			return;
		}
		await timeout(ParadisCodexHookTrustPrompt.STARTUP_DELAY_MS);
		if (this._store.isDisposed || this.mode !== 'ask' || !paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING))) {
			return;
		}
		const channel = this.sharedProcessService.getChannel(PARADIS_CODEX_HOOK_TRUST_CHANNEL);
		// 窓が複数あっても、確かめるのは1つだけ。札は、実際に通知を出したときだけ使い切る
		// （調べられなかった・まだ hook が無かったときは返して、ほかの窓や次の機会に回す）
		if (!await channel.call<boolean>('claimPrompt')) {
			return;
		}
		let shown = false;
		try {
			// hook は全ての Codex ホーム（既定のホームとアカウント用のホーム）に置くので、全部を見る
			const statuses = await channel.call<IParadisCodexHookTrustStatus[]>('getStatusAll');
			const pending = statuses.filter(status => status.supported && status.pending.length > 0);
			if (pending.length > 0 && !this._store.isDisposed && this.mode === 'ask') {
				this.ask(pending);
				shown = true;
			}
		} finally {
			await channel.call('releasePrompt', shown);
		}
	}

	private ask(statuses: readonly IParadisCodexHookTrustStatus[]): void {
		const listings = statuses.flatMap(status => status.pending);
		const events = [...new Set(listings.map(listing => listing.eventName).filter(name => name.length > 0))];
		const eventText = events.length > MAX_EVENTS_IN_MESSAGE ? `${events.slice(0, MAX_EVENTS_IN_MESSAGE).join(', ')}, …` : events.join(', ');
		this.notificationService.prompt(
			Severity.Info,
			// allow-any-unicode-next-line
			localize('paradis.codexHookTrust.ask', "Para Code が状態通知のために設置した Codex の hook（{0} の {1} 件: {2}）を、信頼済みにしますか？ 信頼が無いと、Codex の状態表示と通知が働きません。信頼するのは Para Code が設置した hook だけで、以後 Para Code が設置し直したときも自動で信頼します（設定で変えられます）。", statuses.map(status => status.hooksPath).join(', '), listings.length, eventText),
			[
				{
					// allow-any-unicode-next-line
					label: localize('paradis.codexHookTrust.trust', "信頼する"),
					run: () => this.trust(),
				},
				{
					// allow-any-unicode-next-line
					label: localize('paradis.codexHookTrust.decline', "信頼しない"),
					run: () => this.configurationService.updateValue(PARADIS_CODEX_HOOK_TRUST_SETTING, 'off', ConfigurationTarget.USER),
				},
			],
			{ sticky: true },
		);
	}

	private async trust(): Promise<void> {
		await this.configurationService.updateValue(PARADIS_CODEX_HOOK_TRUST_SETTING, 'auto', ConfigurationTarget.USER);
		let results: IParadisCodexHookTrustGrantResult[];
		try {
			results = await this.sharedProcessService.getChannel(PARADIS_CODEX_HOOK_TRUST_CHANNEL).call<IParadisCodexHookTrustGrantResult[]>('grantAll');
		} catch (error) {
			this.logService.warn('[ParadisCodexHookTrust] grant failed', error);
			this.showFailed();
			return;
		}
		const failed = results.filter(result => result.outcome !== 'granted' && result.outcome !== 'already-trusted' && result.outcome !== 'nothing-installed' && result.outcome !== 'skipped');
		for (const result of failed) {
			this.logService.warn(`[ParadisCodexHookTrust] grant for ${result.codexHome} ended with ${result.outcome}: ${result.detail ?? ''}`);
		}
		if (failed.length > 0) {
			this.showFailed();
			return;
		}
		const granted = results.reduce((total, result) => total + (result.outcome === 'granted' ? result.grantedEvents.length : 0), 0);
		if (granted > 0) {
			// allow-any-unicode-next-line
			this.notificationService.info(localize('paradis.codexHookTrust.granted', "Para Code が設置した Codex の hook（{0} 件）を信頼済みにしました。", granted));
		}
	}

	private showFailed(): void {
		// allow-any-unicode-next-line
		this.notificationService.warn(localize('paradis.codexHookTrust.failed', "Codex の hook を信頼済みにできませんでした。Codex の画面（/hooks）から信頼してください。"));
	}
}

registerWorkbenchContribution2(ParadisCodexHookTrustPrompt.ID, ParadisCodexHookTrustPrompt, WorkbenchPhase.AfterRestored);
