/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// フォルダの容量を測る。`du` は Windows に無いので Node だけで書く。
//
// 実測(このリポジトリ 12.7GiB/36万ファイル, macOS APFS): 逐次で歩くと10秒だが、
// CPU時間は3.6秒しか使っておらず残りはディスク待ちだった。並列に歩かせると3.6秒。
// つまり**並列度が効く**ので、ディレクトリ単位で同時に走らせる。

import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';

/**
 * 同時に開くディレクトリの数。
 *
 * ディスク待ちが支配的なので上げるほど速いが、上げすぎると libuv の
 * threadpool を溢れさせて他のI/Oまで待たせる。16 は実測で頭打ちになった辺り。
 */
const CONCURRENCY = 16;

/** 1回の計測で数えるファイル数の上限。壊れた木や巨大すぎる木で止まらなくする。 */
const MAX_FILES = 3_000_000;

export interface IDirectorySizeOptions {
	/** この配下は数えない(親の中にある worktree を除くために使う)。 */
	readonly exclude?: readonly string[];
	/** 中断させたいときに立てる。 */
	readonly token?: { readonly isCancellationRequested: boolean };
}

export interface IDirectorySizeResult {
	readonly bytes: number;
	/** 数えたファイル数(デバッグと上限判定用)。 */
	readonly files: number;
	/** 上限に達して打ち切った場合 true(数字は「少なくともこれだけ」になる)。 */
	readonly truncated: boolean;
}

function normalize(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * フォルダの容量を測る。
 *
 * - シンボリックリンクは**辿らない**。辿ると外のフォルダを数えたり循環したりする
 * - ハードリンクは inode を覚えて2回目以降を数えない。pnpm のストアのように同じ実体が
 *   何度も現れる構成で、実際のディスク消費より大きく出るのを防ぐ
 * - サイズは `blocks * 512`(実際に割り当てられた量)を使う。`du` と同じ数え方。
 *   取れない環境(Windows)では `size` に落とす
 */
export async function measureDirectorySize(root: string, options: IDirectorySizeOptions = {}): Promise<IDirectorySizeResult> {
	// ルートが存在しない・ファイルだった場合は歩く前に返す。
	//
	// ここだけは `lstat` ではなく `stat` を使い、リンクを1段だけ辿る。`~/dev/repo` を
	// 外部ボリュームへ symlink している構成があり、`lstat` だと `isDirectory()` も
	// `isFile()` も false になって**エラーにもならず 0 バイト**が返る(そしてその値が
	// キャッシュされる)。中身を歩くときは Dirent のまま判定するので、リンクを辿るのは
	// この1段だけ＝循環の危険は増えない。
	try {
		const rootStat = await fs.promises.stat(root);
		if (!rootStat.isDirectory()) {
			return { bytes: rootStat.isFile() ? rootStat.size : 0, files: rootStat.isFile() ? 1 : 0, truncated: false };
		}
	} catch (error) {
		throw new Error(`cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const excluded = new Set((options.exclude ?? []).map(normalize));
	// 除外が無いスペースが大多数。全エントリで正規表現2回と toLowerCase を回すのは
	// ホットパスなので、そのときは判定ごと飛ばす。
	const isExcluded = excluded.size === 0 ? () => false : (full: string) => excluded.has(normalize(full));
	// 見たハードリンクの inode。`dev:ino` の**文字列**にすると、pnpm のストアのように
	// 実体を共有する構成で最大 MAX_FILES 件ぶんの文字列が shared process に居座る。
	// device ごとに数値の Set を持てば、要素は数値のまま済む。
	const seenHardLinks = new Map<number, Set<number>>();
	const queue: string[] = [root];
	let bytes = 0;
	let files = 0;
	let truncated = false;

	const cancelled = () => options.token?.isCancellationRequested === true || truncated;

	/** 1フォルダぶんを数え、見つかった子フォルダを返す。 */
	const visit = async (dir: string): Promise<string[]> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			// 読めないフォルダ(権限が無い、測っている間に消えた)は飛ばす。
			return [];
		}
		const subdirs: string[] = [];
		for (const entry of entries) {
			if (cancelled()) {
				break;
			}
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink() || isExcluded(full)) {
				continue;
			}
			if (entry.isDirectory()) {
				subdirs.push(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			if (++files > MAX_FILES) {
				truncated = true;
				break;
			}
			try {
				const stat = await fs.promises.lstat(full);
				if (stat.nlink > 1) {
					// check-then-add の間に await を挟まないので、走者が並んでいても取りこぼさない。
					let inodes = seenHardLinks.get(stat.dev);
					if (inodes === undefined) {
						inodes = new Set<number>();
						seenHardLinks.set(stat.dev, inodes);
					}
					if (inodes.has(stat.ino)) {
						continue;
					}
					inodes.add(stat.ino);
				}
				// `blocks` は実際に割り当てられたブロック数で、`du` と同じ数え方になる。
				// ただし常に 0 を返すマウント(一部のネットワーク/FUSE)があり、そのまま使うと
				// 木全体が 0 バイトになる。0 のときは論理サイズへ落とす(0バイトファイルは
				// どのみち size も 0 なので実害はない)。
				bytes += typeof stat.blocks === 'number' && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
			} catch {
				// 数えている間に消えたファイルは無視する。
			}
		}
		return subdirs;
	};

	// 走者を最大 CONCURRENCY 本まで立て、終わった走者が次のフォルダを取りに行く。
	// キューは歩きながら増えるので、固定長のバッチではなく都度補充する形にする。
	await new Promise<void>(resolve => {
		let running = 0;
		let settled = false;
		const pump = (): void => {
			if (settled) {
				return;
			}
			if (cancelled()) {
				// 走行中のものが戻り切ってから終わる(結果の書き込みが競合しないように)。
				if (running === 0) {
					settled = true;
					resolve();
				}
				return;
			}
			while (running < CONCURRENCY && queue.length > 0) {
				const dir = queue.pop()!;
				running++;
				// **`running--` は必ず通す**。ここで例外が漏れると走者が減らないまま
				// pump も再入されず、この Promise が永久に解決しない(呼び出し側の
				// in-flight にも居座り、以後の要求が全部その死んだ Promise に相乗りする)。
				void visit(dir)
					.then(subdirs => {
						// スプレッドで渡さない。1フォルダ直下に十数万のサブフォルダがある木
						// (ハッシュ分割キャッシュ等)で `Maximum call stack size exceeded` になる。
						for (const subdir of subdirs) {
							queue.push(subdir);
						}
					}, () => { /* このフォルダは数えられなかった。全体は続ける */ })
					.finally(() => {
						running--;
						pump();
					})
					// `.finally` の中(または上の成功ハンドラ)が投げた場合の最後の受け皿。
					// ここが無いと unhandled rejection になる。
					.catch(() => { });
			}
			if (running === 0 && queue.length === 0) {
				settled = true;
				resolve();
			}
		};
		pump();
	});

	return { bytes, files, truncated };
}
