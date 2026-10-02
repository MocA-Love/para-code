/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の待ち行列が使う読み書きを、IFileService で実装する。
//
// 1 ファイルのコピーは「送り先と同じフォルダーの一時名（`.paratransfer-<実行の印>`）に書いてから、
// プロバイダーの rename 1 回で置き換える」。`writeFile` にストリームを渡すと開いた時点で送り先を切り詰めるので、本名へ
// 直接書くと、失敗・切断・取り消しで元の内容が失われ、書きかけが本名のまま残る。一時名なら、片付けは
// 自分の一時ファイルを消すだけで済み、送り先がリンクでもリンクを辿って木の外へ書かない（リンク自体を置き換える）。
//
// 読む側と書く側の間には上限つきの流れを挟み、書く側が詰まったら読む側を止める（SSH への書き込みは
// 手元の読み込みよりずっと遅く、止めないと大きなファイルがまるごとメモリに溜まる）。進み具合は
// 書く側が受け取った塊を、次の塊を受け取ったとき（＝前の塊を書き終えたとき）に数える。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { listenStream, newWriteableStream, ReadableStream } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, FileSystemProviderCapabilities, IFileService, IFileStatWithPartialMetadata, toFileOperationResult } from '../../../../platform/files/common/files.js';
import {
	IParadisTransferChild,
	IParadisTransferCopyOptions,
	IParadisTransferFileSystem,
	IParadisTransferStat,
	paradisClassifyTransferError,
	ParadisTransferConflictError,
	ParadisTransferReplaceError,
	ParadisTransferSameFileError,
	paradisTransferTempName,
} from '../common/paradisFileTransferQueueTypes.js';

/** 読み取りと書き込みの間に溜める塊の数。超えたら読む側を止める。 */
const PARADIS_COPY_HIGH_WATER_MARK = 16;

/** 一覧を 1 往復で読める相手（権限のチャネル）があれば使う。無ければ undefined を返す。 */
export type ParadisTransferDirectoryLister = (resource: URI) => Promise<readonly IParadisTransferChild[] | undefined>;

function isNotFound(error: unknown): boolean {
	return error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND;
}

function toStat(stat: Pick<IFileStatWithPartialMetadata, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'size' | 'mtime'>): IParadisTransferStat {
	return { isDirectory: stat.isDirectory, size: stat.size ?? 0, mtime: stat.mtime, special: !stat.isFile && !stat.isDirectory, isSymbolicLink: stat.isSymbolicLink };
}

/**
 * 書く側（IFileService）が塊を受け取るたびに、その 1 つ前の塊を「書き終えた」として数える流れ。
 * IFileService は塊ごとに流れを止めて書き、書き終えてから再開するので、次の塊を受け取ったときには
 * 前の塊は書き終わっている。最後の塊は `flush` で数える。
 */
class ParadisWrittenBytesStream implements ReadableStream<VSBuffer> {

	private pendingBytes = 0;
	private readonly wrapped = new Map<Function, (data: VSBuffer) => void>();

	constructor(private readonly inner: ReadableStream<VSBuffer>, private readonly onBytes: (bytes: number) => void) { }

	on(event: 'data', callback: (data: VSBuffer) => void): void;
	on(event: 'error', callback: (err: Error) => void): void;
	on(event: 'end', callback: () => void): void;
	on(event: 'data' | 'error' | 'end', callback: ((data: VSBuffer) => void) | ((err: Error) => void) | (() => void)): void {
		if (event === 'data') {
			const listener = callback as (data: VSBuffer) => void;
			const wrapped = (data: VSBuffer) => {
				this.flush();
				this.pendingBytes = data.byteLength;
				listener(data);
			};
			this.wrapped.set(listener, wrapped);
			this.inner.on('data', wrapped);
		} else if (event === 'error') {
			this.inner.on('error', callback as (err: Error) => void);
		} else {
			this.inner.on('end', callback as () => void);
		}
	}

	flush(): void {
		if (this.pendingBytes) {
			this.onBytes(this.pendingBytes);
			this.pendingBytes = 0;
		}
	}

	pause(): void {
		this.inner.pause();
	}

	resume(): void {
		this.inner.resume();
	}

	destroy(): void {
		this.inner.destroy();
	}

	removeListener(event: string, callback: Function): void {
		this.inner.removeListener(event, this.wrapped.get(callback) ?? callback);
		this.wrapped.delete(callback);
	}
}

/** ファイルの権限・所有者・リンク数と、同じファイルかを見分ける印（置き換えてよいかの判断に使う）。 */
export interface IParadisReplaceTargetInfo {
	readonly mode: number;
	/** 所有者がこのプロセスと同じか。 */
	readonly ownedByMe: boolean;
	/** ハードリンクの数。2 以上なら置き換えると他の名前と切り離される。 */
	readonly linkCount: number;
	/** 同じファイルかを見分ける印（dev / ino / size / mtime）。読めなければ undefined。 */
	readonly identity?: string;
}

/**
 * ファイルの情報を読んだ結果。
 * - `unsupported`: 読む手段が無いと**確かに**分かった（権限のチャネルが無い・版 1 の古い REH）
 * - `missing`: ファイルが無い
 * - `info`: 読めた
 * 接続の詰まり・時間切れ・切断など一時的な失敗は、結果にせず投げる（項目の失敗として再試行させる）。
 */
export type ParadisFileInfoResult =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'info'; readonly info: IParadisReplaceTargetInfo };

/** 権限を読む・合わせる口（権限のチャネル）。無い環境では渡さない（`unsupported` 扱い）。 */
export interface IParadisTransferMetadata {
	fileInfo(resource: URI): Promise<ParadisFileInfoResult>;
	chmod(resource: URI, mode: number): Promise<void>;
	/**
	 * 相手のマシンの素の `fs.rename` で置き換える（provider の rename のように送り先を消す処理を挟まない。
	 * 送り先がフォルダーなら EISDIR で失敗する）。使えない古い相手なら false を返し、呼ぶ側は provider の rename を使う。
	 */
	rename?(from: URI, to: URI): Promise<boolean>;
}

const UNSUPPORTED: ParadisFileInfoResult = { kind: 'unsupported' };

/** 同じファイルか（dev / ino / size / mtime がすべて同じ）。印が無ければ同じとはみなさない。 */
export function paradisIsSameFile(a: IParadisReplaceTargetInfo, b: IParadisReplaceTargetInfo): boolean {
	return !!a.identity && a.identity === b.identity;
}

/** 書いている途中の一時ファイルの控え（閉じたり切れたりして残ったものを、後で片付けるため）。 */
export interface IParadisTransferJournal {
	add(temp: URI): void;
	remove(temp: URI): void;
}

export interface IParadisTransferFileSystemOptions {
	readonly lister?: ParadisTransferDirectoryLister;
	readonly metadata?: IParadisTransferMetadata;
	readonly journal?: IParadisTransferJournal;
}

export class ParadisFileServiceTransferFileSystem implements IParadisTransferFileSystem {

	constructor(
		private readonly fileService: IFileService,
		private readonly options: IParadisTransferFileSystemOptions = {},
	) { }

	async stat(resource: URI): Promise<IParadisTransferStat | undefined> {
		try {
			return toStat(await this.fileService.stat(resource));
		} catch (error) {
			// stat はプロバイダーの EntryNotFound をそのまま投げることがある（FileOperationError に包まれない）
			if (isNotFound(error)) {
				return undefined;
			}
			throw error;
		}
	}

	async readDirectory(resource: URI): Promise<readonly IParadisTransferChild[]> {
		const listed = await this.options.lister?.(resource).catch(error => {
			if (isNotFound(error)) {
				return [];
			}
			throw error;
		});
		if (listed) {
			return listed;
		}
		try {
			const stat = await this.fileService.resolve(resource, { resolveMetadata: true });
			return (stat.children ?? []).map(child => ({
				name: child.name,
				resource: child.resource,
				...toStat(child),
				directoryLink: child.isSymbolicLink && child.isDirectory,
			}));
		} catch (error) {
			if (isNotFound(error)) {
				return [];
			}
			throw error;
		}
	}

	async createDirectory(resource: URI): Promise<void> {
		const existing = await this.stat(resource);
		if (existing?.isDirectory) {
			return;
		}
		if (existing) {
			throw new ParadisTransferConflictError(resource);
		}
		await this.fileService.createFolder(resource);
	}

	async copyFile(source: URI, target: URI, options: IParadisTransferCopyOptions): Promise<void> {
		if (options.token.isCancellationRequested) {
			throw new CancellationError();
		}
		const existing = await this.stat(target);
		// 送り先がフォルダーかリンクなら、ここでは置き換えない（取り除く確認を経てから呼ばれる）
		if (existing && (existing.isDirectory || existing.isSymbolicLink || !options.overwrite)) {
			throw new ParadisTransferConflictError(target);
		}
		const plan = await this.planWrite(source, target, !!existing);
		if (plan.inPlace) {
			// 送り先を直接書き換える（途中で失敗すると元に戻らない）ことを行に出させる
			options.onWriteInPlace?.();
			await this.writeStream(source, target, options);
			return;
		}
		const temp = joinPath(dirname(target), paradisTransferTempName(options.runId));
		if (!await this.writeTemp(source, temp, options)) {
			// 一時名を作れない（フォルダーには書けないがファイルには書ける）ときは、その場で書く
			options.onWriteInPlace?.();
			await this.writeStream(source, target, options);
			return;
		}
		await this.applyMode(temp, plan.mode);
		await this.replace(temp, target, !!existing, options);
	}

	/**
	 * 一時名に書いて置き換えてよいか。置き換えると送り先の権限・所有者・ACL・ハードリンクが新しいファイルのものに
	 * 替わるので、それを保てないと**確かに分かったときだけ**その場で書く:
	 * - 送り先の所有者が自分と違う、またはリンク数が 2 以上だと実際に読めた
	 * - 送り先の権限を読む手段が無いと確かに分かった（権限のチャネルが無い・版 1 の古い REH）。0600 の `.env` が
	 *   0644 になるのを避ける
	 * 一時的な失敗（詰まり・時間切れ・切断）は投げる。その場で書くと、失敗したときに元のファイルを失うため。
	 * 送り元と送り先が同じファイル（同じマシンへの SSH など）なら、送り元を壊さないよう拒否する。
	 */
	private async planWrite(source: URI, target: URI, exists: boolean): Promise<{ readonly inPlace: boolean; readonly mode?: number }> {
		const targetInfo = exists ? await this.fileInfo(target) : undefined;
		const sourceInfo = await this.fileInfo(source);
		if (!targetInfo || targetInfo.kind === 'missing') {
			return { inPlace: false, mode: sourceInfo.kind === 'info' ? sourceInfo.info.mode : undefined };
		}
		if (targetInfo.kind === 'unsupported') {
			return { inPlace: true };
		}
		if (sourceInfo.kind === 'info' && paradisIsSameFile(sourceInfo.info, targetInfo.info)) {
			throw new ParadisTransferSameFileError();
		}
		if (!targetInfo.info.ownedByMe || targetInfo.info.linkCount >= 2) {
			return { inPlace: true };
		}
		return { inPlace: false, mode: targetInfo.info.mode };
	}

	private fileInfo(resource: URI): Promise<ParadisFileInfoResult> {
		return this.options.metadata ? this.options.metadata.fileInfo(resource) : Promise.resolve(UNSUPPORTED);
	}

	/** 一時名へ書く。一時名を作る権限が無ければ false（呼ぶ側がその場で書く）。それ以外の失敗は一時ファイルを消して投げる。 */
	private async writeTemp(source: URI, temp: URI, options: IParadisTransferCopyOptions): Promise<boolean> {
		this.options.journal?.add(temp);
		try {
			await this.writeStream(source, temp, options);
			if (options.token.isCancellationRequested) {
				throw new CancellationError();
			}
			return true;
		} catch (error) {
			await this.discardTemp(temp);
			if (!options.token.isCancellationRequested && paradisClassifyTransferError(error) === 'permission' && !await this.stat(temp)) {
				return false;
			}
			throw error;
		}
	}

	private async applyMode(temp: URI, mode: number | undefined): Promise<void> {
		if (mode === undefined || !this.options.metadata) {
			return;
		}
		try {
			await this.options.metadata.chmod(temp, mode);
		} catch (error) {
			// 送り先と同じ権限にできないまま置き換えると権限が緩むので、置き換えない
			await this.discardTemp(temp);
			throw error;
		}
	}

	/**
	 * 書き終えた一時ファイルで送り先を置き換える。IFileService.move は「存在確認 → 送り先を消す → rename」を
	 * 別々の往復で行い原子的でないので、プロバイダーの rename を 1 回だけ呼ぶ（disk のプロバイダーは fs.rename、
	 * 接続先でも POSIX の rename で、ファイル同士なら送り先を消さずに置き換える）。
	 * rename に入った後の失敗では一時ファイルを消さない（元が消えていても、書き終えた方は残る）。
	 */
	private async replace(temp: URI, target: URI, overwrite: boolean, options: IParadisTransferCopyOptions): Promise<void> {
		if (options.token.isCancellationRequested) {
			await this.discardTemp(temp);
			throw new CancellationError();
		}
		// rename の上書きは、送り先がファイルでなければ中身ごと消すので、直前にもう一度確かめる
		const existing = await this.stat(target);
		if (existing && (existing.isDirectory || existing.isSymbolicLink || !overwrite)) {
			await this.discardTemp(temp);
			throw new ParadisTransferConflictError(target);
		}
		const provider = this.fileService.getProvider(target.scheme);
		if (!provider) {
			await this.discardTemp(temp);
			throw new Error(`no file system provider for ${target.scheme}`);
		}
		try {
			// 上書きは相手のマシンの素の rename で（provider は送り先がファイルでないと消してから rename する）。
			// 上書きしない置き換えは、送り先の有無を確かめる provider の rename を使う
			const renamed = overwrite && await this.options.metadata?.rename?.(temp, target);
			if (!renamed) {
				await provider.rename(temp, target, { overwrite });
			}
		} catch (error) {
			if (!overwrite && paradisClassifyTransferError(error) === 'conflict') {
				// 上書きしない置き換えは、送り先に触れる前に失敗している
				await this.discardTemp(temp);
				throw new ParadisTransferConflictError(target);
			}
			// 書き終えたファイルは残し、自動の片付けからも外す（利用者が場所を見て戻せるように）
			this.options.journal?.remove(temp);
			throw new ParadisTransferReplaceError(temp, error);
		}
		this.options.journal?.remove(temp);
	}

	private async discardTemp(temp: URI): Promise<void> {
		await this.fileService.del(temp, { useTrash: false }).catch(() => undefined);
		if (!await this.stat(temp).catch(() => undefined)) {
			this.options.journal?.remove(temp);
		}
	}

	/** 送り元を数えながら `destination` へ流す。書く側が詰まったら読む側を止める。 */
	private async writeStream(source: URI, destination: URI, options: IParadisTransferCopyOptions): Promise<void> {
		const { token } = options;
		const content = await this.fileService.readFileStream(source, undefined, token);
		const sourceStream = content.value;
		const forward = newWriteableStream<VSBuffer>(chunks => VSBuffer.concat(chunks), { highWaterMark: PARADIS_COPY_HIGH_WATER_MARK });
		listenStream(sourceStream, {
			onData: chunk => {
				const pending = forward.write(chunk);
				if (pending) {
					sourceStream.pause();
					pending.then(() => sourceStream.resume());
				}
			},
			onError: error => forward.error(error),
			onEnd: () => forward.end(),
		});
		const counted = new ParadisWrittenBytesStream(forward, options.onBytes);
		const cancelListener = token.onCancellationRequested(() => {
			sourceStream.destroy();
			forward.error(new CancellationError());
			forward.end();
		});
		try {
			await this.fileService.writeFile(destination, counted);
		} finally {
			cancelListener.dispose();
		}
		counted.flush();
	}

	async removeForReplace(resource: URI): Promise<void> {
		// 手元はゴミ箱に入れて戻せるようにする。接続先にはゴミ箱が無い（呼ぶ側が専用の確認を経ている）
		const useTrash = resource.scheme === Schemas.file && this.fileService.hasCapability(resource, FileSystemProviderCapabilities.Trash);
		await this.fileService.del(resource, { recursive: true, useTrash });
	}
}
