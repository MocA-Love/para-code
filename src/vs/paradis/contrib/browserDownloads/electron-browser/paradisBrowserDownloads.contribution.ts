/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの URL バー右に出すダウンロードのボタン。
//
// upstream のファイルには触らず、公開されている拡張点だけで足している:
//  - MenuId.BrowserActionsToolbar（URL バーの右のツールバー）へアクションを1つ登録
//  - IActionViewItemService で、そのアクションの見た目を自前の項目（進み具合の輪と未確認の点）に差し替える
// ボタンはダウンロードが1件でもあるときだけ出す（Chrome と同じ）。押すと一覧（ポップオーバー）が開く。

import './media/paradisBrowserDownloads.css';
import * as dom from '../../../../base/browser/dom.js';
import { IActionViewItemOptions, BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserActionCategory, BrowserActionGroup, BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { paradisAggregateDownloadProgress } from '../common/paradisBrowserDownloads.js';
import { ParadisBrowserDownloadsPopover } from './paradisBrowserDownloadsPopover.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisBrowserDownloadsService } from './paradisBrowserDownloadsService.js';

const SHOW_DOWNLOADS_ACTION_ID = 'paradis.browser.showDownloads';

/** ダウンロードが1件でもあるか。ボタンの表示条件。 */
const CONTEXT_PARADIS_BROWSER_HAS_DOWNLOADS = new RawContextKey<boolean>('paradisBrowserHasDownloads', false, localize('paradis.browserDownloads.hasDownloads', "内蔵ブラウザのダウンロード一覧に項目があるかどうか"));

const downloadsIcon = registerIcon('paradis-browser-downloads', Codicon.desktopDownload, localize('paradis.browserDownloads.icon', "内蔵ブラウザのダウンロードボタンのアイコン"));

/** 今描かれているボタン。コマンドパレットから開いたときの位置合わせに使う。 */
const liveButtons = new Set<ParadisBrowserDownloadsActionViewItem>();

/**
 * 開いている一覧。補助ウィンドウも同じ renderer なので、ウィンドウ（ボタンのある文書）ごとに1つ持つ。
 * 別のウィンドウのボタンを押したときは、そのウィンドウの一覧を開く（こちらを閉じるだけにしない）。
 */
const openPopovers = new Map<Window, ParadisBrowserDownloadsPopover>();

function closeAllDownloadsPopovers(): void {
	for (const popover of [...openPopovers.values()]) {
		popover.close();
	}
}

function toggleDownloadsPopover(instantiationService: IInstantiationService, anchor: HTMLElement | undefined): void {
	const targetWindow = anchor ? dom.getWindow(anchor) : undefined;
	const existing = targetWindow ? openPopovers.get(targetWindow) : [...openPopovers.values()][0];
	if (existing) {
		existing.close();
		return;
	}
	const popover: ParadisBrowserDownloadsPopover = instantiationService.createInstance(ParadisBrowserDownloadsPopover, anchor, () => {
		if (openPopovers.get(popover.targetWindow) === popover) {
			openPopovers.delete(popover.targetWindow);
		}
	});
	openPopovers.set(popover.targetWindow, popover);
}

class ParadisBrowserDownloadsActionViewItem extends BaseActionViewItem {

	private _hover: IManagedHover | undefined;
	private _ring: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@IParadisBrowserDownloadsService private readonly _downloads: IParadisBrowserDownloadsService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(undefined, action, options);
		this._register(this._downloads.onDidChange(() => this._update()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		if (!this.element) {
			return;
		}
		liveButtons.add(this);
		this._register({ dispose: () => liveButtons.delete(this) });

		this.element.classList.add('paradis-browser-downloads-item');
		this.element.tabIndex = 0;
		this.element.role = 'button';
		this.element.setAttribute('aria-haspopup', 'dialog');
		this.element.setAttribute('aria-expanded', 'false');
		this._ring = dom.append(this.element, dom.$('span.paradis-browser-downloads-ring'));
		dom.append(this.element, dom.$(`span.action-label.paradis-browser-downloads-glyph${ThemeIcon.asCSSSelector(downloadsIcon)}`));
		dom.append(this.element, dom.$('span.paradis-browser-downloads-dot'));
		this._hover = this._register(this._hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.element, ''));
		this._update();
	}

	override onClick(event: dom.EventLike): void {
		dom.EventHelper.stop(event, true);
		this.openPopover();
	}

	openPopover(): void {
		toggleDownloadsPopover(this._instantiationService, this.element);
	}

	get isVisible(): boolean {
		return !!this.element?.isConnected && this.element.offsetParent !== null;
	}

	private _update(): void {
		const element = this.element;
		if (!element) {
			return;
		}
		const progress = paradisAggregateDownloadProgress(this._downloads.items);
		const running = this._downloads.items.filter(item => item.state === 'progressing').length;
		element.classList.toggle('is-running', progress !== 'idle');
		element.classList.toggle('is-indeterminate', progress === undefined);
		element.classList.toggle('has-unseen', this._downloads.hasUnseen);
		// 進み具合の弧は割合ごとに変わるので、ここで直接塗る（大きさが分からないときは CSS の回る弧に任せる）。
		if (this._ring) {
			this._ring.style.background = typeof progress === 'number'
				? `conic-gradient(var(--vscode-progressBar-background) ${Math.round(progress * 100)}%, var(--vscode-widget-border, transparent) 0)`
				: '';
		}
		const label = running > 0
			? localize('paradis.browserDownloads.buttonRunning', "ダウンロード（{0} 件が進行中）", running)
			: this._downloads.hasUnseen
				? localize('paradis.browserDownloads.buttonUnseen', "ダウンロード（完了したものがあります）")
				: localize('paradis.browserDownloads.button', "ダウンロード");
		element.setAttribute('aria-label', label);
		this._hover?.update(label);
	}
}

class ParadisShowBrowserDownloadsAction extends Action2 {
	constructor() {
		super({
			id: SHOW_DOWNLOADS_ACTION_ID,
			title: localize2('paradis.browserDownloads.show', "ダウンロードを表示"),
			category: BrowserActionCategory,
			icon: downloadsIcon,
			f1: true,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				// 右のツールバーの先頭（モックでは URL バーのすぐ右）。
				group: BrowserActionGroup.Tools,
				order: -10,
				when: CONTEXT_PARADIS_BROWSER_HAS_DOWNLOADS,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const editorService = accessor.get(IEditorService);
		// 見えているボタンのうち、アクティブなエディタの中にあるものを優先して位置の基準にする。
		const activePane = editorService.activeEditorPane;
		const activeContainer = activePane instanceof BrowserEditor ? activePane.getContainer() : undefined;
		const visible = [...liveButtons].filter(button => button.isVisible);
		const button = visible.find(candidate => activeContainer && candidate.element && activeContainer.contains(candidate.element)) ?? visible[0];
		if (button) {
			button.openPopover();
		} else {
			toggleDownloadsPopover(instantiationService, undefined);
		}
	}
}

registerAction2(ParadisShowBrowserDownloadsAction);

class ParadisBrowserDownloadsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisBrowserDownloads';

	private readonly _hasDownloads: IContextKey<boolean>;

	constructor(
		@IParadisBrowserDownloadsService downloads: IParadisBrowserDownloadsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();
		this._hasDownloads = CONTEXT_PARADIS_BROWSER_HAS_DOWNLOADS.bindTo(contextKeyService);
		const update = () => this._hasDownloads.set(downloads.items.length > 0);
		this._register(downloads.onDidChange(update));
		update();

		this._register(actionViewItemService.register(MenuId.BrowserActionsToolbar, SHOW_DOWNLOADS_ACTION_ID, (action, options, instantiationService) =>
			instantiationService.createInstance(ParadisBrowserDownloadsActionViewItem, action, options)));
		// スペースを切り替えるときは閉じる（一覧は内蔵ブラウザを止める扱いなので、切替先のページが止まったままになる）。
		this._register(workspaceSwitchService.onWillSwitchScope(() => closeAllDownloadsPopovers()));
		this._register(toDisposable(() => closeAllDownloadsPopovers()));
	}
}

registerWorkbenchContribution2(ParadisBrowserDownloadsContribution.ID, ParadisBrowserDownloadsContribution, WorkbenchPhase.AfterRestored);
