/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebContents } from 'electron';

/**
 * How long one capture may stay in flight before another may start. `capturePage` on a surface
 * that is not drawing can take a while or never settle; the nudge must not stay stuck behind it.
 */
export const PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS = 2_000;

/** After this many captures in a row miss the deadline, the view is no longer nudged this way. */
export const PARA_BROWSER_VIEW_CAPTURE_NUDGE_MAX_EXPIRED = 3;

/** The parts of the view's window this needs (a `BrowserWindow`). */
export interface IParaBrowserViewNudgeWindow {
	isDestroyed(): boolean;
	isFocused(): boolean;
	isVisible(): boolean;
	isMinimized(): boolean;
}

/**
 * Keeps a shown agent-bound view drawing while its window is minimized, hidden, or not in front
 * (behind another app, on another Space). Such a view is not drawn either, so viz stops sending it
 * BeginFrames the same way it does for a hidden view. Toggling its visibility would flash when the
 * window is in fact on screen, so this asks for a 1x1 capture instead: the capture path draws the
 * surface without changing what the user sees. At most one capture is in flight per view, and one
 * that has not settled within {@link PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS} no longer blocks the next.
 */
export class ParaBrowserViewCaptureNudge {
	private inFlightSince: number | undefined;
	/** Captures in a row that never settled within the deadline. */
	private consecutiveExpired = 0;
	private disabled = false;

	constructor(private readonly now: () => number = Date.now) { }

	/** @returns whether a capture was requested. */
	nudge(win: IParaBrowserViewNudgeWindow | undefined, webContents: Pick<WebContents, 'capturePage'>): boolean {
		if (this.disabled || !win || win.isDestroyed()) {
			return false;
		}
		if (win.isFocused() && win.isVisible() && !win.isMinimized()) {
			return false;
		}
		const startedAt = this.now();
		if (this.inFlightSince !== undefined) {
			if (startedAt - this.inFlightSince < PARA_BROWSER_VIEW_CAPTURE_NUDGE_DEADLINE_MS) {
				return false;
			}
			// The previous capture never settled. After a few in a row, capturing does not work for
			// this view; stop piling up captures that never complete.
			if (++this.consecutiveExpired >= PARA_BROWSER_VIEW_CAPTURE_NUDGE_MAX_EXPIRED) {
				this.disabled = true;
				return false;
			}
		}
		this.inFlightSince = startedAt;
		const settle = () => {
			if (this.inFlightSince === startedAt) {
				this.inFlightSince = undefined;
				this.consecutiveExpired = 0;
			}
		};
		try {
			webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }).then(settle, settle);
		} catch {
			settle();
			return false;
		}
		return true;
	}
}
