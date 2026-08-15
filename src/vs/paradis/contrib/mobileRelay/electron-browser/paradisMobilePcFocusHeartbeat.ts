/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

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

/** contributionへPCフォーカスheartbeatを結合するためのPara固有依存関係。 */
export interface IParadisMobilePcFocusHeartbeatCoordinatorOptions<TLease> {
	readonly heartbeatIntervalMs: number;
	readonly isVisiblyFocused: () => boolean;
	readonly getSystemIdleTime: () => Promise<number>;
	readonly resolveCurrentRendererLease: () => Promise<TLease>;
	readonly resolveWindowLease: () => Promise<TLease>;
	readonly setPcFocus: (lease: TLease, focused: boolean) => Promise<void>;
	readonly setSharedProcessEnabled: (enabled: boolean) => Promise<void>;
	readonly onDidLockScreen: Event<void>;
	readonly onDidUnlockScreen: Event<void>;
	readonly onDidChangeFocus: Event<void>;
	readonly onDidChangeVisibility: Event<void>;
	readonly onError?: (operation: 'setPcFocus' | 'setEnabled', error: Error) => void;
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
		const generation = ++this.generation;
		if (!enabled) {
			this.timer.cancel();
			this.publish(false, generation, false);
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
		if (this.enabled) {
			this.generation++;
		}
	}

	reportNow(): void {
		if (this.disposed || !this.enabled) {
			return;
		}
		const generation = ++this.generation;
		if (this.screenLocked || !this.options.isVisiblyFocused()) {
			this.publish(false, generation, true);
			return;
		}
		void this.options.getSystemIdleTime().then(idleSeconds => {
			if (!this.isCurrent(generation, true)) {
				return;
			}
			this.publish(idleSeconds * 1000 <= PC_AWAY_IDLE_MS, generation, true);
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

	private publish(focused: boolean, generation: number, enabled: boolean): void {
		if (!this.isCurrent(generation, enabled)) {
			return;
		}
		void this.options.publish(focused, () => this.isCurrent(generation, enabled)).catch(error => this.reportError(error));
	}

	private isCurrent(generation: number, enabled: boolean): boolean {
		return !this.disposed && this.enabled === enabled && generation === this.generation;
	}

	private reportError(error: Error): void {
		this.options.onError?.(error);
	}
}

/**
 * PCフォーカスheartbeatをmobile relay contributionへ結合する。
 *
 * provider構築後の初期設定、UIイベント、shared process設定同期、window終了時の最終報告を
 * 同じ順序で扱い、renderer lease待機中の古い報告をIPCへ到達させない。
 */
export class ParadisMobilePcFocusHeartbeatCoordinator<TLease> implements IDisposable {
	private readonly listeners = new DisposableStore();
	private readonly heartbeat: ParadisMobilePcFocusHeartbeat;
	private disposed = false;

	constructor(
		private readonly options: IParadisMobilePcFocusHeartbeatCoordinatorOptions<TLease>,
		timer?: IParadisMobilePcFocusHeartbeatTimer,
	) {
		this.heartbeat = new ParadisMobilePcFocusHeartbeat({
			heartbeatIntervalMs: options.heartbeatIntervalMs,
			isVisiblyFocused: options.isVisiblyFocused,
			getSystemIdleTime: options.getSystemIdleTime,
			publish: async (focused, stillCurrent) => {
				const lease = await options.resolveCurrentRendererLease();
				if (stillCurrent()) {
					await options.setPcFocus(lease, focused);
				}
			},
			onError: error => this.reportError('setPcFocus', error),
		}, timer);
		this.listeners.add(options.onDidLockScreen(() => { this.heartbeat.setScreenLocked(true); this.heartbeat.reportNow(); }));
		this.listeners.add(options.onDidUnlockScreen(() => { this.heartbeat.setScreenLocked(false); this.heartbeat.reportNow(); }));
		this.listeners.add(options.onDidChangeFocus(() => this.heartbeat.reportNow()));
		this.listeners.add(options.onDidChangeVisibility(() => this.heartbeat.reportNow()));
	}

	setEnabled(enabled: boolean): void {
		this.heartbeat.setEnabled(enabled);
	}

	setEnabledAndSynchronize(enabled: boolean): void {
		this.heartbeat.setEnabled(enabled);
		void this.options.setSharedProcessEnabled(enabled).catch(error => this.reportError('setEnabled', error));
	}

	reportNow(): void {
		this.heartbeat.reportNow();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.heartbeat.dispose();
		this.listeners.dispose();
		void this.options.resolveWindowLease().then(
			lease => this.options.setPcFocus(lease, false),
			error => this.reportError('setPcFocus', error),
		).catch(error => this.reportError('setPcFocus', error));
	}

	private reportError(operation: 'setPcFocus' | 'setEnabled', error: Error): void {
		this.options.onError?.(operation, error);
	}
}
