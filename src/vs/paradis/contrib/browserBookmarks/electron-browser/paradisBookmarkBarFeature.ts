/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマークバー機能の司令塔。upstream の BrowserEditor.registerContribution 拡張ポイントに
// 乗り、Toolbar 位置（navbar 直下、order 1）へバー widget を常設する。加えて URL バーの
// スターインジケータ（PostUrl）・URLピッカーのスター トグルボタン・「Bookmarks」グループの
// URLサジェストを提供し、閲覧中ページの favicon をブックマークへ書き戻す
// （Superset の syncBookmarkFaviconByUrl 相当）。バーの表示/非表示は設定
// paradis.browser.bookmarkBar.visible に連動し、切替時に WebContentsView のバウンズを再計算する。

import './media/paradisBookmarkBar.css';
import { $ } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { QuickInputButtonLocation } from '../../../../platform/quickinput/common/quickInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import {
	BrowserEditor,
	BrowserEditorContribution,
	BrowserWidgetLocation,
	IBrowserEditorWidget,
	IBrowserUrlPickerAction,
	IBrowserUrlPickerActionProvider,
	IBrowserUrlSuggestion,
	IBrowserUrlSuggestionProvider,
} from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { flattenParadisBookmarks } from '../common/paradisBookmarkModel.js';
import { ParadisBookmarkBarWidget } from './paradisBookmarkBarWidget.js';
import {
	IParadisBookmarksService,
	PARADIS_BOOKMARK_BAR_VISIBLE_SETTING,
	PARADIS_TOGGLE_BOOKMARK_COMMAND_ID,
} from './paradisBookmarksService.js';

export const CONTEXT_PARADIS_URL_IS_BOOKMARKED = new RawContextKey<boolean>('paradisBrowserUrlIsBookmarked', false, localize('paradis.bookmarks.urlIsBookmarked', "Whether the current browser URL is bookmarked"));

/**
 * Clickable star indicator shown in the URL bar's PostUrl slot when the
 * current page is bookmarked. Clicking it removes the bookmark (same shape
 * as the disabled upstream favorites indicator).
 */
class BookmarkIndicator extends Disposable {
	readonly element: HTMLElement;
	private readonly _button: Button;
	private readonly _onDidClick = this._register(new Emitter<void>());
	readonly onDidClick = this._onDidClick.event;

	constructor(
		instantiationService: IInstantiationService,
		private readonly _keybindingService: IKeybindingService,
	) {
		super();
		const hoverDelegate = this._register(instantiationService.createInstance(
			WorkbenchHoverDelegate,
			'element',
			undefined,
			{ position: { hoverPosition: HoverPosition.ABOVE } }
		));

		this.element = $('.paradis-bookmark-indicator-container');
		this.element.style.display = 'none';
		this._button = this._register(new Button(this.element, {
			supportIcons: true,
			title: this._tooltip(),
			small: true,
			hoverDelegate
		}));
		this._button.element.classList.add('paradis-bookmark-indicator');
		this._button.label = `$(${Codicon.starFull.id})`;
		this._button.element.setAttribute('aria-label', localize('paradis.bookmarks.remove', "Remove Bookmark"));
		this._register(this._button.onDidClick(() => this._onDidClick.fire()));
		this._register(this._keybindingService.onDidUpdateKeybindings(() => {
			this._button.setTitle(this._tooltip());
		}));
	}

	private _tooltip(): string {
		const kb = this._keybindingService.lookupKeybinding(PARADIS_TOGGLE_BOOKMARK_COMMAND_ID)?.getLabel();
		return kb
			? localize('paradis.bookmarks.removeWithKb', "Remove Bookmark ({0})", kb)
			: localize('paradis.bookmarks.remove', "Remove Bookmark");
	}

	setVisible(visible: boolean): void {
		this.element.style.display = visible ? '' : 'none';
	}
}

/**
 * Mounts the bookmark bar into the browser editor and keeps its state
 * (active highlight, star indicator, context key, favicon write-back)
 * in sync with the attached page model.
 */
export class ParadisBookmarkBarFeature extends BrowserEditorContribution {

	private readonly _bar: ParadisBookmarkBarWidget;
	private readonly _indicator: BookmarkIndicator;
	private readonly _isBookmarkedContext: IContextKey<boolean>;
	private readonly _onDidChangeState = this._register(new Emitter<void>());

	private readonly _suggestionProvider: IBrowserUrlSuggestionProvider;
	private readonly _actionProvider: IBrowserUrlPickerActionProvider;

	constructor(
		editor: BrowserEditor,
		@IParadisBookmarksService private readonly _bookmarksService: IParadisBookmarksService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super(editor);

		this._isBookmarkedContext = CONTEXT_PARADIS_URL_IS_BOOKMARKED.bindTo(contextKeyService);

		this._bar = this._register(instantiationService.createInstance(ParadisBookmarkBarWidget, {
			openUrl: (url: string) => { void this.editor.model?.loadURL(url); },
			getCurrentPage: () => {
				const model = this.editor.model;
				return model && model.url ? { url: model.url, title: model.title, faviconDataUri: model.favicon } : undefined;
			},
		}));
		this._applyBarVisibility(false);
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOOKMARK_BAR_VISIBLE_SETTING)) {
				this._applyBarVisibility(true);
			}
		}));

		this._indicator = this._register(new BookmarkIndicator(instantiationService, keybindingService));
		this._register(this._indicator.onDidClick(() => this.toggleCurrent()));

		// 別ウィンドウ/別エディタでの変更にもスター・コンテキストキーを追従させる。
		this._register(this._bookmarksService.onDidChange(() => {
			this._refresh();
			this._onDidChangeState.fire();
		}));

		this._suggestionProvider = {
			label: localize('paradis.bookmarks.suggestGroup', "Bookmarks"),
			order: 55,
			onDidChange: this._onDidChangeState.event,
			getSuggestions: async ({ text, input }) => {
				const filter = text.trim().toLowerCase();
				const current = input.url;
				const suggestions: IBrowserUrlSuggestion[] = [];
				for (const bookmark of flattenParadisBookmarks(this._bookmarksService.nodes)) {
					if (bookmark.url === current) {
						continue;
					}
					if (filter && !bookmark.title.toLowerCase().includes(filter) && !bookmark.url.toLowerCase().includes(filter)) {
						continue;
					}
					const favicon = this._bookmarksService.getFavicon(bookmark.faviconHash);
					suggestions.push({
						id: 'paradisBookmark:' + bookmark.id,
						label: bookmark.title || bookmark.url,
						description: bookmark.url,
						icon: favicon ? undefined : Codicon.star,
						iconPath: favicon ? { dark: URI.parse(favicon) } : undefined,
						apply: target => target.navigate(bookmark.url),
					});
				}
				return suggestions;
			},
		};

		this._actionProvider = {
			onDidChange: this._onDidChangeState.event,
			getActions: input => {
				const url = input.url;
				if (!url) {
					return [];
				}
				const bookmarked = this._bookmarksService.isBookmarked(url);
				const action: IBrowserUrlPickerAction = {
					id: PARADIS_TOGGLE_BOOKMARK_COMMAND_ID,
					iconClass: ThemeIcon.asClassName(bookmarked ? Codicon.starFull : Codicon.star),
					tooltip: bookmarked
						? localize('paradis.bookmarks.remove', "Remove Bookmark")
						: localize('paradis.bookmarks.add', "Bookmark This Page"),
					alwaysVisible: true,
					toggle: { checked: bookmarked },
					location: QuickInputButtonLocation.Input,
					run: () => this.toggleCurrent(),
				};
				return [action];
			},
		};
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [
			{ location: BrowserWidgetLocation.Toolbar, element: this._bar.element, order: 1 },
			{ location: BrowserWidgetLocation.PostUrl, element: this._indicator.element, order: 60 },
		];
	}

	override get urlSuggestionProviders(): readonly IBrowserUrlSuggestionProvider[] {
		return [this._suggestionProvider];
	}

	override get urlPickerActionProviders(): readonly IBrowserUrlPickerActionProvider[] {
		return [this._actionProvider];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(model.onDidNavigate(() => {
			this._refresh();
			this._syncFavicon(model);
			this._onDidChangeState.fire();
		}));
		store.add(model.onDidChangeFavicon(() => this._syncFavicon(model)));
		this._refresh();
	}

	override onModelDetached(): void {
		this._isBookmarkedContext.reset();
		this._indicator.setVisible(false);
		this._bar.setActiveUrl('');
	}

	/** Toggle the bookmark for the current page (star button and Cmd+D action). */
	toggleCurrent(): void {
		const model = this.editor.model;
		if (!model?.url) {
			return;
		}
		this._bookmarksService.toggleBookmark({ url: model.url, title: model.title, faviconDataUri: model.favicon });
	}

	private _applyBarVisibility(relayout: boolean): void {
		const visible = this._configurationService.getValue<boolean>(PARADIS_BOOKMARK_BAR_VISIBLE_SETTING) !== false;
		this._bar.element.style.display = visible ? '' : 'none';
		if (relayout) {
			// バーの分だけ WebContentsView のバウンズが変わるので再レイアウトする。
			this.editor.layoutBrowserContainer();
		}
	}

	private _refresh(): void {
		const url = this.editor.model?.url ?? '';
		const bookmarked = !!url && this._bookmarksService.isBookmarked(url);
		this._isBookmarkedContext.set(bookmarked);
		this._indicator.setVisible(bookmarked);
		this._bar.setActiveUrl(url);
	}

	private _syncFavicon(model: IBrowserViewModel): void {
		if (model.url && model.favicon && this._bookmarksService.isBookmarked(model.url)) {
			this._bookmarksService.syncFaviconByUrl(model.url, model.favicon);
		}
	}
}

BrowserEditor.registerContribution(ParadisBookmarkBarFeature);
