/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザページ⇔ターミナルペイン紐付けUIのエントリポイント集約。
//  - コマンドパレット: Share / Unshare / Copy MCP Setup / Open Agent Browser Binding
//  - ブラウザエディタのツールバーボタン（MenuId.BrowserActionsToolbar、upstreamファイル変更なし）
//  - ステータスバー項目（バインドが1件以上あるときのみ表示）
//  - ターミナルグリッドセルのペインインジケータへの状態供給（paradisPaneIndicator.ts のホスト登録）
// バインド/解除の実処理は paradisAgentBrowserBindingModel.ts に集約されている。
// ISharedProcessService（electron-browser専用）に依存するため、
// paradis.electron-browser.contribution.ts 経由でデスクトップworkbenchにのみ登録される。

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { setParadisPaneIndicatorHost } from '../browser/paradisPaneIndicator.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { ParadisBindingDialog } from './paradisBindingDialog.js';
import { getParadisCdpUrl, getParadisClaudeSetupSnippet, getParadisCodexSetupSnippet } from './paradisMcpSnippets.js';

const CATEGORY = localize2('paradis.category', "Paradis");

/** アクティブなブラウザエディタのページが1つ以上のペインと共有中かどうか。 */
const PARADIS_ACTIVE_PAGE_SHARED = new RawContextKey<boolean>('paradisActivePageShared', false, localize('paradis.activePageShared', "Whether the active integrated browser page is shared with a terminal pane."));

const BROWSER_EDITOR_ACTIVE = ContextKeyExpr.equals('activeEditor', BrowserEditorInput.EDITOR_ID);

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

/**
 * バインディングダイアログの対象ページを解決する。優先順:
 * アクティブなブラウザエディタ → 指定ペインにバインド済みのページ → 既知のブラウザビュー。
 */
function resolveDialogPageModel(accessor: ServicesAccessor, instanceId?: number): IBrowserViewModel | undefined {
	const active = getActiveBrowserViewModel(accessor);
	if (active) {
		return active;
	}

	const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
	const knownViews = [...browserViewWorkbenchService.getKnownBrowserViews().values()];

	if (instanceId !== undefined) {
		const bindingModel = accessor.get(IParadisAgentBrowserBindingModel);
		const paneTokenService = accessor.get(IParadisPaneTokenService);
		const token = paneTokenService.getTokenForInstance(instanceId);
		const binding = token ? bindingModel.getBindingForToken(token) : undefined;
		if (binding) {
			const boundModel = knownViews.find(input => input.model?.id === binding.pageId)?.model;
			if (boundModel) {
				return boundModel;
			}
		}
	}

	return knownViews.find(input => !!input.model)?.model;
}

// --- ダイアログのオープン管理（同時に1つだけ） ---

let activeDialog: ParadisBindingDialog | undefined;

function openBindingDialog(accessor: ServicesAccessor, instanceId?: number): void {
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);

	const model = resolveDialogPageModel(accessor, instanceId);
	if (!model) {
		notificationService.warn(localize('paradis.dialog.noBrowserPage', "Open an integrated browser page first, then run this command again."));
		return;
	}

	activeDialog?.dispose();
	activeDialog = instantiationService.createInstance(
		ParadisBindingDialog,
		model,
		instanceId !== undefined ? { selectInstanceId: instanceId } : undefined,
	);
}

// --- コマンドパレット ---

class ParadisOpenBindingDialogAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.openBindingDialog';

	constructor() {
		super({
			id: ParadisOpenBindingDialogAction.ID,
			title: localize2('paradis.openBindingDialog', "Open Agent Browser Binding"),
			category: CATEGORY,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor, instanceId?: unknown): void {
		openBindingDialog(accessor, typeof instanceId === 'number' ? instanceId : undefined);
	}
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
		const bindingModel = accessor.get(IParadisAgentBrowserBindingModel);

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

		const shared = await bindingModel.bindPageToPane(model, pick.token);
		if (!shared) {
			return;
		}

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
		const bindingModel = accessor.get(IParadisAgentBrowserBindingModel);

		const model = getActiveBrowserViewModel(accessor);
		if (!model) {
			notificationService.warn(localize('paradis.unshare.noBrowserPage', "Open the shared integrated browser page as the active editor first."));
			return;
		}

		const removed = await bindingModel.unbindPage(model);

		notificationService.info(removed > 0
			? localize('paradis.unshare.done', "Removed {0} terminal pane binding(s) and stopped sharing the page with the agent.", removed)
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

		const cdpUrl = getParadisCdpUrl();

		interface ISetupPickItem extends IQuickPickItem {
			readonly snippet: string;
			readonly doneMessage: string;
		}
		const items: ISetupPickItem[] = [
			{
				label: 'Claude Code',
				description: localize('paradis.copyMcpSetup.claude.description', "Shell commands — paste into a Para Code terminal pane"),
				detail: localize('paradis.copyMcpSetup.claude.detail', "Registers para-browser (page reading) and chrome-devtools-mcp (full automation via the CDP gateway). One-time setup."),
				snippet: getParadisClaudeSetupSnippet(),
				doneMessage: localize('paradis.copyMcpSetup.claude.done', "Copied Claude Code setup commands. Paste them into a terminal pane. If a server is already registered, remove it first with \"claude mcp remove <name>\"."),
			},
			{
				label: 'Codex',
				description: localize('paradis.copyMcpSetup.codex.description', "TOML snippet — paste into ~/.codex/config.toml (not into a shell)"),
				detail: localize('paradis.copyMcpSetup.codex.detail', "Adds para-browser and chrome-devtools-mcp entries with the required env_vars forwarding."),
				snippet: getParadisCodexSetupSnippet(),
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

// --- ブラウザエディタのツールバーボタン ---
// upstreamの browserEditorChatFeatures.ts と同様、MenuId.BrowserActionsToolbar へ
// menu 付き Action2 を登録するだけで済む（upstreamファイルは変更しない）。
// 動的ラベルはメニュー登録では表現できないため、未共有/共有中で `when` の異なる2つの
// アクションを登録し、共有中側は toggled でハイライト表示する。

class ParadisToolbarShareAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.toolbarShare';

	constructor() {
		super({
			id: ParadisToolbarShareAction.ID,
			title: localize2('paradis.toolbarShare', "Share with Agent (Agent Browser Binding)"),
			icon: Codicon.plug,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: '3_tools',
				order: 0,
				when: PARADIS_ACTIVE_PAGE_SHARED.negate(),
			},
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	run(accessor: ServicesAccessor): void {
		openBindingDialog(accessor);
	}
}

class ParadisToolbarSharedAction extends Action2 {
	static readonly ID = 'paradis.agentBrowser.toolbarShared';

	constructor() {
		super({
			id: ParadisToolbarSharedAction.ID,
			title: localize2('paradis.toolbarShared', "Shared with Agent (Agent Browser Binding)"),
			icon: Codicon.plug,
			toggled: PARADIS_ACTIVE_PAGE_SHARED,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: '3_tools',
				order: 0,
				when: PARADIS_ACTIVE_PAGE_SHARED,
			},
			precondition: BROWSER_EDITOR_ACTIVE,
		});
	}

	run(accessor: ServicesAccessor): void {
		openBindingDialog(accessor);
	}
}

// --- ステータスバー + コンテキストキー + ペインインジケータのホスト ---

class ParadisAgentBrowserStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserStatus';

	private readonly _statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		const activePageShared = PARADIS_ACTIVE_PAGE_SHARED.bindTo(contextKeyService);
		const update = () => {
			this._updateStatusbar();
			const model = this.editorService.activeEditor instanceof BrowserEditorInput ? this.editorService.activeEditor.model : undefined;
			activePageShared.set(!!model && this.bindingModel.getBindingsForPage(model.id).length > 0);
		};

		this._register(this.bindingModel.onDidChange(update));
		this._register(this.editorService.onDidActiveEditorChange(update));
		update();

		// ターミナルグリッドセルの接続インジケータへ状態を供給する（vs/sessions側はこのホスト
		// 経由でのみ状態を知る。デスクトップ以外ではホスト未登録のままインジケータ非表示）。
		setParadisPaneIndicatorHost({
			getPaneIndicatorState: instanceId => {
				const token = this.paneTokenService.getTokenForInstance(instanceId);
				return token && this.bindingModel.getBindingForToken(token) ? 'bound' : 'unbound';
			},
			getPaneIndicatorTooltip: instanceId => {
				const token = this.paneTokenService.getTokenForInstance(instanceId);
				const binding = token ? this.bindingModel.getBindingForToken(token) : undefined;
				return binding
					// allow-any-unicode-next-line
					? localize('paradis.paneIndicator.bound', "このペインは「{0}」を共有中 — クリックで管理", binding.pageInfo.title || binding.pageInfo.url)
					// allow-any-unicode-next-line
					: localize('paradis.paneIndicator.unbound', "ブラウザページ未共有 — クリックでエージェント共有を設定");
			},
			onDidChangeState: this.bindingModel.onDidChange,
			openBindingDialog: instanceId => {
				this.instantiationService.invokeFunction(accessor => openBindingDialog(accessor, instanceId));
			},
		});
		this._register({ dispose: () => setParadisPaneIndicatorHost(undefined) });
	}

	private _updateStatusbar(): void {
		const count = this.bindingModel.bindings.length;
		if (count === 0) {
			this._statusbarEntry.clear();
			return;
		}
		const text = `$(plug) ${localize('paradis.statusbar.text', "Agent Browser: {0} active", count)}`;
		const entry = {
			name: localize('paradis.statusbar.name', "Agent Browser Binding"),
			text,
			ariaLabel: text,
			// allow-any-unicode-next-line
			tooltip: localize('paradis.statusbar.tooltip', "ブラウザページ⇔ターミナルペインのバインディング（クリックで管理）"),
			command: ParadisOpenBindingDialogAction.ID,
		};
		if (this._statusbarEntry.value) {
			this._statusbarEntry.value.update(entry);
		} else {
			this._statusbarEntry.value = this.statusbarService.addEntry(entry, 'paradis.agentBrowser', StatusbarAlignment.RIGHT, 50);
		}
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

registerAction2(ParadisOpenBindingDialogAction);
registerAction2(ParadisShareBrowserPageWithTerminalPaneAction);
registerAction2(ParadisUnshareBrowserPageAction);
registerAction2(ParadisCopyMcpSetupCommandAction);
registerAction2(ParadisToolbarShareAction);
registerAction2(ParadisToolbarSharedAction);
registerWorkbenchContribution2(ParadisAgentBrowserStatusContribution.ID, ParadisAgentBrowserStatusContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ParadisPaneShellSyncContribution.ID, ParadisPaneShellSyncContribution, WorkbenchPhase.AfterRestored);
