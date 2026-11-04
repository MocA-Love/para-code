/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルの「絶対パスをコピー」の口（fs.absolute-path.v1。Q548）の取り決め。依存の無い純粋なファイルにして、
 * `app/protocol/src/fsAbsolutePath.ts` の側から読んで一致を確かめる（`app/protocol/test/fsAbsolutePath.test.ts`）。
 *
 * - 要求: fs の `{ t: 'absolutePath', ws, path }`。`path` はスペースのフォルダの根からの相対（`/` 区切り）
 * - 応答: `{ t: 'absolutePath', path, remote, windows }`。`path` はファイルがある機械の OS で通用する絶対パス
 *   （SSH 先ならそこのパス、Windows なら `\` 区切り）。`remote` は SSH などの接続先のパスか
 * - 失敗: `{ error, code }`。`code` は `invalid`（形が違う）・`missing`（スペースの外・見つからない）・`remote`（接続先を確かめられない）
 *
 * PC は押したときに 1 回だけ答える。アプリは絶対パスを端末に残さない（state に載せない、控えない）。
 */

/** 要求の種類。 */
export const PARADIS_MOBILE_ABSOLUTE_PATH_KIND = 'absolutePath';
/** 受け取る相対パスの長さの上限。 */
export const PARADIS_MOBILE_ABSOLUTE_PATH_MAX_LENGTH = 4096;

export type ParadisMobileAbsolutePathErrorCode = 'invalid' | 'missing' | 'remote';

export interface IParadisMobileAbsolutePathReply {
	readonly t: typeof PARADIS_MOBILE_ABSOLUTE_PATH_KIND;
	readonly path: string;
	readonly remote: boolean;
	readonly windows: boolean;
}

/** 応答の本文を作る。 */
export function paradisMobileAbsolutePathReply(path: string, remote: boolean, windows: boolean): IParadisMobileAbsolutePathReply {
	return { t: PARADIS_MOBILE_ABSOLUTE_PATH_KIND, path, remote, windows };
}

/** 要求の相対パスの形を確かめる（空・長すぎる・NUL・根の外を指す `..` は受けない。実在とリンクの検査は resolvePath が行う）。 */
export function paradisIsMobileAbsolutePathRequestPath(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= PARADIS_MOBILE_ABSOLUTE_PATH_MAX_LENGTH
		&& !value.includes('\0') && !value.split(/[\\/]/).includes('..');
}
