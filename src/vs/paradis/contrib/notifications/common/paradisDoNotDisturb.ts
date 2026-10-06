/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// おやすみモード（通知の一括ミュート）の持続時間の選択肢と、残り時間の表示整形。
// ステータスバーのクイックトグルと通知設定ダイアログのセクションが同じ選択肢を出すため、
// どちらのレイヤーからも参照できる common に置く。

import { localize } from '../../../../nls.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { PARADIS_DO_NOT_DISTURB_DURATION_IDS, ParadisDoNotDisturbDurationId, paradisDoNotDisturbRemaining, paradisResolveDoNotDisturbUntil } from './paradisDoNotDisturbRules.js';

/** The DND snapshot that an owner rendered during a controller refresh. */
export interface IParadisDoNotDisturbRefreshState {
	readonly enabled: boolean;
	readonly until: number | undefined;
}

/**
 * Host timer seam for the refresh controller.
 *
 * `set` must return before invoking `callback`. Returned handles may be
 * `undefined`, but must remain stable under strict equality and must not be
 * `NaN`, so a late callback can be matched to the reservation that owns it.
 */
export interface IParadisDoNotDisturbRefreshTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

/** Synchronous clock and timer dependencies used to create a refresh controller. */
export interface IParadisDoNotDisturbRefreshControllerOptions {
	readonly now?: () => number;
	readonly timer?: IParadisDoNotDisturbRefreshTimer;
}

/** Creates a cold controller for one synchronously rendered DND surface. */
export type ParadisDoNotDisturbRefreshControllerFactory = (
	refresh: (renderNow: number) => IParadisDoNotDisturbRefreshState,
) => ParadisDoNotDisturbRefreshController;

/** Returns the delay before a DND surface must read and render a fresh snapshot. */
export function paradisGetDoNotDisturbRefreshDelay(state: IParadisDoNotDisturbRefreshState, now: number): number | undefined {
	if (!state.enabled || state.until === undefined) {
		return undefined;
	}
	if (!Number.isFinite(state.until) || !Number.isFinite(now)) {
		return 60_000;
	}
	return Math.max(0, Math.min(60_000, state.until - now));
}

/**
 * Owns the single deadline-aware refresh timeout for one DND surface.
 *
 * Construction is cold: it neither renders nor starts a timer. The owner must
 * register its change listeners before calling {@link refresh} explicitly for
 * the initial synchronous render. The owner callback and clock are synchronous;
 * any exception they or the timer seam throw propagates to the caller.
 *
 * An owner that returns a finite expired deadline must read through the DND
 * settings getter, whose normalization guarantees that the next read returns
 * OFF. Repeatedly returning the same expired snapshot violates this contract.
 */
export class ParadisDoNotDisturbRefreshController implements IDisposable {
	private timerHandle: unknown;
	private timerScheduled = false;
	private generation = 0;
	private disposed = false;

	constructor(
		private readonly refreshCallback: (renderNow: number) => IParadisDoNotDisturbRefreshState,
		private readonly now: () => number,
		private readonly timer: IParadisDoNotDisturbRefreshTimer,
	) { }

	/** Cancels the prior reservation, renders synchronously, and schedules at most one new timeout. */
	refresh(): void {
		if (this.disposed) {
			return;
		}
		this.clearTimer();
		const generation = ++this.generation;
		const state = this.refreshCallback(this.now());
		if (this.disposed || generation !== this.generation) {
			return;
		}
		const delay = paradisGetDoNotDisturbRefreshDelay(state, this.now());
		if (delay === undefined) {
			return;
		}
		const handle = this.timer.set(() => {
			if (this.disposed || generation !== this.generation || !this.timerScheduled || this.timerHandle !== handle) {
				return;
			}
			this.timerScheduled = false;
			this.refresh();
		}, delay);
		this.timerHandle = handle;
		this.timerScheduled = true;
	}

	/** Invalidates callbacks and synchronously clears the pending timeout. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation++;
		this.clearTimer();
	}

	private clearTimer(): void {
		if (!this.timerScheduled) {
			return;
		}
		const handle = this.timerHandle;
		this.timerScheduled = false;
		this.timer.clear(handle);
	}
}

const defaultRefreshTimer: IParadisDoNotDisturbRefreshTimer = {
	set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Creates a cold DND refresh controller without performing the initial refresh. */
export function paradisCreateDoNotDisturbRefreshController(
	refresh: (renderNow: number) => IParadisDoNotDisturbRefreshState,
	options: IParadisDoNotDisturbRefreshControllerOptions = {},
): ParadisDoNotDisturbRefreshController {
	return new ParadisDoNotDisturbRefreshController(refresh, options.now ?? Date.now, options.timer ?? defaultRefreshTimer);
}

/** ステータスバーのクリック先。Quick Pick で持続時間を選ぶ。 */
export const PARADIS_DO_NOT_DISTURB_SELECT_COMMAND = 'paradis.notifications.selectDoNotDisturb';

export { paradisNextMorning } from './paradisDoNotDisturbRules.js';

export interface IParadisDoNotDisturbDuration {
	readonly id: ParadisDoNotDisturbDurationId;
	readonly label: string;
	/** 解除予定時刻（epoch ms）。undefined は「自分でオフにするまで」。 */
	readonly resolveUntil: (now: number) => number | undefined;
}

const DURATION_LABELS: Readonly<Record<ParadisDoNotDisturbDurationId, string>> = {
	// allow-any-unicode-next-line
	minutes30: localize('paradis.dnd.duration.minutes30', "30分"),
	// allow-any-unicode-next-line
	hours1: localize('paradis.dnd.duration.hours1', "1時間"),
	// allow-any-unicode-next-line
	morning: localize('paradis.dnd.duration.morning', "朝まで（7:00）"),
	// allow-any-unicode-next-line
	manual: localize('paradis.dnd.duration.manual', "自分でオフにするまで"),
};

/** 選択肢と計算はモバイルアプリと共通（`paradisDoNotDisturbRules.ts`）。ここでは文言だけを足す。 */
export const PARADIS_DO_NOT_DISTURB_DURATIONS: readonly IParadisDoNotDisturbDuration[] = PARADIS_DO_NOT_DISTURB_DURATION_IDS.map(id => ({
	id,
	label: DURATION_LABELS[id],
	resolveUntil: (now: number) => paradisResolveDoNotDisturbUntil(id, now),
}));

/**
 * 残り時間を「2時間5分」「30分」のように整形する。1分未満は「まもなく」。
 * `until` が undefined（自分でオフにするまで）の場合は undefined を返す。
 */
export function paradisFormatDoNotDisturbRemaining(until: number | undefined, now: number): string | undefined {
	const remaining = paradisDoNotDisturbRemaining(until, now);
	switch (remaining?.kind) {
		case undefined:
			return undefined;
		case 'soon':
			// allow-any-unicode-next-line
			return localize('paradis.dnd.remaining.soon', "まもなく");
		case 'minutes':
			// allow-any-unicode-next-line
			return localize('paradis.dnd.remaining.minutes', "{0}分", remaining.minutes);
		case 'hours':
			// allow-any-unicode-next-line
			return localize('paradis.dnd.remaining.hours', "{0}時間", remaining.hours);
		case 'hoursMinutes':
			// allow-any-unicode-next-line
			return localize('paradis.dnd.remaining.hoursMinutes', "{0}時間{1}分", remaining.hours, remaining.minutes);
	}
}
