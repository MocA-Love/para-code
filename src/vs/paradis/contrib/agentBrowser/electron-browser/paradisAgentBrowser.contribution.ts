/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペイン紐付けの最小UI（コマンドパレットのみ、Phase A+B）。
// リッチなUI（モーダル等）はPhase Cで別途実装する。
// ISharedProcessService（electron-browser専用）に依存するため、
// paradis.electron-browser.contribution.ts 経由でデスクトップworkbenchにのみ登録される。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { IParadisPaneBinding, PARADIS_AGENT_BROWSER_CHANNEL, PARADIS_CDP_URL_ENV_VAR, PARADIS_MCP_DEFAULT_PORT, PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_PANE_TOKEN_ENV_VAR } from '../common/paradisAgentBrowser.js';

const CATEGORY = localize2('paradis.category', "Paradis");

interface ITerminalPanePickItem extends IQuickPickItem {
	readonly token: string;
}

/** アクティブエディタがブラウザビューであればその解決済みモデルを返す。 */
function getActiveBrowserViewModel(accessor: ServicesAccessor): IBrowserViewModel | undefined {
	const editorService = accessor.get(IEditorService);
	const input = editorService.activeEditor;
	if (input instanceof BrowserEditorInput) {
		return input.model;
	}
	return undefined;
}

class ParadisShareBrowserPageWithTerminalPaneAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.sharePageWithTerminalPane';

	constructor() {
		super({
			id: ParadisShareBrowserPageWithTerminalPaneAction.ID,
			title: localize2('paradis.sharePageWithTerminalPane', "Share Browser Page with Terminal Pane"),
			category: CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const paneTokenService = accessor.get(IParadisPaneTokenService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const sharedProcessService = accessor.get(ISharedProcessService);

		const model = getActiveBrowserViewModel(accessor);
		if (!model) {
			notificationService.warn(localize('paradis.share.noBrowserPage', "Open an integrated browser page as the active editor first."));
			return;
		}

		const picks: ITerminalPanePickItem[] = [];
		for (const instance of terminalService.instances) {
			const token = paneTokenService.getTokenForInstance(instance.instanceId);
			if (token) {
				picks.push({
					token,
					label: instance.title,
					description: localize('paradis.share.terminalId', "Terminal ID: {0}", instance.instanceId),
				});
			}
		}
		if (picks.length === 0) {
			notificationService.warn(localize('paradis.share.noTerminals', "No terminal panes with a pane token were found. Open a new terminal and try again."));
			return;
		}

		const pick = await quickInputService.pick(picks, {
			placeHolder: localize('paradis.share.pickTerminal', "Select the terminal pane to share \"{0}\" with", model.title || model.url),
		});
		if (!pick) {
			return;
		}

		// 既存の共有フロー（確認ダイアログ + startTrackingPage）をそのまま使う。
		// ダイアログが二重に出ないよう、独自の確認は挟まない。
		const shared = await model.setSharedWithAgent(true);
		if (!shared) {
			return;
		}

		await sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL)
			.call('bind', [pick.token, model.id, { url: model.url, title: model.title }]);

		notificationService.info(localize(
			'paradis.share.done',
			"Shared \"{0}\" with terminal pane \"{1}\". Agent CLIs in that pane can now access the page via the para-browser MCP server (see \"Paradis: Copy MCP Setup Command\").",
			model.title || model.url,
			pick.label,
		));
	}
}

class ParadisUnshareBrowserPageAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.unsharePage';

	constructor() {
		super({
			id: ParadisUnshareBrowserPageAction.ID,
			title: localize2('paradis.unsharePage', "Unshare Browser Page"),
			category: CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const sharedProcessService = accessor.get(ISharedProcessService);

		const model = getActiveBrowserViewModel(accessor);
		if (!model) {
			notificationService.warn(localize('paradis.unshare.noBrowserPage', "Open the shared integrated browser page as the active editor first."));
			return;
		}

		const channel = sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
		const bindings = await channel.call<IParadisPaneBinding[]>('listBindings');
		const matching = bindings.filter(binding => binding.pageId === model.id);
		for (const binding of matching) {
			await channel.call('unbind', [binding.token]);
		}

		// どのペインにもバインドされなくなったらエージェント共有自体も解除する。
		await model.setSharedWithAgent(false);

		notificationService.info(matching.length > 0
			? localize('paradis.unshare.done', "Removed {0} terminal pane binding(s) and stopped sharing the page with the agent.", matching.length)
			: localize('paradis.unshare.noBindings', "The page had no terminal pane bindings. Stopped sharing it with the agent."));
	}
}

class ParadisCopyMcpSetupCommandAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.copyMcpSetupCommand';

	constructor() {
		super({
			id: ParadisCopyMcpSetupCommandAction.ID,
			title: localize2('paradis.copyMcpSetupCommand', "Copy MCP Setup Command"),
			category: CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);

		const shimPath = FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js').fsPath;
		// TOML basic string ではバックスラッシュがエスケープ扱いになるため、Windowsパスを考慮して二重化する
		const shimPathToml = shimPath.replace(/\\/g, '\\\\');
		const cdpUrl = `http://127.0.0.1:${PARADIS_MCP_DEFAULT_PORT}/cdp`;

		// Claude Code向け: シェルにそのまま貼れる純粋なコマンドのみ（コメント行はzshの既定で
		// interactivecomments が無効だとエラーになるため一切含めない）。
		// `${VAR:-default}` はClaude Codeが接続時に展開する（Para Codeペイン外では固定ポートに
		// フォールバックするので設定パースが壊れない）。シェルの事前展開を防ぐシングルクォート必須。
		const claudeSnippet = [
			`claude mcp add para-browser -- node "${shimPath}"`,
			`claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl='\${${PARADIS_CDP_URL_ENV_VAR}:-${cdpUrl}}'`,
			'',
		].join('\n');

		// Codex向け: config.toml に貼るスニペット（TOMLは#コメント可、シェルには貼らない前提）。
		const codexSnippet = [
			'# Add to ~/.codex/config.toml',
			'[mcp_servers.para-browser]',
			'command = "node"',
			`args = ["${shimPathToml}"]`,
			`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}"]`,
			'',
			'[mcp_servers.chrome-devtools]',
			'command = "npx"',
			`args = ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "${cdpUrl}"]`,
			`env_vars = ["${PARADIS_PANE_TOKEN_ENV_VAR}", "${PARADIS_MCP_PORT_FILE_ENV_VAR}", "${PARADIS_CDP_URL_ENV_VAR}"]`,
			'',
		].join('\n');

		interface ISetupPickItem extends IQuickPickItem {
			readonly snippet: string;
			readonly doneMessage: string;
		}
		const items: ISetupPickItem[] = [
			{
				label: 'Claude Code',
				description: localize('paradis.copyMcpSetup.claude.description', "Shell commands — paste into a Para Code terminal pane"),
				detail: localize('paradis.copyMcpSetup.claude.detail', "Registers para-browser (page reading) and chrome-devtools-mcp (full automation via the CDP gateway). One-time setup."),
				snippet: claudeSnippet,
				doneMessage: localize('paradis.copyMcpSetup.claude.done', "Copied Claude Code setup commands. Paste them into a terminal pane. If a server is already registered, remove it first with \"claude mcp remove <name>\"."),
			},
			{
				label: 'Codex',
				description: localize('paradis.copyMcpSetup.codex.description', "TOML snippet — paste into ~/.codex/config.toml (not into a shell)"),
				detail: localize('paradis.copyMcpSetup.codex.detail', "Adds para-browser and chrome-devtools-mcp entries with the required env_vars forwarding."),
				snippet: codexSnippet,
				doneMessage: localize('paradis.copyMcpSetup.codex.done', "Copied the Codex config.toml snippet. Paste it into ~/.codex/config.toml (do not paste it into a shell)."),
			},
			{
				label: 'browser-use / other CDP tools',
				description: localize('paradis.copyMcpSetup.cdpUrl.description', "CDP URL only"),
				detail: cdpUrl,
				snippet: cdpUrl,
				doneMessage: localize('paradis.copyMcpSetup.cdpUrl.done', "Copied the CDP gateway URL. Pass it as the tool's CDP endpoint (e.g. browser-use --cdp-url)."),
			},
		];

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('paradis.copyMcpSetup.placeholder', "Which agent CLI do you want to set up?"),
		});
		if (!picked) {
			return;
		}

		await clipboardService.writeText(picked.snippet);
		notificationService.info(picked.doneMessage);
	}
}

/**
 * 各ターミナルペインの「ペイントークン ⇔ シェルPID」対応表をshared processへ同期する。
 * CDPゲートウェイが接続元プロセスの祖先チェーンと突合して呼び出し元ペインを識別するために使う
 * （他プロセスのenvを読めないWindowsでは、これがCDP経路の主要な識別手段になる）。
 */
class ParadisPaneShellSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisPaneShellSync';

	private _timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) {
		super();
		this._register(this.paneTokenService.onDidChange(() => this._handleChange()));
		this._handleChange();
	}

	private _handleChange(): void {
		// processId は PTY 起動後に確定するため、各インスタンスの processReady 後にも再同期する
		// （解決済みPromiseへの then は蓄積しないので毎回回して問題ない）。
		for (const instance of this.terminalService.instances) {
			void instance.processReady.then(() => this._scheduleSync(), () => { /* 起動失敗は無視 */ });
		}
		this._scheduleSync();
	}

	private _scheduleSync(): void {
		if (this._timer !== undefined || this._store.isDisposed) {
			return;
		}
		this._timer = setTimeout(() => {
			this._timer = undefined;
			if (!this._store.isDisposed) {
				void this._sync();
			}
		}, 100);
	}

	private async _sync(): Promise<void> {
		const entries: { token: string; shellPid: number }[] = [];
		for (const instance of this.terminalService.instances) {
			const token = this.paneTokenService.getTokenForInstance(instance.instanceId);
			const shellPid = instance.processId;
			if (token && typeof shellPid === 'number' && shellPid > 0) {
				entries.push({ token, shellPid });
			}
		}
		try {
			await this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call('syncPaneShells', [entries]);
		} catch {
			// shared process 未起動等。次の変化時に再同期される。
		}
	}

	override dispose(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		super.dispose();
	}
}

registerAction2(ParadisShareBrowserPageWithTerminalPaneAction);
registerAction2(ParadisUnshareBrowserPageAction);
registerAction2(ParadisCopyMcpSetupCommandAction);
registerWorkbenchContribution2(ParadisPaneShellSyncContribution.ID, ParadisPaneShellSyncContribution, WorkbenchPhase.AfterRestored);
