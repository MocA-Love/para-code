/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの新しいタブの「よく開くページ」と「ブックマーク」のタイル。
// よく開くページは、そのタブの保存先の履歴（本家の browserHistory。開くたびに 1 件ずつ足される）を
// ページ（オリジンとパス）ごとに数え、開いた回数の多い順・同じなら新しい順に並べる。

/** 履歴の 1 件（本家の IBrowserHistoryEntry のうち使う分）。 */
export interface IParadisNewTabHistoryEntry {
	readonly url: string;
	readonly title: string;
	readonly time: number;
	readonly icon?: string;
}

export interface IParadisNewTabTile {
	/** 開く URL（そのページを最後に開いたときの URL）。 */
	readonly url: string;
	readonly title: string;
	/** 履歴なら favicon の保存の鍵、ブックマークなら favicon の鍵。 */
	readonly iconKey?: string;
	/** 開いた回数（よく開くページだけ）。 */
	readonly count?: number;
}

export const PARADIS_NEW_TAB_TILE_LIMIT = 8;

/** ページをまとめる鍵（http・https だけ。クエリとハッシュは見ない。末尾の / は無視する）。 */
export function paradisNewTabPageKey(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return undefined;
		}
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
	} catch {
		return undefined;
	}
}

/** 一覧に出す名前。題が無ければホスト名とパス。 */
function displayTitle(entry: IParadisNewTabHistoryEntry): string {
	if (entry.title.trim()) {
		return entry.title.trim();
	}
	try {
		const parsed = new URL(entry.url);
		const path = parsed.pathname.replace(/\/+$/, '');
		return `${parsed.host}${path}`;
	} catch {
		return entry.url;
	}
}

export function paradisRankFrequentPages(entries: readonly IParadisNewTabHistoryEntry[], limit = PARADIS_NEW_TAB_TILE_LIMIT): IParadisNewTabTile[] {
	const pages = new Map<string, { latest: IParadisNewTabHistoryEntry; titled: IParadisNewTabHistoryEntry | undefined; iconed: IParadisNewTabHistoryEntry | undefined; count: number }>();
	for (const entry of entries) {
		const key = paradisNewTabPageKey(entry.url);
		if (!key) {
			continue;
		}
		const page = pages.get(key);
		if (!page) {
			pages.set(key, { latest: entry, titled: entry.title.trim() ? entry : undefined, iconed: entry.icon ? entry : undefined, count: 1 });
			continue;
		}
		page.count++;
		if (entry.time >= page.latest.time) {
			page.latest = entry;
		}
		if (entry.title.trim() && (!page.titled || entry.time >= page.titled.time)) {
			page.titled = entry;
		}
		if (entry.icon && (!page.iconed || entry.time >= page.iconed.time)) {
			page.iconed = entry;
		}
	}
	return [...pages.values()]
		.sort((a, b) => b.count - a.count || b.latest.time - a.latest.time)
		.slice(0, limit)
		.map(page => ({ url: page.latest.url, title: displayTitle(page.titled ?? page.latest), iconKey: page.iconed?.icon, count: page.count }));
}

/** ブックマークの木から、タイルにするもの（バーの先頭の階層の http・https のブックマークだけ。フォルダと javascript: などは除く）。 */
export function paradisBookmarkTiles(nodes: readonly { readonly type: string; readonly url?: string; readonly title?: string; readonly faviconHash?: string }[], limit = PARADIS_NEW_TAB_TILE_LIMIT): IParadisNewTabTile[] {
	const tiles: IParadisNewTabTile[] = [];
	for (const node of nodes) {
		if (tiles.length >= limit) {
			break;
		}
		if (node.type === 'bookmark' && node.url && paradisNewTabPageKey(node.url) !== undefined) {
			tiles.push({ url: node.url, title: node.title?.trim() || node.url, iconKey: node.faviconHash });
		}
	}
	return tiles;
}
