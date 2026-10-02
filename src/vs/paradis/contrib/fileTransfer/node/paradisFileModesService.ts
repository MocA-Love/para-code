/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の権限（st_mode）を読む・変えるチャネル。
//
// 手元は shared process（paradisFileModes.sharedProcess.ts）、接続先は REH（paradisFileModes.server.ts）に
// 同じものを生やす。ウィンドウはすでに IFileService で同じマシンの全ファイルを読み書きできるので、
// ここで新しく開く権限は無い（chmod も、書けるファイルに対してしか通らない）。
//
// 一覧は 1 往復で返す。IFileService の `resolveMetadata` は子ごとに stat が飛ぶため、SSH 越しでは
// 項目数ぶんの往復になる。ここなら接続先の中で lstat を回してまとめて返せる。

import { promises as fsp } from 'fs';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import {
	IParadisChmodRequest,
	IParadisFileModeEntry,
	IParadisFileStatInfo,
	IParadisRenameRequest,
	IParadisFileModeListing,
	IParadisFileModeListRequest,
	paradisIsValidMode,
	paradisRecursiveModeFor,
	PARADIS_FILE_MODES_PROTOCOL_VERSION,
} from '../common/paradisFileTransfer.js';

/** 1 フォルダーの上限。超えた分は返さず、打ち切ったことだけを返す。 */
const PARADIS_FILE_MODES_MAX_ENTRIES = 20_000;
/** 同時に走らせる lstat の数。巨大なフォルダーでファイル記述子を食い尽くさないように。 */
const PARADIS_FILE_MODES_PARALLEL = 64;
/** 「中身にも適用」で辿る項目の上限（誤って巨大な木に当てたときに止まるように）。 */
const PARADIS_FILE_MODES_MAX_RECURSIVE = 200_000;

function toFsPath(resource: IParadisFileModeListRequest['resource']): string {
	const uri = URI.revive(resource);
	if (uri.scheme !== Schemas.file) {
		throw new Error(localize('paradis.fileTransfer.unsupportedScheme', "このマシンのファイルではありません: {0}", uri.scheme));
	}
	return uri.fsPath;
}

async function describe(directory: string, name: string): Promise<IParadisFileModeEntry | undefined> {
	const path = join(directory, name);
	try {
		const stat = await fsp.lstat(path);
		let kind: IParadisFileModeEntry['kind'] = 'other';
		let isDirectory = false;
		if (stat.isSymbolicLink()) {
			kind = 'symlink';
			// リンク先がフォルダーなら一覧から中へ進めるようにする（壊れたリンクはファイル扱い）
			isDirectory = await fsp.stat(path).then(target => target.isDirectory(), () => false);
		} else if (stat.isDirectory()) {
			kind = 'directory';
			isDirectory = true;
		} else if (stat.isFile()) {
			kind = 'file';
		}
		return { name, mode: stat.mode & 0o7777, kind, isDirectory, size: stat.size, mtime: stat.mtimeMs };
	} catch {
		// 一覧を読んだ後に消えた項目は黙って落とす
		return undefined;
	}
}

export class ParadisFileModesService {

	async list(request: IParadisFileModeListRequest): Promise<IParadisFileModeListing> {
		const directory = toFsPath(request.resource);
		const names = await fsp.readdir(directory);
		const truncated = names.length > PARADIS_FILE_MODES_MAX_ENTRIES;
		const kept = names.slice(0, PARADIS_FILE_MODES_MAX_ENTRIES);
		const entries: IParadisFileModeEntry[] = [];
		for (let index = 0; index < kept.length; index += PARADIS_FILE_MODES_PARALLEL) {
			const batch = await Promise.all(kept.slice(index, index + PARADIS_FILE_MODES_PARALLEL).map(name => describe(directory, name)));
			for (const entry of batch) {
				if (entry) {
					entries.push(entry);
				}
			}
		}
		return { entries, truncated };
	}

	/** 1 ファイルの lstat。無ければ undefined。 */
	async statFile(request: IParadisFileModeListRequest): Promise<IParadisFileStatInfo | undefined> {
		const path = toFsPath(request.resource);
		try {
			const stat = await fsp.lstat(path);
			const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
			return {
				mode: stat.mode & 0o7777,
				ownedByMe: uid === undefined || stat.uid === uid,
				linkCount: stat.nlink,
				isSymbolicLink: stat.isSymbolicLink(),
				isDirectory: stat.isDirectory(),
				identity: `${stat.dev}:${stat.ino}:${stat.size}:${Math.floor(stat.mtimeMs)}`,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	/**
	 * 素の fs.rename で置き換える（POSIX では送り先のファイルを 1 回で置き換える）。送り先がフォルダーなら
	 * EISDIR で失敗させ、消してから rename する処理は挟まない。
	 */
	async rename(request: IParadisRenameRequest): Promise<void> {
		const from = toFsPath(request.from);
		const to = toFsPath(request.to);
		const target = await fsp.lstat(to).catch(() => undefined);
		if (target?.isDirectory()) {
			const error: NodeJS.ErrnoException = new Error(`EISDIR: illegal operation on a directory, rename '${from}' -> '${to}'`);
			error.code = 'EISDIR';
			throw error;
		}
		await fsp.rename(from, to);
	}

	async chmod(request: IParadisChmodRequest): Promise<void> {
		if (!paradisIsValidMode(request.mode)) {
			throw new Error(localize('paradis.fileTransfer.invalidMode', "権限の値が正しくありません: {0}", String(request.mode)));
		}
		const root = toFsPath(request.resource);
		// chmod はリンクを辿ってリンク先を変える。一覧で見せているのはリンク自身なので、リンクには当てない
		const rootStat = await fsp.lstat(root);
		if (rootStat.isSymbolicLink()) {
			throw new Error(localize('paradis.fileTransfer.chmodLink', "リンクの権限は変更できません"));
		}
		await fsp.chmod(root, request.mode);
		if (!request.recursive || !rootStat.isDirectory()) {
			return;
		}
		// 中は lstat で辿る。リンクの先へは進まず、リンク自体の権限も変えない（chmod はリンク先に効くため、
		// 木の外のファイルを書き換えてしまう）
		let visited = 0;
		const pending: string[] = [root];
		while (pending.length) {
			const directory = pending.pop()!;
			for (const name of await fsp.readdir(directory)) {
				if (++visited > PARADIS_FILE_MODES_MAX_RECURSIVE) {
					throw new Error(localize('paradis.fileTransfer.chmodTooMany', "中の項目が多すぎるため、途中で止めました（{0} 件まで）", PARADIS_FILE_MODES_MAX_RECURSIVE));
				}
				const path = join(directory, name);
				const stat = await fsp.lstat(path);
				if (stat.isSymbolicLink()) {
					continue;
				}
				const isDirectory = stat.isDirectory();
				await fsp.chmod(path, paradisRecursiveModeFor(request.mode, isDirectory, stat.mode & 0o7777));
				if (isDirectory) {
					pending.push(path);
				}
			}
		}
	}
}

export class ParadisFileModesChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisFileModesService) { }

	listen<T>(_context: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_context: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'version':
				return Promise.resolve(PARADIS_FILE_MODES_PROTOCOL_VERSION as T);
			case 'list':
				return this.service.list(arg as IParadisFileModeListRequest) as Promise<T>;
			case 'chmod':
				return this.service.chmod(arg as IParadisChmodRequest) as Promise<T>;
			case 'statFile':
				return this.service.statFile(arg as IParadisFileModeListRequest) as Promise<T>;
			case 'rename':
				return this.service.rename(arg as IParadisRenameRequest) as Promise<T>;
			default:
				throw new Error(`Method not found: ${command}`);
		}
	}
}
