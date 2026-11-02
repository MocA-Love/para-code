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
//
// SSH の接続先の Codex の hook（paradisRemoteAgentHooks.contribution.ts が置く）には、設定が `off` で
// なければ（既定の `ask` でも）確かめずに信頼を付ける（2026-10 の判断。接続先の hook は Para Code が置いた
// ものを接続先の REH が数えて付ける。node/paradisRemoteCodexHookTrust.server.ts）。ここでは手元の hook
// だけを確かめる。
//
// コマンド `paradis.agentHooks.showCodexHookStatus`（設定ダイアログの「状態を確認…」）で、手元と接続先の
// 信頼の状態と、接続先からの戻り経路（hook が届く道）の状態を出す。

import { timeout } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, paradisAgentHooksEnabled } from '../../agentBrowser/common/paradisAgentHooks.js';
import { PARADIS_REMOTE_AGENT_TUNNEL_SETTING } from '../../agentBrowser/electron-browser/paradisRemoteAgentTunnel.contribution.js';
import {
	IParadisCodexHookTrustGrantResult,
	IParadisCodexHookTrustStatus,
	PARADIS_CODEX_HOOK_TRUST_CHANNEL,
	PARADIS_CODEX_HOOK_TRUST_SETTING,
	PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL,
	PARADIS_SHOW_CODEX_HOOK_STATUS_COMMAND_ID,
	paradisCodexHookTrustMode,
} from '../common/paradisCodexHookTrust.js';
import { IParadisCodexHookStatusRow, paradisCodexHookStateText, paradisCodexHookStatusMarkdown } from '../browser/paradisCodexHookStatusTable.js';

/** SSH の接続先か（接続先の hook は SSH の接続先にしか置かない）。 */
function isSshWindow(remoteAuthority: string | undefined): remoteAuthority is string {
	return remoteAuthority?.startsWith('ssh-remote+') === true;
}

/** 接続先の Codex の hook の信頼の状態。SSH でない・古い REH でチャネルが無いときは undefined。 */
async function remoteCodexHookTrustStatuses(remoteAgentService: IRemoteAgentService, remoteAuthority: string | undefined): Promise<IParadisCodexHookTrustStatus[] | undefined> {
	const connection = remoteAgentService.getConnection();
	if (!isSshWindow(remoteAuthority) || connection === null) {
		return undefined;
	}
	try {
		return await connection.getChannel(PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL).call<IParadisCodexHookTrustStatus[]>('getStatus');
	} catch {
		return undefined;
	}
}

/** 接続先の Codex の hook に信頼を付ける。付けられなければ undefined。 */
async function grantRemoteCodexHookTrust(remoteAgentService: IRemoteAgentService, remoteAuthority: string | undefined): Promise<IParadisCodexHookTrustGrantResult[] | undefined> {
	const connection = remoteAgentService.getConnection();
	if (!isSshWindow(remoteAuthority) || connection === null) {
		return undefined;
	}
	return connection.getChannel(PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL).call<IParadisCodexHookTrustGrantResult[]>('grant');
}

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
				localize('paradis.agentHooks.codexTrust.ask', "信頼が付いていない hook を見つけたら、一度だけ確かめます。SSH の接続先に設置した hook には、確かめずに信頼を付けます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentHooks.codexTrust.auto', "Para Code が設置した hook に、設置し直すたびに自動で信頼を付けます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentHooks.codexTrust.off', "信頼を付けません。Codex の画面で自分で信頼してください。"),
			],
			default: 'ask',
			// hooks.json と config.toml は PC 全体で1つなので、ワークスペースごとに変えられても意味が無い
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentHooks.codexTrust', "Codex は、hook を使う前に「この hook を信頼しますか」と確かめます。Para Code が状態通知のために設置した hook（`~/.codex/hooks.json` と、使用量パネルで追加した Codex のアカウントのホーム `~/.codex-2` など・`paradis.limitsMonitor.codexHomes` で足したホームの `hooks.json`）に、Para Code が代わりに信頼を付けるかどうかです。対象は Para Code が設置した hook だけで、あなた自身の hook の信頼は変えません。信頼はそれぞれのホームの Codex の設定（`config.toml`）に書き込みます。SSH の接続先に設置した hook には、`off` にしない限り（`ask` でも）確かめずに信頼を付けます。"),
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
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this.run().catch(error => this.logService.warn('[ParadisCodexHookTrust] could not check the Codex hook trust', error));
		// 設定を `off` から戻したら、接続先にもその場で付ける（次に hook を置き直すまで待たせない）
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_CODEX_HOOK_TRUST_SETTING) && this.mode !== 'off'
				&& paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING))) {
				grantRemoteCodexHookTrust(this.remoteAgentService, this.environmentService.remoteAuthority)
					.catch(error => this.logService.trace('[ParadisCodexHookTrust] could not trust the Codex hooks on the host', error));
			}
		}));
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
		// 通知は 1 文にし、対象のパス・イベントと、信頼の意味は「詳細」で開く。
		// allow-any-unicode-next-line
		const message = localize('paradis.codexHookTrust.askShort', "Codex の状態表示に使う hook（{0} 件）を信頼済みにしますか？", listings.length);
		// allow-any-unicode-next-line
		const detail = localize('paradis.codexHookTrust.askDetail', "対象: {0} の {1} 件（{2}）\n\n信頼が無いと、Codex の状態表示と通知が働きません。信頼するのは Para Code が設置した hook だけで、以後 Para Code が設置し直したときも自動で信頼します（設定で変えられます）。", statuses.map(status => status.hooksPath).join(', '), listings.length, eventText);
		this.notificationService.prompt(
			Severity.Info,
			message,
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
				{
					// allow-any-unicode-next-line
					label: localize('paradis.codexHookTrust.details', "詳細"),
					run: () => void this.dialogService.info(message, detail),
					keepOpen: true,
				},
			],
			{ sticky: true },
		);
	}

	private trust(): Promise<void> {
		return grantCodexHookTrust(this.configurationService, this.sharedProcessService, this.logService, this.notificationService);
	}
}

/** 信頼の付け方を「自動」にして、Para Code が置いた hook に信頼を付ける（通知と状態のダイアログの「信頼する」）。 */
async function grantCodexHookTrust(configurationService: IConfigurationService, sharedProcessService: ISharedProcessService, logService: ILogService, notificationService: INotificationService): Promise<void> {
	const showFailed = () => {
		// allow-any-unicode-next-line
		notificationService.warn(localize('paradis.codexHookTrust.failed', "Codex の hook を信頼済みにできませんでした。Codex の画面（/hooks）から信頼してください。"));
	};
	await configurationService.updateValue(PARADIS_CODEX_HOOK_TRUST_SETTING, 'auto', ConfigurationTarget.USER);
	let results: IParadisCodexHookTrustGrantResult[];
	try {
		results = await sharedProcessService.getChannel(PARADIS_CODEX_HOOK_TRUST_CHANNEL).call<IParadisCodexHookTrustGrantResult[]>('grantAll');
	} catch (error) {
		logService.warn('[ParadisCodexHookTrust] grant failed', error);
		showFailed();
		return;
	}
	const failed = results.filter(result => result.outcome !== 'granted' && result.outcome !== 'already-trusted' && result.outcome !== 'nothing-installed' && result.outcome !== 'skipped');
	for (const result of failed) {
		logService.warn(`[ParadisCodexHookTrust] grant for ${result.codexHome} ended with ${result.outcome}: ${result.detail ?? ''}`);
	}
	if (failed.length > 0) {
		showFailed();
		return;
	}
	const granted = results.reduce((total, result) => total + (result.outcome === 'granted' ? result.grantedEvents.length : 0), 0);
	if (granted > 0) {
		// allow-any-unicode-next-line
		notificationService.info(localize('paradis.codexHookTrust.granted', "Para Code が設置した Codex の hook（{0} 件）を信頼済みにしました。", granted));
	}
}

registerWorkbenchContribution2(ParadisCodexHookTrustPrompt.ID, ParadisCodexHookTrustPrompt, WorkbenchPhase.AfterRestored);

function describeTrustMode(mode: ReturnType<typeof paradisCodexHookTrustMode>): string {
	switch (mode) {
		// allow-any-unicode-next-line
		case 'auto': return localize('paradis.codexHookStatus.mode.auto', "信頼の付け方: 自動で付ける（この PC と接続先）");
		// allow-any-unicode-next-line
		case 'off': return localize('paradis.codexHookStatus.mode.off', "信頼の付け方: 付けない（この PC と接続先）");
		// allow-any-unicode-next-line
		default: return localize('paradis.codexHookStatus.mode.ask', "信頼の付け方: この PC は初回に確かめる。接続先には自動で付ける");
	}
}

/** 1 つの場所（この PC か接続先）の行。読めなかったとき・ホームが無いときも 1 行にする。 */
function trustStatusRows(place: string, statuses: readonly IParadisCodexHookTrustStatus[] | undefined, remote: boolean): IParadisCodexHookStatusRow[] {
	if (statuses === undefined) {
		return [{
			place, path: '', state: remote
				// allow-any-unicode-next-line
				? localize('paradis.codexHookStatus.remoteUnknown', "調べられませんでした（接続先の Para Code のサーバーが古い可能性があります）")
				// allow-any-unicode-next-line
				: localize('paradis.codexHookStatus.localUnknown', "調べられませんでした"),
		}];
	}
	if (statuses.length === 0) {
		// allow-any-unicode-next-line
		return [{ place, path: '', state: localize('paradis.codexHookStatus.noHome', "Codex のホームがありません") }];
	}
	return statuses.map(status => ({ place, path: status.hooksPath, state: paradisCodexHookStateText(status) }));
}

function describeTunnel(enabled: boolean, port: number | undefined): string {
	if (!enabled) {
		// allow-any-unicode-next-line
		return localize('paradis.codexHookStatus.tunnelOffState', "設定でオフになっています");
	}
	return port !== undefined
		// allow-any-unicode-next-line
		? localize('paradis.codexHookStatus.tunnelUpState', "張れています（接続先のポート {0}）", port)
		// allow-any-unicode-next-line
		: localize('paradis.codexHookStatus.tunnelDownState', "張れていません（設定「リモート (SSH)」の戻り経路を確かめてください）");
}

class ParadisShowCodexHookStatusAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_SHOW_CODEX_HOOK_STATUS_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.codexHookStatus.command', "Codex の hook の信頼と接続先の経路を確認"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const sharedProcessService = accessor.get(ISharedProcessService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		const configurationService = accessor.get(IConfigurationService);
		const dialogService = accessor.get(IDialogService);
		const commandService = accessor.get(ICommandService);
		const logService = accessor.get(ILogService);
		const notificationService = accessor.get(INotificationService);
		const remoteAuthority = environmentService.remoteAuthority;
		const tunnelEnabled = configurationService.getValue<boolean>(PARADIS_REMOTE_AGENT_TUNNEL_SETTING) === true;

		const [local, remote, tunnelPort] = await Promise.all([
			sharedProcessService.getChannel(PARADIS_CODEX_HOOK_TRUST_CHANNEL).call<IParadisCodexHookTrustStatus[]>('getStatusAll').catch(() => undefined),
			remoteCodexHookTrustStatuses(remoteAgentService, remoteAuthority),
			// 今張れているかを見るだけ（状態を見るだけのコマンドで張りに行かない）
			isSshWindow(remoteAuthority) && tunnelEnabled
				? sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<number | undefined>('getRemoteAgentTunnelPort', [remoteAuthority]).catch(() => undefined)
				: Promise.resolve(undefined),
		]);

		// 場所 × hooks.json × 状態の表にする（行を改行で並べた文字列にしない）。
		const rows: IParadisCodexHookStatusRow[] = [
			// allow-any-unicode-next-line
			...trustStatusRows(localize('paradis.codexHookStatus.localPlace', "この PC"), local, false),
		];
		if (isSshWindow(remoteAuthority)) {
			rows.push(
				// allow-any-unicode-next-line
				...trustStatusRows(localize('paradis.codexHookStatus.remotePlace', "接続先"), remote, true),
				// allow-any-unicode-next-line
				{ place: localize('paradis.codexHookStatus.tunnelPlace', "接続先から hook が届く経路"), path: '', state: describeTunnel(tunnelEnabled, tunnelPort) },
			);
		}
		const localPending = (local ?? []).some(status => status.supported && status.pending.length > 0);
		const { result } = await dialogService.prompt<'settings' | 'trust' | undefined>({
			type: 'info',
			// allow-any-unicode-next-line
			message: localize('paradis.codexHookStatus.title', "Codex の hook の状態"),
			detail: describeTrustMode(paradisCodexHookTrustMode(configurationService.getValue(PARADIS_CODEX_HOOK_TRUST_SETTING))),
			buttons: [
				// allow-any-unicode-next-line
				{ label: localize({ key: 'paradis.codexHookStatus.openSettings', comment: ['&& denotes a mnemonic'] }, "設定を開く(&&S)"), run: () => 'settings' as const },
				// この PC に未信頼の hook があるときだけ、ここから信頼を付けられる
				...(localPending ? [{
					// allow-any-unicode-next-line
					label: localize({ key: 'paradis.codexHookStatus.trust', comment: ['&& denotes a mnemonic'] }, "信頼する(&&T)"), run: () => 'trust' as const,
				}] : []),
			],
			cancelButton: localize('paradis.codexHookStatus.close', "OK"),
			custom: { markdownDetails: [{ markdown: new MarkdownString(paradisCodexHookStatusMarkdown(rows)) }] },
		});
		if (result === 'trust') {
			await grantCodexHookTrust(configurationService, sharedProcessService, logService, notificationService);
		} else if (result === 'settings') {
			await commandService.executeCommand('workbench.action.openSettings', PARADIS_CODEX_HOOK_TRUST_SETTING);
		}
	}
}

registerAction2(ParadisShowCodexHookStatusAction);
