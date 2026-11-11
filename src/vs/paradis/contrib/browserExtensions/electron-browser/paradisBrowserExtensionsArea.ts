/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の管理。統合のモーダルの「ブラウザ拡張機能」の領域（Q537 の 38）。
// 左のナビに入れた拡張機能の一覧と追加の入口、右に選んだ 1 件の詳細（有効にする場所・この場所での設定・権限・
// 背景の処理の状態とログ・DevTools・読み込み直す・削除。Q527 の案 B の 2 列のまま）。左のナビの「設定」の「ショートカット」は、
// 入れた拡張機能のショートカットをまとめて付け替える一覧（Q619 の案 B。Chrome の chrome://extensions/shortcuts に当たる）。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { IParadisHubAreaContainers, IParadisHubAreaView, IParadisHubHost, ParadisHubAreaId } from '../../paradisHub/electron-browser/paradisHub.js';
import { paradisHubNavCaption, paradisHubNavItem } from '../../paradisHub/electron-browser/paradisHubNav.js';
import { paradisOpenHub } from '../../paradisHub/electron-browser/paradisHubOpen.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisBrowserProfilesService } from '../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import {
	IParadisAddExtensionResult,
	IParadisBrowserExtensionsMainService,
	IParadisBrowserExtensionsState,
	IParadisBrowserExtensionView,
	IParadisWorkerLogLine,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
	PARADIS_DEFAULT_EXTENSION_PROFILE,
	PARADIS_MAX_EXTENSION_BYTES,
	PARADIS_MAX_EXTENSION_FILES,
	paradisNamedExtensionProfile,
	ParadisOpenWorkerDevToolsResult,
	IParadisBrowserExtensionShortcut,
} from '../common/paradisBrowserExtensions.js';
import { IParadisShortcut, PARADIS_EXECUTE_ACTION_COMMANDS, paradisCommandPlatform, paradisShortcutFromKeyEvent } from '../common/paradisBrowserExtensionMenus.js';
import { paradisEnabledWhileSharedWarning, paradisSharedPageTitlesInPlace } from './paradisBrowserExtensionsService.js';

const $ = dom.$;

/** フォルダから足せなかった理由を、利用者に見せる文にする。 */
export function paradisDescribeAddExtensionFailure(result: Extract<IParadisAddExtensionResult, { ok: false }>): string {
	switch (result.reason) {
		case 'inactive':
			return localize('paradis.browserExtensions.error.inactive', "試験的な設定がオフのため、拡張機能を足せません。設定をオンにして再起動してください。");
		case 'notFolder':
			return localize('paradis.browserExtensions.error.notFolder', "フォルダが見つかりません。展開済みの拡張機能のフォルダを選んでください。");
		case 'noManifest':
			return localize('paradis.browserExtensions.error.noManifest', "選んだフォルダに manifest.json がありません。拡張機能のフォルダ（manifest.json がある階層）を選んでください。");
		case 'invalidManifest':
			return result.detail === 'id changed'
				? localize('paradis.browserExtensions.error.idChanged', "manifest.json の key が変わったため、別の拡張機能になりました。いったん削除してから足し直してください。")
				: localize('paradis.browserExtensions.error.invalidManifest', "manifest.json を拡張機能として読めません（{0}）。", result.detail ?? '');
		case 'linkOutside':
			return localize('paradis.browserExtensions.error.linkOutside', "フォルダの中の「{0}」は、フォルダの外を指すリンクです。外のファイルを読めないようにするため、このフォルダは読み込めません。リンクを実際のファイルに置き換えてください。", result.detail ?? '');
		case 'tooLarge':
			return result.detail === 'files'
				? localize('paradis.browserExtensions.error.tooManyFiles', "フォルダの中のファイルが多すぎます（上限 {0} 個）。ビルドした拡張機能のフォルダ（manifest.json がある階層）を選んでください。", PARADIS_MAX_EXTENSION_FILES)
				: localize('paradis.browserExtensions.error.tooLarge', "フォルダが大きすぎます（上限 {0} MB）。ビルドした拡張機能のフォルダ（manifest.json がある階層）を選んでください。", PARADIS_MAX_EXTENSION_BYTES / (1024 * 1024));
		case 'restartNeeded':
			return localize('paradis.browserExtensions.error.restartNeeded', "この拡張機能は削除したばかりです。前に保存したデータを消しきるため、再起動の後に入れ直してください。");
		case 'hardLink':
			return localize('paradis.browserExtensions.error.hardLink', "フォルダの中の「{0}」は、ほかの場所と中身を共有するファイル（ハードリンク）です。外のファイルを読めないようにするため、このフォルダは読み込めません。ふつうのファイルとして写してから選んでください。", result.detail ?? '');
		case 'nameClash':
			return localize('paradis.browserExtensions.error.nameClash', "フォルダの中に、大文字と小文字などだけが違う同じ名前（「{0}」）があります。写すと上書きされるため、読み込めません。", result.detail ?? '');
		case 'reservedName':
			return localize('paradis.browserExtensions.error.reservedName', "フォルダの中の「{0}」は、Para Code が拡張機能の写しに書くファイルと同じ名前です。名前を変えてから読み込んでください。", result.detail ?? '');
		case 'changed':
			return localize('paradis.browserExtensions.error.changed', "写している間にフォルダの中身（「{0}」）が変わりました。もう一度読み込んでください。", result.detail ?? '');
		case 'tooMany':
			return localize('paradis.browserExtensions.error.tooMany', "これ以上の拡張機能は足せません。使っていないものを削除してください。");
		case 'invalidInput':
			return localize('paradis.browserExtensions.error.invalidInput', "Chrome ウェブストアの拡張機能のページのリンクか、32 文字の拡張機能の ID を貼ってください。");
		case 'cancelled':
			return localize('paradis.browserExtensions.error.cancelled', "追加を取り消しました。");
		case 'busy':
			return localize('paradis.browserExtensions.error.busy', "この拡張機能は今入れている途中です。");
		case 'alreadyAdded':
			return localize('paradis.browserExtensions.error.alreadyAdded', "「{0}」はこの場所に入っています。", result.detail ?? '');
		case 'sameIdUnpacked':
			return localize('paradis.browserExtensions.error.sameIdUnpacked', "同じ ID の拡張機能（「{0}」）をフォルダから読み込んであります。ストアから入れるには、先にそれを削除してください。", result.detail ?? '');
		case 'sameIdWebStore':
			return localize('paradis.browserExtensions.error.sameIdWebStore', "同じ ID の拡張機能を Chrome ウェブストアから入れてあります。フォルダから読み込むには、先にそれを削除してください。");
		case 'webStoreFailed':
			return localize('paradis.browserExtensions.error.webStoreFailed', "Chrome ウェブストアから入れられませんでした（{0}）。", result.detail ?? '');
		case 'noPrompt':
			return localize('paradis.browserExtensions.error.noPrompt', "確認の画面を出せないため、ストアから入れられません。Para Code のウィンドウを前に出してからもう一度試してください。");
		default:
			return localize('paradis.browserExtensions.error.failed', "拡張機能を足せませんでした（{0}）。", result.detail ?? '');
	}
}

/** 背景の処理の DevTools を開けなかった理由を、利用者に見せる文にする（開けたら undefined）。 */
export function paradisDescribeOpenWorkerDevTools(result: ParadisOpenWorkerDevToolsResult): string | undefined {
	if (result.ok) {
		return undefined;
	}
	switch (result.reason) {
		case 'noWorker':
		case 'inactive':
			return localize('paradis.browserExtensions.devtools.noWorker', "この拡張機能には背景の処理がありません。");
		case 'notRunning':
			return localize('paradis.browserExtensions.devtools.notRunning', "背景の処理を起動できないため、DevTools を開けません。起動できなかった理由と、下のログを確かめてください。");
		case 'noDebugPort':
			return localize('paradis.browserExtensions.devtools.noDebugPort', "DevTools を開けませんでした。Para Code を 2 つ起動している場合は、すべて閉じてから起動し直してください。");
		default:
			return localize('paradis.browserExtensions.devtools.failed', "DevTools を開けませんでした（{0}）。", result.detail ?? '');
	}
}

/** ログの 1 行の時刻（時:分:秒）。 */
function formatLogTime(at: number): string {
	const date = new Date(at);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** この OS の suggested_key の鍵（キーの見せ方を main と合わせる）。 */
const SHORTCUT_PLATFORM = paradisCommandPlatform(OS === OperatingSystem.Macintosh ? 'darwin' : OS === OperatingSystem.Windows ? 'win32' : 'linux');

/** おすすめのキーをほかのコマンドに取られて使えないショートカットの数（Q619）。 */
export function paradisLostShortcutCount(extension: Pick<IParadisBrowserExtensionView, 'commands'>): number {
	return extension.commands?.filter(command => command.source === 'lost').length ?? 0;
}

/** そのキーを今使っている、ほかのコマンド（Q619。無ければ undefined）。 */
export function paradisShortcutOwner(extensions: readonly Pick<IParadisBrowserExtensionView, 'id' | 'name' | 'commands'>[], shortcut: string, extensionId: string, name: string): { readonly extension: Pick<IParadisBrowserExtensionView, 'id' | 'name'>; readonly command: IParadisBrowserExtensionShortcut } | undefined {
	for (const extension of extensions) {
		const command = extension.commands?.find(candidate => candidate.shortcut === shortcut && !(extension.id === extensionId && candidate.name === name));
		if (command) {
			return { extension, command };
		}
	}
	return undefined;
}

/** キーの見せ方を、キー 1 つずつの札に分ける（macOS は「⇧⌘L」、ほかは「Ctrl+Shift+L」）。 */
export function paradisShortcutKeyParts(shortcut: string): string[] {
	if (shortcut.includes('+')) {
		return shortcut.split('+');
	}
	const match = /^(?<modifiers>[⌃⌥⇧⌘]*)(?<key>.*)$/u.exec(shortcut);
	return [...(match?.groups?.modifiers ?? ''), match?.groups?.key ?? ''].filter(Boolean);
}

/** ショートカットの一覧に出す、コマンドの名前。 */
function describeCommand(command: IParadisBrowserExtensionShortcut): string {
	if (PARADIS_EXECUTE_ACTION_COMMANDS.has(command.name)) {
		return command.description
			? localize('paradis.browserExtensions.shortcuts.executeActionNamed', "{0}（ツールバーのボタンを押すのと同じ）", command.description)
			: localize('paradis.browserExtensions.shortcuts.executeAction', "ツールバーのボタンを押す");
	}
	return command.description || command.name;
}

/** 付けようとしたキーが、ほかのコマンドのものだった（付け替えるか確かめる）。 */
interface IPendingShortcut {
	readonly extensionId: string;
	readonly name: string;
	readonly binding: IParadisShortcut;
	readonly shortcut: string;
	readonly ownerName: string;
	readonly ownerCommand: string;
}

/** 拡張機能ごとの切り替え（「SSH 先のページでも使う」など）。詳細の列の「この場所での設定」に並べる。 */
interface IExtensionOption {
	readonly label: string;
	readonly note: string;
	readonly checked: boolean;
	readonly run: (checked: boolean) => Promise<unknown>;
}

/** 背景の処理のログを読み直す間隔。 */
const WORKER_LOG_POLL_MS = 1_500;
/** 画面に残すログの行（main が覚えている数と同じ）。 */
const MAX_SHOWN_LOG_LINES = 200;

export class ParadisBrowserExtensionsArea extends Disposable implements IParadisHubAreaView {

	private readonly _mainService: IParadisBrowserExtensionsMainService;
	private readonly _noticeElement: HTMLElement;
	private readonly _profileSelect: ParadisSelect;
	private readonly _listElement: HTMLElement;
	private readonly _detailElement: HTMLElement;
	private readonly _messageElement: HTMLElement;
	private readonly _addItem: HTMLElement;
	private readonly _storeRow: HTMLElement;
	private readonly _storeInput: HTMLInputElement;
	private readonly _storeButton: HTMLButtonElement;
	/** 一覧と詳細の作り直しごとに捨てるリスナー置き場。 */
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _noticeStore = this._register(new DisposableStore());
	private readonly _logTimer = this._register(new IntervalTimer());
	private readonly _workersChanged = this._register(new RunOnceScheduler(() => void this._refreshWorkers(), 300));
	private _logElement: HTMLElement | undefined;
	/** 一覧の行（拡張機能の id → 行）。選び直した行へフォーカスを戻すのに使う。 */
	private readonly _rowElements = new Map<string, HTMLElement>();
	/** 一覧の行の状態の印（拡張機能の id → 要素）。背景の処理が変わったときは、ここだけを書き換える。 */
	private readonly _rowStatusElements = new Map<string, HTMLElement>();
	/** 詳細の列の、背景の処理を起動できなかった理由と、背景の処理の状態（書き換えるだけの要素）。 */
	private _workerErrorElement: HTMLElement | undefined;
	private _workerStatusElement: HTMLElement | undefined;
	private _state: IParadisBrowserExtensionsState | undefined;
	private _profile = PARADIS_DEFAULT_EXTENSION_PROFILE;
	/** 詳細の列に出している拡張機能。 */
	private _selectedId: string | undefined;
	private _busy = false;
	/** 右に出しているもの: 選んだ拡張機能の詳細か、ショートカットの一覧（Q619）。 */
	private _view: 'detail' | 'shortcuts' = 'detail';
	private readonly _shortcutsItem: { readonly element: HTMLElement; setActive(active: boolean): void };
	/** キーを押すのを待っているコマンド。 */
	private _recording: { readonly extensionId: string; readonly name: string } | undefined;
	/** 付け替えるか確かめているキー。 */
	private _pending: IPendingShortcut | undefined;
	private readonly _contentElement: HTMLElement;

	constructor(
		containers: IParadisHubAreaContainers,
		private readonly host: IParadisHubHost,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IParadisBrowserProfilesService private readonly profilesService: IParadisBrowserProfilesService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._mainService = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));

		// ---------- 左のナビ: 入れた拡張機能 / 追加 / 設定 ----------
		const nav = containers.nav;
		paradisHubNavCaption(nav, localize('paradis.browserExtensions.listLabel', "入れた拡張機能"));
		this._listElement = dom.append(nav, $('.pbe-list'));
		this._listElement.setAttribute('role', 'listbox');
		this._listElement.setAttribute('aria-label', localize('paradis.browserExtensions.listLabel', "入れた拡張機能"));

		paradisHubNavCaption(nav, localize('paradis.browserExtensions.addCaption', "追加"));
		const storeItem = paradisHubNavItem(nav, localize('paradis.browserExtensions.addFromStore', "Chrome ウェブストアから"), { icon: Codicon.add });
		this._register(dom.addDisposableListener(storeItem.element, dom.EventType.CLICK, () => this._showStoreRow()));
		const folderItem = paradisHubNavItem(nav, localize('paradis.browserExtensions.add', "フォルダから読み込む…"), { icon: Codicon.newFolder });
		this._addItem = folderItem.element;
		this._register(dom.addDisposableListener(folderItem.element, dom.EventType.CLICK, () => {
			if (!this._addItem.classList.contains('is-disabled')) {
				void this._addFromFolder();
			}
		}));
		paradisHubNavCaption(nav, localize('paradis.browserExtensions.settingsCaption', "設定"));
		this._shortcutsItem = paradisHubNavItem(nav, localize('paradis.browserExtensions.shortcutsLink', "ショートカット"), { icon: Codicon.keyboard });
		this._register(dom.addDisposableListener(this._shortcutsItem.element, dom.EventType.CLICK, () => this._showShortcuts()));
		const settingsItem = paradisHubNavItem(nav, localize('paradis.browserExtensions.settingsLink', "内蔵ブラウザ・拡張機能"), { icon: Codicon.settingsGear, external: true });
		this._register(dom.addDisposableListener(settingsItem.element, dom.EventType.CLICK, () => this.host.open(ParadisHubAreaId.Settings, 'psd-sec-browser')));

		// ---------- 右の本文: 説明・お知らせ・有効にする場所・ストアから追加・メッセージ・詳細 ----------
		this._contentElement = containers.content;
		containers.content.classList.add('paradis-browser-extensions-area');
		const body = dom.append(containers.content, $('.pbe-area-body'));
		dom.append(body, $('p.pbpm-description')).textContent = localize(
			'paradis.browserExtensions.description',
			"拡張機能は、入れたタブで開いたページの中身を読み書きできます。信頼できるものだけ入れてください。エージェントのタブ・使い捨てのタブには入りません。SSH 先のページには、「SSH 先のページでも使う」をオンにした拡張機能だけが入ります。",
		);
		this._noticeElement = dom.append(body, $('.pbe-notice'));

		const profileRow = dom.append(body, $('label.pbe-profile'));
		const profileLabel = localize('paradis.browserExtensions.profile', "有効にする場所");
		dom.append(profileRow, $('span')).textContent = profileLabel;
		this._profileSelect = this._register(new ParadisSelect(profileRow, contextViewService, this.configurationService, [], undefined, { ariaLabel: profileLabel, className: 'pbe-select' }));
		this._register(this._profileSelect.onDidChange(value => {
			this._profile = value;
			this._render();
		}));

		// Chrome ウェブストアのリンクか ID を貼って入れる（外と話すのは「追加」を押したときだけ）。ナビの「Chrome ウェブストアから」で出す
		this._storeRow = dom.append(body, $('.pbe-store'));
		this._storeRow.style.display = 'none';
		this._storeInput = dom.append(this._storeRow, $<HTMLInputElement>('input.pbpm-input.pbe-store-input'));
		this._storeInput.type = 'text';
		this._storeInput.placeholder = localize('paradis.browserExtensions.store.placeholder', "Chrome ウェブストアのリンクか拡張機能の ID");
		this._storeInput.setAttribute('aria-label', localize('paradis.browserExtensions.store.label', "Chrome ウェブストアから追加する拡張機能のリンクか ID"));
		this._storeButton = dom.append(this._storeRow, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
		this._storeButton.type = 'button';
		this._storeButton.textContent = localize('paradis.browserExtensions.store.add', "ストアから追加");
		this._register(dom.addDisposableListener(this._storeButton, dom.EventType.CLICK, () => void this._addFromWebStore()));
		this._register(dom.addDisposableListener(this._storeInput, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this._addFromWebStore();
			}
		}));

		this._messageElement = dom.append(body, $('.pbe-message'));
		this._messageElement.setAttribute('role', 'status');
		this._detailElement = dom.append(body, $('.pbe-detail'));

		this._register(this.profilesService.onDidChangeProfiles(() => this._renderProfiles()));
		// 背景の処理が動き出した・止まった・起動に失敗した: 開いている画面にも出す（続けて来ても 1 回にまとめる）
		this._register(this._mainService.onDidChangeWorkers(() => this._workersChanged.schedule()));
		this._renderProfiles();
		void this._refresh();
	}

	reveal(extensionId: string | undefined): void {
		if (extensionId && this._state?.extensions.some(extension => extension.id === extensionId) && (this._selectedId !== extensionId || this._view !== 'detail')) {
			this._selectedId = extensionId;
			this._view = 'detail';
			this._render();
		}
	}

	handleEscape(): boolean {
		// キーを待っている・付け替えを確かめているときの Esc はそれをやめる（モーダルは閉じない）
		if (this._recording || this._pending) {
			this._recording = undefined;
			this._pending = undefined;
			this._render();
			return true;
		}
		return false;
	}

	setVisible(visible: boolean): void {
		if (!visible) {
			// 見えない間は背景の処理のログを読み直さない（ほかの領域を見ている間も 1.5 秒ごとに読み直さないように）
			this._logTimer.cancel();
		} else if (this._state) {
			// 見えたら描き直して、ログの読み直しを再開する
			this._render();
		}
	}

	layout(_width: number): void { }

	/** ナビの「Chrome ウェブストアから」: リンクか ID を貼る欄を出してフォーカスする。 */
	private _showStoreRow(): void {
		this._storeRow.style.display = '';
		this._storeInput.focus();
	}

	private async _refresh(): Promise<void> {
		try {
			this._state = await this._mainService.getState();
		} catch (error) {
			this._showMessage(localize('paradis.browserExtensions.error.state', "拡張機能の一覧を読めませんでした（{0}）。", error instanceof Error ? error.message : String(error)), true);
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		this._renderNotice();
		this._render();
	}

	private _showMessage(text: string, isError: boolean): void {
		this._messageElement.textContent = text;
		this._messageElement.classList.toggle('is-error', isError);
	}

	private _renderProfiles(): void {
		const options: Array<[string, string]> = [
			[PARADIS_DEFAULT_EXTENSION_PROFILE, localize('paradis.browserExtensions.profile.default', "既定（通常のタブ・ワークスペースのタブ）")],
			...this.profilesService.list().map((profile): [string, string] => [paradisNamedExtensionProfile(profile.id), localize('paradis.browserExtensions.profile.named', "プロファイル「{0}」", profile.name)]),
		];
		if (!options.some(([key]) => key === this._profile)) {
			this._profile = PARADIS_DEFAULT_EXTENSION_PROFILE;
		}
		this._profileSelect.setOptions(options.map(([key, label]) => ({ value: key, label })), this._profile);
		this._render();
	}

	/** 試験的な設定の状態（オフ・再起動待ち）を出す。 */
	private _renderNotice(): void {
		this._noticeStore.clear();
		dom.clearNode(this._noticeElement);
		const state = this._state;
		if (!state || (state.active && state.setting)) {
			this._noticeElement.style.display = 'none';
			return;
		}
		this._noticeElement.style.display = '';
		const text = dom.append(this._noticeElement, $('span'));
		const button = dom.append(this._noticeElement, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.primary'));
		button.type = 'button';
		if (!state.active && !state.setting) {
			text.textContent = localize('paradis.browserExtensions.notice.off', "試験的な機能です。今はオフになっています。オンにすると、再起動の後に使えます。");
			button.textContent = localize('paradis.browserExtensions.notice.turnOn', "オンにする");
			this._noticeStore.add(dom.addDisposableListener(button, 'click', async () => {
				await this.configurationService.updateValue(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING, true, ConfigurationTarget.USER);
				await this._refresh();
			}));
		} else {
			text.textContent = state.setting
				? localize('paradis.browserExtensions.notice.restartOn', "設定をオンにしました。再起動すると拡張機能が使えます。")
				: localize('paradis.browserExtensions.notice.restartOff', "設定をオフにしました。再起動すると拡張機能は読み込まれなくなります（入れたものは残ります）。");
			button.textContent = localize('paradis.browserExtensions.notice.restart', "再起動");
			this._noticeStore.add(dom.addDisposableListener(button, 'click', () => void this.nativeHostService.relaunch()));
		}
	}

	/** 一覧と詳細を作り直す。 */
	private _render(): void {
		this._renderStore.clear();
		this._logTimer.cancel();
		this._logElement = undefined;
		this._rowElements.clear();
		this._rowStatusElements.clear();
		this._workerErrorElement = undefined;
		this._workerStatusElement = undefined;
		dom.clearNode(this._listElement);
		dom.clearNode(this._detailElement);
		this._detailElement.classList.remove('pbe-detail-2col');
		const state = this._state;
		this._addItem.classList.toggle('is-disabled', !state?.active || this._busy);
		this._addItem.setAttribute('aria-disabled', String(!state?.active || this._busy));
		this._storeInput.disabled = !state?.active || this._busy;
		this._storeButton.disabled = !state?.active || this._busy;
		if (!state) {
			return;
		}
		if (state.extensions.length === 0) {
			dom.append(this._listElement, $('.pbe-list-empty')).textContent = localize('paradis.browserExtensions.emptyNav', "まだありません");
			dom.append(this._detailElement, $('.pbpm-empty')).textContent = localize('paradis.browserExtensions.emptyWithStore', "まだ拡張機能がありません。左の「Chrome ウェブストアから」でリンクか ID を貼って「ストアから追加」を押すか、展開済みの拡張機能のフォルダを「フォルダから読み込む…」で選んでください。");
			this._storeRow.style.display = '';
			return;
		}
		if (!state.extensions.some(extension => extension.id === this._selectedId)) {
			this._selectedId = state.extensions[0].id;
		}
		for (const extension of state.extensions) {
			this._renderListRow(extension, state.active);
		}
		this._shortcutsItem.setActive(this._view === 'shortcuts');
		if (this._view === 'shortcuts') {
			this._renderShortcuts(state);
			return;
		}
		const selected = state.extensions.find(extension => extension.id === this._selectedId);
		if (selected) {
			this._renderDetail(selected, state.active);
		}
	}

	private _appendIcon(parent: HTMLElement, extension: IParadisBrowserExtensionView, large: boolean): void {
		const icon = dom.append(parent, $(large ? '.pbe-icon.is-large' : '.pbe-icon'));
		if (extension.iconDataUrl) {
			const image = dom.append(icon, $<HTMLImageElement>('img'));
			image.src = extension.iconDataUrl;
			image.alt = '';
		} else {
			icon.appendChild($(ThemeIcon.asCSSSelector(Codicon.extensions)));
		}
	}

	/** 一覧の 1 行（アイコン・名前・状態・この場所で有効にするチェック）。押すと詳細の列に出す。 */
	private _renderListRow(extension: IParadisBrowserExtensionView, active: boolean): void {
		const selected = extension.id === this._selectedId;
		const row = dom.append(this._listElement, $('.phub-nav-item.pbe-list-row.paradis-focus-subtle'));
		// ショートカットの一覧を出している間は、どの行も選んでいる見た目にしない（Tab で止まる行は残す）
		row.classList.toggle('is-selected', selected && this._view === 'detail');
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(selected && this._view === 'detail'));
		// Tab で止まるのは選んでいる行だけ（ほかへは上下の矢印で移る。器の paradisHubDialog.ts）
		row.tabIndex = selected ? 0 : -1;
		this._rowElements.set(extension.id, row);
		this._appendIcon(row, extension, false);
		const info = dom.append(row, $('.pbpm-info'));
		dom.append(info, $('.pbpm-name')).textContent = extension.name;
		// 長い名前は省略記号で切れるので、行に乗せたときに全部を出す
		this._renderStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), row, extension.name));
		const status = dom.append(info, $('.pbpm-meta'));
		this._rowStatusElements.set(extension.id, status);
		this._fillRowStatus(status, extension);
		const select = () => {
			if (this._selectedId !== extension.id || this._view !== 'detail') {
				this._selectedId = extension.id;
				this._view = 'detail';
				this._recording = undefined;
				this._pending = undefined;
				this._render();
				this._focusSelectedRow();
			}
		};
		this._renderStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, select));
		this._renderStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.target !== row) {
				return;
			}
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				select();
				return;
			}
			// Tab で止まるのは選んでいる行だけなので、上下の矢印・Home・End で隣の行へ移って選ぶ（listbox の決まり）。
			// 器のナビの矢印の処理には渡さない（一覧の行は器のナビの直下ではないため、そちらでは行を辿れない）
			const ids = this._state?.extensions.map(candidate => candidate.id) ?? [];
			const index = ids.indexOf(extension.id);
			const next = event.key === 'ArrowUp' ? Math.max(0, index - 1)
				: event.key === 'ArrowDown' ? Math.min(ids.length - 1, index + 1)
					: event.key === 'Home' ? 0
						: event.key === 'End' ? ids.length - 1
							: undefined;
			if (next === undefined || index < 0) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (ids[next] !== this._selectedId || this._view !== 'detail') {
				this._selectedId = ids[next];
				this._view = 'detail';
				this._recording = undefined;
				this._pending = undefined;
				this._render();
			}
			this._focusSelectedRow();
		}));
	}

	/** 一覧の行の状態の印。 */
	private _fillRowStatus(status: HTMLElement, extension: IParadisBrowserExtensionView): void {
		const failed = !!(extension.loadError || extension.workerError);
		const lost = paradisLostShortcutCount(extension);
		status.classList.toggle('is-error', failed);
		status.classList.toggle('is-warning', !failed && lost > 0);
		if (failed) {
			status.textContent = extension.loadError
				? localize('paradis.browserExtensions.status.loadError', "読み込めませんでした")
				: localize('paradis.browserExtensions.status.workerError', "背景の処理を起動できませんでした");
		} else if (lost > 0) {
			// Q619: おすすめのキーをほかの拡張機能に取られて使えないショートカットがある
			status.textContent = localize('paradis.browserExtensions.status.lostShortcuts', "キーの重なり {0}", lost);
		} else if (!extension.enabledIn.includes(this._profile)) {
			status.textContent = localize('paradis.browserExtensions.status.disabled', "この場所では無効");
		} else if (extension.worker) {
			status.textContent = extension.worker.running
				? localize('paradis.browserExtensions.status.running', "背景の処理: 動作中")
				: localize('paradis.browserExtensions.status.idle', "背景の処理: 待機中");
		} else {
			status.textContent = localize('paradis.browserExtensions.status.version', "バージョン {0}", extension.version);
		}
	}

	/** 詳細の列の、背景の処理を起動できなかった理由（無ければ隠す）。 */
	private _fillWorkerError(element: HTMLElement, extension: IParadisBrowserExtensionView): void {
		element.style.display = extension.workerError ? '' : 'none';
		element.textContent = extension.workerError ? localize('paradis.browserExtensions.workerError', "背景の処理を起動できませんでした: {0}", extension.workerError) : '';
	}

	/** 詳細の列の、背景の処理の状態。 */
	private _fillWorkerStatus(element: HTMLElement, extension: IParadisBrowserExtensionView): void {
		element.textContent = extension.workerError
			? localize('paradis.browserExtensions.worker.failed', "状態: 起動できませんでした")
			: extension.worker?.running
				? localize('paradis.browserExtensions.worker.running', "状態: 動作中")
				: localize('paradis.browserExtensions.worker.idle', "状態: 待機中（使われると起動します）");
	}

	/**
	 * 背景の処理が動き出した・止まった・起動に失敗した: 一覧の行の状態の印と、詳細の列の背景の処理の欄だけを書き換える
	 * （約 30 秒で止まる worker のたびに画面を作り直すと、フォーカスと開いている削除の確認が消えるため）。拡張機能の顔ぶれが
	 * 変わっていたら作り直す。
	 */
	private async _refreshWorkers(): Promise<void> {
		if (this._busy) {
			return;
		}
		let state: IParadisBrowserExtensionsState;
		try {
			state = await this._mainService.getState();
		} catch {
			return;
		}
		if (this._store.isDisposed || this._busy) {
			return;
		}
		const previous = this._state;
		this._state = state;
		if (!previous || previous.active !== state.active || previous.extensions.map(extension => extension.id).join() !== state.extensions.map(extension => extension.id).join()) {
			this._renderNotice();
			this._render();
			return;
		}
		for (const extension of state.extensions) {
			const status = this._rowStatusElements.get(extension.id);
			if (status) {
				this._fillRowStatus(status, extension);
			}
			if (extension.id === this._selectedId) {
				if (this._workerErrorElement) {
					this._fillWorkerError(this._workerErrorElement, extension);
				}
				if (this._workerStatusElement) {
					this._fillWorkerStatus(this._workerStatusElement, extension);
				}
			}
		}
	}

	private _focusSelectedRow(): void {
		if (this._selectedId !== undefined) {
			this._rowElements.get(this._selectedId)?.focus();
		}
	}

	private _setEnabled(extension: IParadisBrowserExtensionView, enabling: boolean): void {
		const place = this._profile;
		void this._run(async () => {
			await this._mainService.setEnabled(extension.id, place, enabling);
			// 共有した後に有効にしたタブは共有の確認を通らないので、ここで知らせる（D4）
			if (enabling && extension.touchesPages) {
				const titles = paradisSharedPageTitlesInPlace(
					this.bindingModel.bindings.map(binding => ({ pageId: binding.pageId, title: binding.pageInfo.title || binding.pageInfo.url })),
					place,
					pageId => this.profilesService.getViewSession(pageId),
				);
				if (titles.length > 0) {
					this._showMessage(paradisEnabledWhileSharedWarning(extension.name, titles), true);
				}
			}
		});
	}

	/** 詳細の列（選んだ 1 件）。背景の処理がある拡張機能は 2 列にし、ログを右の列に置く（Q544）。 */
	private _renderDetail(extension: IParadisBrowserExtensionView, active: boolean): void {
		const twoColumns = !!extension.worker;
		this._detailElement.classList.toggle('pbe-detail-2col', twoColumns);
		const detail = twoColumns ? dom.append(this._detailElement, $('.pbe-col-main')) : this._detailElement;
		const header = dom.append(detail, $('.pbe-detail-header'));
		this._appendIcon(header, extension, true);
		const titles = dom.append(header, $('.pbe-detail-titles'));
		dom.append(titles, $('.pbe-detail-name')).textContent = extension.name;
		dom.append(titles, $('.pbpm-meta')).textContent = extension.source === 'webstore'
			? localize('paradis.browserExtensions.metaWebStore', "バージョン {0} ・ Manifest V{1} ・ Chrome ウェブストア", extension.version, extension.manifestVersion)
			: localize('paradis.browserExtensions.metaUnpacked', "バージョン {0} ・ Manifest V{1} ・ 開発用（フォルダから読み込み）: {2}", extension.version, extension.manifestVersion, extension.sourcePath);
		dom.append(titles, $('.pbpm-meta.pbe-detail-id')).textContent = localize('paradis.browserExtensions.id', "ID: {0}", extension.id);

		const actions = dom.append(detail, $('.pbe-detail-actions'));
		const confirmHost = dom.append(detail, $('.pbe-confirm-host'));
		if (extension.worker) {
			this._appendDetailButton(actions, localize('paradis.browserExtensions.devtools', "DevTools で調べる"), !active, async () => {
				const message = paradisDescribeOpenWorkerDevTools(await this._mainService.openWorkerDevTools(extension.id));
				if (message !== undefined) {
					this._showMessage(message, true);
				}
			});
		}
		// ストアから入れたものは読み込み直すフォルダが無い（更新はストアから）
		if (extension.source === 'unpacked') {
			this._appendDetailButton(actions, localize('paradis.browserExtensions.reload', "フォルダから読み込み直す"), !active, () => this._run(async () => {
				const result = await this._mainService.reloadUnpacked(extension.id);
				if (!result.ok) {
					this._showMessage(paradisDescribeAddExtensionFailure(result), true);
					return;
				}
				this._showMessage(localize('paradis.browserExtensions.reloaded', "「{0}」を読み込み直しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
			}));
		}
		if (extension.source === 'webstore' && extension.pendingUpdate) {
			this._appendDetailButton(actions, localize('paradis.browserExtensions.approveUpdate', "確かめて更新"), !active, () => this._run(async () => {
				const result = await this._mainService.approveWebStoreUpdate(extension.id);
				if (!result.ok) {
					this._showMessage(paradisDescribeAddExtensionFailure(result), result.reason !== 'cancelled');
					return;
				}
				this._showMessage(localize('paradis.browserExtensions.updated', "「{0}」を版 {1} に更新しました。開いているページには、読み込み直すと効きます。", result.extension.name, result.extension.version), false);
			}));
		}
		const removeButton = this._appendDetailButton(actions, localize('paradis.browserExtensions.remove', "削除"), !active, async () => this._confirmRemove(extension, confirmHost));
		removeButton.classList.add('is-danger');

		if (extension.loadError) {
			dom.append(detail, $('.pbe-callout.is-error')).textContent = localize('paradis.browserExtensions.loadError', "読み込めませんでした: {0}", extension.loadError);
		}
		// 背景の処理の欄は、状態が変わったときに書き換えるので、理由が無くても置いておく（隠す）
		this._workerErrorElement = dom.append(detail, $('.pbe-callout.is-error'));
		this._fillWorkerError(this._workerErrorElement, extension);
		if (extension.pagesWithoutApis?.length) {
			dom.append(detail, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.pagesWithoutApis', "次のページは UTF-8 でないか Para Code が書き換えられない形式のため、Para Code が足す機能（chrome.storage.sync など）が使えません: {0}", extension.pagesWithoutApis.join('、'));
		}
		if (extension.nextVersion) {
			dom.append(detail, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.nextVersion', "版 {0} に更新しました。次に Para Code を起動したときから使います。", extension.nextVersion);
		}
		if (extension.pendingUpdate) {
			// 新しく権限を求める更新は自動では入れない（確かめてから入れる）
			const added = [...extension.pendingUpdate.permissions, ...extension.pendingUpdate.hostPermissions].join('、');
			dom.append(detail, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.pendingUpdate', "版 {0} への更新が確認待ちです。新しく次を求めています: {1}", extension.pendingUpdate.version, added);
		}

		this._renderOptions(detail, extension, active);
		this._renderShortcutSummary(detail, extension);
		this._renderPermissions(detail, extension);
		if (twoColumns) {
			this._renderWorker(dom.append(this._detailElement, $('.pbe-col-log')), extension);
		}
	}

	private _appendSection(parent: HTMLElement, title: string): HTMLElement {
		const section = dom.append(parent, $('.pbe-section'));
		dom.append(section, $('.pbe-section-title')).textContent = title;
		return section;
	}

	/** 「この場所での設定」。拡張機能ごとの切り替えは {@link IExtensionOption} を足せば並ぶ。 */
	private _renderOptions(parent: HTMLElement, extension: IParadisBrowserExtensionView, active: boolean): void {
		const section = this._appendSection(parent, localize('paradis.browserExtensions.section.options', "この場所での設定"));
		const enabled = dom.append(section, $<HTMLLabelElement>('label.pbe-row-option'));
		const enabledSwitch = this._renderStore.add(new ParadisSwitch(enabled, { checked: extension.enabledIn.includes(this._profile), disabled: !active || this._busy }));
		dom.append(enabled, $('span')).textContent = localize('paradis.browserExtensions.enabledHere', "この場所で有効にする");
		this._renderStore.add(enabledSwitch.onDidChange(checked => this._setEnabled(extension, checked)));

		const options: IExtensionOption[] = [];
		if (extension.userScripts) {
			// Chrome の「ユーザースクリプトを許可」と同じ（拡張機能ごと・この場所で。既定はオフ）
			const place = this._profile;
			options.push({
				label: localize('paradis.browserExtensions.allowUserScripts', "ユーザースクリプトを許可"),
				note: localize('paradis.browserExtensions.userScriptsNote', "許可すると、この拡張機能が登録したスクリプト（ユーザースクリプト）が、この場所のタブのページで動きます。エージェントのタブと、エージェントと共有中のタブでは動きません。"),
				checked: extension.userScripts.allowedIn.includes(place),
				run: allowing => this._mainService.setUserScriptsAllowed(extension.id, place, allowing),
			});
		}
		if (extension.debuggerAccess) {
			// Q529: chrome.debugger（拡張機能ごと・この場所で。既定はオフ）。共有中のタブには設定に関わらずつながせない（Q530）
			const place = this._profile;
			options.push({
				label: localize('paradis.browserExtensions.allowDebugger', "デバッガーの接続を許可"),
				note: localize('paradis.browserExtensions.debuggerNote', "許可すると、この拡張機能がこの場所のタブにデバッガーでつなぎ、つないだタブのページの中身をすべて読み書きできます（表示している内容、入力欄の値、クリックやキー入力の操作を含みます）。エージェントのタブと、エージェントと共有中のタブには、共有中のタブでも拡張機能の画面を出す設定をオンにしていても、つながりません。"),
				checked: extension.debuggerAccess.allowedIn.includes(place),
				run: allowing => this._mainService.setDebuggerAllowed(extension.id, place, allowing),
			});
		}
		if (this._profile === PARADIS_DEFAULT_EXTENSION_PROFILE) {
			// SSH の窓で SSH 先へトンネルを通すのはワークスペースのタブ（「既定」の場所）だけなので、既定の場所でだけ出す（Q519。既定はオフ）
			options.push({
				label: localize('paradis.browserExtensions.allowOnRemote', "SSH 先のページでも使う"),
				note: localize('paradis.browserExtensions.allowOnRemoteNote', "オンにすると、SSH の窓で SSH 先のページを開くタブにもこの拡張機能が入ります。オンにすると、この拡張機能の通信（保管庫の同期など）も SSH 先から出ます。手元のアプリと localhost で話す拡張機能は、手元のアプリに届きません。"),
				checked: extension.allowedOnRemote,
				run: allowing => this._mainService.setAllowedOnRemote(extension.id, allowing),
			});
		}
		for (const option of options) {
			const label = dom.append(section, $<HTMLLabelElement>('label.pbe-row-option'));
			const optionSwitch = this._renderStore.add(new ParadisSwitch(label, { checked: option.checked, disabled: !active || this._busy }));
			dom.append(label, $('span')).textContent = option.label;
			this._renderStore.add(optionSwitch.onDidChange(checked => void this._run(() => option.run(checked))));
			dom.append(section, $('.pbe-option-note')).textContent = option.note;
		}
		if (extension.touchesPages) {
			// 共有の確認で知らせる対象（入力欄に値を入れられる・ページの中身を読める）
			dom.append(section, $('.pbe-row-note')).textContent = localize('paradis.browserExtensions.touchesPages', "ページの中身を読み書きできます。このタブを共有すると、拡張機能が入力した値はエージェントからも読めます");
		}
	}

	// ---------- ショートカット（Q619 の案 B） ----------

	/** ナビの「ショートカット」: 右に一覧を出す。 */
	private _showShortcuts(): void {
		if (this._view !== 'shortcuts') {
			this._view = 'shortcuts';
			this._recording = undefined;
			this._pending = undefined;
			this._render();
		}
	}

	/** 詳細の列の「ショートカット」: 数と、一覧へ移るボタンだけ。 */
	private _renderShortcutSummary(parent: HTMLElement, extension: IParadisBrowserExtensionView): void {
		const commands = extension.commands ?? [];
		const section = this._appendSection(parent, localize('paradis.browserExtensions.section.shortcuts', "ショートカット"));
		const summary = dom.append(section, $('.pbe-sc-summary'));
		if (commands.length === 0) {
			dom.append(summary, $('span')).textContent = localize('paradis.browserExtensions.shortcuts.none', "ありません");
			return;
		}
		const count = dom.append(summary, $('span'));
		const lost = paradisLostShortcutCount(extension);
		count.textContent = localize('paradis.browserExtensions.shortcuts.count', "{0} 個", commands.length);
		if (lost > 0) {
			dom.append(summary, $('span.pbe-sc-warn-text')).textContent = localize('paradis.browserExtensions.shortcuts.lostCount', "{0} 個は重なって使えません", lost);
		}
		const open = dom.append(summary, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
		open.type = 'button';
		open.textContent = localize('paradis.browserExtensions.shortcuts.openList', "ショートカットの一覧で変える");
		this._renderStore.add(dom.addDisposableListener(open, 'click', () => this._showShortcuts()));
	}

	/** ショートカットの一覧（入れた拡張機能を先に入れた順に並べ、コマンドとキーを出す）。 */
	private _renderShortcuts(state: IParadisBrowserExtensionsState): void {
		const page = dom.append(this._detailElement, $('.pbe-sc-page'));
		dom.append(page, $('.pbe-detail-name')).textContent = localize('paradis.browserExtensions.shortcuts.title', "拡張機能のショートカット");
		dom.append(page, $('p.pbpm-description')).textContent = localize('paradis.browserExtensions.shortcuts.description', "内蔵ブラウザのページを開いているときに効くキーです。同じキーは 1 つのコマンドだけが使えます（先に入れた拡張機能が取ります。ここで付け替えると、付け替えた方が取ります）。Para Code のショートカットと同じキーは付けられません。");
		const extensions = [...state.extensions].sort((a, b) => a.installedAt - b.installedAt);
		const lostAll = extensions.reduce((sum, extension) => sum + paradisLostShortcutCount(extension), 0);
		if (lostAll > 0) {
			const callout = dom.append(page, $('.pbe-callout.is-warning'));
			callout.appendChild($(ThemeIcon.asCSSSelector(Codicon.warning)));
			dom.append(callout, $('span')).textContent = localize('paradis.browserExtensions.shortcuts.lostAll', "重なって使えないショートカットが {0} 個あります。", lostAll);
		}
		for (const extension of extensions) {
			const group = dom.append(page, $('.pbe-sc-group'));
			const head = dom.append(group, $('.pbe-sc-head'));
			this._appendIcon(head, extension, false);
			dom.append(head, $('span.pbe-sc-head-name')).textContent = extension.name;
			const commands = extension.commands ?? [];
			if (commands.length === 0) {
				dom.append(group, $('.pbpm-meta.pbe-sc-none')).textContent = localize('paradis.browserExtensions.shortcuts.noneForExtension', "ショートカットがありません");
				continue;
			}
			const list = dom.append(group, $('.pbe-sc-list'));
			for (const command of commands) {
				this._renderShortcutRow(list, state, extension, command);
			}
		}
	}

	private _renderShortcutRow(list: HTMLElement, state: IParadisBrowserExtensionsState, extension: IParadisBrowserExtensionView, command: IParadisBrowserExtensionShortcut): void {
		const row = dom.append(list, $('.pbe-sc-row'));
		const main = dom.append(row, $('.pbe-sc-main'));
		const label = describeCommand(command);
		dom.append(main, $('span.pbe-sc-desc')).textContent = label;
		if (command.source === 'lost' && command.lostTo) {
			const owner = state.extensions.find(candidate => candidate.id === command.lostTo?.extensionId);
			const warn = dom.append(main, $('span.pbe-sc-warn'));
			warn.appendChild($(ThemeIcon.asCSSSelector(Codicon.warning)));
			dom.append(warn, $('span')).textContent = localize('paradis.browserExtensions.shortcuts.lost', "{0} は {1} が使っています", command.suggested, owner?.name ?? command.lostTo.extensionId);
		} else if (command.source === 'user') {
			dom.append(main, $('span.pbe-sc-note')).textContent = localize('paradis.browserExtensions.shortcuts.changed', "変更済み");
		} else if (command.source === 'removed') {
			dom.append(main, $('span.pbe-sc-note')).textContent = localize('paradis.browserExtensions.shortcuts.removed', "外しました");
		}
		const keyCell = dom.append(row, $('.pbe-sc-key'));
		const recording = this._recording?.extensionId === extension.id && this._recording.name === command.name;
		const disabled = !state.active || this._busy;
		if (recording) {
			const recorder = dom.append(keyCell, $('span.pbe-sc-recorder.paradis-focus-ring'));
			recorder.tabIndex = 0;
			recorder.setAttribute('role', 'textbox');
			recorder.setAttribute('aria-label', localize('paradis.browserExtensions.shortcuts.recorderLabel', "「{0}」のキー", label));
			recorder.textContent = localize('paradis.browserExtensions.shortcuts.recorder', "キーを押してください（Esc でやめる）");
			this._renderStore.add(dom.addDisposableListener(recorder, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => this._onRecorderKey(event, extension, command)));
			this._renderStore.add(dom.addDisposableListener(recorder, dom.EventType.BLUR, () => {
				// ほかを押してフォーカスが外れたらやめる（描き直しで外れたときは同じものに戻っている）
				const targetWindow = dom.getWindow(recorder);
				targetWindow.setTimeout(() => {
					const stillRecording = this._recording?.extensionId === extension.id && this._recording.name === command.name;
					if (stillRecording && recorder.isConnected && targetWindow.document.activeElement !== recorder) {
						this._recording = undefined;
						this._render();
					}
				}, 0);
			}));
			recorder.focus();
		} else if (command.shortcut) {
			const keys = dom.append(keyCell, $('span.pbe-sc-keys'));
			keys.setAttribute('aria-label', command.shortcut);
			for (const part of paradisShortcutKeyParts(command.shortcut)) {
				dom.append(keys, $('kbd')).textContent = part;
			}
		} else {
			dom.append(keyCell, $('span.pbe-sc-unset')).textContent = localize('paradis.browserExtensions.shortcuts.unset', "未設定");
		}
		const actions = dom.append(row, $('.pbe-sc-actions'));
		if (!recording) {
			const edit = dom.append(actions, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
			edit.type = 'button';
			edit.textContent = command.shortcut
				? localize('paradis.browserExtensions.shortcuts.edit', "変更")
				: localize('paradis.browserExtensions.shortcuts.add', "キーを付ける");
			edit.disabled = disabled;
			edit.setAttribute('aria-label', localize('paradis.browserExtensions.shortcuts.editLabel', "「{0}」のキーを変える", label));
			this._renderStore.add(dom.addDisposableListener(edit, 'click', () => {
				this._recording = { extensionId: extension.id, name: command.name };
				this._pending = undefined;
				this._showMessage('', false);
				this._render();
			}));
		}
		const iconButton = (icon: ThemeIcon, text: string, run: () => Promise<unknown>) => {
			const button = this._renderStore.add(new ParadisButton(actions, { kind: 'icon', icon, small: true, ariaLabel: text, title: text, disabled }));
			this._renderStore.add(button.onDidClick(() => void this._run(run)));
		};
		const slot = () => dom.append(actions, $('span.pbe-sc-slot'));
		if (!recording && command.shortcut) {
			iconButton(Codicon.close, localize('paradis.browserExtensions.shortcuts.clear', "キーを外す"), async () => {
				await this._mainService.clearShortcut(extension.id, command.name);
				this._showMessage(localize('paradis.browserExtensions.shortcuts.cleared', "「{0}」のキーを外しました。", label), false);
			});
		} else if (!recording) {
			slot();
		}
		if (!recording && (command.source === 'user' || command.source === 'removed')) {
			iconButton(Codicon.discard, localize('paradis.browserExtensions.shortcuts.reset', "拡張機能のおすすめのキーに戻す"), async () => {
				await this._mainService.resetShortcut(extension.id, command.name);
				this._showMessage(localize('paradis.browserExtensions.shortcuts.resetDone', "「{0}」を拡張機能のおすすめのキーに戻しました。", label), false);
			});
		} else if (!recording) {
			slot();
		}
		const pending = this._pending;
		if (pending && pending.extensionId === extension.id && pending.name === command.name) {
			const conflict = dom.append(row, $('.pbe-sc-conflict'));
			conflict.setAttribute('role', 'alert');
			conflict.appendChild($(ThemeIcon.asCSSSelector(Codicon.warning)));
			dom.append(conflict, $('span')).textContent = localize('paradis.browserExtensions.shortcuts.conflict', "{0} は {1} の「{2}」が使っています。付け替えると、{1} のほうは外れます。", pending.shortcut, pending.ownerName, pending.ownerCommand);
			const take = dom.append(conflict, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.primary'));
			take.type = 'button';
			take.textContent = localize('paradis.browserExtensions.shortcuts.take', "付け替える");
			take.disabled = disabled;
			const keep = dom.append(conflict, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
			keep.type = 'button';
			keep.textContent = localize('paradis.browserExtensions.shortcuts.keep', "やめる");
			this._renderStore.add(dom.addDisposableListener(take, 'click', () => {
				this._pending = undefined;
				void this._assignShortcut(pending, label);
			}));
			this._renderStore.add(dom.addDisposableListener(keep, 'click', () => {
				this._pending = undefined;
				this._render();
			}));
			take.focus();
		}
	}

	/** キーを待っている欄で押されたキー。Para Code のショートカットや、修飾キーの無いキーは断る。 */
	private _onRecorderKey(event: KeyboardEvent, extension: IParadisBrowserExtensionView, command: IParadisBrowserExtensionShortcut): void {
		// 押したキーで Para Code のコマンド（コマンドパレット・エディタを閉じるなど）が走らないように止める
		event.preventDefault();
		event.stopPropagation();
		if (event.repeat || event.isComposing) {
			return;
		}
		const read = paradisShortcutFromKeyEvent(event, SHORTCUT_PLATFORM, () => this._paraCodeCommand(event));
		if ('refusal' in read) {
			switch (read.refusal) {
				case 'modifierOnly':
					return;
				case 'unsupportedKey':
					this._showMessage(SHORTCUT_PLATFORM === 'mac'
						? localize('paradis.browserExtensions.shortcuts.unsupportedMac', "このキーは使えません。A〜Z・0〜9・矢印・, . などのキーを、⌘・⌃・⌥ のどれかと一緒に押してください。")
						: localize('paradis.browserExtensions.shortcuts.unsupported', "このキーは使えません。A〜Z・0〜9・矢印・, . などのキーを、Ctrl・Alt のどちらかと一緒に押してください。"), true);
					return;
				case 'noModifier':
					this._showMessage(SHORTCUT_PLATFORM === 'mac'
						? localize('paradis.browserExtensions.shortcuts.noModifierMac', "⌘・⌃・⌥ のどれかと一緒に押してください（Chrome と同じく、⇧ だけではショートカットになりません）。")
						: localize('paradis.browserExtensions.shortcuts.noModifier', "Ctrl・Alt のどちらかと一緒に押してください（Chrome と同じく、Shift だけではショートカットになりません）。"), true);
					return;
				case 'metaKey':
					this._showMessage(localize('paradis.browserExtensions.shortcuts.metaKey', "Windows キー（Super キー）を含むキーは付けられません。Ctrl・Alt のどちらかと一緒に押してください。"), true);
					return;
				case 'paraCode':
					this._showMessage(localize('paradis.browserExtensions.shortcuts.paraCode', "{0} は Para Code の「{1}」に使われています。ページの中では Para Code が先に取るので、拡張機能には付けられません。", read.shortcut, read.command), true);
					return;
			}
		}
		this._recording = undefined;
		const owner = paradisShortcutOwner(this._state?.extensions ?? [], read.shortcut, extension.id, command.name);
		const label = describeCommand(command);
		if (owner) {
			this._pending = { extensionId: extension.id, name: command.name, binding: read.binding, shortcut: read.shortcut, ownerName: owner.extension.name, ownerCommand: describeCommand(owner.command) };
			this._showMessage('', false);
			this._render();
			return;
		}
		void this._assignShortcut({ extensionId: extension.id, name: command.name, binding: read.binding, shortcut: read.shortcut, ownerName: '', ownerCommand: '' }, label);
	}

	private async _assignShortcut(pending: IPendingShortcut, label: string): Promise<void> {
		await this._run(async () => {
			const assigned = await this._mainService.assignShortcut(pending.extensionId, pending.name, pending.binding);
			const extensionName = this._state?.extensions.find(candidate => candidate.id === pending.extensionId)?.name ?? '';
			if (!assigned) {
				this._showMessage(localize('paradis.browserExtensions.shortcuts.assignFailed', "{0} を付けられませんでした。", pending.shortcut), true);
			} else if (pending.ownerName) {
				this._showMessage(localize('paradis.browserExtensions.shortcuts.assignedTaken', "{0} を {1} の「{2}」に付けました。{3} の「{4}」は外れました。", pending.shortcut, extensionName, label, pending.ownerName, pending.ownerCommand), false);
			} else {
				this._showMessage(localize('paradis.browserExtensions.shortcuts.assigned', "{0} を {1} の「{2}」に付けました。", pending.shortcut, extensionName, label), false);
			}
		});
	}

	/**
	 * そのキーが Para Code のショートカットなら、コマンドの名前（ページのキーを走らせるときと同じく softDispatch で、開いている
	 * 内蔵ブラウザのタブ（無ければこの領域）から引く。2 打のキーの初めも Para Code が取るので断る）。
	 */
	private _paraCodeCommand(event: KeyboardEvent): string | undefined {
		const browser = this.editorService.visibleEditorPanes.map(pane => pane as unknown).find(pane => pane instanceof BrowserEditor);
		const target = (browser instanceof BrowserEditor ? browser.getContainer() : undefined) ?? this._contentElement;
		const result = this.keybindingService.softDispatch(new StandardKeyboardEvent(event), target);
		if (result.kind === ResultKind.MoreChordsNeeded) {
			return localize('paradis.browserExtensions.shortcuts.chord', "2 打のキーの初め");
		}
		if (result.kind !== ResultKind.KbFound || !result.commandId) {
			return undefined;
		}
		const title = MenuRegistry.getCommand(result.commandId)?.title;
		return typeof title === 'string' ? title : title?.value ?? result.commandId;
	}

	/** 「権限」（manifest の permissions と、読み書きできるサイト）。 */
	private _renderPermissions(parent: HTMLElement, extension: IParadisBrowserExtensionView): void {
		const permissions = extension.permissions ?? [];
		const hosts = extension.hostPermissions ?? [];
		const section = this._appendSection(parent, localize('paradis.browserExtensions.section.permissions', "権限"));
		if (permissions.length === 0 && hosts.length === 0) {
			dom.append(section, $('.pbpm-meta')).textContent = localize('paradis.browserExtensions.noPermissions', "求めている権限はありません。");
			return;
		}
		const chips = dom.append(section, $('.pbe-chips'));
		for (const host of hosts) {
			const chip = dom.append(chips, $('span.pbe-chip.is-host'));
			chip.textContent = host === '<all_urls>' || host === '*://*/*' ? localize('paradis.browserExtensions.allSites', "すべてのサイト") : host;
			chip.title = host;
		}
		for (const permission of permissions) {
			dom.append(chips, $('span.pbe-chip')).textContent = permission;
		}
	}

	/** 「背景の処理」（状態と console のログ）。開いている間だけログを読み直す。 */
	private _renderWorker(parent: HTMLElement, extension: IParadisBrowserExtensionView): void {
		const section = this._appendSection(parent, localize('paradis.browserExtensions.section.worker', "背景の処理（service worker）"));
		section.classList.add('pbe-section-worker');
		this._workerStatusElement = dom.append(section, $('.pbpm-meta'));
		this._fillWorkerStatus(this._workerStatusElement, extension);
		const log = dom.append(section, $('.pbe-log.paradis-focus-ring-inset'));
		log.setAttribute('role', 'log');
		log.setAttribute('aria-label', localize('paradis.browserExtensions.worker.logLabel', "背景の処理のログ"));
		log.tabIndex = 0;
		this._logElement = log;
		const id = extension.id;
		const empty = dom.append(log, $('.pbe-log-empty'));
		empty.textContent = localize('paradis.browserExtensions.worker.noLog', "まだ出力はありません。");
		// 読み直すのは前に読んだ行より後だけ（全行を作り直すと、選んでいる文字が消える）
		let lastSeq = 0;
		let loading = false;
		const load = async () => {
			if (loading) {
				return;
			}
			loading = true;
			let lines: readonly IParadisWorkerLogLine[];
			try {
				lines = await this._mainService.getWorkerLog(id, lastSeq);
			} catch {
				return;
			} finally {
				loading = false;
			}
			if (this._logElement !== log || this._selectedId !== id || lines.length === 0) {
				return;
			}
			lastSeq = lines[lines.length - 1].seq;
			empty.remove();
			this._appendLog(log, lines);
		};
		void load();
		this._logTimer.cancelAndSet(() => void load(), WORKER_LOG_POLL_MS, dom.getWindow(log));
	}

	/** ログに行を足す（古い行は {@link MAX_SHOWN_LOG_LINES} を超えた分だけ消す）。 */
	private _appendLog(log: HTMLElement, lines: readonly IParadisWorkerLogLine[]): void {
		const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
		for (const line of lines) {
			const row = dom.append(log, $(`.pbe-log-line.is-${line.level}`));
			row.textContent = line.session ? `[${formatLogTime(line.at)}] [${line.session}] ${line.message}` : `[${formatLogTime(line.at)}] ${line.message}`;
			if (line.source) {
				row.title = line.source;
			}
		}
		while (log.childElementCount > MAX_SHOWN_LOG_LINES) {
			log.firstElementChild?.remove();
		}
		if (atBottom) {
			log.scrollTop = log.scrollHeight;
		}
	}

	private _appendDetailButton(parent: HTMLElement, label: string, disabled: boolean, run: () => Promise<unknown>): HTMLButtonElement {
		const button = dom.append(parent, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
		button.type = 'button';
		button.textContent = label;
		button.disabled = disabled || this._busy;
		this._renderStore.add(dom.addDisposableListener(button, 'click', () => void run()));
		return button;
	}

	private _confirmRemove(extension: IParadisBrowserExtensionView, host: HTMLElement): void {
		dom.clearNode(host);
		const popover = dom.append(host, $('.pbpm-confirm'));
		const title = dom.append(popover, $('.pbpm-confirm-title'));
		dom.append(title, $(ThemeIcon.asCSSSelector(Codicon.warning)));
		dom.append(title, $('span')).textContent = localize('paradis.browserExtensions.confirmTitle', "「{0}」を削除しますか？", extension.name);
		dom.append(popover, $('p')).textContent = localize('paradis.browserExtensions.confirmBody', "すべての場所から外し、この拡張機能が保存したデータも消します（消しきるのは次の起動の後です。それまでは入れ直せません）。元のフォルダは消しません。");
		const buttons = dom.append(popover, $('.pbpm-confirm-actions'));
		const cancel = dom.append(buttons, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.secondary'));
		cancel.type = 'button';
		cancel.textContent = localize('paradis.browserExtensions.confirmCancel', "キャンセル");
		const confirm = dom.append(buttons, $<HTMLButtonElement>('button.pbpm-btn.paradis-focus-ring.danger'));
		confirm.type = 'button';
		confirm.textContent = localize('paradis.browserExtensions.confirmRemove', "削除する");
		this._renderStore.add(dom.addDisposableListener(cancel, 'click', () => this._render()));
		this._renderStore.add(dom.addDisposableListener(confirm, 'click', () => void this._run(() => this._mainService.remove(extension.id))));
		confirm.focus();
	}

	/** main への操作を 1 つずつ行い、終わったら一覧を読み直す。 */
	private async _run(operation: () => Promise<unknown>): Promise<void> {
		if (this._busy) {
			return;
		}
		this._busy = true;
		this._render();
		try {
			await operation();
		} catch (error) {
			this._showMessage(localize('paradis.browserExtensions.error.operation', "操作できませんでした（{0}）。", error instanceof Error ? error.message : String(error)), true);
		} finally {
			this._busy = false;
		}
		if (!this._store.isDisposed) {
			await this._refresh();
		}
	}

	private async _addFromWebStore(): Promise<void> {
		const input = this._storeInput.value.trim();
		if (!input || this._busy) {
			return;
		}
		const place = this._profile;
		const label = this._profileSelect.values.find(option => option.value === place)?.label ?? place;
		this._showMessage(localize('paradis.browserExtensions.store.downloading', "Chrome ウェブストアから落として、署名を確かめています…"), false);
		await this._run(async () => {
			const result = await this._mainService.addFromWebStore(input, place, label);
			if (!result.ok) {
				this._showMessage(paradisDescribeAddExtensionFailure(result), result.reason !== 'cancelled');
				return;
			}
			this._storeInput.value = '';
			this._selectedId = result.extension.id;
			this._showMessage(localize('paradis.browserExtensions.store.added', "「{0}」を Chrome ウェブストアから追加しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
		});
	}

	private async _addFromFolder(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('paradis.browserExtensions.pickTitle', "拡張機能のフォルダを選ぶ"),
			openLabel: localize('paradis.browserExtensions.pickOpen', "読み込む"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			// 拡張機能はこのパソコンのブラウザに入るので、SSH 先のフォルダは選ばせない
			availableFileSystems: [Schemas.file],
		});
		const folder = picked?.[0];
		if (!folder || this._store.isDisposed) {
			return;
		}
		await this._run(async () => {
			const result = await this._mainService.addUnpacked(folder.fsPath, this._profile);
			if (!result.ok) {
				this._showMessage(paradisDescribeAddExtensionFailure(result), true);
				return;
			}
			this._selectedId = result.extension.id;
			this._showMessage(localize('paradis.browserExtensions.added', "「{0}」を足しました。開いているページには、読み込み直すと効きます。", result.extension.name), false);
		});
	}
}

/** 統合のモーダルの「ブラウザ拡張機能」の領域を開く。 */
export function paradisShowBrowserExtensionsDialog(instantiationService: IInstantiationService): void {
	instantiationService.invokeFunction(accessor => paradisOpenHub(accessor, ParadisHubAreaId.Extensions));
}
