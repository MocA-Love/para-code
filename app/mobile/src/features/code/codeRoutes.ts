// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { routes, type RouteHref } from '../../routes.js';
import { DIR_VIEW, FILE_VIEW } from './fileViewerModel.js';

/**
 * ファイルの画面へ移る行き先。`routes.files(...)` に「ファイルとして開く / フォルダとして開く」の印
 * （`view`）を足す。印が無い `routes.files(pcId, spaceId, path)` でも開けるが、そのときは画面が
 * 親のフォルダを読んでどちらかを確かめる（1往復ぶん遅い）。
 */
function withView(href: RouteHref, view: string, extra: Record<string, string> = {}): RouteHref {
	return typeof href === 'string' ? href : { pathname: href.pathname, params: { ...href.params, ...extra, view } };
}

/** ファイルをビューアで開く。`line`（1始まり）を渡すとその行へ送って色を敷く（内容の検索から開いたとき）。 */
export function fileViewerHref(pcId: string, spaceId: string, path: string, line?: number): RouteHref {
	return withView(routes.files(pcId, spaceId, path), FILE_VIEW, line !== undefined && line > 0 ? { line: String(line) } : {});
}

/** ツリーをそのフォルダまで開いた状態で出す（`path` が空なら根）。 */
export function folderHref(pcId: string, spaceId: string, path: string): RouteHref {
	return path.length > 0 ? withView(routes.files(pcId, spaceId, path), DIR_VIEW) : routes.files(pcId, spaceId);
}
