/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 外部 CLI を起こす fork の node 層(ccusage / rtk / limitsMonitor)が共有する、子プロセスの止め方。
//
// Windows では npm 由来の .cmd/.bat シムを `cmd.exe /d /s /c` でラップして起動している
// (`vs/paradis/common/paradisWindowsScriptShim.ts`)。そのため `ChildProcess` は cmd.exe であり、
// `child.kill()` は cmd.exe しか終わらせない——その先で走っている実体(node / codex 等)は
// 孤児として残り続ける。長く生きるプロセスほど効いてくるので、ツリーごと落とす。

import * as cp from 'child_process';
import { IDisposable } from '../../base/common/lifecycle.js';
import { killTree } from '../../base/node/processes.js';

/**
 * 子プロセスを終了させる。Windows ではプロセスツリーごと落とし、失敗したときだけ
 * `child.kill()` へ落とす(既に死んでいる場合もここへ来るが、二重に止めても無害)。
 *
 * `killTree` は Windows で絶対パスの `taskkill.exe` を `/T /F` で叩く既存実装
 * (`vs/base/node/processes.ts`)。`paradisMcpSetup.ts` も同じものを使っている。
 *
 * @param onError 失敗を記録したい呼び出し元向け(ログサービスは層をまたぐのでここでは持たない)
 */
export function paradisKillChildProcessTree(child: cp.ChildProcess, onError?: (error: unknown) => void, options?: IParadisChildProcessTreeTerminationOptions): void {
	const reportError = (error: unknown) => {
		try {
			onError?.(error);
		} catch {
			// Error reporting must not interrupt termination ownership.
		}
	};
	const killDirectly = () => {
		try {
			(options?.terminator ?? (child => child.kill()))(child);
		} catch (error) {
			reportError(error);
		}
	};

	const pid = child.pid;
	if ((options?.platform ?? process.platform) !== 'win32' || typeof pid !== 'number') {
		killDirectly();
		return;
	}
	// 既に終わっている子へ pid で taskkill を撃つと、Windows が同じ pid を再利用していた場合に
	// 無関係のプロセスツリーを落としうる。窓は極めて狭いが、撃つ必要も無いので撃たない。
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	try {
		(options?.treeKill ?? killTree)(pid, true).catch(error => {
			reportError(error);
			killDirectly();
		});
	} catch (error) {
		reportError(error);
		killDirectly();
	}
}

export interface IParadisChildProcessTreeTerminationOptions {
	readonly platform?: NodeJS.Platform;
	readonly treeKill?: typeof killTree;
	readonly terminator?: (child: cp.ChildProcess) => void;
}

export interface IParadisTrackedChildProcess extends IDisposable {
	readonly timedOut: boolean;
}

export class ParadisChildProcessTreeTracker implements IDisposable {

	private readonly active = new Set<ParadisTrackedChildProcess>();
	private disposed = false;

	constructor(
		private readonly onError?: (error: unknown) => void,
		private readonly terminationOptions?: IParadisChildProcessTreeTerminationOptions,
	) { }

	get activeCount(): number {
		return this.active.size;
	}

	track(child: cp.ChildProcess, timeoutMs: number): IParadisTrackedChildProcess {
		const execution = new ParadisTrackedChildProcess(
			child,
			timeoutMs,
			this.onError,
			this.terminationOptions,
			() => this.active.delete(execution),
		);
		if (this.disposed) {
			execution.killForOwnerDispose();
		} else {
			this.active.add(execution);
		}
		return execution;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const execution of [...this.active]) {
			execution.killForOwnerDispose();
		}
		this.active.clear();
	}
}

class ParadisTrackedChildProcess implements IParadisTrackedChildProcess {

	private timer: ReturnType<typeof setTimeout> | undefined;
	private completed = false;
	private killStarted = false;
	private _timedOut = false;

	get timedOut(): boolean {
		return this._timedOut;
	}

	constructor(
		private readonly child: cp.ChildProcess,
		timeoutMs: number,
		private readonly onError: ((error: unknown) => void) | undefined,
		private readonly terminationOptions: IParadisChildProcessTreeTerminationOptions | undefined,
		private readonly onComplete: () => void,
	) {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this._timedOut = true;
			this.startKill();
		}, timeoutMs);
	}

	dispose(): void {
		this.complete();
	}

	killForOwnerDispose(): void {
		if (this.completed) {
			return;
		}
		this.clearTimer();
		this.startKill();
		this.complete();
	}

	private startKill(): void {
		if (this.killStarted) {
			return;
		}
		this.killStarted = true;
		paradisKillChildProcessTree(this.child, this.onError, this.terminationOptions);
	}

	private complete(): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		this.clearTimer();
		this.onComplete();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
