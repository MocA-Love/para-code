/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisAgentTerminalHint, ParadisAgentTerminalHintParser } from './paradisAgentTerminalHints.js';

export type ParadisTerminalOutputConsumer = (data: string) => void;

export interface IParadisTerminalHintTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

export interface IParadisAgentTerminalHintConsumer extends IDisposable {
	readonly accept: ParadisTerminalOutputConsumer;
	reset(): void;
}

export interface IParadisTerminalRelayPendingState {
	suspended: boolean;
	droppedWhileSuspended: boolean;
	pending: string[];
	pendingChars: number;
	readonly coalesceTimer: unknown;
}

export const PARADIS_TERMINAL_RELAY_FLUSH_CHARS = 64 * 1024;

/**
 * Terminal outputのconsumer構成をlistener登録時に確定する。
 * 単独consumerはその関数を直接返し、毎chunkのoptional分岐とwrapper呼び出しを避ける。
 */
export function paradisCreateTerminalOutputConsumer(
	relayConsumer: ParadisTerminalOutputConsumer | undefined,
	hintConsumer: ParadisTerminalOutputConsumer | undefined,
): ParadisTerminalOutputConsumer | undefined {
	if (relayConsumer === undefined) {
		return hintConsumer;
	}
	if (hintConsumer === undefined) {
		return relayConsumer;
	}
	return data => {
		relayConsumer(data);
		hintConsumer(data);
	};
}

export function paradisCreateAgentTerminalHintConsumer(
	parser: ParadisAgentTerminalHintParser,
	onHint: (hint: IParadisAgentTerminalHint) => void,
	timer: IParadisTerminalHintTimer = {
		set: (callback, delayMs) => setTimeout(callback, delayMs),
		// valid-layersのbrowser checkerはWeb標準のnumeric handleとして型検査する。
		// castは型境界だけで、Nodeで返るobject handleもruntimeではそのままclearTimeoutへ渡る。
		clear: handle => globalThis.clearTimeout(handle as number),
	},
): IParadisAgentTerminalHintConsumer {
	let timerHandle: unknown;
	let scanDue = true;
	let disposed = false;
	const clearTimer = () => {
		if (timerHandle !== undefined) {
			timer.clear(timerHandle);
			timerHandle = undefined;
		}
	};
	const reset = () => {
		clearTimer();
		scanDue = true;
		parser.reset();
	};
	const arm = () => {
		clearTimer();
		timerHandle = timer.set(() => {
			timerHandle = undefined;
			if (!disposed) {
				scanDue = true;
			}
		}, 400);
	};
	return {
		accept: data => {
			if (disposed) {
				return;
			}
			parser.append(data);
			if (!scanDue) {
				return;
			}
			scanDue = false;
			const hint = parser.scan();
			arm();
			if (hint !== undefined) {
				onHint(hint);
			}
		},
		reset,
		dispose: () => {
			if (!disposed) {
				disposed = true;
				reset();
			}
		},
	};
}

/** Mobile terminal streamのproduction queue hot path。timer生成とflush本体はownerへ戻す。 */
export function paradisQueueTerminalRelayOutput(
	state: IParadisTerminalRelayPendingState,
	data: string,
	flush: () => void,
	scheduleFlush: () => void,
): void {
	if (state.suspended) {
		state.droppedWhileSuspended = true;
		return;
	}
	state.pending.push(data);
	state.pendingChars += data.length;
	if (state.pendingChars >= PARADIS_TERMINAL_RELAY_FLUSH_CHARS) {
		flush();
	} else if (state.coalesceTimer === undefined) {
		scheduleFlush();
	}
}
