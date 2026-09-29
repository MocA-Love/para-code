/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp の子プロセスに渡す一時フォルダ（TMPDIR 兼 roots の1つ）の後始末。
//
//  - mkdtemp で推測できない名前・0700 で作る（共有の /tmp でも他の利用者に先回りされない）
//  - 子プロセスを起こすたびに、まだ自分の 0700 のフォルダとして在るかを確かめ、無ければ作り直す
//    （OS の一時フォルダの掃除で消えることがある）。作れなかったことは覚えず、次の起動でまた試す
//  - shared process の終了時に消す。前の実行が消し損ねたもの（異常終了など）は起動時に消す。
//    同じ利用者の別の Para Code（製品版と開発版を並べて動かす場合など）が使っている最中のものを
//    消さないよう、フォルダに作ったプロセスの PID を書いておき、そのプロセスが生きていれば残す

import { promises as fs, lstatSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from '../../../../base/common/path.js';

const PREFIX = 'para-code-devtools-';
const OWNER_FILE = '.para-code-owner';
/** 持ち主の印が無いもの（印を書く前の版が作ったもの）は、この時間より古ければ消す。 */
const UNOWNED_STALE_MS = 24 * 60 * 60_000;

function isOwnPrivateDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return false;
		}
		if (process.platform === 'win32' || typeof process.getuid !== 'function') {
			return true;
		}
		return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM は「在るが別の利用者のもの」
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** 1 つの shared process（1 つの proxy）が使う一時フォルダ。 */
export class ParadisDevtoolsTemporaryDirectory {

	private _path: string | undefined;
	private _disposed = false;

	constructor(
		private readonly parent: string,
		private readonly ownPid: number = process.pid,
	) { }

	/** 使える一時フォルダを返す。無くなっていれば作り直す。作れなければ undefined（次の呼び出しでまた試す）。 */
	ensure(): string | undefined {
		if (this._disposed) {
			return undefined;
		}
		if (this._path !== undefined && isOwnPrivateDirectory(this._path)) {
			return this._path;
		}
		this._path = undefined;
		try {
			const created = mkdtempSync(join(this.parent, PREFIX));
			writeFileSync(join(created, OWNER_FILE), String(this.ownPid), { mode: 0o600 });
			this._path = created;
		} catch {
			return undefined;
		}
		return this._path;
	}

	/** 作った一時フォルダを消す。 */
	async dispose(): Promise<void> {
		this._disposed = true;
		const path = this._path;
		this._path = undefined;
		if (path !== undefined) {
			await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * 前の実行が残した一時フォルダを消す。自分の PID のもの・持ち主が生きているもの・自分の 0700 の
	 * フォルダでないものは残す。消した名前を返す。
	 */
	static async sweepStale(parent: string, ownPid: number = process.pid, now: number = Date.now(), isAlive: (pid: number) => boolean = isProcessAlive): Promise<string[]> {
		let names: string[];
		try {
			names = await fs.readdir(parent);
		} catch {
			return [];
		}
		const removed: string[] = [];
		for (const name of names) {
			if (!name.startsWith(PREFIX)) {
				continue;
			}
			const path = join(parent, name);
			if (!isOwnPrivateDirectory(path)) {
				continue;
			}
			const owner = await fs.readFile(join(path, OWNER_FILE), 'utf8').then(text => Number.parseInt(text, 10), () => undefined);
			if (owner !== undefined && Number.isSafeInteger(owner) && owner > 0) {
				if (owner === ownPid || isAlive(owner)) {
					continue;
				}
			} else {
				const stat = await fs.stat(path).catch(() => undefined);
				if (stat === undefined || now - stat.mtimeMs < UNOWNED_STALE_MS) {
					continue;
				}
			}
			try {
				await fs.rm(path, { recursive: true, force: true });
				removed.push(name);
			} catch {
				// 次の起動でまた試す
			}
		}
		return removed;
	}
}
