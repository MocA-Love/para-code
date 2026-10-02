/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分の画面の「表示」「差分」「Raw」の材料（scm.file-at.v1）。スマホの差分の画面が、変更前（HEAD・インデックス）と
// 変更後（インデックス・作業ツリー）のファイルの中身をバイト列のまま受け取る。
//
// - scm の `fileAt` { ws, path, side: 'head' | 'index' | 'worktree', responseEncoding? }
// - `responseEncoding: 'fs-binary-v1'` なら fs のバイナリ応答（種類は media）で、それ以外は `{ t: 'fileAt', data（base64）, size }`
// - その側にファイルが無い（新規・削除）ときは `{ t: 'fileAt', missing: true }`
//
// HEAD とインデックスは、Excel の差分（`xlsxDiff`）と同じく git 拡張の `git:` の URI で読む（SSH 先でも接続先の git が答える）。
// 文字かバイナリかは見分けない（アプリが種類で決める。Markdown は UTF-8 として読み、画像・Office はバイト列のまま使う）。

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisResolveHostPath } from '../../../common/paradisHostPath.js';
import { paradisEncodeNegotiatedBinaryFsResponse } from '../common/paradisMobileFileResponse.js';
import { IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/** 読む上限（fs の media と同じ 20MiB。base64 にしても FrameMux の再結合上限 32MiB に収まる）。 */
export const PARADIS_MOBILE_FILE_AT_LIMIT = 20 * 1024 * 1024;

export type ParadisMobileFileSide = 'head' | 'index' | 'worktree';

export function paradisParseMobileFileSide(value: unknown): ParadisMobileFileSide | undefined {
	return value === 'head' || value === 'index' || value === 'worktree' ? value : undefined;
}

/**
 * スマホから届いた相対パスを、`/` 区切りの安全な区画に分ける。外へ出る・別の綴り（ドライブ・UNC・スキーム）の
 * パスは undefined。HEAD やインデックスの側は作業ツリーに無いことがある（削除）ので、`realpath` で確かめる前の段階の検査。
 */
export function paradisMobileRelativeSegments(relativePath: unknown): readonly string[] | undefined {
	if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 4096
		|| relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(relativePath)) {
		return undefined;
	}
	const segments = relativePath.split('/').filter(segment => segment.length > 0);
	return segments.length > 0 && !segments.some(segment => segment === '.' || segment === '..') ? segments : undefined;
}

/** git 拡張の `git:` の URI（`ref` は HEAD なら `HEAD`、インデックスなら空。git 拡張の toGitUri と同じ綴り）。 */
export function paradisMobileGitUri(file: URI, hostPath: string, side: 'head' | 'index'): URI {
	return file.with({ scheme: 'git', query: JSON.stringify({ path: hostPath, ref: side === 'head' ? 'HEAD' : '' }) });
}

/**
 * その側のファイルの URI を求める。無ければ（その側に無い・スペースの外）undefined。
 * - 作業ツリー: シンボリックリンクで外へ出ていないことを確かめた実体
 * - HEAD・インデックス: `git rev-parse --verify` で、その側にそのパスがあるかを先に確かめる
 */
export async function paradisResolveMobileFileAt(context: Pick<IParadisMobileRequestContext, 'root' | 'resolvePath' | 'runGit'>, remoteAgentService: Pick<IRemoteAgentService, 'getConnection'> | undefined, relativePath: unknown, side: ParadisMobileFileSide): Promise<URI | undefined> {
	const segments = paradisMobileRelativeSegments(relativePath);
	if (segments === undefined || context.root === undefined) {
		return undefined;
	}
	const relative = segments.join('/');
	if (side === 'worktree') {
		return context.resolvePath(relative);
	}
	const exists = await context.runGit(['rev-parse', '--verify', '--quiet', `${side === 'head' ? 'HEAD' : ''}:./${relative}`]).catch(() => undefined);
	if (exists === undefined || exists.code !== 0) {
		return undefined;
	}
	// 根だけは実体に直す（根がシンボリックリンクでも、git の答えるパスは実体の側）。パスの区画は上で検査済み
	const realRoot = await context.resolvePath('');
	if (realRoot === undefined) {
		return undefined;
	}
	const file = joinPath(realRoot, ...segments);
	const hostPath = paradisResolveHostPath(file, remoteAgentService?.getConnection() ?? undefined);
	return hostPath !== undefined ? paradisMobileGitUri(file, hostPath.path, side) : undefined;
}

registerParadisMobileRequestHandler('scm', 'fileAt', {
	handle(accessor, request, context) {
		const fileService = accessor.get(IFileService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const side = paradisParseMobileFileSide(request.side);
		if (side === undefined || typeof request.path !== 'string') {
			context.reply({ error: 'invalid fileAt request' });
			return;
		}
		if (context.root === undefined) {
			context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
			return;
		}
		// スペースの外を指す（`..`・絶対パス）パスは、その側に無いのではなく要求の誤り
		if (paradisMobileRelativeSegments(request.path) === undefined) {
			context.reply({ error: 'invalid path' });
			return;
		}
		return (async () => {
			const uri = await paradisResolveMobileFileAt(context, remoteAgentService, request.path, side);
			if (uri === undefined) {
				// 作業ツリーで解決できない（シンボリックリンクで外へ出る・読めない）のは要求の誤り。HEAD・インデックスに無いのは「その側に無い」
				context.reply(side === 'worktree' ? { error: 'invalid path' } : { t: 'fileAt', missing: true });
				return;
			}
			const content = await fileService.readFile(uri, { length: PARADIS_MOBILE_FILE_AT_LIMIT + 1 });
			if (content.value.byteLength > PARADIS_MOBILE_FILE_AT_LIMIT) {
				context.reply({ error: localize('paradis.mobile.fileAt.tooLarge', "This file exceeds the transfer limit ({0} MB).", PARADIS_MOBILE_FILE_AT_LIMIT / 1024 / 1024) });
				return;
			}
			const bytes = content.value.buffer;
			const binary = paradisEncodeNegotiatedBinaryFsResponse(request.responseEncoding, 'media', request.id, bytes.byteLength, bytes);
			if (binary !== undefined) {
				context.sendBytes(binary);
				return;
			}
			context.reply({ t: 'fileAt', data: encodeBase64(VSBuffer.wrap(bytes)), size: bytes.byteLength });
		})();
	},
});

