/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（SSH・WSL・コンテナ）のペインのエージェントに代わって、接続先のファイルを読み書きする renderer 側。
// shared process の ParadisAgentBrowserService が、呼び出し元ペインを所有するウィンドウの
// {@link PARADIS_AGENT_PREVIEW_CHANNEL} 経由で呼ぶ（取り決めは common/paradisRemoteFileBridge.ts）。
//
// 書いてよいのは、ペインが属するスペースのフォルダ（同じ接続先のもの）と、接続先のホームの
// `.para-code/browser-files` の下だけ。共有の一時フォルダ（/tmp）には書かない（他の利用者がシンボリックリンクを
// 先に置ける）。読む側は加えて接続先の一時フォルダを許す。`.git`・`.hg`・`.svn` の中は読み書きとも断る。
//
// シンボリックリンクで外へ・`.git` の中へ出ていないかは、パスそのものに加えて、書く前に親フォルダ（ファイルが
// 在ればファイル自身）の realpath で、書いた後にファイル自身の realpath で確かめる。途中のフォルダは作らない
// （親フォルダが無ければ断る）。作るのは受け渡し用フォルダだけ。既にあるものはふつうのファイルのときだけ扱う。
// 失敗の詳細は log にだけ残し、IPC では理由の種類だけを返す（パスや例外の文を shared process へ渡さない）。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	ParadisRemoteFileCheckResult,
	ParadisRemoteFileFailure,
	ParadisRemoteFileReadResult,
	ParadisRemoteFileWriteResult,
	PARADIS_REMOTE_FILE_COPY_TTL_MS,
	PARADIS_REMOTE_FILE_MAX_BYTES,
	PARADIS_REMOTE_FILE_USER_FOLDER,
	paradisNormalizeRemoteFilePath,
	paradisPathHasVersionControlSegment,
} from '../common/paradisRemoteFileBridge.js';

/** ファイル名に使えない文字（区切り・制御文字）。 */
const UNSAFE_FILE_NAME = /[\\/\u0000-\u001f\u007f]/;

type Failure = { readonly ok: false; readonly reason: ParadisRemoteFileFailure };

export interface IParadisRemoteFileBridgeHost {
	/**
	 * ペインが属するスペースのフォルダ（スペースを持たないペインはウィンドウのワークスペースのフォルダ）。
	 * ペインがまだ台帳に無ければ undefined。
	 */
	paneFolders(token: string): readonly URI[] | undefined;
	/** 接続先のホームと一時フォルダ（接続先の環境が取れなければ undefined）。 */
	remoteFolders(remoteAuthority: string): Promise<{ readonly userHome: URI; readonly tmpDir: URI } | undefined>;
}

interface IAllowedFolders {
	/** パスの比較用。 */
	readonly literal: readonly URI[];
	/** realpath の比較用（シンボリックリンクを解いたもの）。 */
	readonly real: readonly URI[];
	/** 接続先のホームの受け渡し用フォルダ（環境が取れなければ undefined）。 */
	readonly userFolder: URI | undefined;
}

interface IWriteTarget {
	readonly ok: true;
	readonly resource: URI;
	readonly folders: IAllowedFolders;
}

export class ParadisRemoteFileBridge {

	constructor(
		private readonly fileService: IFileService,
		private readonly host: IParadisRemoteFileBridgeHost,
		private readonly logService: ILogService,
		private readonly maxBytes: number = PARADIS_REMOTE_FILE_MAX_BYTES,
		private readonly now: () => number = Date.now,
	) { }

	async checkWrite(token: string, remoteAuthority: string, path: string): Promise<ParadisRemoteFileCheckResult> {
		const target = await this.resolveWriteTarget(token, remoteAuthority, this.resource(remoteAuthority, path));
		return target.ok ? { ok: true } : target;
	}

	async write(token: string, remoteAuthority: string, path: string, data: VSBuffer): Promise<ParadisRemoteFileWriteResult> {
		if (data.byteLength > this.maxBytes) {
			return { ok: false, reason: 'tooLarge' };
		}
		const target = await this.resolveWriteTarget(token, remoteAuthority, this.resource(remoteAuthority, path));
		return target.ok ? this.writeAndVerify(target, data) : target;
	}

	/**
	 * 接続先のホームの受け渡し用フォルダへ、重ならない名前（`<乱数>-<fileName>`）で書く。書いたパスを返す。
	 * 書く前に、そこの古い写しを消す。
	 */
	async writeTemporary(token: string, remoteAuthority: string, fileName: string, data: VSBuffer): Promise<ParadisRemoteFileWriteResult> {
		if (data.byteLength > this.maxBytes) {
			return { ok: false, reason: 'tooLarge' };
		}
		if (fileName.length === 0 || fileName.length > 200 || fileName === '.' || fileName === '..' || UNSAFE_FILE_NAME.test(fileName)) {
			return { ok: false, reason: 'invalidPath' };
		}
		const folders = await this.allowedFolders(token, remoteAuthority, false, true);
		if (!folders.ok) {
			return folders;
		}
		const userFolder = folders.value.userFolder;
		if (userFolder === undefined) {
			return { ok: false, reason: 'noTemporaryFolder' };
		}
		await this.sweepOldCopies(userFolder);
		const target = await this.resolveWriteTarget(token, remoteAuthority, joinPath(userFolder, `${generateUuid().slice(0, 8)}-${fileName}`));
		return target.ok ? this.writeAndVerify(target, data) : target;
	}

	async read(token: string, remoteAuthority: string, path: string, maxBytes: number): Promise<ParadisRemoteFileReadResult<VSBuffer>> {
		const limit = Math.min(this.maxBytes, Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : this.maxBytes);
		const resource = this.resource(remoteAuthority, path);
		if (resource === undefined) {
			return { ok: false, reason: 'invalidPath' };
		}
		if (paradisPathHasVersionControlSegment(resource.path)) {
			return { ok: false, reason: 'versionControlFolder' };
		}
		const folders = await this.allowedFolders(token, remoteAuthority, true, false);
		if (!folders.ok) {
			return folders;
		}
		if (!folders.value.literal.some(folder => isEqualOrParent(resource, folder))) {
			return { ok: false, reason: 'outsideAllowedFolders' };
		}
		try {
			const stat = await this.fileService.stat(resource);
			if (stat.isDirectory) {
				return { ok: false, reason: 'isDirectory' };
			}
			if (!stat.isFile) {
				return { ok: false, reason: 'notAFile' };
			}
			if (stat.size > limit) {
				return { ok: false, reason: 'tooLarge' };
			}
			const real = await this.fileService.realpath(resource);
			const placement = this.placement(real, folders.value);
			if (placement !== undefined || real === undefined) {
				return { ok: false, reason: placement ?? 'outsideAllowedFolders' };
			}
			const content = await this.fileService.readFile(real, { limits: { size: limit } });
			return { ok: true, data: content.value, name: basename(resource) };
		} catch (error) {
			if (error instanceof FileOperationError) {
				if (error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
					return { ok: false, reason: 'notFound' };
				}
				if (error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
					return { ok: false, reason: 'tooLarge' };
				}
				if (error.fileOperationResult === FileOperationResult.FILE_IS_DIRECTORY) {
					return { ok: false, reason: 'isDirectory' };
				}
			}
			return this.failed('ioFailed', resource, error);
		}
	}

	/**
	 * 書いた後にファイル自身の realpath で場所を確かめ直す。外れていたら失敗を返し、ログを残す。何も消さない
	 * （確かめた後でフォルダがリンクに差し替えられると、書いた先は外の既存のファイルでありうるため）。
	 */
	private async writeAndVerify(target: IWriteTarget, data: VSBuffer): Promise<ParadisRemoteFileWriteResult> {
		const { resource, folders } = target;
		try {
			await this.fileService.writeFile(resource, data);
		} catch (error) {
			return this.failed('ioFailed', resource, error);
		}
		const real = await this.fileService.realpath(resource).catch(() => undefined);
		const placement = this.placement(real, folders);
		if (placement !== undefined) {
			this.logService.warn(`[ParadisRemoteFileBridge] ${resource.toString()} resolved to ${real?.toString() ?? 'an unknown place'} after writing (${placement}); nothing was removed`);
			return { ok: false, reason: placement };
		}
		// 受け渡し用フォルダの中に書いたときだけ、そのフォルダを返す（shared process が本人だけのものにする）
		const userFolder = folders.userFolder !== undefined && isEqualOrParent(resource, folders.userFolder) ? folders.userFolder.path : undefined;
		return userFolder !== undefined ? { ok: true, path: resource.path, userFolder } : { ok: true, path: resource.path };
	}

	/**
	 * 書く先を確かめる。パスそのものが許された場所の下にあり、`.git` などの中でないこと。親フォルダは実在する
	 * フォルダであること（途中のフォルダは作らない）。親フォルダ（ファイルが在ればファイル自身）の realpath も
	 * 許された場所の下で、`.git` などの中でないこと。在るものはふつうのファイルに限る。
	 */
	private async resolveWriteTarget(token: string, remoteAuthority: string, resource: URI | undefined): Promise<IWriteTarget | Failure> {
		if (resource === undefined) {
			return { ok: false, reason: 'invalidPath' };
		}
		if (paradisPathHasVersionControlSegment(resource.path)) {
			return { ok: false, reason: 'versionControlFolder' };
		}
		const allowed = await this.allowedFolders(token, remoteAuthority, false, false, resource);
		if (!allowed.ok) {
			return allowed;
		}
		const folders = allowed.value;
		if (!folders.literal.some(folder => isEqualOrParent(resource, folder))) {
			return { ok: false, reason: 'outsideAllowedFolders' };
		}
		try {
			const stat = await this.fileService.stat(resource).catch(() => undefined);
			let probe = resource;
			if (stat !== undefined) {
				if (stat.isDirectory) {
					return { ok: false, reason: 'isDirectory' };
				}
				if (!stat.isFile) {
					return { ok: false, reason: 'notAFile' };
				}
			} else {
				probe = dirname(resource);
				const parent = await this.fileService.stat(probe).catch(() => undefined);
				if (parent === undefined || !parent.isDirectory) {
					// 途中のフォルダは作らない。エージェントに、在るフォルダを選ばせる
					return { ok: false, reason: 'parentMissing' };
				}
			}
			const placement = this.placement(await this.fileService.realpath(probe), folders);
			if (placement !== undefined) {
				return { ok: false, reason: placement };
			}
			return { ok: true, resource, folders };
		} catch (error) {
			return this.failed('ioFailed', resource, error);
		}
	}

	/** realpath が許された場所の下にあり、`.git` などの中でないか。問題があればその理由。 */
	private placement(real: URI | undefined, folders: IAllowedFolders): ParadisRemoteFileFailure | undefined {
		if (real === undefined || !folders.real.some(folder => isEqualOrParent(real, folder))) {
			return 'outsideAllowedFolders';
		}
		return paradisPathHasVersionControlSegment(real.path) ? 'versionControlFolder' : undefined;
	}

	private resource(remoteAuthority: string, path: string): URI | undefined {
		const normalized = paradisNormalizeRemoteFilePath(path);
		return normalized === undefined ? undefined : URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: normalized });
	}

	/**
	 * 許された場所。`forRead` のときだけ接続先の一時フォルダも含める。受け渡し用フォルダを作るのは、
	 * `createUserFolder` のときと、書き込み先 `target` がその中のときだけ。
	 */
	private async allowedFolders(token: string, remoteAuthority: string, forRead: boolean, createUserFolder: boolean, target?: URI): Promise<{ readonly ok: true; readonly value: IAllowedFolders } | Failure> {
		const paneFolders = this.host.paneFolders(token);
		if (paneFolders === undefined) {
			return { ok: false, reason: 'paneUnresolved' };
		}
		const literal = paneFolders.filter(folder => folder.scheme === Schemas.vscodeRemote && folder.authority === remoteAuthority);
		const remote = await this.host.remoteFolders(remoteAuthority).catch(() => undefined);
		const sameRemote = (folder: URI | undefined) => folder !== undefined && folder.scheme === Schemas.vscodeRemote && folder.authority === remoteAuthority;
		const real: URI[] = [];
		let userFolder: URI | undefined;
		let candidate: URI | undefined;
		if (remote !== undefined && sameRemote(remote.userHome)) {
			candidate = joinPath(remote.userHome, PARADIS_REMOTE_FILE_USER_FOLDER);
			if (createUserFolder || (target !== undefined && isEqualOrParent(target, candidate))) {
				await this.fileService.createFolder(candidate).catch(() => undefined);
			}
			// ホームの下に在ることを、ホームの realpath と合わせて確かめる
			const realHome = await this.fileService.realpath(remote.userHome).catch(() => undefined);
			const realUserFolder = await this.fileService.realpath(candidate).catch(() => undefined);
			literal.push(candidate);
			if (realHome !== undefined && realUserFolder !== undefined && isEqualOrParent(realUserFolder, realHome)) {
				real.push(realUserFolder);
				userFolder = candidate;
			}
		}
		if (forRead && remote !== undefined && sameRemote(remote.tmpDir)) {
			literal.push(remote.tmpDir);
		}
		for (const folder of literal) {
			if (folder === candidate) {
				// 受け渡し用フォルダの realpath は上で（ホームの下にあるときだけ）載せた
				continue;
			}
			const resolved = await this.fileService.realpath(folder).catch(() => undefined);
			// 解けないフォルダ（まだ無い等）は、比べる相手にしない（外へのリンクを通さない側へ倒す）
			if (resolved !== undefined) {
				real.push(resolved);
			}
		}
		return { ok: true, value: { literal, real, userFolder } };
	}

	/** 受け渡し用フォルダの古い写しを消す（失敗は無視。次に写すときにまた試す）。 */
	private async sweepOldCopies(userFolder: URI): Promise<void> {
		try {
			const listing = await this.fileService.resolve(userFolder, { resolveMetadata: true });
			const cutoff = this.now() - PARADIS_REMOTE_FILE_COPY_TTL_MS;
			for (const child of listing.children ?? []) {
				if (child.isFile && child.mtime < cutoff) {
					await this.fileService.del(child.resource).catch(() => undefined);
				}
			}
		} catch {
			// まだ無い・読めない。消すものは無い
		}
	}

	private failed(reason: ParadisRemoteFileFailure, resource: URI, error: unknown): Failure {
		this.logService.warn(`[ParadisRemoteFileBridge] ${reason} for ${resource.toString()}`, error);
		return { ok: false, reason };
	}
}
