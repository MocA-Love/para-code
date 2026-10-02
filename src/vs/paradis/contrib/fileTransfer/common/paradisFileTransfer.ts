/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送（段階 1）の共通の定義。
//
// 左はこのマシン（file://）、右はこのウィンドウが繋いでいる接続先（vscode-remote://）。どちらも同じ
// IFileService で読み書きできるので、転送の通り道は新しく作らない。足りないのは権限（st_mode）だけで、
// `IStat.permissions` は Readonly / Locked / Executable の 3 ビットしか持たない。そこで手元は shared process、
// 接続先は REH に、1 往復で lstat の一覧と chmod を返すチャネル（PARADIS_FILE_MODES_CHANNEL）を足す。
// ここはそのチャネルの型と、権限の文字列の組み立て・解釈、入口の出し分けの条件を持つ（どれも純関数）。

import { Schemas } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';

// --- ID ------------------------------------------------------------------------------------------

export const PARADIS_FILE_TRANSFER_EDITOR_ID = 'paradis.editor.fileTransfer';
export const PARADIS_FILE_TRANSFER_INPUT_TYPE_ID = 'paradis.input.fileTransfer';
/** ファイル転送のタブを開くコマンド。引数に URI を渡すと、その場所をその側に出す。 */
export const PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID = 'paradis.fileTransfer.open';
/** エクスプローラーのフォルダーの右クリックから開くコマンド（コマンドパレットには出さない）。 */
export const PARADIS_FILE_TRANSFER_OPEN_FOLDER_COMMAND_ID = 'paradis.fileTransfer.openFolder';
/** タイトルバーのボタン（アクティビティバーが左右に無いときだけ出す）。 */
export const PARADIS_FILE_TRANSFER_TITLE_BAR_COMMAND_ID = 'paradis.fileTransfer.openFromTitleBar';
/** アクティビティバーの左下（アカウントと設定の間）のボタンの ID。 */
export const PARADIS_FILE_TRANSFER_ACTIVITY_ID = 'workbench.actions.paradis.fileTransfer';

// --- 権限のチャネル --------------------------------------------------------------------------------

/** 手元（shared process）と接続先（REH）の両方に同じ名前で生やす。 */
export const PARADIS_FILE_MODES_CHANNEL = 'paradisFileModes';
/** チャネルの版。足りない命令があるかをウィンドウ側が見分けるのに使う。 */
export const PARADIS_FILE_MODES_PROTOCOL_VERSION = 3;
/** `list` / `chmod` が使える最小の版。 */
export const PARADIS_FILE_MODES_MIN_VERSION = 1;
/** `statFile`（所有者・リンク数）が使える最小の版。転送で送り先の権限を保つのに要る。 */
export const PARADIS_FILE_MODES_STAT_VERSION = 2;
/** `rename`（素の fs.rename）と `statFile` の `identity` が使える最小の版。 */
export const PARADIS_FILE_MODES_RENAME_VERSION = 3;

/** `rename` の引数。どちらも相手のマシンの `file://`。 */
export interface IParadisRenameRequest {
	readonly from: UriComponents;
	readonly to: UriComponents;
}

/**
 * そのチャネルが相手に無いと**確かに**分かる失敗か。IPC の ChannelServer は知らないチャネルへの呼び出しを
 * 1 秒待ってから `name: 'Unknown channel'` で返す（メッセージは "... timed out after 1000ms"）。
 * メッセージの「timed out」だけでは、ただの時間切れと見分けられないので名前で見る。
 */
export function paradisIsUnknownChannelError(error: unknown): boolean {
	return error instanceof Error && error.name === 'Unknown channel';
}

/** 1 ファイルの lstat（置き換えてよいかの判断用）。 */
export interface IParadisFileStatInfo {
	readonly mode: number;
	/** 所有者がチャネルのプロセスと同じか（Windows では常に true）。 */
	readonly ownedByMe: boolean;
	readonly linkCount: number;
	readonly isSymbolicLink: boolean;
	readonly isDirectory: boolean;
	/** 同じファイルかを見分ける印（`dev:ino:size:mtime`）。版 3 から。 */
	readonly identity?: string;
}

/** 1 項目の lstat の結果。 */
export interface IParadisFileModeEntry {
	readonly name: string;
	/** `st_mode & 0o7777`（種類のビットは含めない）。 */
	readonly mode: number;
	readonly kind: 'file' | 'directory' | 'symlink' | 'other';
	/** シンボリックリンクの先がフォルダーか。リンク以外は `kind === 'directory'` と同じ。 */
	readonly isDirectory: boolean;
	readonly size: number;
	readonly mtime: number;
}

/** 1 フォルダーぶんの一覧。`truncated` なら上限で打ち切っている。 */
export interface IParadisFileModeListing {
	readonly entries: readonly IParadisFileModeEntry[];
	readonly truncated: boolean;
}

/** `list` の引数。`resource` は相手のマシンの `file://`。 */
export interface IParadisFileModeListRequest {
	readonly resource: UriComponents;
}

/** `chmod` の引数。`recursive` はフォルダーの中身にも当てる（ファイルの実行権は元の有無を保つ）。 */
export interface IParadisChmodRequest {
	readonly resource: UriComponents;
	readonly mode: number;
	readonly recursive: boolean;
}

/**
 * ウィンドウが見ている URI を、チャネルの相手のマシンの `file://` に直す。
 * 接続先の `vscode-remote://host/home/a` は、REH から見れば `file:///home/a`。
 */
export function paradisToMachineFileUri(resource: URI): URI {
	return resource.scheme === Schemas.file ? resource : URI.from({ scheme: Schemas.file, path: resource.path });
}

// --- 権限の文字列 ----------------------------------------------------------------------------------

/** 一覧の 1 文字目。 */
export type ParadisFileTypeChar = 'd' | 'l' | '-';

const SETUID = 0o4000;
const SETGID = 0o2000;
const STICKY = 0o1000;

/** 権限として受け付ける値か（0〜0o7777 の整数）。 */
export function paradisIsValidMode(mode: number): boolean {
	return Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;
}

/**
 * `ls -l` と同じ 10 文字（例 `drwxr-xr-x`）を組み立てる。
 * setuid / setgid は実行権の欄に `s`（実行権が無ければ `S`）、sticky は `t` / `T` で出す。
 */
export function paradisFormatMode(mode: number, type: ParadisFileTypeChar): string {
	const triple = (shift: number, special: boolean, specialChar: string): string => {
		const bits = (mode >> shift) & 0o7;
		const read = bits & 0o4 ? 'r' : '-';
		const write = bits & 0o2 ? 'w' : '-';
		const executable = (bits & 0o1) !== 0;
		let execute = executable ? 'x' : '-';
		if (special) {
			execute = executable ? specialChar : specialChar.toUpperCase();
		}
		return read + write + execute;
	};
	return type
		+ triple(6, (mode & SETUID) !== 0, 's')
		+ triple(3, (mode & SETGID) !== 0, 's')
		+ triple(0, (mode & STICKY) !== 0, 't');
}

/**
 * `rwxr-xr-x`（9 文字）または `drwxr-xr-x`（10 文字）を値に直す。読めなければ undefined。
 * 1 文字目の種類は値に含めない。
 */
export function paradisParseModeString(text: string): number | undefined {
	let body = text.trim();
	if (body.length === 10) {
		if (!/^[-dlbcps]$/.test(body[0])) {
			return undefined;
		}
		body = body.slice(1);
	}
	if (body.length !== 9) {
		return undefined;
	}
	let mode = 0;
	const specials: Array<[number, string, number]> = [[2, 's', SETUID], [5, 's', SETGID], [8, 't', STICKY]];
	for (let index = 0; index < 9; index++) {
		const char = body[index];
		const position = index % 3;
		const bit = 1 << (8 - index);
		if (position === 0) {
			if (char === 'r') {
				mode |= bit;
			} else if (char !== '-') {
				return undefined;
			}
		} else if (position === 1) {
			if (char === 'w') {
				mode |= bit;
			} else if (char !== '-') {
				return undefined;
			}
		} else {
			const special = specials.find(([at]) => at === index);
			if (char === 'x') {
				mode |= bit;
			} else if (special && char === special[1]) {
				mode |= bit | special[2];
			} else if (special && char === special[1].toUpperCase()) {
				mode |= special[2];
			} else if (char !== '-') {
				return undefined;
			}
		}
	}
	return mode;
}

/** `755` / `0755` / `4755` を値に直す。8 進数として読めなければ undefined。 */
export function paradisParseOctalMode(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^[0-7]{3,4}$/.test(trimmed)) {
		return undefined;
	}
	const mode = parseInt(trimmed, 8);
	return paradisIsValidMode(mode) ? mode : undefined;
}

/** 値を 8 進数の欄に出す形にする。特殊ビットが無ければ 3 桁（`755`）、あれば 4 桁（`4755`）。 */
export function paradisFormatOctalMode(mode: number): string {
	const masked = mode & 0o7777;
	return masked > 0o777 ? masked.toString(8).padStart(4, '0') : masked.toString(8).padStart(3, '0');
}

/** 権限の表の 1 マス。 */
export type ParadisPermissionWho = 'owner' | 'group' | 'other';
export type ParadisPermissionWhat = 'read' | 'write' | 'execute';

/** 表の 1 マスに当たるビット。 */
export function paradisModeBit(who: ParadisPermissionWho, what: ParadisPermissionWhat): number {
	const shift = who === 'owner' ? 6 : who === 'group' ? 3 : 0;
	const bit = what === 'read' ? 0o4 : what === 'write' ? 0o2 : 0o1;
	return bit << shift;
}

/**
 * 「中身にも適用」のとき、中の 1 項目に当てる値。
 *
 * フォルダーには選んだ値をそのまま当てる。ファイルは、選んだ値から実行権を外し、元から実行権を
 * どれか持っていたときだけ選んだ値の実行権を戻す（`chmod -R u=rwX` と同じ考え方）。特殊ビットは付けない。フォルダーの
 * `755` をそのまま中身へ当てると、すべてのファイルが実行できるようになってしまうため。
 */
export function paradisRecursiveModeFor(selectedMode: number, isDirectory: boolean, currentMode: number): number {
	if (isDirectory) {
		return selectedMode;
	}
	// setuid / setgid / sticky は中のファイルへ持ち込まない（フォルダーに付けた setgid が、中の実行ファイルの
	// setgid になると権限の昇格になる）
	const withoutExecute = selectedMode & ~0o111 & ~0o7000;
	return (currentMode & 0o111) !== 0 ? withoutExecute | (selectedMode & 0o111) : withoutExecute;
}

// --- 入口の出し分け -------------------------------------------------------------------------------

/** 画面の左右。左はこのマシン、右はこのウィンドウの接続先。 */
export type ParadisTransferSide = 'local' | 'remote';

/**
 * タイトルバーのボタンを出すか。アクティビティバーを上・下・非表示にしていると、左下の欄
 * （主の入口）ごと描かれないので、そのときだけ代わりに出す。
 * 値が無いときは既定（左右）とみなして出さない。
 */
export function paradisShowsTitleBarEntry(activityBarLocation: unknown): boolean {
	return typeof activityBarLocation === 'string' && activityBarLocation !== 'default';
}

/**
 * エクスプローラーで選んだ場所を、転送画面のどちら側に出すか。
 * 手元のファイルは左、このウィンドウの接続先のファイルは右。それ以外（別の接続先・仮想の
 * ファイルシステム）は出さない（undefined）。
 */
export function paradisSideForResource(resource: URI, remoteAuthority: string | undefined): ParadisTransferSide | undefined {
	if (resource.scheme === Schemas.file) {
		return 'local';
	}
	if (resource.scheme === Schemas.vscodeRemote && !!remoteAuthority && resource.authority === remoteAuthority) {
		return 'remote';
	}
	return undefined;
}

/** 接続先のラベル（`ssh-remote+dev-server` → `dev-server`）。 */
export function paradisHostLabelFromAuthority(authority: string): string {
	const plus = authority.indexOf('+');
	return plus >= 0 ? authority.slice(plus + 1) : authority;
}

/**
 * 「接続して開く」で開いた新しいウィンドウに、転送画面を出させるための控え。
 * 開いた側が APPLICATION の保存領域に書き、繋がった側が起動時に読んで消す。
 */
export const PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY = 'paradis.fileTransfer.pendingOpen';
/** 控えの有効期間。接続に時間がかかっても間に合い、古い控えで勝手に開かない長さ。 */
export const PARADIS_FILE_TRANSFER_PENDING_OPEN_TTL_MS = 3 * 60 * 1000;

export interface IParadisFileTransferPendingOpen {
	readonly authority: string;
	readonly at: number;
}

/** 控えがこのウィンドウ宛てで、まだ新しいか。 */
export function paradisShouldOpenFromPending(raw: string | undefined, remoteAuthority: string | undefined, now: number): boolean {
	if (!raw || !remoteAuthority) {
		return false;
	}
	try {
		const pending = JSON.parse(raw) as Partial<IParadisFileTransferPendingOpen>;
		return pending.authority === remoteAuthority
			&& typeof pending.at === 'number'
			&& now - pending.at >= 0
			&& now - pending.at <= PARADIS_FILE_TRANSFER_PENDING_OPEN_TTL_MS;
	} catch {
		return false;
	}
}
