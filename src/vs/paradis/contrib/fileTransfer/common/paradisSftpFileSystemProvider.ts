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
	/** 開いたファイルのホスト（失敗の文言に別名を入れるため）。 */
	private readonly handleHosts = new Map<number, string>();

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
	private async call<T>(alias: string, command: string, args: unknown[]): Promise<T> {
		try {
			return await this.channel.call<T>(command, args);
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
		this.handleHosts.set(fd, resource.authority);
		return fd;
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
		const alias = this.handleHosts.get(fd) ?? '';
		this.handleHosts.delete(fd);
		return this.call<void>(alias, 'close', [fd]);
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const buffer = await this.call<VSBuffer>(this.handleHosts.get(fd) ?? '', 'read', [fd, pos, length]);
		data.set(buffer.buffer.subarray(0, Math.min(buffer.byteLength, length)), offset);
		return Math.min(buffer.byteLength, length);
	}

	async write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		return this.call<number>(this.handleHosts.get(fd) ?? '', 'write', [fd, pos, VSBuffer.wrap(data).slice(offset, offset + length)]);
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
}

/** 理由の名前を、画面に出すエラーにする（`open` が失敗したとき）。 */
export function paradisSftpOpenError(alias: string, result: IParadisSftpOpenResult): Error | undefined {
	return result.ok ? undefined : new Error(paradisDescribeSftpFailure(result.reason, alias));
}
