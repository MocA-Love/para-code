/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PC の内蔵ブラウザのブックマークを、モバイルへ送る形（browser.bookmarks.v1、`paradisMobileBrowserProtocol.ts`）にする。

import { ParadisBookmarkNode } from '../../browserBookmarks/common/paradisBookmarkModel.js';
import {
	IParadisMobileBookmarks,
	PARADIS_MOBILE_BOOKMARK_FAVICON_MAX,
	PARADIS_MOBILE_BOOKMARK_FAVICONS_TOTAL_MAX,
	PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH,
	PARADIS_MOBILE_BOOKMARKS_MAX_NODES,
	PARADIS_MOBILE_BROWSER_TITLE_MAX,
	PARADIS_MOBILE_BROWSER_URL_MAX,
	ParadisMobileBookmarkNode,
} from './paradisMobileBrowserProtocol.js';

/**
 * PC のブックマークの木をモバイルへ送る形にする。数・深さの上限を超えた分は落とし、favicon は 1 枚の
 * 大きさと合計の上限に収まるものだけ（収まらないものは favicon 無しで送る。アプリは地球のアイコンを出す）。
 */
export function paradisMobileBookmarksPayload(nodes: readonly ParadisBookmarkNode[], getFavicon: (hash: string) => string | undefined): IParadisMobileBookmarks {
	const favicons: { [hash: string]: string } = {};
	let faviconBytes = 0;
	let count = 0;
	const faviconOf = (hash: string | undefined): string | undefined => {
		if (hash === undefined) {
			return undefined;
		}
		if (favicons[hash] !== undefined) {
			return hash;
		}
		const uri = getFavicon(hash);
		if (uri === undefined || uri.length > PARADIS_MOBILE_BOOKMARK_FAVICON_MAX || !/^data:image\//i.test(uri) || faviconBytes + uri.length > PARADIS_MOBILE_BOOKMARK_FAVICONS_TOTAL_MAX) {
			return undefined;
		}
		faviconBytes += uri.length;
		favicons[hash] = uri;
		return hash;
	};
	const convert = (source: readonly ParadisBookmarkNode[], depth: number): ParadisMobileBookmarkNode[] => {
		const result: ParadisMobileBookmarkNode[] = [];
		if (depth > PARADIS_MOBILE_BOOKMARKS_MAX_DEPTH) {
			return result;
		}
		for (const node of source) {
			if (count >= PARADIS_MOBILE_BOOKMARKS_MAX_NODES) {
				break;
			}
			const title = node.title.slice(0, PARADIS_MOBILE_BROWSER_TITLE_MAX);
			if (node.type === 'bookmark') {
				if (node.url.length === 0 || node.url.length > PARADIS_MOBILE_BROWSER_URL_MAX) {
					continue;
				}
				count++;
				const favicon = faviconOf(node.faviconHash);
				result.push({ type: 'bookmark', id: node.id, title, url: node.url, ...(favicon !== undefined ? { favicon } : {}) });
			} else {
				count++;
				result.push({
					type: 'folder', id: node.id, title,
					...(node.icon !== undefined ? { icon: node.icon } : {}),
					...(node.color !== undefined ? { color: node.color } : {}),
					children: convert(node.children, depth + 1),
				});
			}
		}
		return result;
	};
	const converted = convert(nodes, 1);
	return { t: 'bookmarks', nodes: converted, favicons };
}
