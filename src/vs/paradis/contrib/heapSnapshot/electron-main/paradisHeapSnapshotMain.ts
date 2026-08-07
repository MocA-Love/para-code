/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { app } from 'electron';
import { statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { getHeapSpaceStatistics, writeHeapSnapshot } from 'v8';
import { join } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisHeapSnapshotMainService, IParadisHeapSnapshotResult, PARADIS_HEAP_SNAPSHOT_CHANNEL } from '../common/paradisHeapSnapshot.js';

/** {@link paradisRegisterHeapSnapshot} が要求する最小の口。app.ts の実体を丸ごと受け取らないため。 */
export interface IParadisHeapSnapshotChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

/**
 * ファイル名に稼働時間を入れておく。
 *
 * リークの犯人を名指しするには**時間を空けた2枚の差分**が要るので、あとから見て
 * 「どちらが後か」「どれだけ間が空いたか」が分からないと使い物にならない。日時だけだと
 * 再起動を跨いだ2枚を誤って比べてしまうため、稼働時間も一緒に入れる。
 */
function snapshotFileName(uptimeMs: number): string {
	const uptimeMinutes = Math.round(uptimeMs / 60_000);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return `para-code-main-${stamp}-up${uptimeMinutes}m.heapsnapshot`;
}

/**
 * 書き出し先。
 *
 * 既定は一時ディレクトリ。数GB になるので、ユーザーデータ配下へ置くと同期対象や退避対象へ
 * 紛れ込み、消し忘れがそのまま容量を食い続ける。
 *
 * **Linux だけは別扱い**。多くのディストロで `/tmp` は tmpfs ＝ RAM 上にあり、メモリの調査中に
 * 2GB を RAM へ書き出すのは、まさに調べている問題を自分で悪化させる行為になる。
 * macOS の `/var/folders` と Windows の `%TEMP%` は実ディスクなのでそのままでよい。
 */
function snapshotDirectory(): string {
	return isLinux ? app.getPath('userData') : tmpdir();
}

class ParadisHeapSnapshotMainService implements IParadisHeapSnapshotMainService {

	private inFlight = false;

	async writeSnapshot(): Promise<IParadisHeapSnapshotResult> {
		// 同期実行なので実質は直列化されるが、待っている間に2回目を叩かれると数GB のファイルが
		// 2つできる。調べたいのはメモリ逼迫時の状態なので、そこでディスクを倍食うのは避ける。
		if (this.inFlight) {
			throw new Error('A heap snapshot is already being written');
		}
		this.inFlight = true;
		try {
			// `process.uptime()` は秒。プロセスの実際の連続稼働時間で、チャネル登録時刻ではない。
			const uptimeMs = Math.round(process.uptime() * 1000);
			// 直前の old space 使用量を添える。スナップショット自体にも同じ情報はあるが、
			// 開くのに数GB のメモリが要るので、比べるかどうかを**開く前に**決められるようにする。
			const oldSpaceUsed = getHeapSpaceStatistics()
				.find(space => space.space_name === 'old_space')?.space_used_size ?? 0;

			const path = join(snapshotDirectory(), snapshotFileName(uptimeMs));

			// **ここで main プロセスが止まる**。writeHeapSnapshot は同期的で、途中で中断もできない。
			const writeStartedAt = Date.now();
			try {
				writeHeapSnapshot(path);
			} catch (error) {
				// 容量不足などで落ちると、途中まで書かれた数GB のファイルが残る。調査のために
				// 空けたい容量を、失敗した調査自身が食ったままにしない。
				try {
					unlinkSync(path);
				} catch {
					// 消せなくても元の失敗のほうを伝える。
				}
				throw error;
			}
			const durationMs = Date.now() - writeStartedAt;

			// 大きさが読めなかった場合は 0 ではなく -1。0 を返すと呼び出し側の表示が
			// 「0.00 GB」になり、「空のファイルができた」と読めてしまう。
			let bytes = -1;
			try {
				bytes = statSync(path).size;
			} catch {
				// 大きさが読めなくてもパスは返す。呼び出し側にとってはパスのほうが本体。
			}

			return { path, bytes, durationMs, oldSpaceUsed, uptimeMs };
		} finally {
			this.inFlight = false;
		}
	}
}

/**
 * app.ts の PARA-PATCH 点から1行で呼ぶための入り口。
 * ここ以外に main プロセス側の配線は無い。
 */
export function paradisRegisterHeapSnapshot(channelHost: IParadisHeapSnapshotChannelHost): IDisposable {
	const disposables = new DisposableStore();
	channelHost.registerChannel(
		PARADIS_HEAP_SNAPSHOT_CHANNEL,
		ProxyChannel.fromService(new ParadisHeapSnapshotMainService(), disposables));
	return disposables;
}
