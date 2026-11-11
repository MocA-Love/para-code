/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タブの「＋」の横の ⌄ から開くランチャー本体（Q570 の案 A: 一覧の横に起動パネル）。
//
// 左の一覧に、検索欄・新しいターミナル（› で upstream のプロファイルの一覧）・新しいブラウザのタブ・
// シミュレータを開く（› で起動している iOS のシミュレータと動いている Android。行を押すと全部の端末の一覧）・
// 新しい Markdown・新しいファイル（› で拡張機能が `file/newFile` に足した項目）・エージェント・
// エージェントの設定を並べる。エージェントの行を押すと横に起動パネルを出し、モデル・エフォート・権限・
// 最初の指示を選んで「ターミナルで起動」か「チャットで起動」する。行を押しただけでは起動しない（Q570 の 4）。
//
// 起動の中身は既存のものだけを使う: エージェントの定義とモデル一覧は IParadisAgentModelCatalogService、
// 起動は paradisLaunchAgentInWorkspace（モバイル・launch_agent・定期実行と同じ道）、チャット表示への切り替えは
// IParadisAgentChatService.openChatWhenReady。ターミナルのプロファイルの一覧は upstream の
// getTerminalActionBarArgs をそのまま呼ぶので、拡張機能が足したプロファイルも今の ⌄ と同じ並びで出る。
//
// IContextMenuService を使わず HTML で描く（macOS 既定の window.menuStyle: native では OS のメニューになり、
// 起動パネルを横に出せないため）。内蔵ブラウザの上に重なっても隠れないよう、どの面にも
// overlayManager.ts の一覧にある共通のクラス `paradis-overlay-popover` を付ける。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { paradisCloseWhenModalOpens } from '../../../browser/paradisAnchoredPopover.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { NEW_UNTITLED_FILE_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileConstants.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { getTerminalActionBarArgs } from '../../../../workbench/contrib/terminal/browser/terminalMenus.js';
import { ITerminalProfileResolverService, ITerminalProfileService } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisAgentChatService } from '../../agentChat/browser/paradisAgentChatService.js';
import { PARADIS_AGENT_CHAT_ENABLED_SETTING } from '../../agentChat/common/paradisAgentChat.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { ParadisAgentLogo, paradisAgentLogoForId } from '../../../common/paradisAgentLogoPaths.js';
import { IParadisSimulatorClient } from '../../simulator/electron-browser/paradisSimulatorClient.js';
import { PARADIS_SIMULATOR_OPEN_ANDROID_COMMAND_ID, PARADIS_SIMULATOR_OPEN_COMMAND_ID } from '../../simulator/electron-browser/paradisSimulatorScreenOpener.js';
import { PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID } from '../../paradisSettings/electron-browser/paradisSettingsDialog.contribution.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentCommandTemplate, PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import {
	IParadisTabLauncherChoice,
	paradisMatchLauncherAgents,
	paradisNormalizeLaunchChoice,
	paradisParseStoredLaunchChoices,
	paradisRestoreLaunchChoice,
	paradisStoreLaunchChoice,
	IParadisTabLauncherDevice,
	ParadisTabLauncherDeviceCache,
	paradisTabLauncherAgents,
	paradisTabLauncherDevices,
	paradisTabLauncherEfforts,
	paradisTabLauncherOffersChat,
	paradisTabLauncherRoot,
	paradisTabLauncherUrl,
} from '../common/paradisTabLauncher.js';

const $ = dom.$;

/** 「シミュレータを開く ›」の端末の一覧（ランチャーを開き直しても 30 秒は取り直さない）。 */
const deviceCache = new ParadisTabLauncherDeviceCache<readonly IParadisTabLauncherDevice[]>();

/** 開いているタブを検索で出す件数（Orca と同じ 4 件）。 */
const OPEN_EDITOR_RESULT_LIMIT = 4;
/**
 * 「チャットで起動」でチャット表示へ切り替えるまで待つ時間。会話は最初のやりとりで見つかるので、
 * 指示を空のまま起動したときは利用者が最初の文を打つまで待つ。
 */
const CHAT_OPEN_TIMEOUT_MS = 10 * 60 * 1000;
/** Para Code の設定の「エージェント」の節。 */
const SETTINGS_AGENT_SECTION_ID = 'psd-sec-agent';

const STR_SEARCH = localize('paradis.tabLauncher.search', "タブ・エージェント・URL を探す…");
const STR_NEW_TERMINAL = localize('paradis.tabLauncher.newTerminal', "新しいターミナル");
const STR_NEW_TERMINAL_MORE = localize('paradis.tabLauncher.newTerminalMore', "プロファイルと分割");
const STR_NEW_BROWSER = localize('paradis.tabLauncher.newBrowser', "新しいブラウザのタブ");
const STR_OPEN_SIMULATOR = localize('paradis.tabLauncher.openSimulator', "シミュレータを開く");
const STR_OPEN_SIMULATOR_MORE = localize('paradis.tabLauncher.openSimulatorMore', "起動している端末");
const STR_ALL_DEVICES = localize('paradis.tabLauncher.allDevices', "すべての端末…");
const STR_NO_RUNNING_DEVICE = localize('paradis.tabLauncher.noRunningDevice', "起動している端末はありません");
const STR_DEVICE_LABEL = (name: string, runtime: string) => localize('paradis.tabLauncher.deviceLabel', "{0}（{1}）", name, runtime);
const STR_NEW_MARKDOWN = localize('paradis.tabLauncher.newMarkdown', "新しい Markdown");
const STR_UNTITLED = localize('paradis.tabLauncher.untitled', "無題");
const STR_NEW_FILE = localize('paradis.tabLauncher.newFile', "新しいファイル…");
const STR_AGENT_SETTINGS = localize('paradis.tabLauncher.agentSettings', "エージェントの設定…");
const STR_OPEN_URL = localize('paradis.tabLauncher.openUrl', "内蔵ブラウザで開く");
const STR_SWITCH_TAB = localize('paradis.tabLauncher.switchTab', "タブに切り替え");
const STR_FIND_FILE = localize('paradis.tabLauncher.findFile', "ファイルを探す");
const STR_NO_RESULTS = localize('paradis.tabLauncher.noResults', "見つかりません");
const STR_DEFAULT = localize('paradis.tabLauncher.default', "既定");
const STR_MODEL_SEARCH = localize('paradis.tabLauncher.modelSearch', "モデルを探す…");
const STR_EFFORT = localize('paradis.tabLauncher.effort', "エフォート");
const STR_EFFORT_UNSUPPORTED = localize('paradis.tabLauncher.effortUnsupported', "このモデルは対応していません");
const STR_PERMISSION = localize('paradis.tabLauncher.permission', "権限");
const STR_PROMPT = localize('paradis.tabLauncher.prompt', "最初の指示（任意）");
const STR_WHERE = localize('paradis.tabLauncher.where', "エディタ領域の新しいタブで起動");
const STR_LAUNCH_TERMINAL = localize('paradis.tabLauncher.launchTerminal', "ターミナルで起動");
const STR_LAUNCH_CHAT = localize('paradis.tabLauncher.launchChat', "チャットで起動");
const STR_NO_FOLDER = localize('paradis.tabLauncher.noFolder', "フォルダを開いていないため、エージェントを起動できません。");
const STR_CHAT_NOT_READY = localize('paradis.tabLauncher.chatNotReady', "エージェントの会話が見つからなかったため、ターミナル表示のままにしました。会話が始まったら ⌘⇧J でチャット表示に切り替えられます。");
const STR_ROW_DESCRIPTION = (model: string, effort: string) => localize('paradis.tabLauncher.agentDescription', "{0} · {1}", model, effort);
const STR_DEFAULT_WITH = (value: string) => localize('paradis.tabLauncher.defaultWith', "既定（{0}）", value);
const STR_LAUNCH_FAILED = (agent: string, error: string) => localize('paradis.tabLauncher.launchFailed', "{0} を起動できませんでした: {1}", agent, error);

/** ランチャーを開いたツールバーの項目が渡すもの。 */
export interface IParadisTabLauncherHost {
	/** ⌄ の要素（位置合わせと、閉じたときにフォーカスを戻す先）。 */
	readonly anchor: HTMLElement;
	/** 「＋」と同じ操作（今のグループに新しいターミナル）。 */
	runPrimary(): void;
	/** 項目を実行する直前に呼ぶ（⌄ を押したエディタグループをアクティブにする）。 */
	prepareRun(): void;
	/** 閉じた（どの経路でも 1 回だけ）。 */
	onDidHide(): void;
}

/** 一覧の 1 行。キーボードで移る対象。 */
interface IParadisLauncherRow {
	readonly element: HTMLElement;
	/** Enter・クリック。 */
	readonly run?: () => void;
	/** → で横の面を開いて、その先頭へフォーカスを移す。 */
	readonly openSide?: () => void;
}

interface IParadisLauncherRowOptions {
	readonly icon?: ThemeIcon;
	readonly agentLogo?: ParadisAgentLogo;
	readonly label: string;
	readonly description?: string;
	readonly hasSide?: boolean;
	readonly enabled?: boolean;
	readonly checked?: boolean;
	/** マウスを乗せると横の面を開く（サブメニュー）。 */
	readonly hoverOpens?: boolean;
}

/** 開いている横の面（サブメニューか起動パネル）。level 1 が一覧のすぐ横。 */
interface IParadisLauncherSide {
	readonly element: HTMLElement;
	readonly store: DisposableStore;
	readonly ownerRow: HTMLElement;
	rows: IParadisLauncherRow[];
	/** 行を持たない面（起動パネル）で、開いたときにフォーカスを移す先。 */
	firstFocus?: HTMLElement;
}

export class ParadisTabLauncherPopup extends Disposable {

	private readonly window: Window & typeof globalThis;
	private readonly list: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly rowsElement: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private rows: IParadisLauncherRow[] = [];
	private readonly sides: IParadisLauncherSide[] = [];
	/** 横の面を一覧の左に出すか（右寄りのツールバーから開くと、右には入らない）。 */
	private sideToLeft = true;
	private readonly choices = new Map<string, IParadisTabLauncherChoice>();
	private hidden = false;

	constructor(
		private readonly host: IParadisTabLauncherHost,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalProfileService private readonly terminalProfileService: ITerminalProfileService,
		@ITerminalProfileResolverService private readonly terminalProfileResolverService: ITerminalProfileResolverService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisAgentChatService private readonly agentChatService: IParadisAgentChatService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisSimulatorClient private readonly simulatorClient: IParadisSimulatorClient,
	) {
		super();
		this.window = dom.getWindow(host.anchor);
		// .monaco-workbench の内側に置く（CSS のセレクタとテーマの変数をそこから効かせる。プリセットのポップアップと同じ）
		const container = host.anchor.closest<HTMLElement>('.monaco-workbench') ?? this.window.document.body;
		this.list = dom.append(container, $('.paradis-tab-launcher.paradis-overlay-popover'));
		this.list.setAttribute('role', 'menu');
		this._register(toDisposable(() => this.list.remove()));
		// 小窓はモーダルより上の段にあるので、モーダルが開いたら閉じる（幕の上に浮かせない）
		this._register(paradisCloseWhenModalOpens(this.list, () => this.hide(false)));

		const search = dom.append(this.list, $('.paradis-tab-launcher-search.paradis-focus-subtle-within'));
		dom.append(search, $(ThemeIcon.asCSSSelector(Codicon.search)));
		this.searchInput = dom.append(search, $('input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = STR_SEARCH;
		this.searchInput.setAttribute('aria-label', STR_SEARCH);
		this.rowsElement = dom.append(this.list, $('.paradis-tab-launcher-rows'));

		// 前回の選択を引き継ぐ。ただし危ない権限（全許可など）は引き継がず、開くたびに危なくない既定へ戻す
		const stored = paradisParseStoredLaunchChoices(this.storageService.get(PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY, StorageScope.PROFILE));
		for (const agent of this.agents()) {
			this.choices.set(agent.id, paradisRestoreLaunchChoice(agent, stored[agent.id]));
		}

		this._register(dom.addDisposableListener(this.searchInput, 'input', () => this.renderRows()));
		this._register(dom.addDisposableListener(this.list, 'keydown', e => this.onListKeyDown(e)));
		this._register(this.modelCatalogService.onDidChange(() => {
			// モデル一覧が届き直したら一覧の説明を直す（起動パネルは開き直したときに反映する）
			if (this.sides.length === 0) {
				this.renderRows();
			}
		}));
		this.modelCatalogService.refresh();

		this.renderRows();
		this.position();
		this.searchInput.focus();
		this.registerCloseListeners();
	}

	hide(focusAnchor: boolean): void {
		if (this.hidden) {
			return;
		}
		this.hidden = true;
		this.closeSides(1);
		this.dispose();
		if (focusAnchor && this.host.anchor.isConnected) {
			this.host.anchor.focus();
		}
		this.host.onDidHide();
	}

	// ---- 位置と閉じ方 ------------------------------------------------------------------------

	private position(): void {
		const anchorRect = this.host.anchor.getBoundingClientRect();
		const rect = this.list.getBoundingClientRect();
		const margin = 4;
		const left = Math.max(margin, Math.min(anchorRect.right - rect.width, this.window.innerWidth - rect.width - margin));
		let top = anchorRect.bottom + 2;
		if (top + rect.height > this.window.innerHeight - margin) {
			top = Math.max(margin, this.window.innerHeight - margin - rect.height);
		}
		this.list.style.left = `${Math.round(left)}px`;
		this.list.style.top = `${Math.round(top)}px`;
		this.sideToLeft = left >= this.window.innerWidth - (left + rect.width);
	}

	private positionSide(level: number, side: HTMLElement, ownerRow: HTMLElement): void {
		const parent = level === 1 ? this.list : this.sides[level - 2].element;
		const parentRect = parent.getBoundingClientRect();
		const rowRect = ownerRow.getBoundingClientRect();
		const rect = side.getBoundingClientRect();
		const margin = 4;
		const gap = 2;
		let left = this.sideToLeft ? parentRect.left - gap - rect.width : parentRect.right + gap;
		if (left < margin || left + rect.width > this.window.innerWidth - margin) {
			// 入らない向きなら反対側へ。それでも入らなければ画面の端に寄せる
			left = this.sideToLeft ? parentRect.right + gap : parentRect.left - gap - rect.width;
			left = Math.max(margin, Math.min(left, this.window.innerWidth - rect.width - margin));
		}
		let top = rowRect.top - 4;
		if (top + rect.height > this.window.innerHeight - margin) {
			top = Math.max(margin, this.window.innerHeight - margin - rect.height);
		}
		side.style.left = `${Math.round(left)}px`;
		side.style.top = `${Math.round(top)}px`;
	}

	private registerCloseListeners(): void {
		// Esc はキャプチャで拾う（フォーカスが xterm に残っていても先にシェルへ渡さない。プリセットのポップアップと同じ）
		this._register(dom.addDisposableListener(this.window, 'keydown', e => {
			if (e.key === 'Escape' && !e.isComposing) {
				dom.EventHelper.stop(e, true);
				this.hide(true);
			}
		}, true));
		this._register(dom.scheduleAtNextAnimationFrame(this.window, () => {
			if (this.hidden) {
				return;
			}
			this._register(dom.addDisposableListener(this.window.document, 'mousedown', e => {
				const target = e.target as Node | null;
				if (!target || this.host.anchor.contains(target) || this.list.contains(target) || this.sides.some(side => side.element.contains(target))) {
					return;
				}
				this.hide(false);
			}, true));
		}));
		this._register(dom.addDisposableListener(this.window, 'resize', () => this.hide(false)));
		this._register(dom.addDisposableListener(this.window, 'blur', () => this.hide(false)));
	}

	// ---- 左の一覧 ----------------------------------------------------------------------------

	private renderRows(): void {
		this.renderStore.clear();
		this.closeSides(1);
		dom.clearNode(this.rowsElement);
		this.rows = [];
		const query = this.searchInput.value.trim();
		if (query.length === 0) {
			this.renderFixedRows();
		} else {
			this.renderResults(query);
		}
	}

	private renderFixedRows(): void {
		const terminalRow = this.addRow(this.rowsElement, this.rows, { icon: Codicon.terminal, label: STR_NEW_TERMINAL, hasSide: true, hoverOpens: true }, () => this.run(() => this.host.runPrimary()), row => this.openActionSide(1, row, this.terminalActions(this.renderStore)));
		terminalRow.element.setAttribute('aria-description', STR_NEW_TERMINAL_MORE);
		this.addRow(this.rowsElement, this.rows, { icon: Codicon.globe, label: STR_NEW_BROWSER }, () => this.run(() => this.commandService.executeCommand(BrowserViewCommandId.Open)));
		const simulatorRow = this.addRow(this.rowsElement, this.rows, { icon: Codicon.deviceMobile, label: STR_OPEN_SIMULATOR, hasSide: true, hoverOpens: true }, () => this.run(() => this.commandService.executeCommand(PARADIS_SIMULATOR_OPEN_COMMAND_ID)), row => void this.openSimulatorSide(row));
		simulatorRow.element.setAttribute('aria-description', STR_OPEN_SIMULATOR_MORE);
		this.addRow(this.rowsElement, this.rows, { icon: Codicon.newFile, label: STR_NEW_MARKDOWN, description: STR_UNTITLED }, () => this.run(() => this.commandService.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID, { languageId: 'markdown' })));
		const newFileActions = this.newFileActions();
		if (newFileActions.length > 0) {
			this.addRow(this.rowsElement, this.rows, { icon: Codicon.file, label: STR_NEW_FILE, hasSide: true, hoverOpens: true }, undefined, row => this.openActionSide(1, row, newFileActions));
		}
		const agents = this.agents();
		if (agents.length > 0) {
			this.addSeparator(this.rowsElement);
			for (const agent of agents) {
				this.addAgentRow(agent);
			}
		}
		this.addSeparator(this.rowsElement);
		this.addRow(this.rowsElement, this.rows, { icon: Codicon.gear, label: STR_AGENT_SETTINGS }, () => this.run(() => this.commandService.executeCommand(PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID, SETTINGS_AGENT_SECTION_ID)));
	}

	private renderResults(query: string): void {
		const lower = query.toLowerCase();
		const url = paradisTabLauncherUrl(query);
		if (url !== undefined) {
			this.addRow(this.rowsElement, this.rows, { icon: Codicon.globe, label: STR_OPEN_URL, description: url }, () => this.run(() => this.commandService.executeCommand(BrowserViewCommandId.Open, url)));
		}
		let openEditors = 0;
		for (const { editor, groupId } of this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			if (openEditors >= OPEN_EDITOR_RESULT_LIMIT) {
				break;
			}
			const name = editor.getName();
			if (!name.toLowerCase().includes(lower)) {
				continue;
			}
			openEditors++;
			this.addRow(this.rowsElement, this.rows, { icon: Codicon.window, label: name, description: STR_SWITCH_TAB }, () => this.run(() => this.editorService.openEditor(editor, undefined, groupId)));
		}
		const fixed: { label: string; icon: ThemeIcon; run: () => unknown }[] = [
			{ label: STR_NEW_TERMINAL, icon: Codicon.terminal, run: () => this.host.runPrimary() },
			{ label: STR_NEW_BROWSER, icon: Codicon.globe, run: () => this.commandService.executeCommand(BrowserViewCommandId.Open) },
			{ label: STR_OPEN_SIMULATOR, icon: Codicon.deviceMobile, run: () => this.commandService.executeCommand(PARADIS_SIMULATOR_OPEN_COMMAND_ID) },
			{ label: STR_NEW_MARKDOWN, icon: Codicon.newFile, run: () => this.commandService.executeCommand(NEW_UNTITLED_FILE_COMMAND_ID, { languageId: 'markdown' }) },
			{ label: STR_AGENT_SETTINGS, icon: Codicon.gear, run: () => this.commandService.executeCommand(PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID, SETTINGS_AGENT_SECTION_ID) },
		];
		for (const item of fixed) {
			if (item.label.toLowerCase().includes(lower)) {
				this.addRow(this.rowsElement, this.rows, { icon: item.icon, label: item.label }, () => this.run(item.run));
			}
		}
		const agents = this.agents();
		for (const match of paradisMatchLauncherAgents(agents, query)) {
			const agent = agents.find(candidate => candidate.id === match.agentId);
			if (!agent) {
				continue;
			}
			if (match.modelId === undefined) {
				this.addAgentRow(agent);
				continue;
			}
			// モデル（とエフォート）の組み合わせの行。選ぶとその組み合わせで起動パネルを開く
			const model = agent.models?.find(candidate => candidate.id === match.modelId);
			const description = STR_ROW_DESCRIPTION(model?.label ?? match.modelId, match.effortId ?? STR_DEFAULT);
			const open = (row: HTMLElement) => {
				this.choices.set(agent.id, paradisNormalizeLaunchChoice(agent, { ...this.choiceFor(agent), modelId: match.modelId, effortId: match.effortId }));
				this.openAgentSide(row, agent);
			};
			this.addRow(this.rowsElement, this.rows, { agentLogo: this.logoFor(agent.id), icon: Codicon.robot, label: agent.label, description, hasSide: true }, undefined, open);
		}
		const quickOpen = this.keybindingService.lookupKeybinding('workbench.action.quickOpen')?.getLabel();
		if (this.rows.length > 0) {
			this.addSeparator(this.rowsElement);
		}
		this.addRow(this.rowsElement, this.rows, { icon: Codicon.search, label: STR_FIND_FILE, description: quickOpen ? `${quickOpen} · ${query}` : query }, () => this.run(() => this.commandService.executeCommand('workbench.action.quickOpen', query)));
		if (this.rows.length === 1) {
			dom.append(this.rowsElement, $('.paradis-tab-launcher-empty')).textContent = STR_NO_RESULTS;
		}
	}

	private addAgentRow(agent: IParadisAgentCommandTemplate): void {
		this.addRow(this.rowsElement, this.rows, { agentLogo: this.logoFor(agent.id), icon: Codicon.robot, label: agent.label, description: this.describeChoice(agent), hasSide: true }, undefined, row => this.openAgentSide(row, agent));
	}

	/**
	 * 行を 1 つ足す。`run` は押したとき、`openSide` は横の面を開くとき（押したとき・→）に呼ぶ。
	 * 両方あれば、押すと `run`、→ と › の上では横の面を開く（「新しいターミナル」）。
	 */
	private addRow(parent: HTMLElement, rows: IParadisLauncherRow[], options: IParadisLauncherRowOptions, run: (() => void) | undefined, openSide?: (row: HTMLElement) => void): IParadisLauncherRow {
		const element = dom.append(parent, $('.paradis-tab-launcher-row'));
		element.tabIndex = -1;
		element.setAttribute('role', options.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
		if (options.checked !== undefined) {
			element.setAttribute('aria-checked', String(options.checked));
		}
		const enabled = options.enabled !== false;
		element.classList.toggle('disabled', !enabled);
		element.setAttribute('aria-disabled', String(!enabled));
		const icon = dom.append(element, $('span.paradis-tab-launcher-icon'));
		if (options.agentLogo) {
			icon.classList.add(options.agentLogo);
			appendParadisAgentLogoSvg(icon, options.agentLogo);
		} else if (options.checked) {
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
		} else if (options.icon) {
			icon.classList.add(...ThemeIcon.asClassNameArray(options.icon));
		}
		dom.append(element, $('span.paradis-tab-launcher-label')).textContent = options.label;
		if (options.description) {
			dom.append(element, $('span.paradis-tab-launcher-description')).textContent = options.description;
		}
		let sideButton: HTMLElement | undefined;
		if (options.hasSide) {
			element.setAttribute('aria-haspopup', 'true');
			sideButton = dom.append(element, $('span.paradis-tab-launcher-chevron'));
			sideButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));
		}
		const row: IParadisLauncherRow = {
			element,
			run: enabled ? run : undefined,
			openSide: enabled && openSide ? () => openSide(element) : undefined,
		};
		rows.push(row);
		this.renderStore.add(dom.addDisposableListener(element, 'click', e => {
			dom.EventHelper.stop(e, true);
			if (!enabled) {
				return;
			}
			const onChevron = sideButton !== undefined && e.target instanceof Node && sideButton.contains(e.target);
			if (row.run && !onChevron) {
				row.run();
			} else {
				row.openSide?.();
			}
		}));
		// サブメニューはマウスを乗せただけでも開く（「新しいターミナル」は › の上だけ）。起動パネルは押したときだけ開く（Q570 の 4）
		if (openSide && options.hoverOpens) {
			this.renderStore.add(dom.addDisposableListener(run ? sideButton! : element, 'mouseenter', () => row.openSide?.()));
		} else {
			// 別の行へマウスが移ったら、開いていたサブメニューは閉じる（起動パネルは、パネルへ動かす途中で閉じないよう残す）
			this.renderStore.add(dom.addDisposableListener(element, 'mouseenter', () => {
				const level = this.levelOfRows(rows);
				if (level >= 0 && this.sides[level]?.element.classList.contains('paradis-tab-launcher-submenu')) {
					this.closeSides(level + 1);
				}
			}));
		}
		return row;
	}

	private addSeparator(parent: HTMLElement): void {
		const last = parent.lastElementChild;
		if (last && !last.classList.contains('paradis-tab-launcher-separator')) {
			dom.append(parent, $('.paradis-tab-launcher-separator')).setAttribute('role', 'separator');
		}
	}

	private onListKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		if (e.isComposing) {
			return;
		}
		const inSearch = e.target === this.searchInput;
		if (inSearch) {
			if (event.equals(KeyCode.DownArrow)) {
				dom.EventHelper.stop(e, true);
				this.rows[0]?.element.focus();
			} else if (event.equals(KeyCode.Enter)) {
				dom.EventHelper.stop(e, true);
				const first = this.rows[0];
				if (first?.run) {
					first.run();
				} else {
					first?.openSide?.();
					this.focusSide(1);
				}
			}
			return;
		}
		this.onRowsKeyDown(e, event, this.rows, () => this.searchInput.focus(), undefined);
	}

	/** 一覧と横の面で共通のキー操作（↑↓・Home・End・Enter・Space・→・←）。 */
	private onRowsKeyDown(e: KeyboardEvent, event: StandardKeyboardEvent, rows: readonly IParadisLauncherRow[], onTopEdge: (() => void) | undefined, onBack: (() => void) | undefined): void {
		const index = rows.findIndex(row => row.element === e.target);
		if (index < 0) {
			return;
		}
		const row = rows[index];
		if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
			dom.EventHelper.stop(e, true);
			const delta = event.equals(KeyCode.DownArrow) ? 1 : -1;
			if (delta < 0 && index === 0 && onTopEdge) {
				onTopEdge();
				return;
			}
			rows[(index + delta + rows.length) % rows.length].element.focus();
		} else if (event.equals(KeyCode.Home) || event.equals(KeyCode.End)) {
			dom.EventHelper.stop(e, true);
			rows[event.equals(KeyCode.Home) ? 0 : rows.length - 1].element.focus();
		} else if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
			dom.EventHelper.stop(e, true);
			if (row.run) {
				row.run();
			} else if (row.openSide) {
				row.openSide();
				this.focusSide(this.levelOfRows(rows) + 1);
			}
		} else if (event.equals(KeyCode.RightArrow) && row.openSide) {
			dom.EventHelper.stop(e, true);
			row.openSide();
			this.focusSide(this.levelOfRows(rows) + 1);
		} else if (event.equals(KeyCode.LeftArrow) && onBack) {
			dom.EventHelper.stop(e, true);
			onBack();
		}
	}

	private levelOfRows(rows: readonly IParadisLauncherRow[]): number {
		if (rows === this.rows) {
			return 0;
		}
		return this.sides.findIndex(side => side.rows === rows) + 1;
	}

	// ---- 横の面 ------------------------------------------------------------------------------

	/** level 以上の横の面を閉じる。 */
	private closeSides(level: number): void {
		while (this.sides.length >= level && this.sides.length > 0) {
			const side = this.sides.pop()!;
			side.ownerRow.classList.remove('expanded');
			side.ownerRow.setAttribute('aria-expanded', 'false');
			side.store.dispose();
			side.element.remove();
		}
	}

	private openSide(level: number, ownerRow: HTMLElement, className: string, build: (element: HTMLElement, store: DisposableStore) => IParadisLauncherRow[]): void {
		if (this.sides[level - 1]?.ownerRow === ownerRow) {
			this.closeSides(level + 1);
			return;
		}
		this.closeSides(level);
		const container = this.list.parentElement ?? this.window.document.body;
		const element = dom.append(container, $(`.paradis-tab-launcher-side.paradis-overlay-popover.${className}`));
		element.setAttribute('role', 'menu');
		const store = new DisposableStore();
		const side: IParadisLauncherSide = { element, store, ownerRow, rows: [] };
		this.sides.push(side);
		ownerRow.classList.add('expanded');
		ownerRow.setAttribute('aria-expanded', 'true');
		side.rows = build(element, store);
		this.positionSide(level, element, ownerRow);
		store.add(dom.addDisposableListener(element, 'keydown', e => {
			if (e.isComposing) {
				return;
			}
			const event = new StandardKeyboardEvent(e);
			const back = () => {
				this.closeSides(level);
				ownerRow.focus();
			};
			if (side.rows.some(row => row.element === e.target)) {
				this.onRowsKeyDown(e, event, side.rows, undefined, back);
			}
		}));
	}

	private focusSide(level: number): void {
		const side = this.sides[level - 1];
		if (!side) {
			return;
		}
		// 起動パネルは先頭の入力欄（モデルの検索欄か最初の指示）、サブメニューは先頭の行へ
		(side.rows[0]?.element ?? side.firstFocus)?.focus();
	}

	/** upstream の ⌄ と同じ一覧（新しいターミナル・新しいウィンドウ・分割・プロファイル・設定・タスク）。 */
	private terminalActions(store: DisposableStore): readonly IAction[] {
		const dropdownMenu = store.add(this.menuService.createMenu(MenuId.TerminalNewDropdownContext, this.contextKeyService));
		let defaultProfileName: string | undefined;
		try {
			defaultProfileName = this.terminalProfileService.getDefaultProfileName();
		} catch {
			defaultProfileName = this.terminalProfileResolverService.defaultProfileName;
		}
		return getTerminalActionBarArgs({ viewColumn: ACTIVE_GROUP }, this.terminalProfileService.availableProfiles, defaultProfileName ?? '', this.terminalProfileService.contributedProfiles, this.terminalService, dropdownMenu, store).dropdownMenuActions;
	}

	/**
	 * 「シミュレータを開く ›」: 起動している端末を並べ、最後に「すべての端末…」（止まっている端末も選べる一覧）。
	 * 端末の一覧は › を開いたときに取る（手元の shared process から。30 秒は覚えておく）。iOS のシミュレータは
	 * macOS だけ（Android は全 OS）。届く前にランチャーが閉じた・別の行の › が開いたなら出さない。
	 * キーボード（→・Enter）で開いたなら、届いたときに先頭の行へフォーカスを移す。
	 */
	private async openSimulatorSide(row: HTMLElement): Promise<void> {
		const devices = await deviceCache.get(async () => {
			const [ios, android] = await Promise.all([
				isMacintosh ? this.simulatorClient.listDevices().catch(() => []) : Promise.resolve([]),
				this.simulatorClient.listAndroidDevices().catch(() => []),
			]);
			return paradisTabLauncherDevices(ios, android, isMacintosh);
		}, Date.now());
		if (this.hidden || !row.isConnected || (this.sides.length > 0 && this.sides[0].ownerRow !== row)) {
			return;
		}
		const actions: IAction[] = devices.map(device => toAction({
			id: `paradis.tabLauncher.device.${device.kind}.${device.id}`,
			label: STR_DEVICE_LABEL(device.name, device.runtime),
			// 行を押したときに this.run で包まれる（閉じてから実行する）ので、ここではコマンドを呼ぶだけ
			run: () => this.commandService.executeCommand(device.kind === 'ios' ? PARADIS_SIMULATOR_OPEN_COMMAND_ID : PARADIS_SIMULATOR_OPEN_ANDROID_COMMAND_ID, device.id),
		}));
		if (actions.length === 0) {
			actions.push(toAction({ id: 'paradis.tabLauncher.device.none', label: STR_NO_RUNNING_DEVICE, enabled: false, run: () => { } }));
		}
		actions.push(new Separator());
		actions.push(toAction({ id: 'paradis.tabLauncher.device.all', label: STR_ALL_DEVICES, run: () => this.commandService.executeCommand(PARADIS_SIMULATOR_OPEN_COMMAND_ID) }));
		const focused = this.window.document.activeElement === row;
		this.openActionSide(1, row, actions);
		if (focused) {
			this.focusSide(1);
		}
	}

	/** 拡張機能が `file/newFile` に足した「新しいファイル」の項目。 */
	private newFileActions(): readonly IAction[] {
		const actions: IAction[] = [];
		for (const [, group] of this.menuService.getMenuActions(MenuId.NewFile, this.contextKeyService)) {
			if (actions.length > 0) {
				actions.push(new Separator());
			}
			actions.push(...group);
		}
		return actions;
	}

	private openActionSide(level: number, ownerRow: HTMLElement, actions: readonly IAction[]): void {
		this.openSide(level, ownerRow, 'paradis-tab-launcher-submenu', (element, store) => {
			const rows: IParadisLauncherRow[] = [];
			for (const action of actions) {
				if (action instanceof Separator) {
					if (rows.length > 0) {
						this.addSeparator(element);
					}
					continue;
				}
				if (action instanceof SubmenuAction) {
					if (action.actions.length > 0) {
						this.addRow(element, rows, { label: action.label, hasSide: true, hoverOpens: true }, undefined, row => this.openActionSide(level + 1, row, action.actions));
					}
					continue;
				}
				this.addRow(element, rows, { label: action.label, enabled: action.enabled, checked: action.checked }, () => this.run(() => action.run()));
			}
			const last = element.lastElementChild;
			if (last?.classList.contains('paradis-tab-launcher-separator')) {
				last.remove();
			}
			return rows;
		});
	}

	// ---- 起動パネル --------------------------------------------------------------------------

	private agents(): readonly IParadisAgentCommandTemplate[] {
		return paradisTabLauncherAgents(this.modelCatalogService.getAgentTemplates());
	}

	private logoFor(agentId: string): ParadisAgentLogo | undefined {
		return paradisAgentLogoForId(agentId);
	}

	private choiceFor(agent: IParadisAgentCommandTemplate): IParadisTabLauncherChoice {
		return paradisNormalizeLaunchChoice(agent, this.choices.get(agent.id));
	}

	private describeChoice(agent: IParadisAgentCommandTemplate): string {
		const choice = this.choiceFor(agent);
		const model = choice.modelId !== undefined ? agent.models?.find(candidate => candidate.id === choice.modelId) : undefined;
		return STR_ROW_DESCRIPTION(model?.label ?? choice.modelId ?? STR_DEFAULT, choice.effortId ?? STR_DEFAULT);
	}

	private openAgentSide(ownerRow: HTMLElement, agent: IParadisAgentCommandTemplate): void {
		this.openSide(1, ownerRow, 'paradis-tab-launcher-agent', (element, store) => {
			const firstFocus = this.buildAgentPanel(element, store, agent, ownerRow);
			const side = this.sides[this.sides.length - 1];
			if (side) {
				side.firstFocus = firstFocus;
			}
			return [];
		});
	}

	/** 起動パネルを組み立て、開いたときにフォーカスを移す入力欄を返す。 */
	private buildAgentPanel(element: HTMLElement, store: DisposableStore, agent: IParadisAgentCommandTemplate, ownerRow: HTMLElement): HTMLElement {
		const update = (patch: IParadisTabLauncherChoice) => {
			this.choices.set(agent.id, paradisNormalizeLaunchChoice(agent, { ...this.choiceFor(agent), ...patch }));
			renderModels();
			renderEfforts();
			renderPermissions();
		};

		const header = dom.append(element, $('.paradis-tab-launcher-agent-header'));
		const logo = this.logoFor(agent.id);
		const icon = dom.append(header, $('span.paradis-tab-launcher-icon'));
		if (logo) {
			icon.classList.add(logo);
			appendParadisAgentLogoSvg(icon, logo);
		} else {
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.robot));
		}
		dom.append(header, $('span.paradis-tab-launcher-agent-name')).textContent = agent.label;
		dom.append(header, $('span.paradis-tab-launcher-agent-where')).textContent = STR_WHERE;

		// モデル（検索欄つき）
		const models = agent.models ?? [];
		const modelList = $('.paradis-tab-launcher-models');
		let modelQuery = '';
		let modelOptions: HTMLElement[] = [];
		const renderModels = () => {
			dom.clearNode(modelList);
			modelOptions = [];
			const selected = this.choiceFor(agent).modelId;
			const entries = [{ id: undefined as string | undefined, label: STR_DEFAULT, sub: undefined as string | undefined }, ...models.map(model => ({ id: model.id as string | undefined, label: model.label ?? model.id, sub: model.label && model.label !== model.id ? model.id : undefined }))];
			for (const entry of entries) {
				if (modelQuery && !`${entry.label} ${entry.sub ?? ''}`.toLowerCase().includes(modelQuery)) {
					continue;
				}
				const option = dom.append(modelList, $('.paradis-tab-launcher-model'));
				modelOptions.push(option);
				option.setAttribute('role', 'option');
				option.tabIndex = -1;
				const isSelected = entry.id === selected;
				option.classList.toggle('selected', isSelected);
				option.setAttribute('aria-selected', String(isSelected));
				dom.append(option, $('span.paradis-tab-launcher-label')).textContent = entry.label;
				if (entry.sub) {
					dom.append(option, $('span.paradis-tab-launcher-model-id')).textContent = entry.sub;
				}
				const check = dom.append(option, $('span.paradis-tab-launcher-check'));
				check.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
				option.addEventListener('click', () => update({ modelId: entry.id }));
				option.addEventListener('keydown', e => {
					const event = new StandardKeyboardEvent(e);
					if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
						dom.EventHelper.stop(e, true);
						update({ modelId: entry.id });
						modelOptions.find(candidate => candidate.classList.contains('selected'))?.focus();
					} else if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
						dom.EventHelper.stop(e, true);
						const sibling = (event.equals(KeyCode.DownArrow) ? option.nextElementSibling : option.previousElementSibling) as HTMLElement | null;
						(sibling ?? (event.equals(KeyCode.UpArrow) ? modelSearch : undefined))?.focus();
					}
				});
			}
		};
		let modelSearch: HTMLInputElement | undefined;
		if (models.length > 0) {
			const search = dom.append(element, $('.paradis-tab-launcher-search.paradis-focus-subtle-within.paradis-tab-launcher-model-search'));
			dom.append(search, $(ThemeIcon.asCSSSelector(Codicon.search)));
			modelSearch = dom.append(search, $('input')) as HTMLInputElement;
			modelSearch.type = 'text';
			modelSearch.placeholder = STR_MODEL_SEARCH;
			modelSearch.setAttribute('aria-label', STR_MODEL_SEARCH);
			store.add(dom.addDisposableListener(modelSearch, 'input', () => {
				modelQuery = modelSearch!.value.trim().toLowerCase();
				renderModels();
			}));
			store.add(dom.addDisposableListener(modelSearch, 'keydown', e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.DownArrow)) {
					dom.EventHelper.stop(e, true);
					modelOptions[0]?.focus();
				}
			}));
			element.appendChild(modelList);
			modelList.setAttribute('role', 'listbox');
		}

		const options = dom.append(element, $('.paradis-tab-launcher-options'));

		// エフォート
		const effortRow = dom.append(options, $('.paradis-tab-launcher-option'));
		dom.append(effortRow, $('span.paradis-tab-launcher-option-label')).textContent = STR_EFFORT;
		const effortValues = dom.append(effortRow, $('.paradis-tab-launcher-segments'));
		effortValues.setAttribute('role', 'radiogroup');
		effortValues.setAttribute('aria-label', STR_EFFORT);
		const renderEfforts = () => {
			dom.clearNode(effortValues);
			const choice = this.choiceFor(agent);
			const efforts = paradisTabLauncherEfforts(agent, choice.modelId);
			effortRow.classList.toggle('hidden', !efforts.shown);
			if (!efforts.shown) {
				return;
			}
			if (efforts.ids.length === 0) {
				dom.append(effortValues, $('span.paradis-tab-launcher-note')).textContent = STR_EFFORT_UNSUPPORTED;
				return;
			}
			const values: (string | undefined)[] = [undefined, ...efforts.ids];
			for (const value of values) {
				const button = dom.append(effortValues, $('button.paradis-tab-launcher-segment.paradis-focus-ring-inset')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('role', 'radio');
				button.textContent = value ?? (efforts.defaultEffort ? STR_DEFAULT_WITH(efforts.defaultEffort) : STR_DEFAULT);
				const isSelected = value === choice.effortId;
				button.classList.toggle('selected', isSelected);
				button.setAttribute('aria-checked', String(isSelected));
				button.addEventListener('click', () => update({ effortId: value }));
			}
		};

		// 権限
		const permissions = agent.permissions ?? [];
		const permissionRow = dom.append(options, $('.paradis-tab-launcher-option'));
		dom.append(permissionRow, $('span.paradis-tab-launcher-option-label')).textContent = STR_PERMISSION;
		const permissionValues = dom.append(permissionRow, $('.paradis-tab-launcher-segments'));
		permissionValues.setAttribute('role', 'radiogroup');
		permissionValues.setAttribute('aria-label', STR_PERMISSION);
		const permissionHint = dom.append(options, $('.paradis-tab-launcher-hint'));
		permissionRow.classList.toggle('hidden', permissions.length === 0);
		const renderPermissions = () => {
			dom.clearNode(permissionValues);
			const selectedId = this.choiceFor(agent).permissionId;
			for (const permission of permissions) {
				const button = dom.append(permissionValues, $('button.paradis-tab-launcher-segment.paradis-focus-ring-inset')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('role', 'radio');
				button.textContent = permission.label;
				button.classList.toggle('danger', !!permission.danger);
				const isSelected = permission.id === selectedId;
				button.classList.toggle('selected', isSelected);
				button.setAttribute('aria-checked', String(isSelected));
				button.addEventListener('click', () => update({ permissionId: permission.id }));
			}
			const selected = permissions.find(permission => permission.id === selectedId);
			permissionHint.textContent = selected?.hint ?? '';
			permissionHint.classList.toggle('danger', !!selected?.danger);
			permissionHint.classList.toggle('hidden', !selected?.hint);
		};

		// 最初の指示
		const promptBox = dom.append(element, $('.paradis-tab-launcher-prompt.paradis-focus-subtle-within'));
		const prompt = dom.append(promptBox, $('textarea')) as HTMLTextAreaElement;
		prompt.placeholder = STR_PROMPT;
		prompt.setAttribute('aria-label', STR_PROMPT);
		prompt.rows = 3;

		// ボタン
		const footer = dom.append(element, $('.paradis-tab-launcher-footer'));
		const chatEnabled = paradisTabLauncherOffersChat(agent.id, this.configurationService.getValue<boolean>(PARADIS_AGENT_CHAT_ENABLED_SETTING) !== false);
		const launch = (mode: 'terminal' | 'chat') => this.launch(agent, mode, prompt.value.trim());
		if (chatEnabled) {
			const chat = dom.append(footer, $('button.paradis-tab-launcher-button.paradis-focus-ring.secondary')) as HTMLButtonElement;
			chat.type = 'button';
			dom.append(chat, $('span')).textContent = STR_LAUNCH_CHAT;
			dom.append(chat, $('span.paradis-tab-launcher-key')).textContent = isMacintosh ? '⌘↩' : 'Ctrl+↩';
			chat.addEventListener('click', () => launch('chat'));
		}
		const terminal = dom.append(footer, $('button.paradis-tab-launcher-button.paradis-focus-ring.primary')) as HTMLButtonElement;
		terminal.type = 'button';
		dom.append(terminal, $('span')).textContent = STR_LAUNCH_TERMINAL;
		dom.append(terminal, $('span.paradis-tab-launcher-key')).textContent = '↩';
		terminal.addEventListener('click', () => launch('terminal'));

		// Enter で起動（ターミナル）、⌘Enter でチャット、Shift+Enter で改行。変換中の Enter は送らない
		store.add(dom.addDisposableListener(element, 'keydown', e => {
			if (e.isComposing) {
				return;
			}
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) && (e.target === prompt || e.target === modelSearch)) {
				dom.EventHelper.stop(e, true);
				launch('terminal');
			} else if (event.equals(KeyMod.CtrlCmd | KeyCode.Enter) && chatEnabled) {
				dom.EventHelper.stop(e, true);
				launch('chat');
			} else if (event.equals(KeyCode.LeftArrow) && e.target === modelSearch && modelSearch.value === '') {
				dom.EventHelper.stop(e, true);
				this.closeSides(1);
				ownerRow.focus();
			}
		}));

		renderModels();
		renderEfforts();
		renderPermissions();
		return modelSearch ?? prompt;
	}

	private async launch(agent: IParadisAgentCommandTemplate, mode: 'terminal' | 'chat', prompt: string): Promise<void> {
		const choice = this.choiceFor(agent);
		this.storageService.store(PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY, paradisStoreLaunchChoice(this.storageService.get(PARADIS_AGENT_LAUNCH_OPTIONS_STORAGE_KEY, StorageScope.PROFILE), agent.id, choice), StorageScope.PROFILE, StorageTarget.MACHINE);
		const rootUri = paradisTabLauncherRoot(this.workspaceSwitchService.activeStateKey, paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService), this.workspaceContextService.getWorkspace().folders[0]?.uri);
		// 閉じた後でもサービスを使えるよう、先に手元へ取っておく（hide で dispose される）
		const { instantiationService, workspaceSwitchService, agentChatService, notificationService } = this;
		this.hide(false);
		if (!rootUri) {
			notificationService.notify({ severity: Severity.Warning, message: STR_NO_FOLDER });
			return;
		}
		this.host.prepareRun();
		try {
			const launched = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri,
				stateKey: workspaceSwitchService.activeStateKey,
				agentId: agent.id,
				...(prompt ? { prompt } : {}),
				modelId: choice.modelId,
				effortId: choice.effortId,
				permissionId: choice.permissionId,
			});
			if (mode === 'chat') {
				const opened = await agentChatService.openChatWhenReady(launched.instanceId, CHAT_OPEN_TIMEOUT_MS);
				if (!opened && prompt) {
					notificationService.notify({ severity: Severity.Info, message: STR_CHAT_NOT_READY });
				}
			}
		} catch (error) {
			notificationService.error(STR_LAUNCH_FAILED(agent.label, toErrorMessage(error)));
		}
	}

	/** 項目を実行する: 先に閉じて、⌄ を押したグループをアクティブにしてから。 */
	private run(action: () => unknown): void {
		const host = this.host;
		const notificationService = this.notificationService;
		this.hide(false);
		host.prepareRun();
		try {
			const result = action();
			if (result instanceof Promise) {
				result.catch(error => notificationService.error(toErrorMessage(error)));
			}
		} catch (error) {
			notificationService.error(toErrorMessage(error));
		}
	}
}
