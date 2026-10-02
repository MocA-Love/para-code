/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の待ち行列が使う型と、失敗の見分け方（純関数）。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationError, FileOperationResult, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';

// --- 読み書きの口 ----------------------------------------------------------------------------------

export interface IParadisTransferStat {
	readonly isDirectory: boolean;
	readonly size: number;
	readonly mtime: number | undefined;
	/** 通常のファイルでもフォルダーでもない（壊れたリンク・ソケット・FIFO など）。読むと止まりうるので写さない。 */
	readonly special?: boolean;
	/** リンクそのもの。送り先がリンクなら、置き換えはリンクを取り除く確認を経てから行う。 */
	readonly isSymbolicLink?: boolean;
}

/** フォルダーの中の 1 項目。大きさと日時も 1 回の一覧で取る（項目ごとに stat しない）。 */
export interface IParadisTransferChild extends IParadisTransferStat {
	readonly name: string;
	readonly resource: URI;
	/** フォルダーを指すリンク。辿らない（自分の親を指すと終わらない）が、飛ばした件数には数える。 */
	readonly directoryLink?: boolean;
}

export interface IParadisTransferCopyOptions {
	/** 送り先に同じ名前があれば置き換えてよいか。false なら、あったときは衝突として失敗する。 */
	readonly overwrite: boolean;
	/** 一時名を他の実行と重ならないようにするための印。 */
	readonly runId: string;
	/** 書き終えたバイト数を知らせる。 */
	readonly onBytes: (bytes: number) => void;
	/** 一時名を使わず送り先を直接書き換えるとき（途中で失敗すると元に戻らない）に知らせる。 */
	readonly onWriteInPlace?: () => void;
	readonly token: CancellationToken;
}

/** 待ち行列が使う読み書き。実装は electron-browser 側（IFileService）とテストの偽物。 */
export interface IParadisTransferFileSystem {
	/** 無ければ undefined。 */
	stat(resource: URI): Promise<IParadisTransferStat | undefined>;
	/** 子の一覧（大きさ・日時つき）。フォルダーが無ければ空。 */
	readDirectory(resource: URI): Promise<readonly IParadisTransferChild[]>;
	/** 親も含めて作る。既にあれば何もしない。 */
	createDirectory(resource: URI): Promise<void>;
	/**
	 * 1 ファイルを写す。**送り先と同じフォルダーの一時名に書いてから、プロバイダーの rename 1 回で置き換える**ので、
	 * 失敗・切断・取り消しで送り先の元の内容は失われない。片付けるのは自分の一時ファイルだけで、rename に入った後に
	 * 失敗したときは一時ファイルも消さない（{@link ParadisTransferReplaceError} で場所を知らせる）。
	 * 送り先の権限・所有者・ハードリンクを保てない場合（所有者が違う・リンク数が 2 以上・権限を読めない・一時名を
	 * 作れない）は、その場で書く。
	 * 送り先がフォルダーかリンクのとき、または `overwrite` が false で送り先があるときは {@link ParadisTransferConflictError}。
	 */
	copyFile(source: URI, target: URI, options: IParadisTransferCopyOptions): Promise<void>;
	/** 種類の違う同名を置き換えるために、送り先を取り除く（手元はゴミ箱へ）。 */
	removeForReplace(resource: URI): Promise<void>;
}

/** 送り先に同じ名前がある（または実行の直前にできた）。 */
export class ParadisTransferConflictError extends Error {
	constructor(readonly target: URI) {
		super(localize('paradis.fileTransfer.error.conflict', "送り先に同じ名前の項目があります"));
		this.name = 'ParadisTransferConflictError';
	}
}

/** 書き終えた一時ファイルで送り先を置き換えられなかった。一時ファイルは消さずに残してある。 */
export class ParadisTransferReplaceError extends Error {
	constructor(readonly temp: URI, readonly reason: unknown) {
		super(localize('paradis.fileTransfer.error.replace', "置き換えられませんでした。書き終えたファイルは {0} に残っています", temp.path));
		this.name = 'ParadisTransferReplaceError';
	}
}

/** 送り元と送り先が同じファイル（同じマシンへの SSH など）。写すと送り元を壊しうるので拒否する。 */
export class ParadisTransferSameFileError extends Error {
	constructor() {
		super(localize('paradis.fileTransfer.error.sameFile', "送り元と送り先が同じファイルです"));
		this.name = 'ParadisTransferSameFileError';
	}
}

/** 写せない種類のファイル（ソケット・FIFO・壊れたリンクなど）。 */
export class ParadisTransferSpecialFileError extends Error {
	constructor() {
		super(localize('paradis.fileTransfer.error.special', "通常のファイルではないため写せません"));
		this.name = 'ParadisTransferSpecialFileError';
	}
}

// --- 名前の衝突 ------------------------------------------------------------------------------------

export type ParadisConflictAction = 'overwrite' | 'rename' | 'skip';

export interface IParadisTransferConflict {
	readonly name: string;
	readonly source: URI;
	readonly target: URI;
	readonly sourceStat: IParadisTransferStat;
	readonly targetStat: IParadisTransferStat;
	/** 「名前を変える」を選んだときの名前。 */
	readonly renamedName: string;
	/** ファイルとフォルダーのように種類が違う（送り先がリンクのときも含む）。上書きすると送り先が丸ごと置き換わる。 */
	readonly kindMismatch: boolean;
	/** 「以後すべてに適用」を出してよいか（種類が違う衝突では出さない）。 */
	readonly allowApplyToAll: boolean;
	/** 衝突の中で何件目か（1 から）。 */
	readonly index: number;
	/** 衝突の件数。 */
	readonly total: number;
}

export interface IParadisConflictDecision {
	/** `cancel` はこの転送の全部をやめる（何も始めない）。 */
	readonly action: ParadisConflictAction | 'cancel';
	/** 残りの衝突にも同じ操作を当てる（種類が違う衝突には当てない）。 */
	readonly applyToAll: boolean;
}

export type ParadisConflictResolver = (conflict: IParadisTransferConflict) => Promise<IParadisConflictDecision>;

// --- 要求と項目 ------------------------------------------------------------------------------------

export interface IParadisTransferSource {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	/** 一覧で分かっている大きさと日時（衝突の確認に使い、もう一度 stat しない）。 */
	readonly size?: number;
	readonly mtime?: number;
}

export type ParadisTransferDirection = 'toRemote' | 'toLocal';

export interface IParadisTransferRequest {
	readonly sources: readonly IParadisTransferSource[];
	readonly targetDirectory: URI;
	/** 送り先の見出し（`dev-server` / `このマシン`）。 */
	readonly targetLabel: string;
	readonly direction: ParadisTransferDirection;
}

export type ParadisTransferState = 'waiting' | 'running' | 'done' | 'error' | 'cancelled';

export type ParadisTransferErrorKind = 'permission' | 'disconnected' | 'notFound' | 'noSpace' | 'conflict' | 'special' | 'replaceFailed' | 'sameFile' | 'other';

export interface IParadisTransferError {
	readonly kind: ParadisTransferErrorKind;
	readonly message: string;
}

/** 待ち行列の 1 行（送り元の 1 項目。フォルダーは中身ごと 1 行）。 */
export interface IParadisTransferItem {
	readonly id: number;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly source: URI;
	readonly target: URI;
	readonly targetLabel: string;
	readonly direction: ParadisTransferDirection;
	readonly state: ParadisTransferState;
	/** 調べ終わるまで undefined。 */
	readonly totalBytes: number | undefined;
	/** 書き終えたバイト数。 */
	readonly doneBytes: number;
	readonly totalFiles: number | undefined;
	readonly doneFiles: number;
	/** 写さずに飛ばした項目（フォルダーを指すリンク・特殊なファイル・読めないファイル）。 */
	readonly skipped: number;
	/** 送り先を直接書き換えた（一時名を使えなかった）ファイルがある。途中で失敗すると元に戻らない。 */
	readonly writesInPlace: boolean;
	/** 計れるだけの時間が経つまで undefined。 */
	readonly bytesPerSecond: number | undefined;
	readonly remainingSeconds: number | undefined;
	readonly error: IParadisTransferError | undefined;
}

/** 待ち行列全体のまとめ（見出し・アクティビティバーのバッジ用）。 */
export interface IParadisTransferSummary {
	/** 待ち＋進行中。 */
	readonly active: number;
	readonly running: number;
	readonly failed: number;
	/** 積む前の確認・下調べをしている転送の数。 */
	readonly preparing: number;
	/** 進行中と待ちのうち、大きさの分かっているものの合計に対する割合（0〜100）。 */
	readonly percent: number | undefined;
	readonly remainingSeconds: number | undefined;
}

// --- 失敗の見分け方 --------------------------------------------------------------------------------

/** 失敗の種類を見分ける。権限・見つからない・容量は、手元でも接続先でも同じ表現で返ってくる。 */
export function paradisClassifyTransferError(error: unknown): ParadisTransferErrorKind {
	if (error instanceof ParadisTransferConflictError) {
		return 'conflict';
	}
	if (error instanceof ParadisTransferSpecialFileError) {
		return 'special';
	}
	if (error instanceof ParadisTransferReplaceError) {
		return 'replaceFailed';
	}
	if (error instanceof ParadisTransferSameFileError) {
		return 'sameFile';
	}
	if (error instanceof FileOperationError) {
		switch (error.fileOperationResult) {
			case FileOperationResult.FILE_PERMISSION_DENIED:
			case FileOperationResult.FILE_WRITE_LOCKED:
				return 'permission';
			case FileOperationResult.FILE_NOT_FOUND:
				return 'notFound';
			case FileOperationResult.FILE_MOVE_CONFLICT:
				return 'conflict';
		}
	}
	if (error instanceof Error) {
		const code = toFileSystemProviderErrorCode(error);
		if (code === FileSystemProviderErrorCode.NoPermissions) {
			return 'permission';
		}
		if (code === FileSystemProviderErrorCode.FileNotFound) {
			return 'notFound';
		}
		if (code === FileSystemProviderErrorCode.FileExists) {
			return 'conflict';
		}
		if (code === FileSystemProviderErrorCode.Unavailable) {
			return 'disconnected';
		}
		const message = error.message;
		if (/\b(EACCES|EPERM)\b|permission denied/i.test(message)) {
			return 'permission';
		}
		if (/\bENOSPC\b|no space left/i.test(message)) {
			return 'noSpace';
		}
		if (/\bENOENT\b/.test(message)) {
			return 'notFound';
		}
	}
	return 'other';
}

/** 失敗の種類ごとの短い説明（待ち行列の行に出す）。 */
export function paradisDescribeTransferError(kind: ParadisTransferErrorKind, detail: string): string {
	switch (kind) {
		case 'permission':
			return localize('paradis.fileTransfer.error.permission', "権限がありません");
		case 'disconnected':
			return localize('paradis.fileTransfer.error.disconnected', "接続が切れました");
		case 'notFound':
			return localize('paradis.fileTransfer.error.notFound', "見つかりません");
		case 'noSpace':
			return localize('paradis.fileTransfer.error.noSpace', "空き容量が足りません");
		case 'conflict':
			return localize('paradis.fileTransfer.error.conflictShort', "送り先に同じ名前の項目ができました");
		case 'special':
			return localize('paradis.fileTransfer.error.specialShort', "通常のファイルではありません");
		case 'sameFile':
			return localize('paradis.fileTransfer.error.sameFileShort', "送り元と送り先が同じファイルです");
		case 'replaceFailed':
			// 残った一時ファイルの場所を出す（利用者が自分で戻せるように）
			return detail;
		default:
			return detail;
	}
}

/**
 * 送り先と同じフォルダーに置く一時名。元の名前は含めない（長い名前でも 255 バイトの上限を超えないように）。
 * 隠しファイルにし、実行ごとに違う名前にする。
 */
export function paradisTransferTempName(runId: string): string {
	return `.paratransfer-${runId}`;
}

/** 転送の一時名か（一覧で「書きかけ」として出し、片付けの対象にする）。 */
export function paradisIsTransferTempName(name: string): boolean {
	return /^\.paratransfer-[A-Za-z0-9-]+$/.test(name);
}

/** フォルダーの中で、読めずに飛ばしてよい失敗か（1 ファイルのせいで全体を止めない）。 */
export function paradisIsSkippableInsideFolder(kind: ParadisTransferErrorKind): boolean {
	return kind === 'permission' || kind === 'notFound' || kind === 'special';
}
