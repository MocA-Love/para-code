/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマークバーのDOM本体。ルート項目の描画（favicon+タイトル／9種アイコン+カラーのフォルダ）、
// クリックでのナビゲーション、フォルダのネストメニュー（IContextMenuService+SubmenuAction）、
// 右クリックメニュー、HTML5 DnDによるルート並べ替え、編集ダイアログ起動を担当する。
// メニュー類は overlayManager が監視済みの context-view で出るため、ネイティブ
// WebContentsView との重なりは自動処理される。

import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Action, IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
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

/** Callbacks the bar needs from its owning editor feature. */
export interface IParadisBookmarkBarHost {
	/** Navigate the current browser tab to the given URL. */
	openUrl(url: string): void;
	/** The page currently shown in the owning editor, if any. */
	getCurrentPage(): { url: string; title: string; faviconDataUri: string | undefined } | undefined;
}

function untitledFolderLabel(): string {
	return localize('paradis.bookmarks.untitledFolder', "Untitled Folder");
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
		}
	}

	/** Open the folder create/edit dialog (also reachable from the bar's context menu). */
	openFolderDialog(folder?: IParadisBookmarkFolder): void {
		this._openDialog.value = this.instantiationService.createInstance(ParadisFolderDialog, {
			dialogTitle: folder
				? localize('paradis.bookmarks.editFolderTitle', "Edit Folder")
				: localize('paradis.bookmarks.newFolderTitle', "New Folder"),
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
			dialogTitle: localize('paradis.bookmarks.editBookmarkTitle', "Edit Bookmark"),
			initial: { title: bookmark.title, url: bookmark.url, folderId },
			folderOptions: getParadisFolderOptions(this.bookmarksService.nodes, untitledFolderLabel()),
			onSubmit: result => {
				if (!normalizeParadisBookmarkUrl(result.url)) {
					return localize('paradis.bookmarks.invalidUrl', "Enter a valid URL.");
				}
				const updated = this.bookmarksService.updateBookmark(bookmark.id, {
					url: result.url,
					title: result.title,
					folderId: result.folderId ?? null,
				});
				return updated ? undefined : localize('paradis.bookmarks.duplicateUrl', "A bookmark for this URL already exists.");
			},
		});
	}

	// --- rendering --------------------------------------------------------

	private _render(): void {
		this._renderDisposables.clear();
		dom.clearNode(this.element);

		const nodes = this.bookmarksService.nodes;
		if (nodes.length === 0) {
			const hint = dom.append(this.element, $('.paradis-bookmark-bar-hint'));
			hint.textContent = localize('paradis.bookmarks.emptyHint', "Click the star in the address bar to add bookmarks.");
			return;
		}

		for (const node of nodes) {
			const item = isParadisBookmark(node) ? this._renderBookmarkItem(node) : this._renderFolderItem(node);
			this._installDnd(item, node);
			this.element.appendChild(item);
		}
	}

	private _renderBookmarkItem(bookmark: IParadisBookmark): HTMLElement {
		const item = $('.paradis-bookmark-item');
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

	private _renderFolderItem(folder: IParadisBookmarkFolder): HTMLElement {
		const item = $('.paradis-bookmark-item.folder');

		const iconContainer = dom.append(item, $('.paradis-bookmark-item-icon'));
		const icon = iconContainer.appendChild($(`span${ThemeIcon.asCSSSelector(paradisFolderIcon(folder.icon))}`));
		if (folder.color) {
			icon.style.color = folder.color;
		}

		dom.append(item, $('span.paradis-bookmark-item-label')).textContent = folderDisplayTitle(folder);
		this._renderDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), item, folderDisplayTitle(folder)));

		this._renderDisposables.add(dom.addDisposableListener(item, 'click', () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => item,
				getActions: () => this._folderMenuActions(folder),
			});
		}));
		this._renderDisposables.add(dom.addDisposableListener(item, 'contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this._showFolderContextMenu(e, folder);
		}));
		return item;
	}

	// --- folder dropdown (nested submenus) ---------------------------------

	private _folderMenuActions(folder: IParadisBookmarkFolder): IAction[] {
		if (folder.children.length === 0) {
			return [new Action('paradis.bookmarks.folderEmpty', localize('paradis.bookmarks.folderEmpty', "Folder Is Empty"), undefined, false)];
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
			new Action('paradis.bookmarks.ctx.open', localize('paradis.bookmarks.ctx.open', "Open"), undefined, true, () => this.host.openUrl(bookmark.url)),
			new Action('paradis.bookmarks.ctx.duplicate', localize('paradis.bookmarks.ctx.duplicate', "Duplicate"), undefined, true, () => this.bookmarksService.duplicateBookmark(bookmark.id)),
			new Action('paradis.bookmarks.ctx.edit', localize('paradis.bookmarks.ctx.edit', "Edit..."), undefined, true, () => this.openEditBookmarkDialog(bookmark)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.remove', localize('paradis.bookmarks.ctx.remove', "Remove"), undefined, true, () => this.bookmarksService.removeNode(bookmark.id)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	private _showFolderContextMenu(e: MouseEvent, folder: IParadisBookmarkFolder): void {
		const actions: IAction[] = [
			new Action('paradis.bookmarks.ctx.editFolder', localize('paradis.bookmarks.ctx.editFolder', "Edit Folder..."), undefined, true, () => this.openFolderDialog(folder)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.removeFolder', localize('paradis.bookmarks.ctx.removeFolder', "Remove Folder"), undefined, true, () => this.bookmarksService.removeNode(folder.id)),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	private _showBarContextMenu(e: MouseEvent): void {
		const currentPage = this.host.getCurrentPage();
		const actions: IAction[] = [
			new Action('paradis.bookmarks.ctx.addPage', localize('paradis.bookmarks.ctx.addPage', "Bookmark Current Page"), undefined, !!currentPage && !!currentPage.url, () => {
				if (currentPage?.url) {
					this.bookmarksService.addBookmark({ url: currentPage.url, title: currentPage.title, faviconDataUri: currentPage.faviconDataUri });
				}
			}),
			new Action('paradis.bookmarks.ctx.newFolder', localize('paradis.bookmarks.ctx.newFolder', "New Folder..."), undefined, true, () => this.openFolderDialog()),
			new Separator(),
			new Action('paradis.bookmarks.ctx.import', localize('paradis.bookmarks.ctx.import', "Import Bookmarks..."), undefined, true, () => this.commandService.executeCommand(PARADIS_IMPORT_BOOKMARKS_COMMAND_ID)),
			new Action('paradis.bookmarks.ctx.export', localize('paradis.bookmarks.ctx.export', "Export Bookmarks..."), undefined, true, () => this.commandService.executeCommand(PARADIS_EXPORT_BOOKMARKS_COMMAND_ID)),
			new Separator(),
			new Action('paradis.bookmarks.ctx.hideBar', localize('paradis.bookmarks.ctx.hideBar', "Hide Bookmarks Bar"), undefined, true, () => this.commandService.executeCommand(PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID)),
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
