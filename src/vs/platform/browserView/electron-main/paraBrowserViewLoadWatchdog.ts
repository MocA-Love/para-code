/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WebContents } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { IBrowserViewLoadError } from '../common/browserView.js';
import { IParaBrowserViewLoadStall, ParaBrowserViewLoadStallOutcome, ParaBrowserViewLoadStallResponse } from '../common/paraBrowserViewLoadStall.js';

/**
 * How long the main frame may stay uncommitted before we ask whether to keep waiting.
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
 * seconds is normal for a cold start on a large project. A person is asked
 * rather than cut off (they may know the server is still compiling); only a tab
 * nobody can answer for is stopped outright.
 */
export const PARA_BROWSER_VIEW_LOAD_TIMEOUT = 60_000;

/**
 * How many times a person may choose to keep waiting for one load. Past this the load is stopped
 * like an unanswered agent tab: ten more minutes without a single response header is not a cold
 * compile any more.
 */
export const PARA_BROWSER_VIEW_LOAD_MAX_WAITS = 10;

/**
 * Chromium's `net::ERR_TIMED_OUT`. We report the stall using Chromium's own
 * error code so it reaches the error overlay as an ordinary load error.
 */
const PARA_ERR_TIMED_OUT = -7;

/**
 * The page as written to the log: without the query, the fragment or the credentials, which can
 * hold sign-in values. Non-hierarchical URLs (`data:`, `blob:`) keep only their scheme.
 */
function paraLoggableURL(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.host ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : parsed.protocol;
	} catch {
		return '[unparsable URL]';
	}
}

/** The part of `WebContents` the watchdog uses (tests pass a fake). */
export type ParaBrowserViewLoadWatchdogWebContents = Pick<WebContents, 'on' | 'removeListener' | 'isDestroyed' | 'isLoadingMainFrame' | 'getURL' | 'stop' | 'getOSProcessId'>;

/** What the view knows about itself when a load stalls. Read lazily, at the moment of the stall. */
export interface IParaBrowserViewLoadStallContext {
	/** The authority of the window that hosts the view (`ssh-remote+…`), or `undefined` for a local window. */
	readonly remoteAuthority: string | undefined;
	/** Whether the view's requests go through the remote tunnel proxy. */
	readonly tunnelProxy: boolean;
	/** Whether an agent opened the tab (see {@link paraSetBrowserViewAgentTab}); nobody may be watching it. */
	readonly agentTab: boolean;
}

/** One stalled load, as handed to the reporter when it ends. Main-process only; the reporter decides what leaves it. */
export interface IParaBrowserViewLoadStallReport extends IParaBrowserViewLoadStallContext {
	readonly outcome: ParaBrowserViewLoadStallOutcome;
	readonly url: string;
	/** From the navigation starting to the stall ending. */
	readonly elapsedMs: number;
	readonly waits: number;
	/** What {@link IParaBrowserViewLoadStallReporter.sample} returned at the first stall. */
	readonly sample: Readonly<Record<string, number>>;
}

/**
 * Receives stalled loads (Sentry, wired from `vs/paradis`). `sample` is called when the load first
 * stalls, so memory figures describe the moment it stopped answering rather than the moment it ended.
 */
export interface IParaBrowserViewLoadStallReporter {
	sample(webContents: ParaBrowserViewLoadWatchdogWebContents): Readonly<Record<string, number>>;
	report(report: IParaBrowserViewLoadStallReport): void;
}

let reporter: IParaBrowserViewLoadStallReporter | undefined;

/** Connects stalled-load reports to a sink. Set once by the process; replaced by tests. */
export function paraSetBrowserViewLoadStallReporter(value: IParaBrowserViewLoadStallReporter | undefined): void {
	reporter = value;
}

interface IParaLoadStallController {
	readonly stall: IParaBrowserViewLoadStall | undefined;
	respond(response: ParaBrowserViewLoadStallResponse): boolean;
}

const controllers = new Map<string, IParaLoadStallController>();
/** Views an agent opened for itself, as told by the workbench's agent tab ledger. */
const agentTabs = new Set<string>();

/**
 * Marks a view as opened by an agent (or no longer), so a stall in it is stopped instead of asking a
 * person. Told by the workbench: the storage scope cannot tell, since agents also open named
 * profile tabs and a person's "Open and Share" copy lives in the agent storage.
 */
export function paraSetBrowserViewAgentTab(viewId: string, agentTab: boolean): void {
	if (agentTab) {
		agentTabs.add(viewId);
	} else {
		agentTabs.delete(viewId);
	}
}

/** The view each child view was opened from (target=_blank, window.open, middle click), as recorded by the CDP target service. */
const openerViewIds = new Map<string, string>();

/**
 * Records the view a child view was opened from (or forgets it). A child of an agent tab is treated
 * as an agent tab too: it carries the same `user` owner, so neither the ledger nor the owner can tell
 * it apart, and nobody is watching it either. The mark follows the opener: it is gone once the
 * opener leaves the ledger or the child closes.
 */
export function paraSetBrowserViewOpener(viewId: string, openerViewId: string | undefined): void {
	if (openerViewId === undefined || openerViewId === viewId) {
		openerViewIds.delete(viewId);
	} else {
		openerViewIds.set(viewId, openerViewId);
	}
}

/**
 * Whether the view, or a view it was (transitively) opened from, is marked as an agent tab. The
 * browser extension tab model uses it too, so extensions never see an agent's tabs.
 */
export function paraIsAgentTabOrChild(viewId: string): boolean {
	const visited = new Set<string>();
	let current: string | undefined = viewId;
	while (current !== undefined && !visited.has(current)) {
		if (agentTabs.has(current)) {
			return true;
		}
		visited.add(current);
		current = openerViewIds.get(current);
	}
	return false;
}
const onDidChangeStallEmitter = new Emitter<{ readonly viewId: string; readonly stall: IParaBrowserViewLoadStall | undefined }>();

/** Fires when a view starts or stops asking whether to keep waiting. */
export const paraOnDidChangeBrowserViewLoadStall: Event<{ readonly viewId: string; readonly stall: IParaBrowserViewLoadStall | undefined }> = onDidChangeStallEmitter.event;

/** The question a view is asking right now, if any. */
export function paraGetBrowserViewLoadStall(viewId: string): IParaBrowserViewLoadStall | undefined {
	return controllers.get(viewId)?.stall;
}

/** Answers a view's question. Returns false when that view is not asking (anymore). */
export function paraRespondToBrowserViewLoadStall(viewId: string, response: ParaBrowserViewLoadStallResponse): boolean {
	return controllers.get(viewId)?.respond(response) ?? false;
}

export interface IParaBrowserViewLoadWatchdogOptions {
	/** The id the renderer knows the view by; the question is looked up by it. */
	readonly viewId: string;
	/**
	 * Read at each expiry. `agentOwner`: the view is owned by an agent (upstream's open_browser tool
	 * and the tabs those open), which the agent tab ledger never sees.
	 */
	readonly context: () => Omit<IParaBrowserViewLoadStallContext, 'agentTab'> & { readonly agentOwner: boolean };
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

/**
 * Notice main-frame loads that stall before the response ever begins.
 *
 * Chromium will happily wait forever for a server that accepted the TCP
 * connection and then said nothing — a remote agent tunnel wedged mid-handshake
 * produces exactly that. No `did-fail-load` is ever emitted, so the view spins
 * indefinitely with no way for the user to tell that anything is wrong.
 *
 * When the budget runs out the view asks the person whether to keep waiting
 * (see {@link paraGetBrowserViewLoadStall}): waiting grants another budget,
 * stopping fails the load into the ordinary error path through `onStall`. A tab
 * in the agent-only storage has no one to ask, so it is stopped right away.
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
	webContents: ParaBrowserViewLoadWatchdogWebContents,
	logService: ILogService,
	onStall: (error: IBrowserViewLoadError) => void,
	options: IParaBrowserViewLoadWatchdogOptions
): IDisposable {
	const timeoutMs = options.timeoutMs ?? PARA_BROWSER_VIEW_LOAD_TIMEOUT;
	const now = options.now ?? Date.now;
	const viewId = options.viewId;

	let timer: Timeout | undefined;
	/** The load being watched. `sample` is set once it has stalled at least once. */
	let episode: {
		url: string;
		readonly startedAt: number;
		waits: number;
		sample?: Readonly<Record<string, number>>;
		context?: IParaBrowserViewLoadStallContext;
	} | undefined;
	let stall: IParaBrowserViewLoadStall | undefined;

	const setStall = (value: IParaBrowserViewLoadStall | undefined) => {
		if (stall === value) {
			return;
		}
		stall = value;
		onDidChangeStallEmitter.fire({ viewId, stall });
	};

	const clearTimer = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	/** Ends the watched load; a load that stalled is reported with how it ended. */
	const finish = (outcome: ParaBrowserViewLoadStallOutcome) => {
		clearTimer();
		const ended = episode;
		episode = undefined;
		setStall(undefined);
		if (ended?.sample && ended.context) {
			try {
				reporter?.report({ ...ended.context, outcome, url: ended.url, elapsedMs: Math.max(0, now() - ended.startedAt), waits: ended.waits, sample: ended.sample });
			} catch {
				// Diagnostics must never change the behavior they observe.
			}
		}
	};

	const stop = (outcome: ParaBrowserViewLoadStallOutcome) => {
		const url = episode?.url ?? '';
		const elapsedMs = episode ? Math.max(0, now() - episode.startedAt) : timeoutMs;
		finish(outcome);
		logService.warn(`[ParaBrowserView] ${paraLoggableURL(url)} did not commit within ${elapsedMs}ms; stopping the load and reporting it as a timeout (${outcome}).`);
		// Report before stopping. `stop()` makes Chromium emit
		// `did-fail-load` with ERR_ABORTED, which the view treats as a
		// user-initiated stop and reports as "no longer loading"; having
		// the error in place first means that event carries it rather than
		// briefly clearing it.
		onStall({
			url,
			errorCode: PARA_ERR_TIMED_OUT,
			// allow-any-unicode-next-line
			errorDescription: localize('paraBrowserView.loadTimedOut', "Para Code が {0} 秒待ってもサーバーから応答が無かったため、読み込みを止めました", Math.round(elapsedMs / 1000)),
		});
		webContents.stop();
	};

	const startTimer = () => {
		clearTimer();
		timer = setTimeout(() => {
			timer = undefined;
			// Only act on a load that is still running. Arming is cheap but disarming depends on
			// observing one of a handful of events, and a load can end through a path this
			// watchdog does not watch (a renderer crash is one). Asking Chromium directly means
			// a missed disarm can no longer drop a full-pane error over a page that finished
			// painting long ago.
			if (!episode || webContents.isDestroyed() || !webContents.isLoadingMainFrame()) {
				finish('abandoned');
				return;
			}
			// Read on every expiry: the ledger may mark the tab, or the owner change, after the load started.
			let agentOwner = false;
			try {
				const { remoteAuthority, tunnelProxy, agentOwner: owned } = options.context();
				agentOwner = owned;
				episode.context = { remoteAuthority, tunnelProxy, agentTab: false };
			} catch {
				episode.context ??= { remoteAuthority: undefined, tunnelProxy: false, agentTab: false };
			}
			if (!episode.sample) {
				try {
					episode.sample = reporter?.sample(webContents) ?? {};
				} catch {
					episode.sample = {};
				}
			}
			const agentTab = paraIsAgentTabOrChild(viewId) || agentOwner;
			episode.context = { ...episode.context, agentTab };
			if (agentTab) {
				stop('agent-stopped');
				return;
			}
			if (episode.waits >= PARA_BROWSER_VIEW_LOAD_MAX_WAITS) {
				stop('wait-limit');
				return;
			}
			logService.info(`[ParaBrowserView] ${paraLoggableURL(episode.url)} has not committed after ${now() - episode.startedAt}ms; asking whether to keep waiting.`);
			const askedAt = now();
			setStall({ elapsedMs: Math.max(0, askedAt - episode.startedAt), askedAt, waits: episode.waits });
		}, timeoutMs);
	};

	const arm = (url: string, redirect: boolean) => {
		if (redirect && episode) {
			// A redirect is a response from the server we were waiting on, and a fresh request
			// to the next one: give it its own budget but keep counting the navigation's time.
			if (episode.sample) {
				const { startedAt } = episode;
				finish('responded');
				episode = { url, startedAt, waits: 0 };
			} else {
				episode.url = url;
			}
			setStall(undefined);
			startTimer();
			return;
		}
		finish('abandoned');
		episode = { url, startedAt: now(), waits: 0 };
		startTimer();
	};

	const controller: IParaLoadStallController = {
		get stall() { return stall; },
		respond(response) {
			if (!episode || !stall) {
				return false;
			}
			if (response === 'stop') {
				stop('stopped');
				return true;
			}
			episode.waits++;
			setStall(undefined);
			startTimer();
			return true;
		},
	};
	controllers.set(viewId, controller);

	const onDidStartLoading = () => {
		// Only main-frame loads spin the view; subframe activity is not ours to police. The
		// navigation usually arms first with the real destination; `getURL()` here is still the
		// page being left, so it only stands in when no navigation was seen.
		if (!episode && webContents.isLoadingMainFrame()) {
			arm(webContents.getURL(), false);
		}
	};
	const onDidStartNavigation = (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
		// Same-document navigations (fragments, pushState) never load anything.
		if (details.isMainFrame && !details.isSameDocument) {
			arm(details.url, false);
		}
	};
	const onDidRedirectNavigation = (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
		if (details.isMainFrame && !details.isSameDocument) {
			arm(details.url, true);
		}
	};
	const onDidFailLoad = (_event: unknown, errorCode: number, _errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
		if (isMainFrame) {
			// ERR_ABORTED (-3): stopped from the toolbar, or replaced by another navigation.
			finish(errorCode === -3 ? 'abandoned' : 'failed');
		}
	};
	// The main frame committed: the response has started arriving.
	const onDidNavigate = () => finish('responded');
	const onDidStopLoading = () => finish('abandoned');
	const onDidFinishLoad = () => finish('responded');
	// A renderer crash ends the load without any of the events above. The view already records
	// the crash as its error; staying armed would let this watchdog overwrite it with a timeout
	// and hide what actually happened.
	const onGone = () => finish('abandoned');

	webContents.on('did-navigate', onDidNavigate);
	webContents.on('did-stop-loading', onDidStopLoading);
	webContents.on('did-finish-load', onDidFinishLoad);
	webContents.on('did-fail-load', onDidFailLoad);
	webContents.on('render-process-gone', onGone);
	webContents.on('destroyed', onGone);
	webContents.on('did-start-loading', onDidStartLoading);
	webContents.on('did-start-navigation', onDidStartNavigation);
	webContents.on('did-redirect-navigation', onDidRedirectNavigation);

	return toDisposable(() => {
		finish('abandoned');
		if (controllers.get(viewId) === controller) {
			controllers.delete(viewId);
			agentTabs.delete(viewId);
			openerViewIds.delete(viewId);
		}
		if (webContents.isDestroyed()) {
			return;
		}
		webContents.removeListener('did-navigate', onDidNavigate);
		webContents.removeListener('did-stop-loading', onDidStopLoading);
		webContents.removeListener('did-finish-load', onDidFinishLoad);
		webContents.removeListener('did-fail-load', onDidFailLoad);
		webContents.removeListener('render-process-gone', onGone);
		webContents.removeListener('destroyed', onGone);
		webContents.removeListener('did-start-loading', onDidStartLoading);
		webContents.removeListener('did-start-navigation', onDidStartNavigation);
		webContents.removeListener('did-redirect-navigation', onDidRedirectNavigation);
	});
}
