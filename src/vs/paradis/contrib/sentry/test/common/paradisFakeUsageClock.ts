/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisUsageClock } from '../../common/paradisUsageTally.js';

/** 時刻とタイマーを手で進める時計。 */
export class ParadisFakeUsageClock implements IParadisUsageClock {
	time = 1_000;
	private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
	private next = 1;
	now(): number {
		return this.time;
	}
	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.next++;
		this.timers.set(id, { at: this.time + ms, callback });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}
	advance(ms: number): void {
		this.time += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.time) {
				this.timers.delete(id);
				timer.callback();
			}
		}
	}
	get pending(): number {
		return this.timers.size;
	}
}
