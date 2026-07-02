/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのブックマークバー（Superset互換）のデータモデルと純関数群。
// ツリー構造（ブックマーク／9種アイコン+任意カラーのネスト可能フォルダ）・URL正規化・
// イミュータブルなCRUDヘルパー・ストレージ用サニタイズをここに集約する。
// DOMに依存しないため common レイヤーに置く（サービス/UIは electron-browser 側）。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * The nine folder icon keys supported by the bookmark bar
 * (kept identical to Superset's `browser-bookmark-folder-icons.tsx`).
 */
export type ParadisFolderIconKey = 'folder' | 'star' | 'globe' | 'code' | 'briefcase' | 'image' | 'heart' | 'book' | 'file';

const FOLDER_ICONS: Record<ParadisFolderIconKey, ThemeIcon> = {
	folder: Codicon.folder,
	star: Codicon.star,
	globe: Codicon.globe,
	code: Codicon.code,
	briefcase: Codicon.briefcase,
	image: Codicon.fileMedia,
	heart: Codicon.heart,
	book: Codicon.book,
	file: Codicon.file,
};

/** Ordered icon choices rendered in the folder dialog's icon grid. */
export const PARADIS_FOLDER_ICON_KEYS: readonly ParadisFolderIconKey[] = ['folder', 'star', 'globe', 'code', 'briefcase', 'image', 'heart', 'book', 'file'];

/**
 * Preset folder colors rendered in the folder dialog
 * (same eight presets as Superset's `BookmarkFolderDialog.tsx`).
 */
export const PARADIS_FOLDER_COLOR_PRESETS: readonly string[] = ['#64748b', '#2563eb', '#0891b2', '#16a34a', '#d97706', '#e11d48', '#7c3aed', '#6b7280'];

export function isParadisFolderIconKey(value: unknown): value is ParadisFolderIconKey {
	return typeof value === 'string' && value in FOLDER_ICONS;
}

export function paradisFolderIcon(key: ParadisFolderIconKey | undefined): ThemeIcon {
	return FOLDER_ICONS[key ?? 'folder'] ?? Codicon.folder;
}

/** A single bookmark. `faviconHash` keys into the deduplicated favicon store. */
export interface IParadisBookmark {
	readonly id: string;
	readonly type: 'bookmark';
	readonly url: string;
	readonly title: string;
	readonly faviconHash?: string;
	readonly createdAt: number;
}

/** A bookmark folder. Folders may nest arbitrarily deep. */
export interface IParadisBookmarkFolder {
	readonly id: string;
	readonly type: 'folder';
	readonly title: string;
	readonly icon?: ParadisFolderIconKey;
	readonly color?: string;
	readonly children: readonly ParadisBookmarkNode[];
	readonly createdAt: number;
}

export type ParadisBookmarkNode = IParadisBookmark | IParadisBookmarkFolder;

/** A folder choice offered by the edit-bookmark dialog (label is the nested "Parent / Child" path). */
export interface IParadisFolderOption {
	readonly id: string;
	readonly label: string;
}

export function isParadisBookmark(node: ParadisBookmarkNode): node is IParadisBookmark {
	return node.type === 'bookmark';
}

export function isParadisBookmarkFolder(node: ParadisBookmarkNode): node is IParadisBookmarkFolder {
	return node.type === 'folder';
}

/**
 * Normalize a bookmark URL the same way Superset does: origin-only URLs are
 * collapsed to the origin, unparseable strings just lose trailing slashes.
 */
export function normalizeParadisBookmarkUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed || trimmed === 'about:blank') {
		return trimmed;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
			return parsed.origin;
		}
		return parsed.toString();
	} catch {
		return trimmed.replace(/\/+$/, '');
	}
}

export function findParadisNodeById(nodes: readonly ParadisBookmarkNode[], nodeId: string): ParadisBookmarkNode | undefined {
	for (const node of nodes) {
		if (node.id === nodeId) {
			return node;
		}
		if (isParadisBookmarkFolder(node)) {
			const childMatch = findParadisNodeById(node.children, nodeId);
			if (childMatch) {
				return childMatch;
			}
		}
	}
	return undefined;
}

export function findParadisBookmarkByUrl(nodes: readonly ParadisBookmarkNode[], url: string, excludedId?: string): IParadisBookmark | undefined {
	const normalizedUrl = normalizeParadisBookmarkUrl(url);
	for (const node of nodes) {
		if (isParadisBookmark(node)) {
			if (node.id !== excludedId && normalizeParadisBookmarkUrl(node.url) === normalizedUrl) {
				return node;
			}
			continue;
		}
		const childMatch = findParadisBookmarkByUrl(node.children, normalizedUrl, excludedId);
		if (childMatch) {
			return childMatch;
		}
	}
	return undefined;
}

export function findParadisParentFolderId(nodes: readonly ParadisBookmarkNode[], nodeId: string, parentFolderId: string | null = null): string | null {
	for (const node of nodes) {
		if (node.id === nodeId) {
			return parentFolderId;
		}
		if (isParadisBookmarkFolder(node)) {
			const childMatch = findParadisParentFolderId(node.children, nodeId, node.id);
			if (childMatch !== null) {
				return childMatch;
			}
		}
	}
	return null;
}

/**
 * Flatten all folders into selectable options whose labels show the nested
 * path ("Parent / Child"). Optionally excludes a subtree (unused for now but
 * mirrors Superset's helper shape).
 */
export function getParadisFolderOptions(nodes: readonly ParadisBookmarkNode[], untitledLabel: string, parentTitles: readonly string[] = []): IParadisFolderOption[] {
	const options: IParadisFolderOption[] = [];
	for (const node of nodes) {
		if (!isParadisBookmarkFolder(node)) {
			continue;
		}
		const titles = [...parentTitles, node.title.trim() || untitledLabel];
		options.push({ id: node.id, label: titles.join(' / ') });
		options.push(...getParadisFolderOptions(node.children, untitledLabel, titles));
	}
	return options;
}

/** Collect every bookmark in the tree (depth-first). */
export function flattenParadisBookmarks(nodes: readonly ParadisBookmarkNode[]): IParadisBookmark[] {
	const result: IParadisBookmark[] = [];
	for (const node of nodes) {
		if (isParadisBookmark(node)) {
			result.push(node);
		} else {
			result.push(...flattenParadisBookmarks(node.children));
		}
	}
	return result;
}

/** Collect every favicon hash referenced by the tree (for store GC). */
export function collectParadisFaviconHashes(nodes: readonly ParadisBookmarkNode[], into: Set<string> = new Set()): Set<string> {
	for (const node of nodes) {
		if (isParadisBookmark(node)) {
			if (node.faviconHash) {
				into.add(node.faviconHash);
			}
		} else {
			collectParadisFaviconHashes(node.children, into);
		}
	}
	return into;
}

export function removeParadisNodeFromTree(nodes: readonly ParadisBookmarkNode[], nodeId: string): { nodes: ParadisBookmarkNode[]; removed?: ParadisBookmarkNode } {
	let removed: ParadisBookmarkNode | undefined;
	const nextNodes: ParadisBookmarkNode[] = [];
	for (const node of nodes) {
		if (node.id === nodeId) {
			removed = node;
			continue;
		}
		if (isParadisBookmarkFolder(node)) {
			const childResult = removeParadisNodeFromTree(node.children, nodeId);
			if (childResult.removed) {
				removed = childResult.removed;
				nextNodes.push({ ...node, children: childResult.nodes });
				continue;
			}
		}
		nextNodes.push(node);
	}
	return { nodes: nextNodes, removed };
}

export function insertParadisNodeIntoFolder(nodes: readonly ParadisBookmarkNode[], nodeToInsert: ParadisBookmarkNode, folderId: string): { nodes: ParadisBookmarkNode[]; inserted: boolean } {
	let inserted = false;
	const nextNodes = nodes.map((node): ParadisBookmarkNode => {
		if (!isParadisBookmarkFolder(node)) {
			return node;
		}
		if (node.id === folderId) {
			inserted = true;
			return { ...node, children: [...node.children, nodeToInsert] };
		}
		const childResult = insertParadisNodeIntoFolder(node.children, nodeToInsert, folderId);
		if (childResult.inserted) {
			inserted = true;
			return { ...node, children: childResult.nodes };
		}
		return node;
	});
	return { nodes: nextNodes, inserted };
}

/**
 * Root-level reorder used by the bar's drag-and-drop: the active node takes
 * the position of the node it was dropped on (Superset `moveNode` semantics).
 */
export function moveParadisRootNode(nodes: readonly ParadisBookmarkNode[], activeId: string, overId: string): ParadisBookmarkNode[] | undefined {
	if (activeId === overId) {
		return undefined;
	}
	const fromIndex = nodes.findIndex(node => node.id === activeId);
	const toIndex = nodes.findIndex(node => node.id === overId);
	if (fromIndex < 0 || toIndex < 0) {
		return undefined;
	}
	const nextNodes = [...nodes];
	const [movedItem] = nextNodes.splice(fromIndex, 1);
	nextNodes.splice(toIndex, 0, movedItem);
	return nextNodes;
}

/** Write the given favicon hash onto every bookmark whose normalized URL matches. */
export function syncParadisFaviconInTree(nodes: readonly ParadisBookmarkNode[], url: string, faviconHash: string): { nodes: ParadisBookmarkNode[]; updated: boolean } {
	const normalizedUrl = normalizeParadisBookmarkUrl(url);
	let updated = false;
	const nextNodes = nodes.map((node): ParadisBookmarkNode => {
		if (isParadisBookmark(node)) {
			if (normalizeParadisBookmarkUrl(node.url) !== normalizedUrl || node.faviconHash === faviconHash) {
				return node;
			}
			updated = true;
			return { ...node, faviconHash };
		}
		const childResult = syncParadisFaviconInTree(node.children, normalizedUrl, faviconHash);
		if (!childResult.updated) {
			return node;
		}
		updated = true;
		return { ...node, children: childResult.nodes };
	});
	return { nodes: nextNodes, updated };
}

/**
 * A bookmark parsed from an external source (Netscape bookmark HTML). Unlike
 * {@link IParadisBookmark} it carries the favicon as a raw data URI; the
 * service registers it into the deduplicated favicon store on import.
 */
export interface IParadisImportedBookmark {
	readonly type: 'bookmark';
	readonly url: string;
	readonly title: string;
	readonly faviconDataUri?: string;
	readonly createdAt?: number;
}

/** A folder parsed from an external source (Netscape bookmark HTML). */
export interface IParadisImportedFolder {
	readonly type: 'folder';
	readonly title: string;
	readonly children: readonly ParadisImportedNode[];
	readonly createdAt?: number;
}

export type ParadisImportedNode = IParadisImportedBookmark | IParadisImportedFolder;

/** Counters reported after an import. */
export interface IParadisBookmarkImportStats {
	readonly bookmarksAdded: number;
	readonly foldersAdded: number;
	readonly skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Sanitize an untrusted (persisted) value into a valid bookmark tree.
 * Invalid entries are dropped; missing ids/timestamps are regenerated.
 */
export function sanitizeParadisNodes(value: unknown): ParadisBookmarkNode[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: ParadisBookmarkNode[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) {
			continue;
		}
		const id = typeof entry.id === 'string' && entry.id ? entry.id : generateUuid();
		const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : Date.now();
		const rawTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
		if (entry.type === 'folder') {
			result.push({
				id,
				type: 'folder',
				title: rawTitle,
				icon: isParadisFolderIconKey(entry.icon) ? entry.icon : undefined,
				color: typeof entry.color === 'string' && entry.color ? entry.color : undefined,
				children: sanitizeParadisNodes(entry.children),
				createdAt,
			});
			continue;
		}
		const normalizedUrl = normalizeParadisBookmarkUrl(typeof entry.url === 'string' ? entry.url : '');
		if (!normalizedUrl || normalizedUrl === 'about:blank') {
			continue;
		}
		result.push({
			id,
			type: 'bookmark',
			url: normalizedUrl,
			title: rawTitle || normalizedUrl,
			faviconHash: typeof entry.faviconHash === 'string' && entry.faviconHash ? entry.faviconHash : undefined,
			createdAt,
		});
	}
	return result;
}
