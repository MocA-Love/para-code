/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { basename, dirname, join } from '../../../../base/common/path.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IParadisHeapSnapshotMainService, IParadisHeapSnapshotResult, PARADIS_HEAP_SNAPSHOT_CHANNEL } from '../common/paradisHeapSnapshot.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

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
	readonly chmod: (path: string, mode: number) => void;
	readonly readdir: (directory: string) => Promise<readonly string[]>;
}

/** 書き出した後に、前のスナップショットを何件残すか（今回の分は別に残る）。 */
const PARADIS_HEAP_SNAPSHOT_KEEP_PREVIOUS = 2;

/** 片付けの対象にする名前。置き場は一時フォルダや userData なので、これ以外のファイルには触れない。 */
const PARADIS_HEAP_SNAPSHOT_NAME = /^para-code-main-.+\.heapsnapshot$/;

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
				reportParadisDiagnosticError('owned', 'heap-snapshot', 'write-failed', error);
				throw error;
			}
			const durationMs = Date.now() - writeStartedAt;
			// ヒープにはトークンや API キーが文字列で残っているので、本人だけが読めるようにする。
			// v8.writeHeapSnapshot は権限を指定できないため、書いた後に掛ける。
			try {
				this.dependencies.chmod(path, 0o600);
			} catch {
				// 掛けられなくても書き出しは成功として返す。
			}
			await this.removeOlderSnapshots(path);

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

	/** 数 GB になるファイルが取るたびに溜まらないよう、今回の分と前の数件だけを残す。 */
	private async removeOlderSnapshots(path: string): Promise<void> {
		const directory = dirname(path);
		let names: readonly string[];
		try {
			names = await this.dependencies.readdir(directory);
		} catch {
			return;
		}
		const current = basename(path);
		// 名前は時刻（ISO の順に並ぶ形）から始まるので、名前の順が古い順になる。
		const previous = names.filter(name => name !== current && PARADIS_HEAP_SNAPSHOT_NAME.test(name)).sort();
		for (const name of previous.slice(0, Math.max(0, previous.length - PARADIS_HEAP_SNAPSHOT_KEEP_PREVIOUS))) {
			try {
				this.dependencies.unlink(join(directory, name));
			} catch {
				// 消せなかったものは次の機会に回す。
			}
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
