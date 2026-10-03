/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（SSH・WSL・コンテナ）で動くエージェントと、手元で動く内蔵ブラウザのツールとの間でファイルを
// 受け渡すときの、shared process と renderer の取り決め。
//
// ブラウザのツール（chrome-devtools-mcp・PDF 保存・ダウンロード）は手元の shared process・electron-main で
// 動くので、ファイルは手元にできる・手元から読む。接続先のファイルに触れられるのは、接続先と繋がっている
// renderer の IFileService（`vscode-remote://`）だけ。そこで shared process は手元の一時ファイルを使い、
// 中身の受け渡しだけを、呼び出し元ペインを所有するウィンドウ（{@link PARADIS_AGENT_PREVIEW_CHANNEL}）に頼む。
//
// 書いてよい場所は renderer が決める（ペインのスペースのフォルダと、接続先のホームの
// {@link PARADIS_REMOTE_FILE_USER_FOLDER}）。共有の一時フォルダ（/tmp）へは書かない（他の利用者が先回りして
// シンボリックリンクを置ける）。読む側は加えて接続先の一時フォルダも許す。
// shared process から場所の一覧は渡さない（トークンを手に入れた別の利用者に、任意の場所を読み書きさせないため）。

import { posix } from '../../../../base/common/path.js';

/** 接続先へ書く。引数は `[token, remoteAuthority, path, VSBuffer]`、結果は {@link ParadisRemoteFileWriteResult}。 */
export const PARADIS_REMOTE_FILE_WRITE_METHOD = 'paradisWriteRemoteFile';

/** 接続先のホームの {@link PARADIS_REMOTE_FILE_USER_FOLDER} へ、重ならない名前で書く。引数は `[token, remoteAuthority, fileName, VSBuffer]`。 */
export const PARADIS_REMOTE_FILE_WRITE_TEMPORARY_METHOD = 'paradisWriteRemoteTemporaryFile';

/** 接続先から読む。引数は `[token, remoteAuthority, path, maxBytes]`、結果は {@link ParadisRemoteFileReadResult}。 */
export const PARADIS_REMOTE_FILE_READ_METHOD = 'paradisReadRemoteFile';

/** 書く前に、書いてよい場所かだけを確かめる（撮影などの重い処理の前に断るため）。引数は `[token, remoteAuthority, path]`。 */
export const PARADIS_REMOTE_FILE_CHECK_WRITE_METHOD = 'paradisCheckRemoteFileWrite';

/** 接続先のホームの下の、受け渡し用のフォルダ（ユーザー専用の場所。写しはここに置き、古いものは消す）。 */
export const PARADIS_REMOTE_FILE_USER_FOLDER = '.para-code/browser-files';

/** {@link PARADIS_REMOTE_FILE_USER_FOLDER} の写しを残す時間。これより古いものは次に写すときに消す。 */
export const PARADIS_REMOTE_FILE_COPY_TTL_MS = 24 * 60 * 60_000;

/**
 * 1 ファイルの上限。IPC と接続先への転送に一度に載せる量で、手元の shared process と renderer を膨らませない。
 * スクリーンショット・スナップショット・PDF・ふつうのダウンロードはこれに収まる。
 */
export const PARADIS_REMOTE_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** {@link PARADIS_REMOTE_FILE_MAX_BYTES} の表示用。 */
export const PARADIS_REMOTE_FILE_MAX_BYTES_LABEL = '64 MiB';

/** 受け渡しを断った・できなかった理由。shared process がエージェント向けの英文へ直す（renderer は文を返さない）。 */
export type ParadisRemoteFileFailure =
	/** 絶対パスでない、`..`・`\\`・制御文字を含む。 */
	| 'invalidPath'
	/** 許された場所のどれの下でもない（シンボリックリンクの先を含む）。 */
	| 'outsideAllowedFolders'
	/** `.git`・`.hg`・`.svn` の中を指している（書く側）。 */
	| 'versionControlFolder'
	/** 書く先のフォルダが無い（途中のフォルダは作らない）。 */
	| 'parentMissing'
	/** 既にあるものがふつうのファイルでない（フォルダ以外。デバイスなど）。 */
	| 'notAFile'
	/** ペインがまだこのウィンドウの台帳に無い（復元中など）。 */
	| 'paneUnresolved'
	/** 読む側: ファイルが無い。 */
	| 'notFound'
	/** フォルダを指している。 */
	| 'isDirectory'
	/** {@link PARADIS_REMOTE_FILE_MAX_BYTES} を超える。 */
	| 'tooLarge'
	/** 接続先のホームが分からない（接続先の環境をまだ取れていない）。 */
	| 'noTemporaryFolder'
	/** 読み書きそのものに失敗した（権限・接続切れなど）。詳細は renderer の log。 */
	| 'ioFailed';

export type ParadisRemoteFileWriteResult =
	/** `userFolder` は、受け渡し用フォルダの中に書いたときだけ入る（そのフォルダのパス）。 */
	| { readonly ok: true; readonly path: string; readonly userFolder?: string }
	| { readonly ok: false; readonly reason: ParadisRemoteFileFailure };

export type ParadisRemoteFileCheckResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: ParadisRemoteFileFailure };

/** 読んだ中身は IPC で VSBuffer として渡る（shared process 側では Uint8Array として扱う）。 */
export type ParadisRemoteFileReadResult<TData = Uint8Array> =
	| { readonly ok: true; readonly data: TData; readonly name: string }
	| { readonly ok: false; readonly reason: ParadisRemoteFileFailure };

/** 制御文字（NUL を含む）。パスに入っていれば断る。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Windows のドライブ文字で始まる絶対パス（`C:/`）。`\` 区切りは受けない。 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;

/** 書いてはいけないバージョン管理のフォルダ。 */
const VERSION_CONTROL_FOLDERS: ReadonlySet<string> = new Set(['.git', '.hg', '.svn']);

/** パスに `.git`・`.hg`・`.svn` の区間があるか（`/` と `\` のどちらの区切りでも見る。大文字小文字は区別しない）。 */
export function paradisPathHasVersionControlSegment(path: string): boolean {
	return path.split(/[\\/]/).some(segment => VERSION_CONTROL_FOLDERS.has(segment.toLowerCase()));
}

/**
 * エージェントが渡した接続先のパスを、`vscode-remote://` の URI のパス部分（`/` 区切り・`/` 始まり）に直す。
 * 絶対パスでない・`..` の区間を含む・`\` を含む・制御文字を含むものは undefined（断る）。
 * `\` は区切りとしても名前の一部としても曖昧（接続先が Windows なら区切り、POSIX なら名前の文字）なので受けない。
 *
 * 相対パスは受けない。エージェントのプロセスの作業フォルダは Para Code から確かめられず（シェルの今いる
 * フォルダとエージェントのプロセスのフォルダはずれうる）、推測で解くと別のファイルを黙って書き換えうるため。
 */
export function paradisNormalizeRemoteFilePath(path: unknown): string | undefined {
	if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || CONTROL_CHARACTERS.test(path) || path.includes('\\')) {
		return undefined;
	}
	const windows = WINDOWS_DRIVE_PATH.test(path);
	if (!windows && !path.startsWith('/')) {
		return undefined;
	}
	const slashed = windows ? `/${path}` : path;
	if (slashed.split('/').some(segment => segment === '..')) {
		return undefined;
	}
	const normalized = posix.normalize(slashed);
	return normalized.length > 1 && normalized.endsWith('/') ? undefined : normalized;
}

/**
 * vendored の `ensureExtension` と同じく、拡張子を `extension` へ置き換えた接続先のパス。
 * 手元の一時ファイルの保存先が拡張子を変えられたとき、接続先へも同じ名前で書くために使う。
 */
export function paradisReplaceRemoteFileExtension(remotePath: string, extension: string): string {
	const current = posix.extname(remotePath);
	return `${remotePath.slice(0, remotePath.length - current.length)}${extension}`;
}
