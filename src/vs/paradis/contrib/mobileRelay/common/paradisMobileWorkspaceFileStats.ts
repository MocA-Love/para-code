/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { extUri, extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * スペースの中の複数のファイルの大きさと最終更新時刻をまとめて調べる（差分レビューの未追跡のファイルの識別、Orca W2-14）。
 *
 * 1件ずつ `paradisResolveMobileWorkspacePath` を通すと、ファイルごとにルートの realpath を2回ずつ引く
 * （SSH 先ではそのたびに往復が要る）。ここではルートの realpath を1回だけ引き、各ファイルは realpath と stat を
 * 1回ずつにする。読むのは大きさと時刻だけなので、確かめた後に差し替えられても中身は漏れない。
 * ルートの外へ出るリンク・フォルダ・読めないものは結果に入れない。
 */
export async function paradisStatMobileWorkspaceFiles(fileService: Pick<IFileService, 'realpath' | 'stat'>, root: URI, relativePaths: readonly string[]): Promise<Map<string, { readonly size: number; readonly mtime: number }>> {
	const stats = new Map<string, { readonly size: number; readonly mtime: number }>();
	if (relativePaths.length === 0) {
		return stats;
	}
	const normalize = (resource: URI): URI => resource.scheme === 'file' && (resource.path.includes('\\') || !resource.path.startsWith('/')) ? URI.file(resource.path) : resource;
	const realRoot = await fileService.realpath(root).catch(() => undefined);
	if (realRoot === undefined) {
		return stats;
	}
	const realRootUri = normalize(realRoot);
	const identity = realRootUri.scheme === 'file' ? extUriBiasedIgnorePathCase : extUri;
	await Promise.all(relativePaths.map(async relativePath => {
		// モバイルのパスは / 区切りの相対パス。ほかの形（ドライブ・UNC・スキーム・`..`）は受けない
		if (relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath)) {
			return;
		}
		const segments = relativePath.split('/').filter(segment => segment.length > 0);
		if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
			return;
		}
		try {
			const real = await fileService.realpath(joinPath(root, ...segments));
			if (real === undefined) {
				return;
			}
			const realUri = normalize(real);
			if (!identity.isEqualOrParent(realUri, realRootUri)) {
				return;
			}
			const stat = await fileService.stat(realUri);
			if (!stat.isDirectory) {
				stats.set(relativePath, { size: stat.size, mtime: stat.mtime });
			}
		} catch {
			// 消えた・読めないファイルは大きさと時刻を付けない
		}
	}));
	return stats;
}
