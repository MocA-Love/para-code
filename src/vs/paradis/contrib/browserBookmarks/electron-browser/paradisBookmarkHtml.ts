/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Netscape Bookmark HTML 形式の import / export（Superset の browser-bookmarks-html.ts 移植）。
// Netscape形式は閉じタグ（</DT>）を省略するのが慣習のため、ブラウザが修復したDOMツリーに
// 頼らず、生のトークン列（<A>/<Hn>/<DL>/<DT>）を正規表現で走査してツリーを復元する。

import {
	IParadisImportedFolder,
	isParadisBookmark,
	normalizeParadisBookmarkUrl,
	ParadisBookmarkNode,
	ParadisImportedNode,
} from '../common/paradisBookmarkModel.js';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function buildBookmarkHtml(node: ParadisBookmarkNode, getFavicon: (hash: string | undefined) => string | undefined, depth = 1): string {
	const indent = '    '.repeat(depth);

	if (isParadisBookmark(node)) {
		const parts = [
			`${indent}<DT><A HREF="${escapeHtml(node.url)}"`,
			` ADD_DATE="${Math.floor(node.createdAt / 1000)}"`,
		];
		const favicon = getFavicon(node.faviconHash);
		if (favicon) {
			parts.push(` ICON="${escapeHtml(favicon)}"`);
		}
		parts.push(`>${escapeHtml(node.title || node.url)}</A>\n`);
		return parts.join('');
	}

	const title = node.title.trim() || 'Untitled Folder';
	return [
		`${indent}<DT><H3 ADD_DATE="${Math.floor(node.createdAt / 1000)}">${escapeHtml(title)}</H3>\n`,
		`${indent}<DL><p>\n`,
		...node.children.map(child => buildBookmarkHtml(child, getFavicon, depth + 1)),
		`${indent}</DL><p>\n`,
	].join('');
}

/** Serialize the bookmark tree into Netscape Bookmark HTML. */
export function exportParadisBookmarksToHtml(nodes: readonly ParadisBookmarkNode[], getFavicon: (hash: string | undefined) => string | undefined): string {
	return [
		'<!DOCTYPE NETSCAPE-Bookmark-file-1>',
		'<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
		'<TITLE>Bookmarks</TITLE>',
		'<H1>Bookmarks</H1>',
		'<DL><p>',
		...nodes.map(node => buildBookmarkHtml(node, getFavicon)),
		'</DL><p>',
		'',
	].join('\n');
}

function parseTimestamp(value: string | null): number {
	if (!value) {
		return Date.now();
	}
	const unixSeconds = Number(value);
	return Number.isFinite(unixSeconds) ? unixSeconds * 1000 : Date.now();
}

function parseElementFragment<T extends Element>(parser: DOMParser, html: string, selector: string): T | null {
	const parsedDocument = parser.parseFromString(html, 'text/html');
	const element = parsedDocument.body.firstElementChild;
	if (!element?.matches(selector)) {
		return null;
	}
	return element as T;
}

function parseBookmarkAnchor(anchor: HTMLAnchorElement): ParadisImportedNode | null {
	const href = normalizeParadisBookmarkUrl(anchor.getAttribute('href') ?? '');
	if (!href || href === 'about:blank') {
		return null;
	}
	const icon = anchor.getAttribute('icon');
	return {
		type: 'bookmark',
		url: href,
		title: anchor.textContent?.trim() || href,
		faviconDataUri: icon && icon.startsWith('data:') ? icon : undefined,
		createdAt: parseTimestamp(anchor.getAttribute('add_date')),
	};
}

interface IMutableImportedFolder {
	readonly type: 'folder';
	readonly title: string;
	readonly children: ParadisImportedNode[];
	readonly createdAt: number;
}

function parseFolderHeading(parser: DOMParser, html: string): IMutableImportedFolder | null {
	const heading = parseElementFragment<HTMLHeadingElement>(parser, html, 'h1, h2, h3, h4, h5, h6');
	if (!heading) {
		return null;
	}
	return {
		type: 'folder',
		title: heading.textContent?.trim() ?? '',
		createdAt: parseTimestamp(heading.getAttribute('add_date')),
		children: [],
	};
}

/** Parse Netscape Bookmark HTML into an imported-node tree. */
export function importParadisBookmarksFromHtml(html: string): ParadisImportedNode[] {
	const parser = new DOMParser();
	const nodes: ParadisImportedNode[] = [];
	const listStack: ParadisImportedNode[][] = [];
	let pendingFolder: IMutableImportedFolder | null = null;

	const tokenPattern = /<a\b[^>]*>[\s\S]*?<\/a\s*>|<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>|<\/?dl\b[^>]*>|<\/?dt\b[^>]*>/gi;

	for (const match of html.matchAll(tokenPattern)) {
		const token = match[0];
		if (!token) {
			continue;
		}

		if (/^<dl\b/i.test(token)) {
			if (listStack.length === 0) {
				listStack.push(nodes);
				pendingFolder = null;
				continue;
			}
			if (pendingFolder) {
				listStack.push(pendingFolder.children);
				pendingFolder = null;
				continue;
			}
			listStack.push(listStack[listStack.length - 1] ?? nodes);
			continue;
		}

		if (/^<\/dl\b/i.test(token)) {
			pendingFolder = null;
			if (listStack.length > 0) {
				listStack.pop();
			}
			continue;
		}

		if (listStack.length === 0) {
			continue;
		}

		if (/^<h[1-6]\b/i.test(token)) {
			const folder = parseFolderHeading(parser, token);
			if (!folder) {
				pendingFolder = null;
				continue;
			}
			const currentList = listStack[listStack.length - 1];
			if (!currentList) {
				pendingFolder = null;
				continue;
			}
			currentList.push(folder as IParadisImportedFolder);
			pendingFolder = folder;
			continue;
		}

		if (/^<a\b/i.test(token)) {
			const anchor = parseElementFragment<HTMLAnchorElement>(parser, token, 'a');
			const bookmark = anchor ? parseBookmarkAnchor(anchor) : null;
			if (bookmark) {
				const currentList = listStack[listStack.length - 1];
				currentList?.push(bookmark);
			}
			pendingFolder = null;
		}
	}

	return nodes;
}
