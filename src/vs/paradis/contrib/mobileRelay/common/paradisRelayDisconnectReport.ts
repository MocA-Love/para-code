/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisRelayDisconnectReport {
	readonly operation: string;
	readonly message: string;
	readonly extras: Record<string, unknown>;
}

export interface IParadisRelayDisconnectReportClock {
	readonly now: () => number;
	readonly setTimeout: (callback: () => void, delay: number) => IDisposable;
}

export interface IParadisRelayDisconnectReporterOptions {
	readonly reportDelayMs: number;
	readonly reportAfterAttempts: number;
	readonly getReconnectAttempt: () => number;
	readonly report: (report: IParadisRelayDisconnectReport) => void;
	readonly clock?: IParadisRelayDisconnectReportClock;
}

interface PendingDisconnectReport {
	readonly operation: string;
	readonly message: string;
	readonly extras: Record<string, unknown>;
	readonly at: number;
	readonly attemptAtArm: number;
}

const defaultClock: IParadisRelayDisconnectReportClock = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => {
		const handle = setTimeout(callback, delay);
		return toDisposable(() => clearTimeout(handle));
	},
};

/**
 * Reports a relay disconnect only when it remains unrecovered across both the grace period and
 * the configured number of reconnect attempts. The first failure owns the resulting report.
 */
export class ParadisRelayDisconnectReporter implements IDisposable {
	private readonly clock: IParadisRelayDisconnectReportClock;
	private pending: PendingDisconnectReport | undefined;
	private timer: IDisposable | undefined;
	private isDisposed = false;

	constructor(private readonly options: IParadisRelayDisconnectReporterOptions) {
		this.clock = options.clock ?? defaultClock;
	}

	arm(operation: string, message: string, extras: Record<string, unknown>): void {
		if (this.isDisposed || this.pending !== undefined || this.timer !== undefined) {
			return;
		}
		this.pending = {
			operation,
			message,
			extras,
			at: this.clock.now(),
			attemptAtArm: this.options.getReconnectAttempt(),
		};
		this.schedule();
	}

	recovered(): void {
		this.cancel();
	}

	/** Applies the relay service lifecycle; disabling always cancels a pending incident. */
	setEnabled(enabled: boolean): void {
		if (!enabled) {
			this.cancel();
		}
	}

	dispose(): void {
		if (this.isDisposed) {
			return;
		}
		this.isDisposed = true;
		this.cancel();
	}

	private schedule(): void {
		this.timer = this.clock.setTimeout(() => {
			const completedTimer = this.timer;
			this.timer = undefined;
			completedTimer?.dispose();
			const pending = this.pending;
			if (pending === undefined || this.isDisposed) {
				this.pending = undefined;
				return;
			}
			const reconnectCount = this.options.getReconnectAttempt();
			const failedAttempts = reconnectCount - pending.attemptAtArm;
			if (failedAttempts < this.options.reportAfterAttempts) {
				this.schedule();
				return;
			}
			this.pending = undefined;
			this.options.report({
				operation: pending.operation,
				message: pending.message,
				extras: {
					...pending.extras,
					duration_ms: this.clock.now() - pending.at,
					reconnect_count: reconnectCount,
					attempt: failedAttempts,
				},
			});
		}, this.options.reportDelayMs);
	}

	private cancel(): void {
		this.timer?.dispose();
		this.timer = undefined;
		this.pending = undefined;
	}
}
