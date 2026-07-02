/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブックマークツリーの唯一の保持者（singletonサービス）。永続化は IStorageService の
// StorageScope.APPLICATION（Supersetのグローバル localStorage 相当・全ワークスペース共通）。
// faviconは履歴と同じ BrowserFaviconsStore を流用してSHA1ハッシュでdedupし、ツリー本体とは
// 別キーに保存する（本体JSONの肥大化防止）。他ウィンドウとの同期は onDidChangeValue 監視。

import { Emitter, Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { BrowserFaviconsStore, ISerializedBrowserFaviconsSnapshot } from '../../../../platform/browserView/common/browserHistory.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	collectParadisFaviconHashes,
	findParadisBookmarkByUrl,
	findParadisNodeById,
	findParadisParentFolderId,
	insertParadisNodeIntoFolder,
	IParadisBookmark,
	IParadisBookmarkFolder,
	IParadisBookmarkImportStats,
	isParadisBookmark,
	isParadisBookmarkFolder,
	moveParadisRootNode,
	normalizeParadisBookmarkUrl,
	ParadisBookmarkNode,
	ParadisFolderIconKey,
	ParadisImportedNode,
	removeParadisNodeFromTree,
	sanitizeParadisNodes,
	syncParadisFaviconInTree,
} from '../common/paradisBookmarkModel.js';

export const IParadisBookmarksService = createDecorator<IParadisBookmarksService>('paradisBookmarksService');

// コマンドID／設定キー（contribution・バーwidget・featureで共用する定数）。
export const PARADIS_TOGGLE_BOOKMARK_COMMAND_ID = 'paradis.browser.toggleBookmark';
export const PARADIS_TOGGLE_BOOKMARK_BAR_COMMAND_ID = 'paradis.browser.toggleBookmarkBar';
export const PARADIS_IMPORT_BOOKMARKS_COMMAND_ID = 'paradis.browser.importBookmarks';
export const PARADIS_EXPORT_BOOKMARKS_COMMAND_ID = 'paradis.browser.exportBookmarks';
export const PARADIS_BOOKMARK_BAR_VISIBLE_SETTING = 'paradis.browser.bookmarkBar.visible';

/** Input for creating or updating a bookmark. */
export interface IParadisBookmarkInput {
	readonly url: string;
	readonly title: string;
	/** Raw favicon data URI; hashed and deduplicated into the favicon store. */
	readonly faviconDataUri?: string;
	/** Target folder; `undefined`/`null` means the bar root. */
	readonly folderId?: string | null;
}

/** Input for creating or updating a folder. */
export interface IParadisFolderInput {
	readonly title: string;
	readonly icon?: ParadisFolderIconKey;
	readonly color?: string;
}

/**
 * Window-global bookmark store shared by every browser editor. All mutations
 * persist immediately and replicate to other windows via storage events.
 */
export interface IParadisBookmarksService {
	readonly _serviceBrand: undefined;

	/** Fires on any change to the tree or the favicon store (including changes from other windows). */
	readonly onDidChange: Event<void>;

	/** The root nodes, in bar display order. */
	readonly nodes: readonly ParadisBookmarkNode[];

	/** Resolve a favicon hash to its data URI. */
	getFavicon(hash: string | undefined): string | undefined;

	/** Whether a bookmark exists for the given URL (normalized comparison). */
	isBookmarked(url: string): boolean;

	/**
	 * Add a bookmark. Returns the existing bookmark unchanged when the
	 * normalized URL is already bookmarked; returns `undefined` for empty or
	 * `about:blank` URLs.
	 */
	addBookmark(input: IParadisBookmarkInput): IParadisBookmark | undefined;

	/** Duplicate a bookmark into the same parent folder with a "(Copy)" title suffix. */
	duplicateBookmark(bookmarkId: string): IParadisBookmark | undefined;

	/**
	 * Update title/URL/folder of a bookmark. Returns `undefined` when the new
	 * URL is invalid or collides with another bookmark.
	 */
	updateBookmark(bookmarkId: string, input: IParadisBookmarkInput): IParadisBookmark | undefined;

	/** Add a folder at the bar root. */
	addFolder(input: IParadisFolderInput): IParadisBookmarkFolder;

	/** Update title/icon/color of a folder. */
	updateFolder(folderId: string, input: IParadisFolderInput): IParadisBookmarkFolder | undefined;

	/** Remove a node (folders are removed with all their children). */
	removeNode(nodeId: string): void;

	/** Root-level reorder: the active node takes the dropped-on node's position. */
	moveNode(activeId: string, overId: string): void;

	/** Toggle a bookmark for the URL. Returns `true` when the bookmark now exists. */
	toggleBookmark(input: IParadisBookmarkInput): boolean;

	/** Write the current page's favicon back onto matching bookmarks. */
	syncFaviconByUrl(url: string, faviconDataUri: string): void;

	/** Append imported nodes (fresh ids) at the bar root. */
	importNodes(nodes: readonly ParadisImportedNode[]): IParadisBookmarkImportStats;
}

const BOOKMARKS_STORAGE_KEY = 'paradis.browser.bookmarks';
const FAVICONS_STORAGE_KEY = 'paradis.browser.bookmarks.favicons';

export class ParadisBookmarksService extends Disposable implements IParadisBookmarksService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _nodes: readonly ParadisBookmarkNode[] = [];
	private readonly _favicons = this._register(new BrowserFaviconsStore());

	/** True while this window is writing to storage, to ignore the echo of its own writes. */
	private _storing = false;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._loadNodes();
		this._loadFavicons();

		// 他ウィンドウの書き込みを反映する（自分の書き込みのechoは _storing でスキップ）。
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, BOOKMARKS_STORAGE_KEY, this._store)(() => {
			if (!this._storing) {
				this._loadNodes();
				this._onDidChange.fire();
			}
		}));
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, FAVICONS_STORAGE_KEY, this._store)(() => {
			if (!this._storing) {
				this._loadFavicons();
				this._onDidChange.fire();
			}
		}));
	}

	get nodes(): readonly ParadisBookmarkNode[] {
		return this._nodes;
	}

	getFavicon(hash: string | undefined): string | undefined {
		return hash ? this._favicons.get(hash) : undefined;
	}

	isBookmarked(url: string): boolean {
		return !!url && !!findParadisBookmarkByUrl(this._nodes, url);
	}

	addBookmark(input: IParadisBookmarkInput): IParadisBookmark | undefined {
		const normalizedUrl = normalizeParadisBookmarkUrl(input.url);
		if (!normalizedUrl || normalizedUrl === 'about:blank') {
			return undefined;
		}
		const existing = findParadisBookmarkByUrl(this._nodes, normalizedUrl);
		if (existing) {
			return existing;
		}
		const bookmark: IParadisBookmark = {
			id: generateUuid(),
			type: 'bookmark',
			url: normalizedUrl,
			title: input.title.trim() || normalizedUrl,
			faviconHash: input.faviconDataUri ? this._favicons.register(input.faviconDataUri) : undefined,
			createdAt: Date.now(),
		};
		this._setNodes(this._insert(this._nodes, bookmark, input.folderId ?? undefined));
		return bookmark;
	}

	duplicateBookmark(bookmarkId: string): IParadisBookmark | undefined {
		const target = findParadisNodeById(this._nodes, bookmarkId);
		if (!target || !isParadisBookmark(target)) {
			return undefined;
		}
		const duplicated: IParadisBookmark = {
			...target,
			id: generateUuid(),
			title: localize('paradis.bookmarks.duplicateTitle', "{0} (Copy)", target.title.trim() || target.url),
			createdAt: Date.now(),
		};
		const folderId = findParadisParentFolderId(this._nodes, bookmarkId);
		this._setNodes(this._insert(this._nodes, duplicated, folderId ?? undefined));
		return duplicated;
	}

	updateBookmark(bookmarkId: string, input: IParadisBookmarkInput): IParadisBookmark | undefined {
		const normalizedUrl = normalizeParadisBookmarkUrl(input.url);
		if (!normalizedUrl || normalizedUrl === 'about:blank') {
			return undefined;
		}
		const target = findParadisNodeById(this._nodes, bookmarkId);
		if (!target || !isParadisBookmark(target)) {
			return undefined;
		}
		if (normalizeParadisBookmarkUrl(target.url) !== normalizedUrl && findParadisBookmarkByUrl(this._nodes, normalizedUrl, bookmarkId)) {
			return undefined;
		}
		const updated: IParadisBookmark = {
			...target,
			url: normalizedUrl,
			title: input.title.trim() || normalizedUrl,
			faviconHash: input.faviconDataUri ? this._favicons.register(input.faviconDataUri) : target.faviconHash,
		};
		const removed = removeParadisNodeFromTree(this._nodes, bookmarkId);
		this._setNodes(this._insert(removed.nodes, updated, input.folderId ?? undefined));
		return updated;
	}

	addFolder(input: IParadisFolderInput): IParadisBookmarkFolder {
		const folder: IParadisBookmarkFolder = {
			id: generateUuid(),
			type: 'folder',
			title: input.title.trim(),
			icon: input.icon,
			color: input.color,
			children: [],
			createdAt: Date.now(),
		};
		this._setNodes([...this._nodes, folder]);
		return folder;
	}

	updateFolder(folderId: string, input: IParadisFolderInput): IParadisBookmarkFolder | undefined {
		const target = findParadisNodeById(this._nodes, folderId);
		if (!target || !isParadisBookmarkFolder(target)) {
			return undefined;
		}
		const updated: IParadisBookmarkFolder = {
			...target,
			title: input.title.trim(),
			icon: input.icon,
			color: input.color,
		};
		const replaceFolder = (nodes: readonly ParadisBookmarkNode[]): ParadisBookmarkNode[] =>
			nodes.map((node): ParadisBookmarkNode => {
				if (node.id === folderId && isParadisBookmarkFolder(node)) {
					return updated;
				}
				if (isParadisBookmarkFolder(node)) {
					return { ...node, children: replaceFolder(node.children) };
				}
				return node;
			});
		this._setNodes(replaceFolder(this._nodes));
		return updated;
	}

	removeNode(nodeId: string): void {
		const result = removeParadisNodeFromTree(this._nodes, nodeId);
		if (result.removed) {
			this._setNodes(result.nodes);
		}
	}

	moveNode(activeId: string, overId: string): void {
		const next = moveParadisRootNode(this._nodes, activeId, overId);
		if (next) {
			this._setNodes(next);
		}
	}

	toggleBookmark(input: IParadisBookmarkInput): boolean {
		const existing = findParadisBookmarkByUrl(this._nodes, input.url);
		if (existing) {
			this.removeNode(existing.id);
			return false;
		}
		return this.addBookmark(input) !== undefined;
	}

	syncFaviconByUrl(url: string, faviconDataUri: string): void {
		const normalizedUrl = normalizeParadisBookmarkUrl(url);
		if (!normalizedUrl || normalizedUrl === 'about:blank' || !findParadisBookmarkByUrl(this._nodes, normalizedUrl)) {
			return;
		}
		const hash = this._favicons.register(faviconDataUri);
		const result = syncParadisFaviconInTree(this._nodes, normalizedUrl, hash);
		if (result.updated) {
			this._setNodes(result.nodes);
		} else {
			// ハッシュ登録だけが起きた可能性があるので favicon 側は保存しておく。
			this._persistFavicons();
		}
	}

	importNodes(nodes: readonly ParadisImportedNode[]): IParadisBookmarkImportStats {
		const stats = { bookmarksAdded: 0, foldersAdded: 0, skipped: 0 };
		const cloned = this._cloneImported(nodes, stats);
		if (cloned.length > 0) {
			this._setNodes([...this._nodes, ...cloned]);
		}
		return stats;
	}

	// --- internals -------------------------------------------------------

	private _insert(nodes: readonly ParadisBookmarkNode[], node: ParadisBookmarkNode, folderId: string | undefined): ParadisBookmarkNode[] {
		if (folderId) {
			const inserted = insertParadisNodeIntoFolder(nodes, node, folderId);
			if (inserted.inserted) {
				return inserted.nodes;
			}
		}
		return [...nodes, node];
	}

	private _cloneImported(nodes: readonly ParadisImportedNode[], stats: { bookmarksAdded: number; foldersAdded: number; skipped: number }): ParadisBookmarkNode[] {
		const result: ParadisBookmarkNode[] = [];
		for (const node of nodes) {
			if (node.type === 'bookmark') {
				const normalizedUrl = normalizeParadisBookmarkUrl(node.url);
				if (!normalizedUrl || normalizedUrl === 'about:blank') {
					stats.skipped++;
					continue;
				}
				stats.bookmarksAdded++;
				result.push({
					id: generateUuid(),
					type: 'bookmark',
					url: normalizedUrl,
					title: node.title.trim() || normalizedUrl,
					faviconHash: node.faviconDataUri ? this._favicons.register(node.faviconDataUri) : undefined,
					createdAt: node.createdAt || Date.now(),
				});
				continue;
			}
			stats.foldersAdded++;
			result.push({
				id: generateUuid(),
				type: 'folder',
				title: node.title.trim(),
				children: this._cloneImported(node.children, stats),
				createdAt: node.createdAt || Date.now(),
			});
		}
		return result;
	}

	private _setNodes(nodes: readonly ParadisBookmarkNode[]): void {
		this._nodes = nodes;
		this._favicons.gc(collectParadisFaviconHashes(nodes));
		this._storing = true;
		try {
			this._storageService.store(BOOKMARKS_STORAGE_KEY, JSON.stringify(nodes), StorageScope.APPLICATION, StorageTarget.USER);
			this._persistFaviconsRaw();
		} finally {
			this._storing = false;
		}
		this._onDidChange.fire();
	}

	private _persistFavicons(): void {
		this._storing = true;
		try {
			this._persistFaviconsRaw();
		} finally {
			this._storing = false;
		}
	}

	private _persistFaviconsRaw(): void {
		this._storageService.store(FAVICONS_STORAGE_KEY, JSON.stringify(this._favicons.serialize()), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private _loadNodes(): void {
		const raw = this._storageService.get(BOOKMARKS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			this._nodes = [];
			return;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			this._nodes = sanitizeParadisNodes(parsed);
		} catch {
			this._nodes = [];
		}
	}

	private _loadFavicons(): void {
		const raw = this._storageService.get(FAVICONS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			this._favicons.hydrate(undefined);
			return;
		}
		try {
			this._favicons.hydrate(JSON.parse(raw) as ISerializedBrowserFaviconsSnapshot);
		} catch {
			this._favicons.hydrate(undefined);
		}
	}
}
