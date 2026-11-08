/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 新しいワークツリーへ、宣言したファイル・フォルダを元のリポジトリから持ち込む（Orca W3 の G-06）。
// 宣言の形は common/paradisWorktreeInclude.ts。リポジトリのあるマシン（shared process か接続先の REH）で動く。
// Orca の worktree-include-file.ts・worktree-shared-directories.ts・worktree-symlinks.ts と同じ規則で、
// 加えて書き込み先・元が途中のシンボリックリンクでワークツリー・リポジトリの外へ出ないことを確かめる。

import { constants as fsConstants, promises as fs } from 'fs';
import { dirname, join, relative, isAbsolute, sep } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IParadisWorktreeIncludeConfig, IParadisWorktreeIncludeResult, IParadisWorktreeIncludeSkipped, PARADIS_WORKTREE_INCLUDE_FILE, PARADIS_WORKTREE_INCLUDE_MAX_COPY_BYTES, PARADIS_WORKTREE_INCLUDE_MAX_COPY_ENTRIES, PARADIS_WORKTREE_INCLUDE_MAX_FILE_BYTES, paradisNormalizeWorktreeIncludePath, paradisParseWorktreeIncludeConfig, paradisParseWorktreeIncludeFile } from '../common/paradisWorktreeInclude.js';
import { PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';

/** 持ち込みが使う外の働き（テストから差し替える）。 */
export interface IParadisWorktreeIncludeHost {
	/** リポジトリで git が無視しているパスだけを返す（`git check-ignore`）。読めなければ空を返す。 */
	checkIgnored(repoPath: string, paths: readonly string[]): Promise<ReadonlySet<string>>;
	/** フォルダへのリンクを作れるか（Windows から WSL のリポジトリへは作らない）。 */
	readonly canLink: boolean;
	/** フォルダのリンクの種類（Windows は管理者権限の要らない junction）。 */
	readonly directoryLinkType: 'dir' | 'junction';
	/**
	 * 作ったリンクを書き留めるファイル（作業ツリーごとの git のフォルダの中）。削除の前に、ここに書いたリンクだけを外す。
	 * undefined ならリンクを作らない（記録できないリンクは、削除のときに外せないため）。
	 */
	readonly linkRecordPath: string | undefined;
	/** 写す量の上限（テストから小さくする）。 */
	readonly maxCopyBytes?: number;
	readonly maxCopyEntries?: number;
}

async function readTextIfSmall(path: string, maxBytes: number): Promise<string | undefined> {
	try {
		const stat = await fs.lstat(path);
		if (!stat.isFile() || stat.size > maxBytes) {
			return undefined;
		}
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * リポジトリの宣言を読む。`.paracode.json` の `worktree.include` と `.worktreeinclude` を「写す」にまとめ、
 * `worktree.sharedDirectories` を「リンク」にする。どちらも読めなければ空（作成を止めない）。
 */
export async function paradisReadWorktreeIncludeDeclarations(repoPath: string): Promise<IParadisWorktreeIncludeConfig> {
	let config: IParadisWorktreeIncludeConfig = { include: [], sharedDirectories: [] };
	const json = await readTextIfSmall(join(repoPath, PARADIS_WORKSPACE_PRESET_FILE), PARADIS_WORKTREE_INCLUDE_MAX_FILE_BYTES);
	if (json !== undefined) {
		try {
			config = paradisParseWorktreeIncludeConfig(json);
		} catch {
			// 壊れた .paracode.json は setup スクリプトの側で知らせる。ここでは持ち込まないだけ
		}
	}
	const includeFile = await readTextIfSmall(join(repoPath, PARADIS_WORKTREE_INCLUDE_FILE), PARADIS_WORKTREE_INCLUDE_MAX_FILE_BYTES);
	const include = [...config.include];
	for (const path of includeFile === undefined ? [] : paradisParseWorktreeIncludeFile(includeFile)) {
		if (!include.includes(path)) {
			include.push(path);
		}
	}
	// 両方に書かれたパスは「写す」を優先する（リンクだと元のものを書き換えてしまうため）
	return { include, sharedDirectories: config.sharedDirectories.filter(path => !include.includes(path)) };
}

function isInside(root: string, path: string): boolean {
	const part = relative(root, path);
	return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/** パスの一番近い、在るところまで遡って実体を解決する（無いところはまだ作っていないフォルダ）。 */
async function realpathOfNearestExisting(path: string): Promise<string> {
	let current = path;
	for (; ;) {
		try {
			return await fs.realpath(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return current;
			}
			current = parent;
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** 写す前に量を測る。上限を超えたら途中でやめて undefined を返す。中のシンボリックリンクは辿らない。 */
async function measure(source: string, remainingBytes: number, remainingEntries: number): Promise<{ bytes: number; entries: number } | undefined> {
	let bytes = 0;
	let entries = 0;
	const pending = [source];
	while (pending.length > 0) {
		const current = pending.pop()!;
		let stat;
		try {
			stat = await fs.lstat(current);
		} catch {
			continue;
		}
		entries++;
		if (entries > remainingEntries) {
			return undefined;
		}
		if (stat.isDirectory()) {
			for (const name of await fs.readdir(current)) {
				pending.push(join(current, name));
			}
		} else if (stat.isFile()) {
			bytes += stat.size;
			if (bytes > remainingBytes) {
				return undefined;
			}
		}
	}
	return { bytes, entries };
}

/**
 * 宣言したものを新しいワークツリーへ持ち込む。1 つの失敗は記録して次へ進む（作成は止めない）。
 *
 * - 元のリポジトリに無いもの、新しいワークツリーに既にあるものは、知らせずに飛ばす
 * - git が無視していないもの（追跡しているもの）は持ち込まない
 * - 「写す」は複製（APFS・btrfs などでは複製の仕組みを使い、無ければ普通に写す）。量の上限を超えるものは写さない
 * - 「リンク」はフォルダだけ。元のフォルダへのシンボリックリンク（Windows は junction）を作る
 */
export async function paradisMaterializeWorktreeIncludes(repoPath: string, worktreePath: string, config: IParadisWorktreeIncludeConfig, host: IParadisWorktreeIncludeHost): Promise<IParadisWorktreeIncludeResult> {
	const copied: string[] = [];
	const linked: string[] = [];
	const skipped: IParadisWorktreeIncludeSkipped[] = [];
	const all = [...config.include.map(path => ({ path, mode: 'copy' as const })), ...config.sharedDirectories.map(path => ({ path, mode: 'link' as const }))];
	if (all.length === 0) {
		return { copied, linked, skipped };
	}
	const present: typeof all = [];
	for (const entry of all) {
		if (await exists(join(repoPath, entry.path))) {
			present.push(entry);
		}
	}
	if (present.length === 0) {
		return { copied, linked, skipped };
	}
	const ignored = await host.checkIgnored(repoPath, present.map(entry => entry.path));
	const repoReal = await fs.realpath(repoPath);
	const worktreeReal = await fs.realpath(worktreePath);
	let remainingBytes = host.maxCopyBytes ?? PARADIS_WORKTREE_INCLUDE_MAX_COPY_BYTES;
	let remainingEntries = host.maxCopyEntries ?? PARADIS_WORKTREE_INCLUDE_MAX_COPY_ENTRIES;

	for (const { path, mode } of present) {
		if (!ignored.has(path)) {
			skipped.push({ path, reason: 'notIgnored' });
			continue;
		}
		const source = join(repoPath, path);
		const target = join(worktreePath, path);
		try {
			if (await exists(target)) {
				continue;
			}
			// 途中のフォルダや元そのものがシンボリックリンクだと、元はリポジトリの外を読み、書き込み先はワークツリーの外へ書く
			if (!isInside(repoReal, await fs.realpath(source)) || !isInside(worktreeReal, await realpathOfNearestExisting(dirname(target)))) {
				skipped.push({ path, reason: 'outside' });
				continue;
			}
			const sourceStat = await fs.stat(source);
			if (mode === 'link') {
				if (!sourceStat.isDirectory()) {
					skipped.push({ path, reason: 'notDirectory' });
					continue;
				}
				if (!host.canLink || host.linkRecordPath === undefined) {
					skipped.push({ path, reason: 'unsupported' });
					continue;
				}
				await fs.mkdir(dirname(target), { recursive: true });
				// 記録を先に書く。リンクを作れて記録に失敗すると、削除のときに外せないリンクが残るため
				await appendLinkRecord(host.linkRecordPath, { path, source, type: host.directoryLinkType });
				await fs.symlink(source, target, host.directoryLinkType);
				linked.push(path);
				continue;
			}
			// 「写す」は中身を自分のものにする。一番上のシンボリックリンクは辿って実体を写す（Orca と同じ）
			const copySource = await fs.realpath(source);
			const size = await measure(copySource, remainingBytes, remainingEntries);
			if (size === undefined) {
				skipped.push({ path, reason: 'tooLarge' });
				continue;
			}
			remainingBytes -= size.bytes;
			remainingEntries -= size.entries;
			await fs.mkdir(dirname(target), { recursive: true });
			// 確かめた後に別のものが作った書き込み先は上書きしない
			await fs.cp(copySource, target, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE });
			copied.push(path);
		} catch {
			skipped.push({ path, reason: 'failed' });
		}
	}
	return { copied, linked, skipped };
}

/** 作業ツリーごとの git のフォルダに置く、持ち込みで作ったリンクの記録のファイル名。 */
export const PARADIS_WORKTREE_LINK_RECORD_FILE = 'paracode-shared-links.json';

/** 持ち込みで作ったリンク 1 つ。 */
export interface IParadisWorktreeLinkRecord {
	/** 作業ツリーのルートからの相対パス。 */
	readonly path: string;
	/** リンク先（元のリポジトリの中のフォルダの絶対パス）。 */
	readonly source: string;
	readonly type: 'dir' | 'junction';
}

async function readLinkRecords(recordPath: string): Promise<IParadisWorktreeLinkRecord[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(recordPath, 'utf8'));
		return Array.isArray(parsed) ? parsed.filter((item): item is IParadisWorktreeLinkRecord => !!item && typeof item.path === 'string' && typeof item.source === 'string' && (item.type === 'dir' || item.type === 'junction')) : [];
	} catch {
		return [];
	}
}

async function appendLinkRecord(recordPath: string, record: IParadisWorktreeLinkRecord): Promise<void> {
	const records = (await readLinkRecords(recordPath)).filter(item => item.path !== record.path);
	records.push(record);
	await fs.writeFile(recordPath, JSON.stringify(records));
}

/** Windows の junction の readlink は長いパスの印（\\?\）を前に付けて返す。比べるときは落とす。 */
function sameLinkTarget(actual: string, expected: string): boolean {
	const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
	return isWindows ? normalize(actual).toLowerCase() === normalize(expected).toLowerCase() : normalize(actual) === normalize(expected);
}

/**
 * ワークツリーを消す前に、持ち込みで作ったリンクを外す（Orca の removeWorktreeSymlinks と同じ目的）。
 * `node_modules/` のようにフォルダとして無視している設定はリンクに当たらず、git がリンクを未追跡と見て削除を断るため。
 * 外すのは記録にあり、今もシンボリックリンク（junction）で、記録と同じ先を指しているものだけ。宣言が後で変わっても
 * 記録から外すので、前のリンクも残らない。同じ名前の普通のファイル・フォルダには触らない。外したものを返す
 * （削除が断られたら {@link paradisRestoreWorktreeLinks} で戻す）。
 */
export async function paradisUnlinkRecordedWorktreeLinks(worktreePath: string, recordPath: string): Promise<IParadisWorktreeLinkRecord[]> {
	const unlinked: IParadisWorktreeLinkRecord[] = [];
	for (const record of await readLinkRecords(recordPath)) {
		if (paradisNormalizeWorktreeIncludePath(record.path) !== record.path) {
			continue;
		}
		const target = join(worktreePath, record.path);
		try {
			if ((await fs.lstat(target)).isSymbolicLink() && sameLinkTarget(await fs.readlink(target), record.source)) {
				await fs.unlink(target);
				unlinked.push(record);
			}
		} catch {
			// 無いもの・外せないものは git の削除の側で扱う
		}
	}
	return unlinked;
}

/**
 * 記録にあり、今もシンボリックリンク（junction）で記録と同じ先を指しているリンクの相対パス（{@link paradisUnlinkRecordedWorktreeLinks}
 * が外す対象と同じ）。`git status` の未追跡から持ち込みのリンクを外すために使う。
 */
export async function paradisLiveRecordedWorktreeLinkPaths(worktreePath: string, recordPath: string): Promise<string[]> {
	const paths: string[] = [];
	for (const record of await readLinkRecords(recordPath)) {
		if (paradisNormalizeWorktreeIncludePath(record.path) !== record.path) {
			continue;
		}
		const target = join(worktreePath, record.path);
		try {
			if ((await fs.lstat(target)).isSymbolicLink() && sameLinkTarget(await fs.readlink(target), record.source)) {
				paths.push(record.path);
			}
		} catch {
			// 無いもの
		}
	}
	return paths;
}

/**
 * 外したリンクを作り直す（作業ツリーの削除が断られたとき）。作業ツリーのルートとリンクの親のフォルダがまだ在るときだけ戻す
 * （途中まで消えた作業ツリーに、消えたフォルダを作り直さない）。作れないものは飛ばす。
 */
export async function paradisRestoreWorktreeLinks(worktreePath: string, records: readonly IParadisWorktreeLinkRecord[]): Promise<void> {
	if (!(await fs.lstat(worktreePath).catch(() => undefined))?.isDirectory()) {
		return;
	}
	for (const record of records) {
		try {
			const target = join(worktreePath, record.path);
			if (!(await fs.lstat(dirname(target))).isDirectory()) {
				continue;
			}
			await fs.symlink(record.source, target, record.type);
		} catch {
			// 既に在る・親が消えた
		}
	}
}
