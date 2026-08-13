/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { join } from '../../../../base/common/path.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisHeapSnapshotMainService, IParadisHeapSnapshotResult, PARADIS_HEAP_SNAPSHOT_CHANNEL } from '../common/paradisHeapSnapshot.js';

/** {@link paradisRegisterHeapSnapshot} が要求する最小の口。app.ts の実体を丸ごと受け取らないため。 */
export interface IParadisHeapSnapshotChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

/** Electron と Node の境界で渡す heap snapshot の実行依存性。 */
export interface IParadisHeapSnapshotDependencies {
	readonly isLinux: boolean;
	readonly userDataDirectory: () => string;
	readonly temporaryDirectory: () => string;
	readonly uptime: () => number;
	readonly heapSpaceStatistics: () => ReadonlyArray<{ readonly space_name: string; readonly space_used_size: number }>;
	readonly writeHeapSnapshot: (path: string) => void;
	readonly stat: (path: string) => { readonly size: number };
	readonly unlink: (path: string) => void;
}

/** ファイル名には、再起動を跨いだ比較を避けるため稼働時間を含める。 */
function snapshotFileName(uptimeMs: number): string {
	const uptimeMinutes = Math.round(uptimeMs / 60_000);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return `para-code-main-${stamp}-up${uptimeMinutes}m.heapsnapshot`;
}

/** Electron 非依存の heap snapshot lifecycle。 */
export class ParadisHeapSnapshotMainService implements IParadisHeapSnapshotMainService {

	private inFlight = false;

	constructor(private readonly dependencies: IParadisHeapSnapshotDependencies) { }

	async writeSnapshot(): Promise<IParadisHeapSnapshotResult> {
		if (this.inFlight) {
			throw new Error('A heap snapshot is already being written');
		}
		this.inFlight = true;
		try {
			const uptimeMs = Math.round(this.dependencies.uptime() * 1000);
			const oldSpaceUsed = this.dependencies.heapSpaceStatistics()
				.find(space => space.space_name === 'old_space')?.space_used_size ?? 0;
			const path = join(this.dependencies.isLinux ? this.dependencies.userDataDirectory() : this.dependencies.temporaryDirectory(), snapshotFileName(uptimeMs));
			const writeStartedAt = Date.now();
			try {
				this.dependencies.writeHeapSnapshot(path);
			} catch (error) {
				try {
					this.dependencies.unlink(path);
				} catch {
					// 消せなくても元の書き出し失敗を伝える。
				}
				throw error;
			}
			const durationMs = Date.now() - writeStartedAt;

			let bytes = -1;
			try {
				bytes = this.dependencies.stat(path).size;
			} catch {
				// 大きさが読めなくてもパスは返す。
			}

			return { path, bytes, durationMs, oldSpaceUsed, uptimeMs };
		} finally {
			this.inFlight = false;
		}
	}
}

/** 既存 IPC channel へ、Electron 非依存の service を登録する。 */
export function paradisRegisterHeapSnapshot(channelHost: IParadisHeapSnapshotChannelHost, service: IParadisHeapSnapshotMainService): IDisposable {
	const disposables = new DisposableStore();
	channelHost.registerChannel(
		PARADIS_HEAP_SNAPSHOT_CHANNEL,
		ProxyChannel.fromService(service, disposables));
	return disposables;
}
