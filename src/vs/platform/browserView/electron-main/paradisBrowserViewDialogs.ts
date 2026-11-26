/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Two page dialogs the built-in browser could not offer to an agent that drives a tab over CDP:
//
// 1. window.prompt(). Electron does not implement it (the call throws), so a page that asks with prompt()
//    stopped with an exception and nobody could answer. The preload (preload-browserView.ts, PARA-PATCH)
//    replaces window.prompt with a confirm() that stands in for it; this file keeps the default value and
//    reads the text a CDP client answered with from `Page.javascriptDialogClosed`. See
//    ../common/paradisBrowserViewPrompt.ts for the whole flow.
//
// 2. beforeunload ("Leave site?"). Electron decides it synchronously in `will-prevent-unload`, before any CDP
//    client hears about the dialog, and browserView.ts always lets the page leave. A caller that wants to keep
//    the page must say so before the navigation starts: {@link paradisArmKeepPage} keeps the page for the next
//    beforeunload of that tab only, for a short time. Nothing else (closing the tab, the user's own navigation
//    after the time passed) is affected, so a page cannot use this to trap the user.

import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, paradisPromptStandInMessage } from '../common/paradisBrowserViewPrompt.js';

/** Longest message / default value / answer passed on (a page can call prompt() with any string). */
const PROMPT_TEXT_LIMIT = 10_000;

/**
 * How long the result waits for `Page.javascriptDialogClosed` when the page reports the confirm as accepted
 * before the event arrived (the event normally arrives first). After that the default value is the answer.
 */
export const PARADIS_PROMPT_CLOSE_WAIT_MS = 500;

function clip(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, PROMPT_TEXT_LIMIT) : '';
}

/**
 * One tab's window.prompt() state. A prompt is three steps in the page, all on its blocked main thread:
 * {@link begin} (before the stand-in confirm opens), the confirm itself, and {@link end} (after it closed).
 * {@link dialogClosed} is the CDP event of the confirm closing; it carries the text a CDP client answered with.
 */
export class ParadisPromptStandIn {

	private current: {
		readonly defaultPrompt: string;
		closed?: { readonly accepted: boolean; readonly userInput: string };
		waiter?: { readonly reply: (value: string | null) => void; readonly timer: ReturnType<typeof setTimeout> };
	} | undefined;

	/** @param hint what a person reads in the stand-in confirm (it has no text field) */
	constructor(private readonly hint: string, private readonly closeWaitMs: number = PARADIS_PROMPT_CLOSE_WAIT_MS) { }

	/** The page called prompt(). Returns the text of the confirm that stands in for it. */
	begin(message: unknown, defaultPrompt: unknown): string {
		this.cancel();
		this.current = { defaultPrompt: clip(defaultPrompt) };
		return paradisPromptStandInMessage(clip(message), this.current.defaultPrompt, this.hint);
	}

	/** `Page.javascriptDialogClosed` of this tab (any dialog; only the one after {@link begin} counts). */
	dialogClosed(params: unknown): void {
		const current = this.current;
		if (current === undefined || current.closed !== undefined) {
			return;
		}
		const record = typeof params === 'object' && params !== null ? params as { result?: unknown; userInput?: unknown } : {};
		current.closed = { accepted: record.result === true, userInput: clip(record.userInput) };
		if (current.waiter !== undefined) {
			clearTimeout(current.waiter.timer);
			this.finish(current.waiter.reply, this.answer(current));
		}
	}

	/** The stand-in confirm returned in the page. `reply` gets the result of prompt(), exactly once. */
	end(accepted: unknown, reply: (value: string | null) => void): void {
		const current = this.current;
		if (current === undefined || accepted !== true) {
			// Cancel, or an end without a begin (the main process restarted the bridge in between).
			this.finish(reply, null);
			return;
		}
		if (current.closed !== undefined) {
			this.finish(reply, this.answer(current));
			return;
		}
		current.waiter = { reply, timer: setTimeout(() => this.finish(reply, current.defaultPrompt), this.closeWaitMs) };
	}

	/** The page went away: let a waiting prompt() return. */
	cancel(): void {
		const waiter = this.current?.waiter;
		if (waiter !== undefined) {
			clearTimeout(waiter.timer);
			this.finish(waiter.reply, null);
		}
		this.current = undefined;
	}

	/** An empty answer (a person pressing OK, or `handle_dialog` without a text) is the default value. */
	private answer(current: { readonly defaultPrompt: string; readonly closed?: { readonly userInput: string } }): string {
		return current.closed?.userInput ? current.closed.userInput : current.defaultPrompt;
	}

	private finish(reply: (value: string | null) => void, value: string | null): void {
		this.current = undefined;
		try {
			reply(value);
		} catch {
			// the frame that asked is gone
		}
	}
}

type ParadisPromptIpcListener = (event: { returnValue: unknown }, ...args: unknown[]) => void;
type ParadisDebuggerMessageListener = (event: unknown, method: string, params: unknown) => void;

/** The parts of BrowserView the prompt stand-in uses. */
export interface IParadisPromptView {
	readonly webContents: {
		readonly ipc: {
			on(channel: string, listener: ParadisPromptIpcListener): unknown;
			removeListener(channel: string, listener: ParadisPromptIpcListener): unknown;
		};
		readonly debugger: {
			on(event: 'message', listener: ParadisDebuggerMessageListener): unknown;
			removeListener(event: 'message', listener: ParadisDebuggerMessageListener): unknown;
		};
		isDestroyed(): boolean;
	};
	readonly debugger: {
		/** Attaches the debugger when needed. */
		sendCommandRaw(method: string): Promise<unknown>;
		/** Fires when the debugger detached (its domains are disabled again). */
		onDidDetach(listener: () => void): IDisposable;
	};
}

/** Wire window.prompt() of a browser view: the preload's two IPCs and the CDP event with the answer. */
export function paradisAttachPromptStandIn(view: IParadisPromptView, closeWaitMs?: number): IDisposable {
	const store = new DisposableStore();
	const standIn = new ParadisPromptStandIn(localize('paradis.browserView.promptStandIn', "The page asks for text with prompt(). The built-in browser has no dialog with a text field: OK answers with the default value shown above, Cancel cancels."), closeWaitMs);
	// The answer text comes in Page.javascriptDialogClosed, which this debugger only receives with the Page domain
	// enabled. The command is not awaited: the page's main thread is blocked in the IPC that asks for it, and the
	// command is answered only after the page runs again. The browser's side of the domain, which reports the
	// event, is on as soon as the command is sent.
	let pageEnabled = false;
	const enablePage = (): void => {
		if (pageEnabled) {
			return;
		}
		pageEnabled = true;
		const failed = () => { pageEnabled = false; };
		try {
			view.debugger.sendCommandRaw('Page.enable').then(undefined, failed);
		} catch {
			// Without the event the answer is the default value; try again at the next prompt.
			failed();
		}
	};
	store.add(view.debugger.onDidDetach(() => { pageEnabled = false; }));
	const onBegin: ParadisPromptIpcListener = (event, message, defaultPrompt) => {
		const shown = standIn.begin(message, defaultPrompt);
		enablePage();
		event.returnValue = shown;
	};
	const onEnd: ParadisPromptIpcListener = (event, accepted) => {
		standIn.end(accepted, value => { event.returnValue = value; });
	};
	const onMessage: ParadisDebuggerMessageListener = (_event, method, params) => {
		if (method === 'Page.javascriptDialogClosed') {
			standIn.dialogClosed(params);
		}
	};
	view.webContents.ipc.on(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, onBegin);
	view.webContents.ipc.on(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, onEnd);
	view.webContents.debugger.on('message', onMessage);
	store.add(toDisposable(() => {
		standIn.cancel();
		if (!view.webContents.isDestroyed()) {
			view.webContents.ipc.removeListener(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, onBegin);
			view.webContents.ipc.removeListener(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, onEnd);
			view.webContents.debugger.removeListener('message', onMessage);
		}
	}));
	return store;
}

// --- beforeunload ---------------------------------------------------------------------------------------

/** Longest time one "keep the page" request stays armed. */
export const PARADIS_KEEP_PAGE_MAX_MS = 60_000;

interface IKeepPage {
	readonly expiresAt: number;
	kept: boolean;
}

const keepPages = new WeakMap<object, IKeepPage>();

/**
 * Keep the page at the next beforeunload of this tab, if it comes within `ttlMs`. One navigation only: the
 * request is used up by the first beforeunload it answers.
 */
export function paradisArmKeepPage(webContents: object, ttlMs: number, now: number = Date.now()): void {
	keepPages.set(webContents, { expiresAt: now + Math.max(0, Math.min(PARADIS_KEEP_PAGE_MAX_MS, ttlMs)), kept: false });
}

/** End the request. Returns whether it kept the page. */
export function paradisDisarmKeepPage(webContents: object): boolean {
	const entry = keepPages.get(webContents);
	keepPages.delete(webContents);
	return entry?.kept === true;
}

/**
 * Called from `will-prevent-unload`: true when the page must stay (the caller then does not override the
 * page's wish to stay).
 */
export function paradisTakeKeepPage(webContents: object, now: number = Date.now()): boolean {
	const entry = keepPages.get(webContents);
	if (entry === undefined || entry.kept || now > entry.expiresAt) {
		return false;
	}
	entry.kept = true;
	return true;
}
