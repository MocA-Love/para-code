/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマークバーのDOM本体。ルート項目の描画（favicon+タイトル／9種アイコン+カラーのフォルダ）、
// クリックでのナビゲーション、フォルダのネストメニュー（IContextMenuService+SubmenuAction）、
// 右クリックメニュー、HTML5 DnDによるルート並べ替え、編集ダイアログ起動を担当する。
// バーは role="toolbar"（矢印キーで項目を移り、Tab の止まりは 1 つ）。入りきらない項目は末尾の「»」の
// メニューへ逃がす（Chrome と同じ）。
// メニュー類は overlayManager が監視済みの context-view で出るため、ネイティブ
// WebContentsView との重なりは自動処理される。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Action, IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	findParadisParentFolderId,
	getParadisFolderOptions,
	IParadisBookmark,
	IParadisBookmarkFolder,
	isParadisBookmark,
	isParadisBookmarkUrlAllowed,
	normalizeParadisBookmarkUrl,
	ParadisBookmarkNode,
	paradisFolderIcon,
} from '../common/paradisBookmarkModel.js';
import { ParadisEditBookmarkDialog, ParadisFolderDialog } from './paradisBookmarkDialogs.js';
import {
	IParadisBookmarksService,
	PARADIS_EXPORT_BOOKMARKS_COMMAND_ID,
	PARADIS_IMPORT_BOOKMARKS_COMMAND_ID,
	PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID,
} from './paradisBookmarksService.js';

const $ = dom.$;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 「»」の項目のフォーカスの目印（ブックマークの id と重ならない値）。 */
const MORE_FOCUS_KEY = ':more';

/** 描いた項目 1 つ。はみ出したものは「»」のメニューに入る。 */
interface IRenderedBarItem {
	readonly element: HTMLButtonElement;
	readonly node: ParadisBookmarkNode;
}

/** Callbacks the bar needs from its owning editor feature. */
export interface IParadisBookmarkBarHost {
	/** Navigate the current browser tab to the given URL. */
	openUrl(url: string): void;
	/** The page currently shown in the owning editor, if any. */
	getCurrentPage(): { url: string; title: string; faviconDataUri: string | undefined } | undefined;
}

function untitledFolderLabel(): string {
	return localize('paradis.bookmarks.untitledFolder', "無題のフォルダ");
}

function folderDisplayTitle(folder: IParadisBookmarkFolder): string {
	return folder.title.trim() || untitledFolderLabel();
}

/**
 * The bookmark bar DOM widget. One instance per browser editor; all
 * instances render the same shared {@link IParadisBookmarksService} state.
 */
export class ParadisBookmarkBarWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _openDialog = this._register(new MutableDisposable<IDisposable>());

	private readonly _more: HTMLButtonElement;
	private readonly _resizeObserver = this._register(new MutableDisposable<IDisposable>());
	private _observedWindow: Window | undefined;
	private _items: IRenderedBarItem[] = [];
	/** Tab で入ったときにフォーカスする項目（ブックマーク・フォルダの id か「»」）。 */
	private _focusKey: string | undefined;

	private _activeUrl = '';
	private _draggingId: string | undefined;
	private _dropTargetElement: HTMLElement | undefined;

	constructor(
		private readonly host: IParadisBookmarkBarHost,
		@IParadisBookmarksService private readonly bookmarksService: IParadisBookmarksService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.element = $('.paradis-bookmark-bar');
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('paradis.bookmarks.barAriaLabel', "ブックマークバー"));
		this._more = this._createMoreButton();
		this._register(dom.addDisposableListener(this.element, 'keydown', e => this._onKeyDown(e)));
		this._register(dom.addDisposableListener(this.element, 'contextmenu', e => {
			// 項目上の右クリックは項目側のメニューに任せる（バー地肌と空ヒントのみ反応）。
			if (e.target === this.element || (dom.isHTMLElement(e.target) && e.target.classList.contains('paradis-bookmark-bar-hint'))) {
				e.preventDefault();
				e.stopPropagation();
				this._showBarContextMenu(e);
			}
		}));

		this._register(this.bookmarksService.onDidChange(() => this._render()));
		this._render();
	}

	/** Update the highlighted (current page) bookmark. */
	setActiveUrl(url: string): void {
		const normalized = url ? normalizeParadisBookmarkUrl(url) : '';
		if (normalized !== this._activeUrl) {
			this._activeUrl = normalized;
			this._render();
		} else {
			// 別のウィンドウへ移ったときに、大きさの見張りをそのウィンドウで付け直す
			this._observeSize();
		}
	}

	/** Open the folder create/edit dialog (also reachable from the bar's context menu). */
	openFolderDialog(folder?: IParadisBookmarkFolder): void {
		this._openDialog.value = this.instantiationService.createInstance(ParadisFolderDialog, {
			dialogTitle: folder
				? localize('paradis.bookmarks.editFolderTitle', "フォルダを編集")
				: localize('paradis.bookmarks.newFolderTitle', "新しいフォルダ"),
			initial: folder ? { title: folder.title, icon: folder.icon ?? 'folder', color: folder.color } : undefined,
			onSubmit: result => {
				if (folder) {
					this.bookmarksService.updateFolder(folder.id, result);
				} else {
					this.bookmarksService.addFolder(result);
				}
			},
		});
	}

	/** Open the bookmark edit dialog. */
	openEditBookmarkDialog(bookmark: IParadisBookmark): void {
		const folderId = findParadisParentFolderId(this.bookmarksService.nodes, bookmark.id) ?? undefined;
		this._openDialog.value = this.instantiationService.createInstance(ParadisEditBookmarkDialog, {
			dialogTitle: localize('paradis.bookmarks.editBookmarkTitle', "ブックマークを編集"),
			initial: { title: bookmark.title, url: bookmark.url, folderId },
			folderOptions: getParadisFolderOptions(this.bookmarksService.nodes, untitledFolderLabel()),
			onSubmit: result => {
				// 取り込みと同じ判定（http・https・about: だけ）。javascript: や file: はバーから開くと危ないので断る。
				if (!isParadisBookmarkUrlAllowed(normalizeParadisBookmarkUrl(result.url))) {
					return localize('paradis.bookmarks.invalidUrlScheme', "http:// か https:// で始まる URL を入力してください。");
				}
				const updated = this.bookmarksService.updateBookmark(bookmark.id, {
					url: result.url,
					title: result.title,
					folderId: result.folderId ?? null,
				});
				return updated ? undefined : localize('paradis.bookmarks.duplicateUrl', "このURLのブックマークは既に存在します。");
			},
		});
	}

	// --- rendering --------------------------------------------------------

	private _render(): void {
		// 描き直し（ページの移動のたびに起きる）でキーボードのフォーカスが BODY に落ちないよう、同じ項目へ戻す
		const hadFocus = dom.isAncestorOfActiveElement(this.element);
		this._renderDisposables.clear();
		dom.clearNode(this.element);
		this._items = [];

		const nodes = this.bookmarksService.nodes;
		if (nodes.length === 0) {
			const hint = dom.append(this.element, $('.paradis-bookmark-bar-hint'));
			hint.textContent = localize('paradis.bookmarks.emptyHint', "アドレスバーの星マークをクリックしてブックマークを追加できます。");
			this._focusKey = undefined;
			this._observeSize();
			return;
		}

		for (const node of nodes) {
			const item = isParadisBookmark(node) ? this._renderBookmarkItem(node) : this._renderFolderItem(node);
			this._installDnd(item, node);
			this.element.appendChild(item);
			this._items.push({ element: item, node });
			this._renderDisposables.add(dom.addDisposableListener(item, 'focus', () => this._setFocusKey(node.id)));
		}
		this.element.appendChild(this._more);
		this._layoutOverflow();
		this._observeSize();
		if (hadFocus) {
			this._focusTarget(this._focusKey)?.focus();
		}
	}

	private _createItemButton(className: string): HTMLButtonElement {
		const item = $<HTMLButtonElement>(`button.${className}.paradis-focus-ring-inset`);
		item.type = 'button';
		item.tabIndex = -1;
		return item;
	}

	private _renderBookmarkItem(bookmark: IParadisBookmark): HTMLButtonElement {
		const item = this._createItemButton('paradis-bookmark-item');
		item.classList.toggle('active', !!this._activeUrl && normalizeParadisBookmarkUrl(bookmark.url) === this._activeUrl);

		const iconContainer = dom.append(item, $('.paradis-bookmark-item-icon'));
		const favicon = this.bookmarksService.getFavicon(bookmark.faviconHash);
		if (favicon) {
			const img = dom.append(iconContainer, $('img')) as HTMLImageElement;
			img.src = favicon;
			img.alt = '';
			this._renderDisposables.add(dom.addDisposableListener(img, 'error', () => {
				dom.clearNode(iconContainer);
				iconContainer.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
			}));
		} else {
			iconContainer.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
		}

		dom.append(item, $('span.paradis-bookmark-item-label')).textContent = bookmark.title || bookmark.url;
		this._renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), item, bookmark.url));

		this._renderDisposables.add(dom.addDisposableListener(item, 'click', () => this.host.openUrl(bookmark.url)));
		this._renderDisposables.add(dom.addDisposableListener(item, 'contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this._showBookmarkContextMenu(e, bookmark);
		}));
		return item;
	}

	private _renderFolderItem(folder: IParadisBookmarkFolder): HTMLButtonElement {
		const item = this._createItemButton('paradis-bookmark-item.folder');
		item.setAttribute('aria-haspopup', 'menu');

		const iconContainer = dom.append(item, $('.paradis-bookmark-item-icon'));
		const icon = iconContainer.appendChild($(`span${ThemeIcon.asCSSSelector(paradisFolderIcon(folder.icon))}`));
		if (folder.color) {
			icon.style.color = folder.color;
		}

		dom.append(item, $('span.paradis-bookmark-item-label')).textContent = folderDisplayTitle(folder);
		this._renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), item, folderDisplayTitle(folder)));

		this._renderDisposables.add(dom.addDisposableListener(item, 'click', () => this._showFolderMenu(item, folder)));
		this._renderDisposables.add(dom.addDisposableListener(item, 'keydown', e => {
			// Enter・Space は button の click で開く。下矢印でも開く（メニューのボタンの決まり）
			if (new StandardKeyboardEvent(e).keyCode === KeyCode.DownArrow) {
				e.preventDefault();
				e.stopPropagation();
				this._showFolderMenu(item, folder);
			}
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this._showFolderContextMenu(e, folder);
		}));
		return item;
	}

	// --- overflow (») and keyboard navigation --------------------------------

	private _createMoreButton(): HTMLButtonElement {
		const more = this._createItemButton('paradis-bookmark-more');
		more.classList.add('paradis-bookmark-overflowed');
		more.setAttribute('aria-haspopup', 'menu');
		more.setAttribute('aria-label', localize('paradis.bookmarks.more', "その他のブックマーク"));
		const svg = more.ownerDocument.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('aria-hidden', 'true');
		const path = more.ownerDocument.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', 'M4 4l4 4-4 4M8.5 4l4 4-4 4');
		svg.appendChild(path);
		more.appendChild(svg);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), more, localize('paradis.bookmarks.more', "その他のブックマーク")));
		this._register(dom.addDisposableListener(more, 'click', () => this._showMoreMenu()));
		this._register(dom.addDisposableListener(more, 'focus', () => this._setFocusKey(MORE_FOCUS_KEY)));
		this._register(dom.addDisposableListener(more, 'keydown', e => {
			if (new StandardKeyboardEvent(e).keyCode === KeyCode.DownArrow) {
				e.preventDefault();
				e.stopPropagation();
				this._showMoreMenu();
			}
		}));
		return more;
	}

	private _showMoreMenu(): void {
		const hidden = this._items.filter(item => item.element.classList.contains('paradis-bookmark-overflowed'));
		if (hidden.length === 0) {
			return;
		}
		this._more.classList.add('open');
		this.contextMenuService.showContextMenu({
			getAnchor: () => this._more,
			getActions: () => hidden.map(item => this._nodeMenuAction(item.node)),
			onHide: () => this._more.classList.remove('open'),
		});
	}

	/** 大きさの見張りを、バーが今いるウィンドウで付ける（補助ウィンドウへ移ったら付け直す）。 */
	private _observeSize(): void {
		const targetWindow = dom.getWindow(this.element);
		if (this._observedWindow === targetWindow && this._resizeObserver.value) {
			return;
		}
		this._observedWindow = targetWindow;
		const observer = new dom.DisposableResizeObserver('paradisBookmarkBar', () => this._layoutOverflow(), targetWindow);
		const store = new DisposableStore();
		store.add(observer);
		store.add(observer.observe(this.element));
		this._resizeObserver.value = store;
	}

	/** 入りきらない項目を隠して「»」のメニューへ回す。 */
	private _layoutOverflow(): void {
		for (const item of this._items) {
			item.element.classList.remove('paradis-bookmark-overflowed');
		}
		this._more.classList.add('paradis-bookmark-overflowed');
		const width = this.element.clientWidth;
		// 隠したバー（設定で非表示・まだ DOM に無い）は幅 0。そのときは測らない（全部が » に入らないように）
		if (width === 0 || this._items.length === 0) {
			this._updateRoving();
			return;
		}
		this.element.scrollLeft = 0;
		if (this.element.scrollWidth > width) {
			this._more.classList.remove('paradis-bookmark-overflowed');
			const style = dom.getWindow(this.element).getComputedStyle(this.element);
			const gap = parseFloat(style.columnGap) || 0;
			const limit = this.element.getBoundingClientRect().left + width - (parseFloat(style.paddingRight) || 0) - this._more.offsetWidth - gap;
			let overflowing = false;
			for (const item of this._items) {
				overflowing = overflowing || item.element.getBoundingClientRect().right > limit;
				item.element.classList.toggle('paradis-bookmark-overflowed', overflowing);
			}
		}
		this._updateRoving();
	}

	/** Tab で巡る先（表示している項目と「»」）。 */
	private _rovingTargets(): HTMLButtonElement[] {
		const targets = this._items.map(item => item.element).filter(element => !element.classList.contains('paradis-bookmark-overflowed'));
		if (!this._more.classList.contains('paradis-bookmark-overflowed')) {
			targets.push(this._more);
		}
		return targets;
	}

	private _focusTarget(key: string | undefined): HTMLButtonElement | undefined {
		const targets = this._rovingTargets();
		if (key === MORE_FOCUS_KEY) {
			return targets.includes(this._more) ? this._more : targets[targets.length - 1];
		}
		const item = this._items.find(candidate => candidate.node.id === key);
		if (item && targets.includes(item.element)) {
			return item.element;
		}
		// 消えた・» に入った項目なら「»」（無ければ先頭）
		return key !== undefined && targets.includes(this._more) ? this._more : targets[0];
	}

	private _setFocusKey(key: string): void {
		this._focusKey = key;
		this._updateRoving();
	}

	/** Tab の止まりを 1 つにする（roving tabindex）。 */
	private _updateRoving(): void {
		const current = this._focusTarget(this._focusKey);
		for (const element of [...this._items.map(item => item.element), this._more]) {
			element.tabIndex = element === current ? 0 : -1;
		}
	}

	private _onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		const targets = this._rovingTargets();
		const index = targets.findIndex(target => dom.isActiveElement(target));
		if (index < 0 || targets.length === 0) {
			return;
		}
		let next: number | undefined;
		switch (event.keyCode) {
			case KeyCode.RightArrow: next = (index + 1) % targets.length; break;
			case KeyCode.LeftArrow: next = (index - 1 + targets.length) % targets.length; break;
			case KeyCode.Home: next = 0; break;
			case KeyCode.End: next = targets.length - 1; break;
		}
		if (next === undefined) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		targets[next].focus();
	}

	// --- folder dropdown (nested submenus) ---------------------------------

	private _showFolderMenu(item: HTMLElement, folder: IParadisBookmarkFolder): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => item,
			getActions: () => this._folderMenuActions(folder),
		});
	}

	private _folderMenuActions(folder: IParadisBookmarkFolder): IAction[] {
		if (folder.children.length === 0) {
			return [new Action('paradis.bookmarks.folderEmpty', localize('paradis.bookmarks.folderEmpty', "フォルダは空です"), undefined, false)];
		}
		return folder.children.map(child => this._nodeMenuAction(child));
	}

	private _nodeMenuAction(node: ParadisBookmarkNode): IAction {
		if (isParadisBookmark(node)) {
			return new Action(`paradis.bookmarks.open.${node.id}`, node.title || node.url, undefined, true, () => this.host.openUrl(node.url));
		}
		return new SubmenuAction(`paradis.bookmarks.folder.${node.id}`, folderDisplayTitle(node), this._folderMenuActions(node));
	}

	// --- context menus ------------------------------------------------------

	private _showBookmarkContextMenu(e: MouseEvent, bookmark: IParadisBookmark): void {
		const actions: IAction[] = [
			new Action('paradis.bookmarks.ctx.open', localize('paradis.bookmarks.ctx.open', "開く"), undefined, true, () => this.host.openUrl(bookmark.url)),
			new Action('paradis.bookmarks.ctx.duplicate', localize('paradis.bookmarks.ctx.duplicate', "複製"), undefined, true, () => this.bookmarksService.duplicateBookmark(bookmark.id)),
			new Action('paradis.bookmarks.ctx.edit', localize('paradis.bookmarks.ctx.edit', "編集..."), undefined, true, () => this.openEditBookmarkDialog(bookmark)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.remove', localize('paradis.bookmarks.ctx.remove', "削除"), undefined, true, () => this.bookmarksService.removeNode(bookmark.id)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	private _showFolderContextMenu(e: MouseEvent, folder: IParadisBookmarkFolder): void {
		const actions: IAction[] = [
			new Action('paradis.bookmarks.ctx.editFolder', localize('paradis.bookmarks.ctx.editFolder', "フォルダを編集..."), undefined, true, () => this.openFolderDialog(folder)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.removeFolder', localize('paradis.bookmarks.ctx.removeFolder', "フォルダを削除"), undefined, true, () => this.bookmarksService.removeNode(folder.id)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	private _showBarContextMenu(e: MouseEvent): void {
		const currentPage = this.host.getCurrentPage();
		const actions: IAction[] = [
			new Action('paradis.bookmarks.ctx.addPage', localize('paradis.bookmarks.ctx.addPage', "現在のページをブックマーク"), undefined, !!currentPage && !!currentPage.url, () => {
				if (currentPage?.url) {
					this.bookmarksService.addBookmark({ url: currentPage.url, title: currentPage.title, faviconDataUri: currentPage.faviconDataUri });
				}
			}),
			new Action('paradis.bookmarks.ctx.newFolder', localize('paradis.bookmarks.ctx.newFolder', "新しいフォルダ..."), undefined, true, () => this.openFolderDialog()),
			new Separator(),
			new Action('paradis.bookmarks.ctx.import', localize('paradis.bookmarks.ctx.import', "ブックマークをインポート..."), undefined, true, () => this.commandService.executeCommand(PARADIS_IMPORT_BOOKMARKS_COMMAND_ID)),
			new Action('paradis.bookmarks.ctx.export', localize('paradis.bookmarks.ctx.export', "ブックマークをエクスポート..."), undefined, true, () => this.commandService.executeCommand(PARADIS_EXPORT_BOOKMARKS_COMMAND_ID)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.hideBar', localize('paradis.bookmarks.ctx.hideBar', "ブックマークバーを隠す"), undefined, true, () => this.commandService.executeCommand(PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	// --- drag & drop (root-level reorder) -----------------------------------

	private _installDnd(item: HTMLElement, node: ParadisBookmarkNode): void {
		item.draggable = true;
		this._renderDisposables.add(dom.addDisposableListener(item, 'dragstart', e => {
			this._draggingId = node.id;
			item.classList.add('dragging');
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', node.id);
			}
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'dragend', () => {
			this._draggingId = undefined;
			item.classList.remove('dragging');
			this._clearDropTargets();
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'dragover', e => {
			if (this._draggingId && this._draggingId !== node.id) {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
				if (this._dropTargetElement !== item) {
					this._clearDropTargets();
					this._dropTargetElement = item;
					item.classList.add('drop-target');
				}
			}
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'dragleave', () => {
			if (this._dropTargetElement === item) {
				this._clearDropTargets();
			}
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'drop', e => {
			if (this._draggingId && this._draggingId !== node.id) {
				e.preventDefault();
				const activeId = this._draggingId;
				this._draggingId = undefined;
				this.bookmarksService.moveNode(activeId, node.id);
			}
			this._clearDropTargets();
		}));
	}

	private _clearDropTargets(): void {
		this._dropTargetElement?.classList.remove('drop-target');
		this._dropTargetElement = undefined;
	}
}
