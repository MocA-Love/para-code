/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストの読み書き（SFTP）と、それを renderer に渡すチャネル。shared process で動く。
//
// renderer のプロバイダ（electron-browser/paradisSftpFileSystemProvider.ts）は IFileService の open/read/write/close で
// 呼ぶ。IFileService は 256KiB ずつ呼ぶので、その中で 32KiB の SFTP 要求を並べて投げ、往復を待つ回数を減らす。
// 失敗は IFileService が見分けられる FileSystemProviderError（名前に種類が入る）で返す。IPC はエラーの名前と
// メッセージを運ぶ。

import type { SFTPWrapper, Stats } from 'ssh2';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createFileSystemProviderError, FileSystemProviderError, FileSystemProviderErrorCode, FileType, IStat } from '../../../../platform/files/common/files.js';
import { paradisIsValidMode, paradisRecursiveModeFor } from '../common/paradisFileTransfer.js';
import {
	IParadisSftpEntry,
	IParadisSftpFileInfo,
	IParadisSftpOpenResult,
	paradisSftpFailureMessage,
	PARADIS_SFTP_SCHEME,
} from '../common/paradisSftp.js';
import { paradisIsSafeSshHost } from '../../remoteHosts/common/paradisRemoteHosts.js';
import { IParadisSftpConnectorOptions, IParadisSftpSession, ParadisSftpConnectionPool, ParadisSftpFailure } from './paradisSftpConnection.js';

/** 1 回の SFTP 要求の大きさ（OpenSSH が受け付ける大きさ）。 */
const PARADIS_SFTP_CHUNK = 32 * 1024;
/** 1 回の read / write で受け付ける上限。 */
const PARADIS_SFTP_MAX_IO = 4 * 1024 * 1024;
/** 1 フォルダーの上限。 */
const PARADIS_SFTP_MAX_ENTRIES = 20_000;
/** 「中身にも適用」・再帰の削除で辿る上限。 */
const PARADIS_SFTP_MAX_RECURSIVE = 200_000;
/** シンボリックリンクの先を調べるときに同時に投げる数。 */
const PARADIS_SFTP_PARALLEL = 32;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** SFTP の状態番号（ssh2 のエラーの `code`）。 */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/** ssh2 の失敗を IFileService が見分けられる形に直す。ホスト名・パスは入れない。 */
export function paradisToSftpProviderError(error: unknown): Error {
	if (error instanceof FileSystemProviderError) {
		return error;
	}
	if (error instanceof ParadisSftpFailure) {
		return createFileSystemProviderError(error.message, FileSystemProviderErrorCode.Unavailable);
	}
	const code = (error as { code?: unknown } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === SFTP_NO_SUCH_FILE) {
		return createFileSystemProviderError(message, FileSystemProviderErrorCode.FileNotFound);
	}
	if (code === SFTP_PERMISSION_DENIED) {
		return createFileSystemProviderError(message, FileSystemProviderErrorCode.NoPermissions);
	}
	if (/no response from server|not connected|channel (?:open failure|closed)|connection lost|ECONNRESET|EPIPE/i.test(message)) {
		return createFileSystemProviderError(paradisSftpFailureMessage('unreachable'), FileSystemProviderErrorCode.Unavailable);
	}
	return createFileSystemProviderError(message, FileSystemProviderErrorCode.Unknown);
}

function typeOfMode(mode: number): FileType {
	switch (mode & S_IFMT) {
		case S_IFDIR: return FileType.Directory;
		case S_IFREG: return FileType.File;
		case S_IFLNK: return FileType.SymbolicLink;
		default: return FileType.Unknown;
	}
}

function call<T>(run: (callback: (error: Error | undefined | null, value?: T) => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		try {
			run((error, value) => error ? reject(error) : resolve(value as T));
		} catch (error) {
			// 接続が切れた後の呼び出しは同期的に投げる
			reject(error);
		}
	});
}

const lstat = (sftp: SFTPWrapper, path: string) => call<Stats>(callback => sftp.lstat(path, callback));
const stat = (sftp: SFTPWrapper, path: string) => call<Stats>(callback => sftp.stat(path, callback));

async function statOrUndefined(sftp: SFTPWrapper, path: string, follow: boolean): Promise<Stats | undefined> {
	try {
		return await (follow ? stat : lstat)(sftp, path);
	} catch (error) {
		if ((error as { code?: unknown }).code === SFTP_NO_SUCH_FILE) {
			return undefined;
		}
		throw error;
	}
}

interface IRawEntry {
	readonly name: string;
	readonly mode: number;
	readonly size: number;
	readonly mtime: number;
}

async function readRawDirectory(sftp: SFTPWrapper, path: string, limit: number): Promise<{ entries: IRawEntry[]; truncated: boolean }> {
	const list = await call<{ filename: string; attrs: Stats }[]>(callback => sftp.readdir(path, callback));
	const entries = list
		.filter(item => item.filename !== '.' && item.filename !== '..')
		.map(item => ({ name: item.filename, mode: item.attrs.mode ?? 0, size: item.attrs.size ?? 0, mtime: (item.attrs.mtime ?? 0) * 1000 }));
	return entries.length > limit ? { entries: entries.slice(0, limit), truncated: true } : { entries, truncated: false };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface IOpenHandle {
	readonly alias: string;
	readonly generation: number;
	readonly handle: Buffer;
	readonly retained: IDisposable;
	/** 進行中の read / write。close はこれを待つ（IFileService は最後の write を待たずに close を呼ぶことがある）。 */
	readonly pending: Set<Promise<unknown>>;
}

/** 接続していないホストの読み書き。URI は `paradis-sftp://<別名>/<絶対パス>`。 */
export class ParadisSftpService extends Disposable {

	private readonly pool: ParadisSftpConnectionPool;
	private readonly handles = new Map<number, IOpenHandle>();
	private nextHandle = 1;

	constructor(options: IParadisSftpConnectorOptions) {
		super();
		this.pool = this._register(new ParadisSftpConnectionPool(options));
	}

	setIdleMs(ms: number): void {
		this.pool.setIdleMs(ms);
	}

	get connectionCount(): number {
		return this.pool.size;
	}

	private target(resource: UriComponents): { alias: string; path: string } {
		const uri = URI.revive(resource);
		if (uri.scheme !== PARADIS_SFTP_SCHEME || !paradisIsSafeSshHost(uri.authority)) {
			throw createFileSystemProviderError('unsupported resource', FileSystemProviderErrorCode.Unknown);
		}
		return { alias: uri.authority, path: posix.normalize(uri.path || '/') };
	}

	private async run<T>(resource: UriComponents, operation: (session: IParadisSftpSession, path: string, generation: number) => Promise<T>): Promise<T> {
		const { alias, path } = this.target(resource);
		try {
			return await this.pool.use(alias, (session, generation) => operation(session, path, generation));
		} catch (error) {
			throw paradisToSftpProviderError(error);
		}
	}

	/** 画面でホストを開いたとき。繋いでホームを返す（失敗は理由だけ）。 */
	async open(alias: string): Promise<IParadisSftpOpenResult> {
		if (!paradisIsSafeSshHost(alias)) {
			return { ok: false, reason: 'sshConfig' };
		}
		try {
			const home = await this.pool.use(alias.trim(), async session => session.home);
			return { ok: true, home };
		} catch (error) {
			return { ok: false, reason: error instanceof ParadisSftpFailure ? error.reason : 'other' };
		}
	}

	stat(resource: UriComponents): Promise<IStat> {
		return this.run(resource, async ({ sftp }, path) => {
			const linkStats = await lstat(sftp, path);
			let type = typeOfMode(linkStats.mode);
			let target: Stats = linkStats;
			if (type === FileType.SymbolicLink) {
				const followed = await statOrUndefined(sftp, path, true);
				type = FileType.SymbolicLink | (followed ? typeOfMode(followed.mode) : FileType.Unknown);
				target = followed ?? linkStats;
			}
			const mtime = (target.mtime ?? 0) * 1000;
			return { type, size: target.size ?? 0, mtime, ctime: mtime };
		});
	}

	readdir(resource: UriComponents): Promise<[string, FileType][]> {
		return this.run(resource, async ({ sftp }, path) => {
			const { entries } = await readRawDirectory(sftp, path, PARADIS_SFTP_MAX_ENTRIES);
			return mapLimited(entries, PARADIS_SFTP_PARALLEL, async (entry): Promise<[string, FileType]> => {
				const type = typeOfMode(entry.mode);
				if (type !== FileType.SymbolicLink) {
					return [entry.name, type];
				}
				const followed = await statOrUndefined(sftp, posix.join(path, entry.name), true).catch(() => undefined);
				return [entry.name, FileType.SymbolicLink | (followed ? typeOfMode(followed.mode) : FileType.Unknown)];
			});
		});
	}

	/** 転送の画面の一覧（権限つき、1 往復）。 */
	list(resource: UriComponents): Promise<{ entries: IParadisSftpEntry[]; truncated: boolean }> {
		return this.run(resource, async ({ sftp }, path) => {
			const { entries, truncated } = await readRawDirectory(sftp, path, PARADIS_SFTP_MAX_ENTRIES);
			const described = await mapLimited(entries, PARADIS_SFTP_PARALLEL, async (entry): Promise<IParadisSftpEntry> => {
				const type = typeOfMode(entry.mode);
				const kind: IParadisSftpEntry['kind'] = type === FileType.Directory ? 'directory' : type === FileType.File ? 'file' : type === FileType.SymbolicLink ? 'symlink' : 'other';
				let isDirectory = kind === 'directory';
				if (kind === 'symlink') {
					const followed = await statOrUndefined(sftp, posix.join(path, entry.name), true).catch(() => undefined);
					isDirectory = !!followed && typeOfMode(followed.mode) === FileType.Directory;
				}
				return { name: entry.name, mode: entry.mode & 0o7777, kind, isDirectory, size: entry.size, mtime: entry.mtime };
			});
			return { entries: described, truncated };
		});
	}

	/** 置き換えてよいかの判断に使う情報。無ければ undefined。 */
	statFile(resource: UriComponents): Promise<IParadisSftpFileInfo | undefined> {
		return this.run(resource, async ({ sftp, ownUid }, path) => {
			const stats = await statOrUndefined(sftp, path, false);
			if (!stats) {
				return undefined;
			}
			const type = typeOfMode(stats.mode);
			return {
				mode: stats.mode & 0o7777,
				// 自分の uid が分からないときは自分のものとみなす（一時名に書いて置き換える）
				ownedByMe: ownUid === undefined || stats.uid === ownUid,
				isDirectory: type === FileType.Directory,
				isSymbolicLink: type === FileType.SymbolicLink,
			};
		});
	}

	mkdir(resource: UriComponents): Promise<void> {
		return this.run(resource, async ({ sftp }, path) => {
			if (await statOrUndefined(sftp, path, false)) {
				throw createFileSystemProviderError('exists', FileSystemProviderErrorCode.FileExists);
			}
			await call<void>(callback => sftp.mkdir(path, callback));
		});
	}

	delete(resource: UriComponents, options: { readonly recursive: boolean }): Promise<void> {
		return this.run(resource, async ({ sftp }, path) => {
			const stats = await lstat(sftp, path);
			if (typeOfMode(stats.mode) !== FileType.Directory) {
				await call<void>(callback => sftp.unlink(path, callback));
				return;
			}
			if (options.recursive) {
				let budget = PARADIS_SFTP_MAX_RECURSIVE;
				const removeChildren = async (directory: string): Promise<void> => {
					const { entries } = await readRawDirectory(sftp, directory, PARADIS_SFTP_MAX_RECURSIVE);
					for (const entry of entries) {
						if (--budget < 0) {
							throw createFileSystemProviderError('too many entries', FileSystemProviderErrorCode.Unknown);
						}
						const child = posix.join(directory, entry.name);
						if (typeOfMode(entry.mode) === FileType.Directory) {
							await removeChildren(child);
							await call<void>(callback => sftp.rmdir(child, callback));
						} else {
							await call<void>(callback => sftp.unlink(child, callback));
						}
					}
				};
				await removeChildren(path);
			}
			await call<void>(callback => sftp.rmdir(path, callback));
		});
	}

	/**
	 * 名前を変える。上書きは OpenSSH の posix-rename（原子的）で、無いサーバーでは送り先のファイルを消してから
	 * rename する。上書きしないときは送り先の有無を確かめてから rename する（SFTP の rename は上書きしない）。
	 */
	async rename(from: UriComponents, to: UriComponents, options: { readonly overwrite: boolean }): Promise<void> {
		const target = this.sameHostTarget(from, to);
		return this.run(from, async ({ sftp }, fromPath) => {
			const existing = await statOrUndefined(sftp, target.path, false);
			if (existing) {
				if (!options.overwrite) {
					throw createFileSystemProviderError('exists', FileSystemProviderErrorCode.FileExists);
				}
				if (await this.tryPosixRename(sftp, fromPath, target.path)) {
					return;
				}
				if (typeOfMode(existing.mode) === FileType.Directory) {
					throw createFileSystemProviderError('target is a directory', FileSystemProviderErrorCode.FileIsADirectory);
				}
				await call<void>(callback => sftp.unlink(target.path, callback));
			}
			await call<void>(callback => sftp.rename(fromPath, target.path, callback));
		});
	}

	/** 素の rename（送り先がファイルなら置き換える）。posix-rename が無ければ false。 */
	async posixRename(from: UriComponents, to: UriComponents): Promise<boolean> {
		const target = this.sameHostTarget(from, to);
		return this.run(from, ({ sftp }, fromPath) => this.tryPosixRename(sftp, fromPath, target.path));
	}

	/** 名前の変更は同じホストの中だけ。 */
	private sameHostTarget(from: UriComponents, to: UriComponents): { alias: string; path: string } {
		const source = this.target(from);
		const target = this.target(to);
		if (source.alias !== target.alias) {
			throw createFileSystemProviderError('cross-host rename', FileSystemProviderErrorCode.Unknown);
		}
		return target;
	}

	private async tryPosixRename(sftp: SFTPWrapper, from: string, to: string): Promise<boolean> {
		try {
			await call<void>(callback => sftp.ext_openssh_rename(from, to, callback));
			return true;
		} catch (error) {
			// 拡張を持たないサーバーでは呼んだ時点で投げる
			if (error instanceof Error && /not support/i.test(error.message)) {
				return false;
			}
			throw error;
		}
	}

	async chmod(resource: UriComponents, mode: number, recursive: boolean): Promise<void> {
		if (!paradisIsValidMode(mode)) {
			throw createFileSystemProviderError('invalid mode', FileSystemProviderErrorCode.Unknown);
		}
		return this.run(resource, async ({ sftp }, path) => {
			await call<void>(callback => sftp.chmod(path, mode, callback));
			const stats = await lstat(sftp, path);
			if (!recursive || typeOfMode(stats.mode) !== FileType.Directory) {
				return;
			}
			let budget = PARADIS_SFTP_MAX_RECURSIVE;
			const walk = async (directory: string): Promise<void> => {
				const { entries } = await readRawDirectory(sftp, directory, PARADIS_SFTP_MAX_RECURSIVE);
				for (const entry of entries) {
					if (--budget < 0) {
						throw createFileSystemProviderError('too many entries', FileSystemProviderErrorCode.Unknown);
					}
					const type = typeOfMode(entry.mode);
					// リンクは辿らない・変えない（リンク先の権限が変わる）
					if (type !== FileType.Directory && type !== FileType.File) {
						continue;
					}
					const child = posix.join(directory, entry.name);
					await call<void>(callback => sftp.chmod(child, paradisRecursiveModeFor(mode, type === FileType.Directory, entry.mode & 0o7777), callback));
					if (type === FileType.Directory) {
						await walk(child);
					}
				}
			};
			await walk(path);
		});
	}

	// --- 開く・読む・書く・閉じる ------------------------------------------------------------------------

	async openFile(resource: UriComponents, options: { readonly create: boolean; readonly append?: boolean }): Promise<number> {
		const { alias } = this.target(resource);
		return this.run(resource, async ({ sftp }, path, generation) => {
			const flags = options.create ? (options.append ? 'a' : 'w') : 'r';
			const handle = await call<Buffer>(callback => sftp.open(path, flags, callback));
			const id = this.nextHandle++;
			this.handles.set(id, { alias, generation, handle, retained: this.pool.retainHandle(alias), pending: new Set() });
			return id;
		});
	}

	private handleFor(id: number): IOpenHandle {
		const open = this.handles.get(id);
		if (!open) {
			throw createFileSystemProviderError('unknown handle', FileSystemProviderErrorCode.Unknown);
		}
		if (!this.pool.isCurrent(open.alias, open.generation)) {
			throw createFileSystemProviderError(paradisSftpFailureMessage('unreachable'), FileSystemProviderErrorCode.Unavailable);
		}
		return open;
	}

	private track<T>(open: IOpenHandle, operation: Promise<T>): Promise<T> {
		open.pending.add(operation);
		const done = () => open.pending.delete(operation);
		operation.then(done, done);
		return operation;
	}

	async read(id: number, position: number, length: number): Promise<VSBuffer> {
		const open = this.handleFor(id);
		return this.track(open, this.doRead(open, position, length));
	}

	private async doRead(open: IOpenHandle, position: number, length: number): Promise<VSBuffer> {
		const size = Math.max(0, Math.min(length, PARADIS_SFTP_MAX_IO));
		try {
			return await this.pool.use(open.alias, async ({ sftp }) => {
				const chunks: Promise<Buffer>[] = [];
				for (let offset = 0; offset < size; offset += PARADIS_SFTP_CHUNK) {
					const chunkLength = Math.min(PARADIS_SFTP_CHUNK, size - offset);
					const buffer = Buffer.allocUnsafe(chunkLength);
					chunks.push(new Promise<Buffer>((resolve, reject) => {
						try {
							sftp.read(open.handle, buffer, 0, chunkLength, position + offset, (error, bytesRead) => error ? reject(error) : resolve(buffer.subarray(0, bytesRead)));
						} catch (error) {
							reject(error);
						}
					}));
				}
				const results = await Promise.all(chunks);
				// 途中で短くなったら（ファイルの終わり）、そこまでを返す。続きは呼ぶ側がもう一度読む
				const parts: Buffer[] = [];
				for (let index = 0; index < results.length; index++) {
					parts.push(results[index]);
					if (results[index].length < Math.min(PARADIS_SFTP_CHUNK, size - index * PARADIS_SFTP_CHUNK)) {
						break;
					}
				}
				return VSBuffer.wrap(Buffer.concat(parts));
			});
		} catch (error) {
			throw paradisToSftpProviderError(error);
		}
	}

	async write(id: number, position: number, data: VSBuffer): Promise<number> {
		const open = this.handleFor(id);
		return this.track(open, this.doWrite(open, position, data));
	}

	private async doWrite(open: IOpenHandle, position: number, data: VSBuffer): Promise<number> {
		const buffer = Buffer.from(data.buffer.buffer, data.buffer.byteOffset, data.byteLength);
		if (buffer.length > PARADIS_SFTP_MAX_IO) {
			throw createFileSystemProviderError('write too large', FileSystemProviderErrorCode.Unknown);
		}
		try {
			return await this.pool.use(open.alias, async ({ sftp }) => {
				const writes: Promise<void>[] = [];
				for (let offset = 0; offset < buffer.length; offset += PARADIS_SFTP_CHUNK) {
					const chunkLength = Math.min(PARADIS_SFTP_CHUNK, buffer.length - offset);
					writes.push(call<void>(callback => sftp.write(open.handle, buffer, offset, chunkLength, position + offset, callback)));
				}
				await Promise.all(writes);
				return buffer.length;
			});
		} catch (error) {
			throw paradisToSftpProviderError(error);
		}
	}

	async close(id: number): Promise<void> {
		const open = this.handles.get(id);
		if (!open) {
			return;
		}
		this.handles.delete(id);
		try {
			// 書きかけの write を待ってから閉じる（閉じた後に残りが届くと、送り先が欠ける）
			await Promise.allSettled([...open.pending]);
			if (this.pool.isCurrent(open.alias, open.generation)) {
				await this.pool.use(open.alias, ({ sftp }) => call<void>(callback => sftp.close(open.handle, callback)));
			}
		} catch (error) {
			throw paradisToSftpProviderError(error);
		} finally {
			open.retained.dispose();
		}
	}

	override dispose(): void {
		for (const open of this.handles.values()) {
			open.retained.dispose();
		}
		this.handles.clear();
		super.dispose();
	}
}

/** IPC のサーバー側。 */
export class ParadisSftpChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisSftpService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown, _token?: CancellationToken): Promise<T> {
		const args = (Array.isArray(arg) ? arg : []) as unknown[];
		switch (command) {
			case 'configure': {
				const ms = (args[0] as { idleMs?: unknown } | undefined)?.idleMs;
				if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
					this.service.setIdleMs(ms);
				}
				return Promise.resolve(undefined as T);
			}
			case 'open': return this.service.open(String(args[0] ?? '')) as Promise<T>;
			case 'stat': return this.service.stat(args[0] as UriComponents) as Promise<T>;
			case 'readdir': return this.service.readdir(args[0] as UriComponents) as Promise<T>;
			case 'list': return this.service.list(args[0] as UriComponents) as Promise<T>;
			case 'statFile': return this.service.statFile(args[0] as UriComponents) as Promise<T>;
			case 'mkdir': return this.service.mkdir(args[0] as UriComponents) as Promise<T>;
			case 'delete': return this.service.delete(args[0] as UriComponents, { recursive: !!(args[1] as { recursive?: boolean } | undefined)?.recursive }) as Promise<T>;
			case 'rename': return this.service.rename(args[0] as UriComponents, args[1] as UriComponents, { overwrite: !!(args[2] as { overwrite?: boolean } | undefined)?.overwrite }) as Promise<T>;
			case 'posixRename': return this.service.posixRename(args[0] as UriComponents, args[1] as UriComponents) as Promise<T>;
			case 'chmod': return this.service.chmod(args[0] as UriComponents, Number(args[1]), !!args[2]) as Promise<T>;
			case 'openFile': return this.service.openFile(args[0] as UriComponents, { create: !!(args[1] as { create?: boolean } | undefined)?.create, append: !!(args[1] as { append?: boolean } | undefined)?.append }) as Promise<T>;
			case 'read': return this.service.read(Number(args[0]), Number(args[1]), Number(args[2])) as Promise<T>;
			case 'write': return this.service.write(Number(args[0]), Number(args[1]), args[2] as VSBuffer) as Promise<T>;
			case 'close': return this.service.close(Number(args[0])) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}
