/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebContents } from 'electron';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IBrowserViewLoadError } from '../common/browserView.js';

/**
 * How long the main frame may stay uncommitted before we treat the load as dead.
 *
 * This only covers the window between a main-frame navigation starting and the
 * response headers arriving; see {@link paraInstallBrowserViewLoadWatchdog} for
 * why that is the only phase we guard. Nothing is rendered yet during it, so the
 * whole budget is spent waiting on the server (or on whatever sits between us
 * and it) to say the first word.
 *
 * A minute is deliberately generous. Chromium does not time this phase out at
 * all, and the pages our users point the browser at are frequently local dev
 * servers that hold the very first request open while they compile — tens of
 * seconds is normal for a cold start on a large project, and cutting those off
 * would be a worse bug than the one this guards against.
 */
export const PARA_BROWSER_VIEW_LOAD_TIMEOUT = 60_000;

/**
 * Chromium's `net::ERR_TIMED_OUT`. We report the stall using Chromium's own
 * error code so it reaches the error overlay indistinguishable from a timeout
 * the network stack detected itself — which is exactly what it is.
 */
const PARA_ERR_TIMED_OUT = -7;

/**
 * Stop main-frame loads that stall before the response ever begins, and report
 * them through `onStall` so they surface as an ordinary load error.
 *
 * Chromium will happily wait forever for a server that accepted the TCP
 * connection and then said nothing — a remote agent tunnel wedged mid-handshake
 * produces exactly that. No `did-fail-load` is ever emitted, so the view spins
 * indefinitely with no way for the user to tell that anything is wrong.
 *
 * The watchdog is armed only for the phase between a main-frame navigation
 * starting and it committing (`did-navigate`, i.e. the response headers landed),
 * and it is disarmed the moment the load commits, finishes, or fails. Guarding
 * only this phase is what makes the watchdog safe: nothing has been painted yet,
 * so aborting can never replace visible content with an error page. A slow but
 * live transfer commits early and then streams for as long as it likes; a page
 * that renders and then stalls on one subresource is likewise left alone.
 */
export function paraInstallBrowserViewLoadWatchdog(
	webContents: WebContents,
	logService: ILogService,
	onStall: (error: IBrowserViewLoadError) => void,
	timeoutMs: number = PARA_BROWSER_VIEW_LOAD_TIMEOUT
): IDisposable {
	let timer: Timeout | undefined;
	let pendingURL: string | undefined;

	const disarm = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		pendingURL = undefined;
	};

	const arm = (url: string) => {
		disarm();
		pendingURL = url;
		timer = setTimeout(() => {
			timer = undefined;
			const url = pendingURL ?? '';
			pendingURL = undefined;

			// Only fail a load that is still running. Arming is cheap but disarming depends on
			// observing one of a handful of events, and a load can end through a path this
			// watchdog does not watch (a renderer crash is one). Asking Chromium directly means
			// a missed disarm can no longer drop a full-pane error over a page that finished
			// painting long ago.
			if (webContents.isDestroyed() || !webContents.isLoadingMainFrame()) {
				return;
			}

			logService.warn(`[ParaBrowserView] ${url} did not commit within ${timeoutMs}ms; stopping the load and reporting it as a timeout.`);

			// Report before stopping. `stop()` makes Chromium emit
			// `did-fail-load` with ERR_ABORTED, which the view treats as a
			// user-initiated stop and reports as "no longer loading"; having
			// the error in place first means that event carries it rather than
			// briefly clearing it.
			onStall({ url, errorCode: PARA_ERR_TIMED_OUT, errorDescription: 'ERR_TIMED_OUT' });
			webContents.stop();
		}, timeoutMs);
	};

	const onDidStartLoading = () => {
		// Only main-frame loads spin the view; subframe activity is not ours to police.
		if (webContents.isLoadingMainFrame()) {
			arm(webContents.getURL());
		}
	};
	const onDidStartNavigation = (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
		// Same-document navigations (fragments, pushState) never load anything.
		if (details.isMainFrame && !details.isSameDocument) {
			arm(details.url);
		}
	};
	const onDidRedirectNavigation = (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
		// A redirect is a fresh request to a different server: give it its own budget.
		if (details.isMainFrame && !details.isSameDocument) {
			arm(details.url);
		}
	};
	const onDidFailLoad = (_event: unknown, _errorCode: number, _errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
		if (isMainFrame) {
			disarm();
		}
	};

	// The main frame committed: the response has started arriving.
	webContents.on('did-navigate', disarm);
	webContents.on('did-stop-loading', disarm);
	webContents.on('did-finish-load', disarm);
	webContents.on('did-fail-load', onDidFailLoad);
	// A renderer crash ends the load without any of the events above. The view already records
	// the crash as its error; staying armed would let this watchdog overwrite it with a timeout
	// and hide what actually happened.
	webContents.on('render-process-gone', disarm);
	webContents.on('destroyed', disarm);
	webContents.on('did-start-loading', onDidStartLoading);
	webContents.on('did-start-navigation', onDidStartNavigation);
	webContents.on('did-redirect-navigation', onDidRedirectNavigation);

	return toDisposable(() => {
		disarm();
		if (webContents.isDestroyed()) {
			return;
		}
		webContents.removeListener('did-navigate', disarm);
		webContents.removeListener('did-stop-loading', disarm);
		webContents.removeListener('did-finish-load', disarm);
		webContents.removeListener('did-fail-load', onDidFailLoad);
		webContents.removeListener('render-process-gone', disarm);
		webContents.removeListener('destroyed', disarm);
		webContents.removeListener('did-start-loading', onDidStartLoading);
		webContents.removeListener('did-start-navigation', onDidStartNavigation);
		webContents.removeListener('did-redirect-navigation', onDidRedirectNavigation);
	});
}
