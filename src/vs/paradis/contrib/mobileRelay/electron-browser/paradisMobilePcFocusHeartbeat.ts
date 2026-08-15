/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

/** OSの無操作時間がこれを超えたら、PCの前にいないとみなす。 */
const PC_AWAY_IDLE_MS = 5 * 60_000;

/** PCフォーカスのheartbeatに必要なIntervalTimerの最小契約。 */
export interface IParadisMobilePcFocusHeartbeatTimer extends IDisposable {
	cancel(): void;
	cancelAndSet(callback: () => void, intervalMs: number): void;
}

/** PCフォーカスの状態をshared processへ発行するための依存関係。 */
export interface IParadisMobilePcFocusHeartbeatOptions {
	readonly heartbeatIntervalMs: number;
	readonly isVisiblyFocused: () => boolean;
	readonly getSystemIdleTime: () => Promise<number>;
	readonly publish: (focused: boolean, stillCurrent: () => boolean) => Promise<void>;
	readonly onError?: (error: Error) => void;
}

/**
 * モバイルリレーが有効な間だけPCフォーカスをheartbeat送信する。
 *
 * idle timeやrenderer leaseの解決中に設定・画面状態が変化しても、世代を検証して古い報告を送らない。
 */
export class ParadisMobilePcFocusHeartbeat implements IDisposable {
	private enabled = false;
	private screenLocked = false;
	private disposed = false;
	private generation = 0;

	constructor(
		private readonly options: IParadisMobilePcFocusHeartbeatOptions,
		private readonly timer: IParadisMobilePcFocusHeartbeatTimer = new IntervalTimer(),
	) {
	}

	setEnabled(enabled: boolean): void {
		if (this.disposed || this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		this.generation++;
		if (!enabled) {
			this.timer.cancel();
			return;
		}
		this.timer.cancelAndSet(() => this.reportNow(), this.options.heartbeatIntervalMs);
		this.reportNow();
	}

	setScreenLocked(screenLocked: boolean): void {
		if (this.disposed || this.screenLocked === screenLocked) {
			return;
		}
		this.screenLocked = screenLocked;
		this.generation++;
	}

	reportNow(): void {
		if (this.disposed || !this.enabled) {
			return;
		}
		const generation = ++this.generation;
		if (this.screenLocked || !this.options.isVisiblyFocused()) {
			this.publish(false, generation);
			return;
		}
		void this.options.getSystemIdleTime().then(idleSeconds => {
			if (!this.isCurrent(generation)) {
				return;
			}
			this.publish(idleSeconds * 1000 <= PC_AWAY_IDLE_MS, generation);
		}, error => this.reportError(error));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation++;
		this.timer.dispose();
	}

	private publish(focused: boolean, generation: number): void {
		if (!this.isCurrent(generation)) {
			return;
		}
		void this.options.publish(focused, () => this.isCurrent(generation)).catch(error => this.reportError(error));
	}

	private isCurrent(generation: number): boolean {
		return !this.disposed && this.enabled && generation === this.generation;
	}

	private reportError(error: Error): void {
		this.options.onError?.(error);
	}
}
