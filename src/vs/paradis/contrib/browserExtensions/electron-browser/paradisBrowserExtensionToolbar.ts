/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/renderer/src/components/browser-pane/assemble-chrome/browser-extension-toolbar.tsx, src/renderer/src/components/browser-pane/assemble-chrome/browser-extension-action-menu.tsx

// 内蔵ブラウザのツールバーの、Chrome 拡張機能（試験的）のボタン（P5）。
//
//  - パズルのボタン（そのタブに拡張機能が入っているときだけ）と、ピン留めした拡張機能のボタン。どちらも
//    MenuId.BrowserActionsToolbar のアクションなので、ツールバーが狭いと後ろから「…」へ畳まれる。置き場所は
//    共有のボタン（2_paradisShare）のすぐ後ろ。共有の状態が最後まで見えるよう、拡張機能のボタンが先に畳まれる
//  - 拡張機能ごとのアクションは、見つけた拡張機能の分だけ登録し、そのタブのエディタの context key（ピン留めした
//    id の並び）で出し分ける。タブ（エディタ）ごとに場所（プロファイル）が違い、ピン留めも場所ごと（D2）
//  - ボタンの絵・バッジ・ホバーの文は main が持つ chrome.action の状態で、タブごとに取り直す
//  - ボタンを押すと main がポップアップ（拡張機能のページの小さな窓）をボタンの下に出す。位置はここで測って渡す
//    （upstream のファイルは触らない）
//
// 一覧（パズルを押すと開く）は自前の DOM なので、内蔵ブラウザのネイティブビューの上に出すために overlayManager.ts の
// 共通の印 `paradis-overlay-popover` を付ける。閉じ方は共有の一覧（paradisBrowserShareButton.ts）と同じ。

import './media/paradisBrowserExtensionToolbar.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisBrowserExtensionsMainService,
	IParadisBrowserExtensionToolbar,
	IParadisToolbarAction,
	IParadisToolbarAnchor,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
} from '../common/paradisBrowserExtensions.js';
import { paradisShowBrowserExtensionsDialog } from './paradisBrowserExtensionsDialog.js';

const $ = dom.$;

/** ツールバーのグループ。共有のボタン（2_paradisShare）の後ろ、upstream の拡大（2_zoom）の前。 */
const PARADIS_EXTENSIONS_TOOLBAR_GROUP = '2_paradisWebExtensions';

/** パズルのボタン（拡張機能の一覧）のアクション。 */
const MENU_ACTION_ID = 'paradis.browserExtensions.toolbarMenu';
/** 拡張機能ごとのボタンのアクションの id の接頭辞（後ろは拡張機能の id）。 */
const BUTTON_ACTION_PREFIX = 'paradis.browserExtensions.toolbarButton.';

/** そのタブに拡張機能が入っているか（パズルのボタンを出す）。 */
const CONTEXT_PARADIS_EXTENSIONS_AVAILABLE = new RawContextKey<boolean>('paradisBrowserExtensionsAvailable', false, localize('paradis.browserExtensions.context.available', "内蔵ブラウザのタブに Chrome 拡張機能が入っているかどうか"));
/** そのタブの場所でピン留めした拡張機能の id（`,id1,id2,` の形。拡張機能ごとのボタンの出し分けに使う）。 */
const CONTEXT_PARADIS_EXTENSIONS_PINNED = new RawContextKey<string>('paradisBrowserExtensionsPinned', '', localize('paradis.browserExtensions.context.pinned', "内蔵ブラウザのタブのツールバーに出す Chrome 拡張機能"));

/** 一覧の幅。 */
const POPOVER_WIDTH = 320;
const ANCHOR_GAP = 4;
const EDGE_MARGIN = 8;
/** バッジに出す文字の数（Chrome は 4 文字ほどで切れる）。 */
const BADGE_MAX_LENGTH = 4;

export const IParadisBrowserExtensionToolbarService = createDecorator<IParadisBrowserExtensionToolbarService>('paradisBrowserExtensionToolbarService');

/** ツールバーのボタンと main をつなぐ（ウィンドウに 1 つ）。 */
export interface IParadisBrowserExtensionToolbarService {
	readonly _serviceBrand: undefined;
	/** 試験的な設定が今の起動で効いているか（オフならツールバーに何も出さない）。 */
	readonly active: boolean;
	readonly main: IParadisBrowserExtensionsMainService;
	/** main のツールバーが変わった（IPC の購読はこの 1 つにまとめる）。 */
	readonly onDidChangeToolbar: Event<void>;
	/** 拡張機能ごとのボタンのアクションを用意する（まだなら登録する）。 */
	ensureButtons(actions: readonly IParadisToolbarAction[]): void;
}

export class ParadisBrowserExtensionToolbarService extends Disposable implements IParadisBrowserExtensionToolbarService {
	declare readonly _serviceBrand: undefined;

	readonly active: boolean;
	readonly main: IParadisBrowserExtensionsMainService;
	private readonly _onDidChangeToolbar = this._register(new Emitter<void>());
	readonly onDidChangeToolbar: Event<void> = this._onDidChangeToolbar.event;
	/** 登録した拡張機能ごとのボタン（id → 名前と登録）。 */
	private readonly _buttons = this._register(new DisposableMap<string, IDisposable & { readonly name: string }>());

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService configurationService: IConfigurationService,
		@IActionViewItemService private readonly _actionViewItemService: IActionViewItemService,
	) {
		super();
		this.active = configurationService.getValue<boolean>(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING) === true;
		this.main = ProxyChannel.toService<IParadisBrowserExtensionsMainService>(mainProcessService.getChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL));
		if (this.active) {
			this._register(this.main.onDidChangeToolbar(() => this._onDidChangeToolbar.fire()));
		}
	}

	ensureButtons(actions: readonly IParadisToolbarAction[]): void {
		let changed = false;
		for (const action of actions) {
			if (this._buttons.get(action.extensionId)?.name !== action.name) {
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		// 並びは名前の順（メニューの順は登録で決まり、場所ごとのピン留めの順にはできない）。名前が変わったら登録し直す
		const known = new Map<string, string>([...this._buttons].map(([id, entry]) => [id, entry.name]));
		for (const action of actions) {
			known.set(action.extensionId, action.name);
		}
		const sorted = [...known].sort((a, b) => a[1].localeCompare(b[1]));
		this._buttons.clearAndDisposeAll();
		sorted.forEach(([extensionId, name], index) => {
			const commandId = `${BUTTON_ACTION_PREFIX}${extensionId}`;
			const store = new DisposableStore();
			store.add(CommandsRegistry.registerCommand(commandId, (accessor: ServicesAccessor, editor?: unknown) => runExtensionButton(accessor, editor, extensionId)));
			store.add(MenuRegistry.appendMenuItem(MenuId.BrowserActionsToolbar, {
				command: { id: commandId, title: name },
				group: PARADIS_EXTENSIONS_TOOLBAR_GROUP,
				order: index,
				when: ContextKeyExpr.regex(CONTEXT_PARADIS_EXTENSIONS_PINNED.key, new RegExp(`,${extensionId},`)),
			}));
			store.add(this._actionViewItemService.register(MenuId.BrowserActionsToolbar, commandId, (action, options, instantiationService) =>
				instantiationService.createInstance(ParadisBrowserExtensionButtonViewItem, action, options, extensionId)));
			this._buttons.set(extensionId, Object.assign(store, { name }));
		});
	}
}

/** ブラウザのエディタ（ツールバーの context）。 */
function asBrowserEditor(value: unknown): BrowserEditor | undefined {
	return value instanceof BrowserEditor ? value : undefined;
}

/** 要素のあるウィンドウと、その中の位置（CSS のピクセル）。 */
function anchorOf(element: HTMLElement): IParadisToolbarAnchor {
	const rect = element.getBoundingClientRect();
	return { windowId: dom.getWindow(element).vscodeWindowId, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** 見えている要素か（ツールバーの「…」へ畳まれていない）。 */
function isShown(element: Element | null | undefined): element is HTMLElement {
	return dom.isHTMLElement(element) && element.isConnected && element.offsetParent !== null;
}

/**
 * ポップアップを置く基準の要素: その拡張機能のボタン → パズルのボタン → ツールバーの「…」→ ツールバー。
 * 畳まれていても「…」の下に出す（Chrome もパズルの下に出す）。
 */
function popupAnchorElement(editor: BrowserEditor, extensionId: string | undefined): HTMLElement | undefined {
	const own = (wanted: string | undefined) => [...liveItems].find(item => item.extensionId === wanted && item.editor() === editor && isShown(item.element()))?.element();
	const root = editor.getContainer();
	// 「…」とツールバーは upstream の ActionBar が作るので、自分で持っていない。見つからなければ自前のボタンだけを使う
	// eslint-disable-next-line no-restricted-syntax -- upstream-owned toolbar DOM, only read to place the popup
	const more = root?.querySelector(`.browser-actions-toolbar ${ThemeIcon.asCSSSelector(Codicon.toolBarMore)}`)?.closest('.action-item');
	// eslint-disable-next-line no-restricted-syntax -- upstream-owned toolbar DOM, only read to place the popup
	const toolbar = root?.querySelector('.browser-actions-toolbar');
	return [extensionId !== undefined ? own(extensionId) : undefined, own(undefined), more, toolbar].find(isShown);
}

/** 描いている自前のボタン（拡張機能のボタンは extensionId あり、パズルは無し）。ポップアップの位置合わせに使う。 */
interface ILiveItem {
	readonly extensionId: string | undefined;
	editor(): BrowserEditor | undefined;
	element(): HTMLElement | undefined;
}
const liveItems = new Set<ILiveItem>();

/** 拡張機能のボタンを押した（ツールバーから・「…」の一覧から）。 */
async function activateExtension(accessor: ServicesAccessor, editor: BrowserEditor, extensionId: string, anchorElement: HTMLElement | undefined, popupOnly: boolean): Promise<boolean> {
	const toolbarService = accessor.get(IParadisBrowserExtensionToolbarService);
	const logService = accessor.get(ILogService);
	const model = editor.model;
	const anchor = anchorElement ?? popupAnchorElement(editor, extensionId);
	if (!model || !anchor) {
		return false;
	}
	const result = await toolbarService.main.activateAction(model.id, extensionId, anchorOf(anchor), popupOnly);
	if (!result.ok) {
		logService.warn('[paradis] a browser extension button did not run', result.error);
	}
	return result.ok;
}

function runExtensionButton(accessor: ServicesAccessor, editorArg: unknown, extensionId: string): Promise<boolean> | undefined {
	const editor = asBrowserEditor(editorArg) ?? asBrowserEditor(accessor.get(IEditorService).activeEditorPane);
	return editor ? activateExtension(accessor, editor, extensionId, undefined, false) : undefined;
}

/** 絵の無い拡張機能に出す、名前の頭文字。 */
export function paradisExtensionInitial(name: string): string {
	return ([...name.trim()][0] ?? '?').toLocaleUpperCase();
}

/** バッジの文字（長いものは切る）。 */
export function paradisBadgeText(text: string): string {
	return [...text].slice(0, BADGE_MAX_LENGTH).join('');
}

/** ボタンのホバーと読み上げの文。 */
export function paradisExtensionButtonLabel(action: Pick<IParadisToolbarAction, 'name' | 'title' | 'badgeText'>): string {
	const title = action.title && action.title !== action.name ? localize('paradis.browserExtensions.button.titled', "{0}: {1}", action.name, action.title) : action.name;
	return action.badgeText ? localize('paradis.browserExtensions.button.badge', "{0}（{1}）", title, action.badgeText) : title;
}

/**
 * タブ（エディタ）ごとの拡張機能のボタンの状態。main からそのタブのツールバーを取り、context key を合わせる。
 */
export class ParadisBrowserExtensionToolbarFeature extends BrowserEditorContribution {

	private readonly _available: IContextKey<boolean>;
	private readonly _pinned: IContextKey<string>;
	private _toolbar: IParadisBrowserExtensionToolbar | undefined;
	private _generation = 0;
	private readonly _onDidChange = this._register(new Emitter<void>());
	/** ボタンの状態が変わった。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IParadisBrowserExtensionToolbarService private readonly _toolbarService: IParadisBrowserExtensionToolbarService,
	) {
		super(editor);
		this._available = CONTEXT_PARADIS_EXTENSIONS_AVAILABLE.bindTo(contextKeyService);
		this._pinned = CONTEXT_PARADIS_EXTENSIONS_PINNED.bindTo(contextKeyService);
	}

	/** そのタブのツールバー（まだ取っていない・拡張機能が入らないタブなら undefined）。 */
	get toolbar(): IParadisBrowserExtensionToolbar | undefined {
		return this._toolbar;
	}

	/** そのタブの拡張機能 1 つのボタン。 */
	action(extensionId: string): IParadisToolbarAction | undefined {
		return this._toolbar?.actions.find(action => action.extensionId === extensionId);
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		if (!this._toolbarService.active) {
			return;
		}
		// 別の文書へ移ってタブごとのボタンの値（バッジなど）が消えたときも、main が知らせる
		store.add(this._toolbarService.onDidChangeToolbar(() => this._refresh(model)));
		this._refresh(model);
	}

	override onModelDetached(): void {
		this._generation++;
		this._set(undefined);
	}

	/** 取り直す（ピン留めを変えた後など）。 */
	refresh(): void {
		const model = this.editor.model;
		if (model) {
			this._refresh(model);
		}
	}

	private _refresh(model: IBrowserViewModel): void {
		const generation = ++this._generation;
		this._toolbarService.main.getToolbar(model.id).then(toolbar => {
			if (generation === this._generation && this.editor.model === model) {
				this._set(toolbar);
			}
		}, () => { /* main が落ちている: 前のまま */ });
	}

	private _set(toolbar: IParadisBrowserExtensionToolbar | undefined): void {
		this._toolbar = toolbar;
		if (toolbar) {
			this._toolbarService.ensureButtons(toolbar.actions);
		}
		this._available.set((toolbar?.actions.length ?? 0) > 0);
		const pinned = toolbar?.actions.filter(action => action.pinned).map(action => action.extensionId) ?? [];
		this._pinned.set(pinned.length > 0 ? `,${pinned.join(',')},` : '');
		this._onDidChange.fire();
	}
}

/** エディタの拡張機能のボタンの状態。 */
function featureOf(editor: BrowserEditor | undefined): ParadisBrowserExtensionToolbarFeature | undefined {
	return editor?.getContribution(ParadisBrowserExtensionToolbarFeature);
}

/** 拡張機能 1 つの操作のメニュー（ボタンの右クリック・一覧の行の「…」）。 */
function extensionMenuActions(accessor: ServicesAccessor, editor: BrowserEditor, action: IParadisToolbarAction, place: string, anchor: () => HTMLElement | undefined): IAction[] {
	const toolbarService = accessor.get(IParadisBrowserExtensionToolbarService);
	const dialogService = accessor.get(IDialogService);
	const instantiationService = accessor.get(IInstantiationService);
	const logService = accessor.get(ILogService);
	const model = editor.model;
	if (!model) {
		return [];
	}
	const refresh = () => featureOf(editor)?.refresh();
	const actions: IAction[] = [
		new Action('paradis.browserExtensions.item.open', localize('paradis.browserExtensions.item.open', "開く"), undefined, action.enabled, () => instantiationService.invokeFunction(activateExtension, editor, action.extensionId, anchor(), false)),
		new Action('paradis.browserExtensions.item.pin', action.pinned ? localize('paradis.browserExtensions.item.unpin', "ツールバーから外す") : localize('paradis.browserExtensions.item.pinToToolbar', "ツールバーに固定"), undefined, true,
			() => toolbarService.main.setPinned(model.id, action.extensionId, !action.pinned).then(refresh)),
	];
	if (action.hasOptionsPage) {
		actions.push(new Action('paradis.browserExtensions.item.options', localize('paradis.browserExtensions.item.options', "オプション"), undefined, true, async () => {
			const result = await toolbarService.main.openOptions(model.id, action.extensionId);
			if (!result.ok) {
				logService.warn('[paradis] could not open the options page of a browser extension', result.error);
			}
		}));
	}
	actions.push(new Action('paradis.browserExtensions.item.disable', localize('paradis.browserExtensions.item.disable', "このプロファイルで無効にする"), undefined, true,
		() => toolbarService.main.setEnabled(action.extensionId, place, false).then(refresh)));
	actions.push(new Separator());
	actions.push(new Action('paradis.browserExtensions.item.remove', localize('paradis.browserExtensions.item.remove', "削除…"), undefined, true, async () => {
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('paradis.browserExtensions.item.removeConfirm', "「{0}」を削除しますか？", action.name),
			detail: localize('paradis.browserExtensions.item.removeDetail', "すべてのプロファイルから外し、拡張機能が保存したデータも消します。"),
			primaryButton: localize('paradis.browserExtensions.item.removeButton', "削除"),
		});
		if (confirmed) {
			await toolbarService.main.remove(action.extensionId);
			refresh();
		}
	}));
	return actions;
}

function showExtensionMenu(accessor: ServicesAccessor, editor: BrowserEditor, action: IParadisToolbarAction, place: string, anchor: HTMLElement): void {
	const contextMenuService = accessor.get(IContextMenuService);
	const actions = extensionMenuActions(accessor, editor, action, place, () => isShown(anchor) ? anchor : undefined);
	contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
}

/** ピン留めした拡張機能のボタン（絵とバッジ）。 */
class ParadisBrowserExtensionButtonViewItem extends BaseActionViewItem {

	private _hover: IManagedHover | undefined;
	private _icon: HTMLImageElement | undefined;
	private _fallback: HTMLElement | undefined;
	private _badge: HTMLElement | undefined;
	private readonly _featureListener = this._register(new MutableDisposable());

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		private readonly _extensionId: string,
		@IHoverService private readonly _hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.element) {
			return;
		}
		this.element.classList.add('paradis-browser-extension-button');
		const live: ILiveItem = { extensionId: this._extensionId, editor: () => asBrowserEditor(this._context), element: () => this.element };
		liveItems.add(live);
		this._register(toDisposable(() => liveItems.delete(live)));
		this.element.tabIndex = 0;
		this.element.role = 'button';
		const face = dom.append(this.element, $('span.paradis-browser-extension-face'));
		this._icon = dom.append(face, $<HTMLImageElement>('img.paradis-browser-extension-icon'));
		this._icon.alt = '';
		this._icon.draggable = false;
		// 絵の無い拡張機能は名前の頭文字（パズルのボタンと見分けが付くように。Chrome と同じ）
		this._fallback = dom.append(face, $('span.paradis-browser-extension-fallback'));
		this._fallback.setAttribute('aria-hidden', 'true');
		this._badge = dom.append(face, $('span.paradis-browser-extension-badge'));
		this._badge.setAttribute('aria-hidden', 'true');
		this._hover = this._register(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.element, ''));
		this._register(dom.addDisposableListener(this.element, dom.EventType.CONTEXT_MENU, event => {
			dom.EventHelper.stop(event, true);
			const editor = asBrowserEditor(this._context);
			const action = featureOf(editor)?.action(this._extensionId);
			const place = featureOf(editor)?.toolbar?.place;
			if (editor && action && place !== undefined && this.element) {
				this._instantiationService.invokeFunction(showExtensionMenu, editor, action, place, this.element);
			}
		}));
		this._watch();
		this._update();
	}

	override setActionContext(newContext: unknown): void {
		super.setActionContext(newContext);
		this._watch();
		this._update();
	}

	override onClick(event: dom.EventLike): void {
		dom.EventHelper.stop(event, true);
		const editor = asBrowserEditor(this._context);
		if (editor && this.element) {
			void this._instantiationService.invokeFunction(activateExtension, editor, this._extensionId, this.element, false);
		}
	}

	private _watch(): void {
		const feature = featureOf(asBrowserEditor(this._context));
		this._featureListener.value = feature?.onDidChange(() => this._update());
	}

	private _update(): void {
		const element = this.element;
		const action = featureOf(asBrowserEditor(this._context))?.action(this._extensionId);
		if (!element || !this._icon || !this._fallback || !this._badge) {
			return;
		}
		if (!action) {
			element.setAttribute('aria-label', this.action.label);
			this._hover?.update(this.action.label);
			return;
		}
		if (action.iconDataUrl) {
			this._icon.src = action.iconDataUrl;
		} else {
			this._icon.removeAttribute('src');
		}
		this._icon.hidden = !action.iconDataUrl;
		this._fallback.hidden = !!action.iconDataUrl;
		this._fallback.textContent = paradisExtensionInitial(action.name);
		const badge = paradisBadgeText(action.badgeText);
		this._badge.textContent = badge;
		// 拡張機能が色を決めていればそれを、決めていなければテーマのバッジの色を使う
		this._badge.style.backgroundColor = action.badgeBackgroundColor ?? '';
		this._badge.style.color = action.badgeTextColor ?? '';
		element.classList.toggle('is-disabled', !action.enabled);
		element.setAttribute('aria-disabled', String(!action.enabled));
		element.setAttribute('aria-haspopup', action.hasPopup ? 'dialog' : 'false');
		const label = paradisExtensionButtonLabel(action);
		element.setAttribute('aria-label', label);
		this._hover?.update(label);
	}
}

/** パズルのボタン（拡張機能の一覧を開く）。 */
class ParadisBrowserExtensionsMenuViewItem extends BaseActionViewItem {

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IHoverService private readonly _hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.element) {
			return;
		}
		this.element.classList.add('paradis-browser-extensions-menu-item');
		const live: ILiveItem = { extensionId: undefined, editor: () => asBrowserEditor(this._context), element: () => this.element };
		liveItems.add(live);
		this._register(toDisposable(() => liveItems.delete(live)));
		this.element.tabIndex = 0;
		this.element.role = 'button';
		this.element.setAttribute('aria-haspopup', 'dialog');
		this.element.setAttribute('aria-expanded', 'false');
		dom.append(this.element, $(`span.action-label${ThemeIcon.asCSSSelector(Codicon.extensions)}`));
		const label = localize('paradis.browserExtensions.menuButton', "拡張機能");
		this.element.setAttribute('aria-label', label);
		this._register(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.element, label));
	}

	override onClick(event: dom.EventLike): void {
		dom.EventHelper.stop(event, true);
		const editor = asBrowserEditor(this._context);
		if (editor && this.element) {
			toggleExtensionsPopover(this._instantiationService, editor, this.element);
		}
	}
}

/** ウィンドウごとに開いている一覧。 */
const openPopovers = new Map<Window, ParadisBrowserExtensionsPopover>();

function closeAllExtensionsPopovers(): void {
	for (const popover of [...openPopovers.values()]) {
		popover.close();
	}
}

function toggleExtensionsPopover(instantiationService: IInstantiationService, editor: BrowserEditor, anchor: HTMLElement): void {
	const targetWindow = dom.getWindow(anchor);
	const existing = openPopovers.get(targetWindow);
	if (existing) {
		existing.close();
		if (existing.anchor === anchor) {
			return;
		}
	}
	const popover: ParadisBrowserExtensionsPopover = instantiationService.createInstance(ParadisBrowserExtensionsPopover, editor, anchor, () => {
		if (openPopovers.get(targetWindow) === popover) {
			openPopovers.delete(targetWindow);
		}
	});
	openPopovers.set(targetWindow, popover);
}

/** そのタブの拡張機能の一覧（パズルを押すと開く）。 */
class ParadisBrowserExtensionsPopover extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _container: HTMLElement;
	private readonly _footerButton: HTMLButtonElement;
	private _focusable: HTMLElement[] = [];
	private readonly _rowStore = this._register(new MutableDisposable());
	private _disposed = false;

	constructor(
		private readonly _editor: BrowserEditor,
		readonly anchor: HTMLElement,
		private readonly _onDidClose: () => void,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IHoverService private readonly _hoverService: IHoverService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();
		this._container = layoutService.getContainer(dom.getWindow(anchor));
		this._element = $('.paradis-browser-extensions-popover.paradis-overlay-popover');
		this._element.tabIndex = -1;
		this._element.setAttribute('role', 'dialog');
		const title = localize('paradis.browserExtensions.popover.title', "拡張機能");
		this._element.setAttribute('aria-label', title);
		dom.append(this._element, $('.pbx-header')).textContent = title;
		this._list = dom.append(this._element, $('.pbx-list'));
		this._list.setAttribute('role', 'list');
		const footer = dom.append(this._element, $('.pbx-footer'));
		this._footerButton = dom.append(footer, $<HTMLButtonElement>('button.pbx-link'));
		this._footerButton.textContent = localize('paradis.browserExtensions.popover.manage', "拡張機能を管理…");
		this._register(dom.addDisposableListener(this._footerButton, dom.EventType.CLICK, () => {
			this.close();
			paradisShowBrowserExtensionsDialog(this._instantiationService);
		}));

		const feature = featureOf(_editor);
		if (feature) {
			this._register(feature.onDidChange(() => this._render()));
		}
		this._register(_editor.onDidChangeModel(() => this.close()));
		this._render();
		this._container.appendChild(this._element);
		anchor.setAttribute('aria-expanded', 'true');
		this._layout();
		this._registerListeners();
		(this._focusable[0] ?? this._footerButton).focus();
	}

	private _render(): void {
		if (this._disposed) {
			return;
		}
		const toolbar = featureOf(this._editor)?.toolbar;
		const actions = toolbar?.actions ?? [];
		if (actions.length === 0) {
			this.close();
			return;
		}
		const focused = this._focusable.find(element => dom.isActiveElement(element));
		const focusedKey = focused ? `${focused.dataset.extensionId}:${focused.dataset.part}` : undefined;
		const store = new DisposableStore();
		this._rowStore.value = store;
		dom.clearNode(this._list);
		this._focusable = [];
		for (const action of actions) {
			const row = dom.append(this._list, $('.pbx-row'));
			row.setAttribute('role', 'listitem');
			row.classList.toggle('is-disabled', !action.enabled);
			const open = dom.append(row, $<HTMLButtonElement>('button.pbx-open'));
			open.dataset.extensionId = action.extensionId;
			open.dataset.part = 'open';
			open.disabled = !action.enabled;
			const iconHolder = dom.append(open, $('span.pbx-icon'));
			if (action.iconDataUrl) {
				const image = dom.append(iconHolder, $<HTMLImageElement>('img'));
				image.src = action.iconDataUrl;
				image.alt = '';
				image.draggable = false;
			} else {
				const initial = dom.append(iconHolder, $('span.pbx-initial'));
				initial.textContent = paradisExtensionInitial(action.name);
			}
			dom.append(open, $('span.pbx-name')).textContent = action.name;
			const label = paradisExtensionButtonLabel(action);
			open.setAttribute('aria-label', label);
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), open, label));
			store.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
				// ポップアップはパズルのボタンの下に出す（Chrome と同じ）
				this.close();
				void this._instantiationService.invokeFunction(activateExtension, this._editor, action.extensionId, isShown(this.anchor) ? this.anchor : undefined, false);
			}));
			const pin = dom.append(row, $<HTMLButtonElement>('button.pbx-icon-button'));
			dom.append(pin, $(`span${ThemeIcon.asCSSSelector(action.pinned ? Codicon.pinned : Codicon.pin)}`));
			pin.dataset.extensionId = action.extensionId;
			pin.dataset.part = 'pin';
			pin.classList.toggle('is-pinned', action.pinned);
			const pinLabel = action.pinned
				? localize('paradis.browserExtensions.popover.unpin', "{0} をツールバーから外す", action.name)
				: localize('paradis.browserExtensions.popover.pin', "{0} をツールバーに固定", action.name);
			pin.setAttribute('aria-label', pinLabel);
			pin.setAttribute('aria-pressed', String(action.pinned));
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), pin, pinLabel));
			store.add(dom.addDisposableListener(pin, dom.EventType.CLICK, () => {
				const model = this._editor.model;
				if (model) {
					pin.disabled = true;
					void this._instantiationService.invokeFunction(accessor => accessor.get(IParadisBrowserExtensionToolbarService).main.setPinned(model.id, action.extensionId, !action.pinned))
						.finally(() => featureOf(this._editor)?.refresh());
				}
			}));
			const more = dom.append(row, $<HTMLButtonElement>('button.pbx-icon-button'));
			dom.append(more, $(`span${ThemeIcon.asCSSSelector(Codicon.ellipsis)}`));
			more.dataset.extensionId = action.extensionId;
			more.dataset.part = 'more';
			const moreLabel = localize('paradis.browserExtensions.popover.more', "{0} の操作", action.name);
			more.setAttribute('aria-label', moreLabel);
			more.setAttribute('aria-haspopup', 'menu');
			store.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), more, moreLabel));
			store.add(dom.addDisposableListener(more, dom.EventType.CLICK, () => {
				if (toolbar) {
					this._instantiationService.invokeFunction(showExtensionMenu, this._editor, action, toolbar.place, more);
				}
			}));
			this._focusable.push(...[open, pin, more].filter(button => !button.disabled));
		}
		if (focusedKey !== undefined) {
			(this._focusable.find(element => `${element.dataset.extensionId}:${element.dataset.part}` === focusedKey) ?? this._focusable[0])?.focus();
		}
		if (this._element.isConnected) {
			this._layout();
		}
	}

	private _layout(): void {
		const containerPosition = dom.getDomNodePagePosition(this._container);
		const width = Math.min(POPOVER_WIDTH, Math.max(200, containerPosition.width - EDGE_MARGIN * 2));
		this._element.style.width = `${width}px`;
		const anchorPosition = dom.getDomNodePagePosition(this.anchor);
		const anchorBottom = anchorPosition.top - containerPosition.top + anchorPosition.height;
		this._element.style.maxHeight = `${Math.max(120, containerPosition.height - anchorBottom - ANCHOR_GAP - EDGE_MARGIN)}px`;
		const anchorRight = anchorPosition.left - containerPosition.left + anchorPosition.width;
		const left = Math.min(Math.max(EDGE_MARGIN, anchorRight - width), Math.max(EDGE_MARGIN, containerPosition.width - width - EDGE_MARGIN));
		this._element.style.top = `${Math.round(anchorBottom + ANCHOR_GAP)}px`;
		this._element.style.left = `${Math.round(left)}px`;
	}

	private _registerListeners(): void {
		const targetWindow = dom.getWindow(this._container);
		this._register(dom.addDisposableListener(this._element, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.keyCode === KeyCode.Escape) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				this.close();
			} else if (keyboardEvent.keyCode === KeyCode.Tab || keyboardEvent.keyCode === KeyCode.DownArrow || keyboardEvent.keyCode === KeyCode.UpArrow) {
				this._moveFocus(keyboardEvent.keyCode === KeyCode.UpArrow || (keyboardEvent.keyCode === KeyCode.Tab && keyboardEvent.shiftKey));
				keyboardEvent.preventDefault();
			}
		}));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.MOUSE_DOWN, event => {
			const target = event.target as Node | null;
			// 行の「…」のメニュー（context view）を押したときは閉じない
			if (target && (this._element.contains(target) || this.anchor.contains(target) || (dom.isHTMLElement(target) && target.closest('.context-view')))) {
				return;
			}
			this.close();
		}, true));
		this._register(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => this.close()));
	}

	private _moveFocus(backwards: boolean): void {
		const focusable = [...this._focusable, this._footerButton];
		const index = focusable.findIndex(element => dom.isActiveElement(element));
		const next = backwards
			? (index <= 0 ? focusable.length - 1 : index - 1)
			: (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
		focusable[next].focus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this.anchor.setAttribute('aria-expanded', 'false');
		const hadFocus = dom.isAncestorOfActiveElement(this._element);
		this._element.remove();
		super.dispose();
		this._onDidClose();
		if (hadFocus && isShown(this.anchor)) {
			this.anchor.focus();
		}
	}
}

class ParadisBrowserExtensionsMenuAction extends Action2 {
	constructor() {
		super({
			id: MENU_ACTION_ID,
			title: localize2('paradis.browserExtensions.action.menu', "Browser Extensions"),
			icon: Codicon.extensions,
			f1: false,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: PARADIS_EXTENSIONS_TOOLBAR_GROUP,
				// ピン留めしたボタンの後ろ（mock のとおりパズルは右端）
				order: 10_000,
				when: CONTEXT_PARADIS_EXTENSIONS_AVAILABLE,
			},
		});
	}

	run(accessor: ServicesAccessor, editorArg?: unknown): void {
		// ツールバーのボタンは view item が受ける。ここに来るのは「…」の一覧から選んだとき
		const editor = asBrowserEditor(editorArg) ?? asBrowserEditor(accessor.get(IEditorService).activeEditorPane);
		const anchor = editor ? popupAnchorElement(editor, undefined) : undefined;
		if (editor && anchor) {
			toggleExtensionsPopover(accessor.get(IInstantiationService), editor, anchor);
		}
	}
}

/** ツールバーのボタンの見た目の登録と、action.openPopup の求めの受け手（ウィンドウに 1 つ）。 */
export class ParadisBrowserExtensionToolbarContribution extends Disposable {
	static readonly ID = 'workbench.contrib.paradisBrowserExtensionToolbar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IParadisBrowserExtensionToolbarService toolbarService: IParadisBrowserExtensionToolbarService,
		@IEditorService editorService: IEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();
		if (!toolbarService.active) {
			return;
		}
		this._register(actionViewItemService.register(MenuId.BrowserActionsToolbar, MENU_ACTION_ID, (action, options, scoped) =>
			scoped.createInstance(ParadisBrowserExtensionsMenuViewItem, action, options)));
		this._register(toolbarService.main.onDidRequestPopup(({ viewId, extensionId }) => {
			// このウィンドウ（と補助ウィンドウ）で、そのタブを見せているエディタのボタンから出す
			const editor = editorService.visibleEditorPanes.map(asBrowserEditor).find(candidate => candidate?.model?.id === viewId);
			if (editor) {
				void instantiationService.invokeFunction(activateExtension, editor, extensionId, undefined, true);
			}
		}));
		// スペースを切り替えるときは閉じる（一覧は前のスペースのタブについてのもの）
		this._register(workspaceSwitchService.onWillSwitchScope(() => closeAllExtensionsPopovers()));
		this._register(toDisposable(() => closeAllExtensionsPopovers()));
	}
}

registerAction2(ParadisBrowserExtensionsMenuAction);
BrowserEditor.registerContribution(ParadisBrowserExtensionToolbarFeature);
