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

/** 「朝まで」の朝の定義（ローカル時刻）。 */
const MORNING_HOUR = 7;

export interface IParadisDoNotDisturbDuration {
	readonly id: string;
	readonly label: string;
	/** 解除予定時刻（epoch ms）。undefined は「自分でオフにするまで」。 */
	readonly resolveUntil: (now: number) => number | undefined;
}

/**
 * `now` から見て次に訪れる朝 MORNING_HOUR 時の epoch ms。
 * 深夜（0時〜7時）にオンにした場合はその日の朝、それ以外は翌日の朝になる。
 */
export function paradisNextMorning(now: number): number {
	const target = new Date(now);
	target.setHours(MORNING_HOUR, 0, 0, 0);
	if (target.getTime() <= now) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

export const PARADIS_DO_NOT_DISTURB_DURATIONS: readonly IParadisDoNotDisturbDuration[] = [
	{
		id: 'minutes30',
		// allow-any-unicode-next-line
		label: localize('paradis.dnd.duration.minutes30', "30分"),
		resolveUntil: now => now + 30 * 60 * 1000,
	},
	{
		id: 'hours1',
		// allow-any-unicode-next-line
		label: localize('paradis.dnd.duration.hours1', "1時間"),
		resolveUntil: now => now + 60 * 60 * 1000,
	},
	{
		id: 'morning',
		// allow-any-unicode-next-line
		label: localize('paradis.dnd.duration.morning', "朝まで（7:00）"),
		resolveUntil: now => paradisNextMorning(now),
	},
	{
		id: 'manual',
		// allow-any-unicode-next-line
		label: localize('paradis.dnd.duration.manual', "自分でオフにするまで"),
		resolveUntil: () => undefined,
	},
];

/**
 * 残り時間を「2時間5分」「30分」のように整形する。1分未満は「まもなく」。
 * `until` が undefined（自分でオフにするまで）の場合は undefined を返す。
 */
export function paradisFormatDoNotDisturbRemaining(until: number | undefined, now: number): string | undefined {
	if (until === undefined) {
		return undefined;
	}
	const minutes = Math.ceil((until - now) / 60000);
	if (minutes <= 0) {
		// allow-any-unicode-next-line
		return localize('paradis.dnd.remaining.soon', "まもなく");
	}
	if (minutes < 60) {
		// allow-any-unicode-next-line
		return localize('paradis.dnd.remaining.minutes', "{0}分", minutes);
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0
		// allow-any-unicode-next-line
		? localize('paradis.dnd.remaining.hours', "{0}時間", hours)
		// allow-any-unicode-next-line
		: localize('paradis.dnd.remaining.hoursMinutes', "{0}時間{1}分", hours, rest);
}
