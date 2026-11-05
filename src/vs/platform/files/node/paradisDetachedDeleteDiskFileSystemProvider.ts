/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { spawn } from 'child_process';
import { promises } from 'fs';
import { setPriority, tmpdir } from 'os';
import { basename, dirname, join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IFileDeleteOptions } from '../common/files.js';
import { ILogService } from '../../log/common/log.js';
import { DiskFileSystemProvider } from './diskFileSystemProvider.js';

/** 退避したフォルダの名前の頭。起動時の片付けはこの名前のものだけを消す。 */
const DELETING_PREFIX = '.para-deleting-';

/** 消している子プロセスの優先度（`nice` の値）。切り替えなど手前の操作に CPU を譲る。 */
const DELETE_PROCESS_NICENESS = 10;

/**
 * SSH の接続先（REH）でフォルダを中身ごと消すとき、消す処理をサーバーのプロセスの外へ出す
 * `DiskFileSystemProvider`。
 *
 * upstream は `Promises.rm(path, RimRafMode.MOVE)` で消す。一時フォルダへ rename できれば
 * 返事は即座に返るが、中身はサーバーのプロセスの中で `fs.promises.rm` が消し続ける。Node の
 * `rm` は子の数だけ並列に `lstat`・`unlink` を投げるので、libuv のスレッドプール（既定 4 本）の
 * 待ち行列が埋まり、同じプロセスが受けるほかのファイル操作（スペースの切り替えの stat・読み込み・
 * 設定の読み込み）が、消し終わるまで順番待ちになる。rename できない（一時フォルダが別の
 * ファイルシステム）ときは、同じ `rm` をその場で待つ。
 *
 * 2026-11-06 の実測（NVMe、Node 24）: 15 万ファイルを消す間、同じプロセスの stat と読み込みの
 * 1 往復が最大 5 秒、45 万ファイルでは最大 25 秒待たされた。別のプロセスの `rm -rf` で消すと、
 * 同じ間の待ちは最大 82ms だった。
 *
 * そこで、中身ごとの完全削除（ごみ箱を使わない `recursive`）だけを次のように扱う。
 *
 * 1. 同じファイルシステムの退避場所へ rename する（サーバーのデータのフォルダ、一時フォルダ、
 *    消す対象の隣の順。rename が `EXDEV` で失敗したら次を試す）。rename は 1 回の syscall なので、
 *    返事は upstream の速い経路と同じく即座に返る
 * 2. 退避したものは、優先度を下げた別のプロセスの `rm -rf` で消し、終わるのを待たない
 * 3. どこへも rename できないときは、別のプロセスの `rm -rf` で消し終わるのを待つ
 * 4. 子プロセスを起動できないときは upstream の消し方に戻す
 *
 * Windows（`rm` が無い）、ごみ箱への移動、中身ごとでない削除は upstream のまま。
 */
export class ParadisDetachedDeleteDiskFileSystemProvider extends DiskFileSystemProvider {

	private readonly trashRoot: string | undefined;

	/**
	 * @param dataPath サーバーのデータのフォルダ。その下の `paradisDeleting` を退避場所の第一候補にする
	 * （作業フォルダと同じファイルシステムであることが多く、エクスプローラーや git に見えない）。
	 * @param spawnRemove テスト用。既定は `rm -rf` の子プロセス。
	 */
	constructor(
		logService: ILogService,
		dataPath: string | undefined,
		private readonly spawnRemove: (path: string) => Promise<number | null> = paradisSpawnRemove,
	) {
		super(logService);
		const trashRoot = this.trashRoot = dataPath === undefined ? undefined : join(dataPath, 'paradisDeleting');

		if (!isWindows && trashRoot !== undefined) {
			// 前回、消し終わる前にサーバーが止まった残りを片付ける。サーバーの起動を待たせない。
			this.removeLeftovers(trashRoot).catch(error => this.logService.trace('[ParadisDetachedDelete] Could not clean up leftovers', error));
		}
	}

	override async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		if (isWindows || !opts.recursive || opts.useTrash) {
			return super.delete(resource, opts);
		}

		const filePath = this.toFilePath(resource);
		if (dirname(filePath) === filePath) {
			return super.delete(resource, opts); // upstream が根の削除を断る
		}

		let moved: string | undefined;
		for (const target of await this.moveTargets(filePath, opts)) {
			try {
				await promises.rename(filePath, target);
				moved = target;
				break;
			} catch (error) {
				if (error.code === 'ENOENT' && !(await this.exists(filePath))) {
					return; // 消す対象がもう無い (upstream の rimrafMove と同じく成功扱い)
				}
				// 退避場所が別のファイルシステム (EXDEV) などで rename できなければ次の候補へ
			}
		}

		if (moved !== undefined) {
			const removing = moved;
			this.spawnRemove(removing).then(code => {
				if (code !== 0) {
					this.logService.warn(`[ParadisDetachedDelete] rm exited with ${code}; removing the moved folder in process`);
					return promises.rm(removing, { recursive: true, force: true, maxRetries: 3 });
				}
				return undefined;
			}, () => promises.rm(removing, { recursive: true, force: true, maxRetries: 3 })).catch(error => {
				this.logService.error('[ParadisDetachedDelete] Could not remove a moved folder', error);
			});
			return;
		}

		// どこへも退避できなかった。消し終わるまでは待つが、消すのは別のプロセスにする。
		let code: number | null;
		try {
			code = await this.spawnRemove(filePath);
		} catch {
			return super.delete(resource, opts);
		}
		if (code !== 0 || await this.exists(filePath)) {
			// 消し切れなかった。upstream で消し直し、失敗ならその理由を返す。
			return super.delete(resource, opts);
		}
	}

	private async moveTargets(filePath: string, opts: IFileDeleteOptions): Promise<string[]> {
		const name = `${DELETING_PREFIX}${generateUuid()}`;
		if (opts.atomic !== false && opts.atomic.postfix) {
			// 呼び出し側が退避先を決めている (upstream の atomic delete と同じ場所)。
			return [join(dirname(filePath), `${basename(filePath)}${opts.atomic.postfix}`)];
		}
		const targets: string[] = [];
		if (this.trashRoot !== undefined) {
			try {
				await promises.mkdir(this.trashRoot, { recursive: true });
				targets.push(join(this.trashRoot, name));
			} catch {
				// 作れなければ使わない
			}
		}
		targets.push(join(tmpdir(), name));
		targets.push(join(dirname(filePath), name));
		return targets;
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await promises.lstat(path);
			return true;
		} catch {
			return false;
		}
	}

	private async removeLeftovers(trashRoot: string): Promise<void> {
		let names: string[];
		try {
			names = await promises.readdir(trashRoot);
		} catch {
			return; // まだ一度も使っていない
		}
		for (const name of names) {
			if (name.startsWith(DELETING_PREFIX)) {
				await this.spawnRemove(join(trashRoot, name));
			}
		}
	}
}

/**
 * `rm -rf -- <path>` を別のプロセスで走らせ、終了コードを返す。起動できなければ投げる。
 * 優先度を下げ、親（サーバー）が先に止まっても消し続けるよう切り離す。
 */
export function paradisSpawnRemove(path: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn('rm', ['-rf', '--', path], { detached: true, stdio: 'ignore' });
		child.once('error', reject);
		child.once('spawn', () => {
			if (child.pid !== undefined) {
				try {
					setPriority(child.pid, DELETE_PROCESS_NICENESS);
				} catch {
					// 下げられなくても消せる
				}
			}
		});
		child.once('exit', code => resolve(code));
		child.unref();
	});
}
