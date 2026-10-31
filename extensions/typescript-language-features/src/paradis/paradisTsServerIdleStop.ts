/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Setting that holds the idle time in minutes before TS Server is stopped. 0 turns the stop off. */
export const paradisIdleStopMinutesSection = 'paradis.typescript';
export const paradisIdleStopMinutesKey = 'idleStopMinutes';
export const paradisIdleStopMinutesDefault = 5;

/** Upper bound so the timer stays below the 32-bit limit of setTimeout (one day). */
const maxIdleStopMinutes = 24 * 60;

/**
 * What the idle stop needs from the extension. Kept free of the `vscode` module so that the
 * decision can be tested on its own.
 */
export interface IParadisTsServerIdleStopHost {
	/** Number of open documents (models) that TS Server would be asked about. */
	countDocuments(): number;
	/** Whether TS Server was ever started in this extension host. A window that never opened JS/TS has none. */
	isStarted(): boolean;
	/** Stops TS Server. Returns false when it was not running. */
	stop(): boolean;
	/** The configured idle time in minutes. */
	getIdleStopMinutes(): number | undefined;
	setTimeout(callback: () => void, milliseconds: number): IParadisIdleStopTimer;
}

export interface IParadisIdleStopTimer {
	cancel(): void;
}

/**
 * Normalizes the setting: anything that is not a positive number disables the stop.
 * @returns the delay in milliseconds, or undefined when the stop is off.
 */
export function paradisIdleStopDelay(minutes: number | undefined): number | undefined {
	if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
		return undefined;
	}
	return Math.min(minutes, maxIdleStopMinutes) * 60 * 1000;
}

/**
 * Stops TS Server once no JS/TS document has been open for the configured time.
 *
 * Call {@link update} whenever documents open or close, the setting changes, or the server starts.
 * The server is started again by the service client on its next request (opening a file, a rename, ...).
 */
export class ParadisTsServerIdleStop {

	private timer: IParadisIdleStopTimer | undefined;

	constructor(private readonly host: IParadisTsServerIdleStopHost) { }

	public update(): void {
		this.cancel();
		const delay = this.canStop();
		if (delay === undefined) {
			return;
		}
		this.timer = this.host.setTimeout(() => {
			this.timer = undefined;
			// Documents or the setting may have changed without an event reaching us; check again.
			if (this.canStop() !== undefined) {
				this.host.stop();
			}
		}, delay);
	}

	public dispose(): void {
		this.cancel();
	}

	private canStop(): number | undefined {
		const delay = paradisIdleStopDelay(this.host.getIdleStopMinutes());
		if (delay === undefined || !this.host.isStarted() || this.host.countDocuments() > 0) {
			return undefined;
		}
		return delay;
	}

	private cancel(): void {
		this.timer?.cancel();
		this.timer = undefined;
	}
}
