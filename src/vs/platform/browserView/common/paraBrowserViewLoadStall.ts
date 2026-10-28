/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * A browser view whose main frame has not received a response within the watchdog's budget and is
 * asking the person whether to keep waiting (see `paraBrowserViewLoadWatchdog.ts`).
 */
export interface IParaBrowserViewLoadStall {
	/** From the navigation starting to the moment the question was asked. */
	readonly elapsedMs: number;
	/** How many times the person already chose to keep waiting for this load. */
	readonly waits: number;
}

/** The person's answer: grant another budget, or stop the load and show the timeout error. */
export type ParaBrowserViewLoadStallResponse = 'wait' | 'stop';

/**
 * How a stalled load ended. Sent to Sentry as a fixed value, so none of these may contain a word
 * Sentry scrubs (see `isParadisSentryScrubbedWord`).
 * - `stopped`: the person chose to stop it.
 * - `agent-stopped`: an agent-only tab, stopped without asking.
 * - `responded`: the server answered after all (the page committed or redirected).
 * - `failed`: Chromium failed the load itself (connection reset, DNS, ...).
 * - `abandoned`: stopped from the toolbar, replaced by another navigation, closed, or crashed.
 */
export type ParaBrowserViewLoadStallOutcome = 'stopped' | 'agent-stopped' | 'responded' | 'failed' | 'abandoned';
