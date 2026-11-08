/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストを `paradis-sftp://<別名>/<絶対パス>` として IFileService に見せるプロバイダ（renderer 側。
// チャネルしか使わないので common に置く）。
// 読み書きは shared process のチャネル（node/paradisSftpService.ts）に渡す。
//
// このウィンドウでユーザーが転送の画面から開いたホストだけを通す（`allowHost`）。拡張機能の `workspace.fs` などから
// `paradis-sftp://` を叩いても、ユーザーが開いていないホストへは繋がない。許可はウィンドウを閉じれば消える。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	createFileSystemProviderError,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	IFileDeleteOptions,
	IFileOpenOptions,
	IFileOverwriteOptions,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	isFileOpenForWriteOptions,
	IStat,
	toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import {
	IParadisSftpEntry,
	IParadisSftpFileInfo,
	IParadisSftpOpenResult,
	paradisDescribeSftpFailure,
	paradisSftpFailureReasonOf,
	PARADIS_SFTP_MAX_IO,
	PARADIS_SFTP_SCHEME,
} from './paradisSftp.js';

/** 転送の画面が使う、プロバイダより上の命令（一覧・権限・素の rename）。 */
export interface IParadisSftpClient {
	/** ユーザーが画面で開いたホスト。以後このウィンドウでの読み書きを通す。 */
	allowHost(alias: string): void;
	isAllowed(alias: string): boolean;
	/** 繋いでホームを返す（ユーザーが開いたホストだけ）。 */
	openHost(alias: string): Promise<IParadisSftpOpenResult>;
	list(resource: URI): Promise<{ entries: IParadisSftpEntry[]; truncated: boolean }>;
	statFile(resource: URI): Promise<IParadisSftpFileInfo | undefined>;
	chmod(resource: URI, mode: number, recursive: boolean): Promise<void>;
	/** 送り先がファイルなら置き換える rename。使えないサーバーなら false。 */
	posixRename(from: URI, to: URI): Promise<boolean>;
}

export class ParadisSftpFileSystemProvider extends Disposable implements IFileSystemProviderWithOpenReadWriteCloseCapability, IParadisSftpClient {

	readonly capabilities = FileSystemProviderCapabilities.FileOpenReadWriteClose | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities: Event<void> = Event.None;
	readonly onDidChangeFile = Event.None;

	private readonly allowed = new Set<string>();
	/**
	 * 開いたファイル。ホストは失敗の文言に別名を入れるため。`cancellation` は転送を取り消したときに
	 * そのファイルの読み書きの要求を取り消す（{@link cancelIo}）。
	 */
	private readonly handles = new Map<number, { readonly alias: string; readonly resource: string; readonly cancellation: CancellationTokenSource }>();

	constructor(private readonly channel: IChannel) {
		super();
	}

	// URI の authority は toString() で小文字になる（タブの控え・journal を通ると戻らない）ので、小文字で比べる。
	// OpenSSH も宛先の名前を小文字にしてから ~/.ssh/config と照らすので、小文字のまま繋いでよい
	allowHost(alias: string): void {
		this.allowed.add(alias.trim().toLowerCase());
	}

	revokeHost(alias: string): void {
		this.allowed.delete(alias.trim().toLowerCase());
	}

	isAllowed(alias: string): boolean {
		return this.allowed.has(alias.trim().toLowerCase());
	}

	private check(resource: URI): void {
		if (resource.scheme !== PARADIS_SFTP_SCHEME || !this.isAllowed(resource.authority)) {
			throw createFileSystemProviderError(paradisDescribeSftpFailure('notAllowed', resource.authority), FileSystemProviderErrorCode.NoPermissions);
		}
	}

	/** 接続の失敗は、理由の名前を画面向けの文に直す（種類はそのまま）。 */
	private async call<T>(alias: string, command: string, args: unknown[], token?: CancellationToken): Promise<T> {
		try {
			return await this.channel.call<T>(command, args, token);
		} catch (error) {
			const reason = paradisSftpFailureReasonOf(error);
			if (reason && error instanceof Error) {
				throw createFileSystemProviderError(paradisDescribeSftpFailure(reason, alias), toFileSystemProviderErrorCode(error));
			}
			throw error;
		}
	}

	configure(idleMs: number): Promise<void> {
		return this.channel.call<void>('configure', [{ idleMs }]);
	}

	async openHost(alias: string): Promise<IParadisSftpOpenResult> {
		if (!this.isAllowed(alias)) {
			return { ok: false, reason: 'notAllowed' };
		}
		return this.channel.call<IParadisSftpOpenResult>('open', [alias.trim().toLowerCase()]);
	}

	async open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		this.check(resource);
		const fd = await this.call<number>(resource.authority, 'openFile', [resource, isFileOpenForWriteOptions(opts) ? { create: true, append: !!opts.append } : { create: false }]);
		this.handles.set(fd, { alias: resource.authority, resource: resource.toString(), cancellation: new CancellationTokenSource() });
		return fd;
	}

	/**
	 * `resource` を開いている読み書きの要求を取り消す。転送の取り消しは IFileService の読み書きを止めるだけで、
	 * shared process へ送った要求（1 回に最大 4 MiB、SFTP が答えなければ最大 120 秒）には届かないため、
	 * 転送の口が取り消しのときに呼ぶ。以後の要求もすぐに失敗し、閉じるのは待たずに送る。
	 */
	cancelIo(resource: URI): void {
		const key = resource.toString();
		for (const open of this.handles.values()) {
			if (open.resource === key) {
				open.cancellation.cancel();
			}
		}
	}

	// --- IFileSystemProvider --------------------------------------------------------------------------

	watch(): IDisposable {
		// 変更の通知は無い（転送の画面は自分で読み直す）
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		this.check(resource);
		return this.call<IStat>(resource.authority, 'stat', [resource]);
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		this.check(resource);
		return this.call<[string, FileType][]>(resource.authority, 'readdir', [resource]);
	}

	async mkdir(resource: URI): Promise<void> {
		this.check(resource);
		return this.call<void>(resource.authority, 'mkdir', [resource]);
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		this.check(resource);
		if (opts.useTrash) {
			// 接続先にはゴミ箱が無い（能力に Trash を出していないので来ないはず）
			throw createFileSystemProviderError('no trash', FileSystemProviderErrorCode.Unknown);
		}
		return this.call<void>(resource.authority, 'delete', [resource, { recursive: opts.recursive }]);
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.check(from);
		this.check(to);
		return this.call<void>(from.authority, 'rename', [from, to, { overwrite: opts.overwrite }]);
	}

	async close(fd: number): Promise<void> {
		const open = this.handles.get(fd);
		this.handles.delete(fd);
		const cancelled = !!open?.cancellation.token.isCancellationRequested;
		open?.cancellation.dispose();
		const closing = this.call<void>(open?.alias ?? '', 'close', [fd]);
		if (cancelled) {
			// 取り消した転送の後始末は待たない（SFTP が答えない接続では、閉じる要求も期限まで返らない）
			closing.catch(() => undefined);
			return;
		}
		return closing;
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const open = this.handles.get(fd);
		const buffer = await this.call<VSBuffer>(open?.alias ?? '', 'read', [fd, pos, length], open?.cancellation.token);
		data.set(buffer.buffer.subarray(0, Math.min(buffer.byteLength, length)), offset);
		return Math.min(buffer.byteLength, length);
	}

	async write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		// 受ける側の上限までを送り、書けた長さを返す（IFileService は残りを続けて書く）。読む側が書く側より速いと、
		// 溜まった塊がつながって上限を超えることがある
		const size = Math.min(length, PARADIS_SFTP_MAX_IO);
		const open = this.handles.get(fd);
		return this.call<number>(open?.alias ?? '', 'write', [fd, pos, VSBuffer.wrap(data).slice(offset, offset + size)], open?.cancellation.token);
	}

	// --- 転送の画面の命令 -------------------------------------------------------------------------------

	async list(resource: URI): Promise<{ entries: IParadisSftpEntry[]; truncated: boolean }> {
		this.check(resource);
		return this.call(resource.authority, 'list', [resource]);
	}

	async statFile(resource: URI): Promise<IParadisSftpFileInfo | undefined> {
		this.check(resource);
		return this.call(resource.authority, 'statFile', [resource]);
	}

	async chmod(resource: URI, mode: number, recursive: boolean): Promise<void> {
		this.check(resource);
		return this.call(resource.authority, 'chmod', [resource, mode, recursive]);
	}

	async posixRename(from: URI, to: URI): Promise<boolean> {
		this.check(from);
		this.check(to);
		return this.call(from.authority, 'posixRename', [from, to]);
	}

	override dispose(): void {
		for (const open of this.handles.values()) {
			open.cancellation.dispose(true);
		}
		this.handles.clear();
		super.dispose();
	}
}

/** 理由の名前を、画面に出すエラーにする（`open` が失敗したとき）。 */
export function paradisSftpOpenError(alias: string, result: IParadisSftpOpenResult): Error | undefined {
	return result.ok ? undefined : new Error(paradisDescribeSftpFailure(result.reason, alias));
}
