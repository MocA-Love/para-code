/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Permission prompts (location, notifications, clipboard, ...) of the built-in browser, as seen by an agent
// that drives the tab.
//
// upstream (browserSessionPermissions.ts) shows the prompt to the user and denies after 30 s without an
// answer. An agent working in a tab the user is not looking at never learned that the page had asked: the
// page's promise stayed pending for 30 s and then failed. This file keeps a small record per tab so that
//  - the agent's tool results can say "this page asks for notifications" while the prompt waits, and that
//    a request ended without an answer, and
//  - the agent can answer the prompt (`handle_permission_request`).
//
// An answer from the agent is never written to the profile's permission store:
//  - "deny" only ends the waiting prompt (the page asks again next time),
//  - "allow" is remembered for that tab and origin until the tab is closed.
// The user's own recorded decisions always win: an origin the user blocked is never prompted, so the agent
// cannot answer it. Which tabs and categories an agent may allow is decided by the caller
// (paradisCdpTargetService.ts / paradisBrowserPageOps.ts).

import { PermissionCategory, PermissionDecision } from '../common/browserPermissions.js';

/** How a permission prompt ended. `pending` while it waits. */
export type ParadisPermissionRequestState = 'pending' | 'allowedByAgent' | 'deniedByAgent' | 'allowedByUser' | 'deniedByUser' | 'unanswered';

export interface IParadisPermissionRequestNote {
	readonly origin: string;
	readonly category: PermissionCategory;
	readonly state: ParadisPermissionRequestState;
	/** Seconds until the prompt is denied by itself (only while `pending`). */
	readonly secondsLeft?: number;
}

interface IRecord {
	readonly origin: string;
	readonly category: PermissionCategory;
	readonly askedAt: number;
	readonly timeoutMs: number;
	state: ParadisPermissionRequestState;
	/** Ends the waiting prompt. */
	complete: (() => void) | undefined;
	/** Whether the settled outcome was already told to the agent. */
	reported: boolean;
}

interface ITabState {
	readonly records: IRecord[];
	/** `origin\ncategory` the agent allowed for this tab. */
	readonly grants: Set<string>;
}

const RECORD_LIMIT = 20;

const tabs = new WeakMap<object, ITabState>();

function stateOf(webContents: object): ITabState {
	let state = tabs.get(webContents);
	if (state === undefined) {
		state = { records: [], grants: new Set() };
		tabs.set(webContents, state);
	}
	return state;
}

function grantKey(origin: string, category: PermissionCategory): string {
	return `${origin}\n${category}`;
}

/**
 * A prompt started waiting. `settled` resolves when it ends (answer, recorded decision or timeout);
 * `decision` reads the profile's recorded decision at that time.
 */
export function paradisNotePermissionPrompt(webContents: object, origin: string, category: PermissionCategory, timeoutMs: number, settled: Promise<void>, complete: () => void, decision: () => PermissionDecision | undefined, now: number = Date.now()): void {
	const tab = stateOf(webContents);
	const record: IRecord = { origin, category, askedAt: now, timeoutMs, state: 'pending', complete, reported: false };
	tab.records.push(record);
	if (tab.records.length > RECORD_LIMIT) {
		const settledIndex = tab.records.findIndex(candidate => candidate.state !== 'pending');
		tab.records.splice(settledIndex === -1 ? 0 : settledIndex, 1);
	}
	const onSettled = () => {
		record.complete = undefined;
		if (record.state === 'pending') {
			const recorded = decision();
			record.state = recorded === 'allow' ? 'allowedByUser' : recorded === 'deny' ? 'deniedByUser' : 'unanswered';
		}
	};
	settled.then(onSettled, onSettled);
}

/** The part of BrowserPermissionStore the permission handlers read. */
export interface IParadisPermissionDecisions {
	isAllowed(origin: string, category: PermissionCategory): boolean;
	getDecision(origin: string, category: PermissionCategory): PermissionDecision | undefined;
}

/**
 * Whether the category is allowed for this tab: by the profile's store (a recorded decision or an
 * allow-by-default category), or by the agent's allow for this tab. A "deny" the user recorded always wins,
 * also when the user records it after the agent allowed.
 */
export function paradisPermissionAllowed(store: IParadisPermissionDecisions, webContents: object | null | undefined, origin: string, category: PermissionCategory): boolean {
	return store.isAllowed(origin, category) || (store.getDecision(origin, category) !== 'deny' && paradisAgentAllowsPermission(webContents, origin, category));
}

/** Whether the agent allowed this category for this tab and origin (see {@link paradisAnswerPermissionRequest}). */
export function paradisAgentAllowsPermission(webContents: object | null | undefined, origin: string, category: PermissionCategory): boolean {
	return webContents !== null && webContents !== undefined && tabs.get(webContents)?.grants.has(grantKey(origin, category)) === true;
}

export type ParadisPermissionAnswerResult =
	| { readonly ok: true; readonly answered: readonly { readonly origin: string; readonly category: PermissionCategory }[] }
	| { readonly ok: false; readonly reason: 'none' | 'ambiguous' | 'notAllowed'; readonly pending: readonly { readonly origin: string; readonly category: PermissionCategory }[] };

/**
 * Answer the waiting prompt(s) of a tab. With `category` only that category is answered; without it, the only
 * waiting prompt (more than one is `ambiguous`). `mayAllow` says whether this caller may allow that category.
 */
export function paradisAnswerPermissionRequest(webContents: object, category: PermissionCategory | undefined, allow: boolean, mayAllow: (category: PermissionCategory) => boolean): ParadisPermissionAnswerResult {
	const tab = tabs.get(webContents);
	const waiting = (tab?.records ?? []).filter(record => record.state === 'pending' && record.complete !== undefined);
	const describe = (records: readonly IRecord[]) => records.map(record => ({ origin: record.origin, category: record.category }));
	const chosen = category !== undefined ? waiting.filter(record => record.category === category) : waiting;
	if (tab === undefined || chosen.length === 0) {
		return { ok: false, reason: 'none', pending: describe(waiting) };
	}
	if (category === undefined && new Set(chosen.map(record => record.category)).size > 1) {
		return { ok: false, reason: 'ambiguous', pending: describe(waiting) };
	}
	if (allow && chosen.some(record => !mayAllow(record.category))) {
		return { ok: false, reason: 'notAllowed', pending: describe(waiting) };
	}
	for (const record of chosen) {
		if (allow) {
			tab.grants.add(grantKey(record.origin, record.category));
		}
		record.state = allow ? 'allowedByAgent' : 'deniedByAgent';
		record.reported = true;
		const complete = record.complete;
		record.complete = undefined;
		complete?.();
	}
	return { ok: true, answered: describe(chosen) };
}

/**
 * What to tell the agent after a tool call on this tab: the prompts that wait now, and the ones that ended
 * by the user's answer or without an answer since the last call (told once).
 */
export function paradisTakePermissionNotes(webContents: object, now: number = Date.now()): IParadisPermissionRequestNote[] {
	const tab = tabs.get(webContents);
	if (tab === undefined) {
		return [];
	}
	const notes: IParadisPermissionRequestNote[] = [];
	for (const record of tab.records) {
		if (record.state === 'pending') {
			notes.push({ origin: record.origin, category: record.category, state: 'pending', secondsLeft: Math.max(0, Math.round((record.askedAt + record.timeoutMs - now) / 1000)) });
		} else if (!record.reported) {
			record.reported = true;
			notes.push({ origin: record.origin, category: record.category, state: record.state });
		}
	}
	return notes;
}
