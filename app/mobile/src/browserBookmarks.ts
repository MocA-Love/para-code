// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザのブックマークバー（PC と同じ一覧を見て開くだけ。案A）の判定。
 *
 * 一覧は PC の fs の `bookmarks`（`browser.bookmarks.v1`）で読み、`bookmarksChanged` の知らせで読み直す。
 * 見た目は PC のブックマークバーに合わせる: 項目は favicon（無ければ地球）と題名（無ければ URL）、
 * フォルダは 9 種のアイコンと色、今のページと同じ URL の項目は地を一段明るくする。
 */

import type { IParadisMobileBookmarkFolder, IParadisMobileBookmarks, ParadisMobileBookmarkNode } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';

/** 比べるための形（`#` 以降と末尾の `/` を外し、スキームとホストを小文字に。PC の `normalizeParadisBookmarkUrl` よりゆるく、`#` の違いも同じとみなす）。 */
export function normalizeBookmarkUrl(url: string): string {
	const withoutHash = url.trim().replace(/#.*$/, '');
	const match = /^(?<origin>[a-z][a-z0-9+.-]*:\/\/[^/?#]*)(?<rest>.*)$/i.exec(withoutHash);
	const origin = match?.groups?.origin?.toLowerCase() ?? withoutHash;
	const rest = (match?.groups?.rest ?? '').replace(/\/$/, '');
	return origin + rest;
}

/** 今のページと同じ URL のブックマークか。 */
export function isCurrentBookmark(bookmarkUrl: string, pageUrl: string | undefined): boolean {
	return pageUrl !== undefined && pageUrl.length > 0 && normalizeBookmarkUrl(bookmarkUrl) === normalizeBookmarkUrl(pageUrl);
}

/** ブックマークを開くときに送る URL。http(s) 以外（`javascript:` など）は開かない。 */
export function bookmarkNavigateUrl(url: string): string | undefined {
	const trimmed = url.trim();
	return /^https?:\/\/[^/?#\s]+/i.test(trimmed) ? trimmed : undefined;
}

/** 項目に出す名前（題名、無ければ URL から `https://` を外したもの）。 */
export function bookmarkLabel(node: ParadisMobileBookmarkNode): string {
	const title = node.title.trim();
	if (title.length > 0) {
		return title;
	}
	return node.type === 'bookmark' ? node.url.replace(/^https?:\/\//i, '') : 'フォルダ';
}

/** favicon の data URI（無ければ `undefined`）。 */
export function bookmarkFavicon(node: ParadisMobileBookmarkNode, bookmarks: IParadisMobileBookmarks): string | undefined {
	return node.type === 'bookmark' && node.favicon !== undefined ? bookmarks.favicons[node.favicon] : undefined;
}

/** PC のフォルダのアイコン（`ParadisFolderIconKey`）→ Ionicons の名前。知らない名前はフォルダ。 */
const FOLDER_ICONS: { readonly [key: string]: string } = {
	folder: 'folder',
	star: 'star',
	globe: 'globe-outline',
	code: 'code-slash',
	briefcase: 'briefcase',
	image: 'image',
	heart: 'heart',
	book: 'book',
	file: 'document-text',
};

export function bookmarkFolderIcon(folder: IParadisMobileBookmarkFolder): string {
	return (folder.icon !== undefined ? FOLDER_ICONS[folder.icon] : undefined) ?? 'folder';
}

/** フォルダをたどった道（id の並び）から、今いるフォルダの中身と見出し。道が切れていたら根に戻す。 */
export function bookmarkFolderView(bookmarks: IParadisMobileBookmarks, path: readonly string[]): { readonly nodes: readonly ParadisMobileBookmarkNode[]; readonly trail: readonly IParadisMobileBookmarkFolder[] } {
	let nodes = bookmarks.nodes;
	const trail: IParadisMobileBookmarkFolder[] = [];
	for (const id of path) {
		const folder = nodes.find((node): node is IParadisMobileBookmarkFolder => node.type === 'folder' && node.id === id);
		if (folder === undefined) {
			break;
		}
		trail.push(folder);
		nodes = folder.children;
	}
	return { nodes, trail };
}
