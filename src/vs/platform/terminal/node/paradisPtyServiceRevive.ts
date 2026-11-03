/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IShellLaunchConfig, ITerminalTabLayoutInfoById, PARADIS_UNRESOLVABLE_PTY_ID, paradisTerminalIdentityNonce } from '../common/terminal.js';
import { IProcessDetails, ISetTerminalLayoutInfoArgs } from '../common/terminalProcess.js';

/*
 * The fork's revive and reattach bookkeeping for `PtyService` (ptyService.ts). The tables stay
 * fields of `PtyService`, which hands them in; everything that reads or writes them lives here so
 * the upstream file only carries the call sites.
 *
 * Nothing in here imports from `vs/paradis`: the few answers that come from the pty daemon
 * (`paradisHandleOf`, `paradisAnswerForMissingNonce`) are passed in by the caller.
 */

/** The shape of `PersistentTerminalProcess` (ptyService.ts) that the functions below read. */
export interface IParadisRevivePty {
	readonly workspaceId: string;
	readonly workspaceName: string;
	readonly shouldPersistTerminal: boolean;
	readonly shellLaunchConfig: IShellLaunchConfig;
	readonly processLaunchOptions: { readonly options: { readonly shellIntegration: { readonly nonce: string } } };
	readonly paradisAdopted: boolean;
	readonly paradisHeldByDaemon: boolean;
	isOrphaned(): Promise<boolean>;
	attach(): Promise<void>;
}

/** The fork's tables kept on `PtyService`. */
export interface IParadisPtyReviveTables {
	/** Revive key (`${workspaceId}-${newId}`) -> the id the terminal had before the revive. */
	readonly revivedOldIdByNewId: Map<string, number>;
	/**
	 * Revived terminals indexed by shell integration nonce, see {@link paradisResolveRevivedPtyByNonce}.
	 *
	 * `_revivedPtyIdMap` in `PtyService` is keyed by the id of the session that was revived and is
	 * consumed as the panel layout claims each entry, so it cannot answer for a restored editor tab.
	 * A nonce, on the other hand, names the terminal itself no matter which generation asks, which
	 * makes this index safe to keep for as long as the host lives.
	 */
	readonly revivedNewIdByNonce: Map<string, number>;
	/** Which entries of `revivedNewIdByNonce` name a terminal taken back from the daemon rather than revived. */
	readonly adoptedNonces: Set<string>;
	/** Short leases serialize nonce-proven orphan attachment across renderer processes. */
	readonly orphanAttachClaims: Map<number, number>;
}

/** The shell integration nonce of a live terminal, if there is one. */
export function paradisNonceOfPty(ptys: ReadonlyMap<number, IParadisRevivePty>, id: number): string | undefined {
	return paradisTerminalIdentityNonce(ptys.get(id)?.processLaunchOptions.options.shellIntegration.nonce);
}

/**
 * A terminal was revived as `newId`: remember new id -> old id so listProcesses/layouts can report
 * paradisRevivedFromPersistentProcessId, and index it by nonce so a restored editor tab can find
 * it (`getRevivedPtyNewId`).
 */
export function paradisRememberRevivedPty(tables: IParadisPtyReviveTables, revivingProcessIdOfNewId: string, oldId: number, newId: number, rawNonce: string | undefined): void {
	tables.revivedOldIdByNewId.set(revivingProcessIdOfNewId, oldId);
	const nonce = paradisTerminalIdentityNonce(rawNonce);
	// Never over a terminal taken back from the daemon. That one is still running the work; this
	// one is a shell restarted from a saved screenful.
	if (nonce !== undefined && !tables.adoptedNonces.has(nonce)) {
		tables.revivedNewIdByNonce.set(nonce, newId);
	}
}

/**
 * A terminal taken back from a daemon got `id`.
 *
 * Taking a terminal back from a daemon hands out a new id, exactly like reviving one does, so it
 * has to answer the same question reviving answers. A window restoring an editor terminal knows
 * only the id it was given generations ago plus the nonce, and asks `getRevivedPtyNewId` to
 * translate. Registering nothing here is what left every adopted editor terminal unreachable: the
 * window gave up, launched a fresh shell, and the process we had just taken back sat in `_ptys`
 * with nobody attached to it.
 *
 * Two held terminals can carry the same nonce: when an attach fails, upstream relaunches the tab
 * and the replacement keeps the instance's nonce, so a daemon that outlived a failed reconnect
 * holds both the original and an empty replacement under one nonce. Adoption offers them
 * live-first, oldest-first (paradisTerminalAdoption.ts), so refusing to overwrite hands the tab
 * back the one still running rather than the shell started because we could not find it.
 */
export function paradisRememberAdoptedPty(tables: IParadisPtyReviveTables, id: number, rawNonce: string): void {
	const adoptedNonce = paradisTerminalIdentityNonce(rawNonce);
	if (adoptedNonce !== undefined && !tables.adoptedNonces.has(adoptedNonce)) {
		// **Taking one back outranks reviving one.** Both write this table, and a revive can land
		// either side of adoption, so order cannot decide it. One of the two is the process that has
		// been running all along; the other is a shell started from a saved screenful. Remember
		// which is which rather than letting the clock choose.
		tables.adoptedNonces.add(adoptedNonce);
		tables.revivedNewIdByNonce.set(adoptedNonce, id);
	}
}

/** The pty `id` exited: drop its orphan attach claim, its reverse revive entry and its nonce. */
export function paradisForgetExitedPty(tables: IParadisPtyReviveTables, id: number, revivingProcessIdOfId: string, rawNonce: string): void {
	tables.orphanAttachClaims.delete(id);
	tables.revivedOldIdByNewId.delete(revivingProcessIdOfId);
	// Let go of the nonce this terminal was answering for. Nothing else clears these, and an entry
	// naming a terminal that has exited is worse than no entry: the adopted mark keeps every later
	// revive of the same tab from registering, so once an adopted terminal ends, its tab can never
	// be reconnected again for as long as this pty host lives — the exact failure the mark exists to
	// prevent, in the other direction.
	const exitedNonce = paradisTerminalIdentityNonce(rawNonce);
	if (exitedNonce !== undefined && tables.revivedNewIdByNonce.get(exitedNonce) === id) {
		tables.revivedNewIdByNonce.delete(exitedNonce);
		tables.adoptedNonces.delete(exitedNonce);
	}
}

/**
 * The nonce branch of `PtyService#getRevivedPtyNewId`: `expectedNonce` names the terminal the
 * caller means to reattach to.
 *
 * A persistent process id only means something within the session that handed it out — this host
 * restarts the counter at 0, so reviving old ids 4, 5, 13… hands out new ids 1, 2, 3… and the two
 * ranges overlap. A serialized editor input, which is written once and then restored several
 * generations later, therefore cannot be resolved by id alone: attaching to whichever terminal
 * holds that number now takes the process away from the window that owns it. The nonce is carried
 * across revives, so it answers the question the id cannot.
 *
 * @param answerForMissingNonce `paradisAnswerForMissingNonce` (paradisPtyReadopt.ts).
 */
export function paradisResolveRevivedPtyByNonce(
	revivedNewIdByNonce: ReadonlyMap<string, number>,
	ptys: ReadonlyMap<number, IParadisRevivePty>,
	id: number,
	expectedNonce: string,
	answerForMissingNonce: (nonce: string, liveNonces: Iterable<string | undefined>) => number | undefined,
): number | undefined {
	// The terminal was revived in this host, possibly generations ago.
	const revivedId = revivedNewIdByNonce.get(expectedNonce);
	if (revivedId !== undefined && paradisNonceOfPty(ptys, revivedId) === expectedNonce) {
		return revivedId;
	}
	// No revive in between (a window reload): the id still names the right terminal.
	if (paradisNonceOfPty(ptys, id) === expectedNonce) {
		return undefined;
	}
	// The id names somebody else's terminal. Answering with an id that cannot exist makes the
	// attach fail, which upstream handles by launching a fresh shell — far better than stealing a
	// live process. An id with nothing behind it fails either way; when no terminal anywhere carries
	// the nonce, say it has ended (paradisPtyReadopt.ts).
	return ptys.has(id) ? PARADIS_UNRESOLVABLE_PTY_ID : answerForMissingNonce(expectedNonce, Array.from(ptys.keys(), ptyId => paradisNonceOfPty(ptys, ptyId)));
}

/**
 * The body of `PtyService#paradisClaimAndAttachToProcess`: resolve and claim an orphan in one
 * pty-host RPC. Renderer-side list/held checks cannot prevent two windows from racing on the same
 * snapshot, so the final nonce/orphan decision lives here.
 *
 * @param resolveId `PtyService#getRevivedPtyNewId`.
 * @param throwIfNoPty `PtyService#_throwIfNoPty`.
 */
export async function paradisClaimAndAttachPty(
	orphanAttachClaims: Map<number, number>,
	ptys: ReadonlyMap<number, IParadisRevivePty>,
	workspaceId: string,
	id: number,
	paradisExpectedNonce: string,
	resolveId: (workspaceId: string, id: number, expectedNonce: string) => Promise<number | undefined>,
	throwIfNoPty: (id: number) => IParadisRevivePty,
): Promise<number> {
	const expectedNonce = paradisTerminalIdentityNonce(paradisExpectedNonce);
	if (expectedNonce === undefined) {
		throw new Error('Cannot claim a terminal without a valid nonce');
	}
	const resolvedId = await resolveId(workspaceId, id, expectedNonce) ?? id;
	const pty = throwIfNoPty(resolvedId);
	if (pty.workspaceId !== workspaceId || paradisNonceOfPty(ptys, resolvedId) !== expectedNonce) {
		throw new Error('The terminal claim did not match the requested workspace and nonce');
	}
	const now = Date.now();
	const existingClaim = orphanAttachClaims.get(resolvedId);
	if (existingClaim !== undefined && existingClaim > now) {
		throw new Error('The terminal is already being attached by another renderer');
	}
	// Hold the reservation across the async orphan question. A bounded lease recovers if the
	// renderer disappears before the RPC completes.
	orphanAttachClaims.set(resolvedId, now + 10_000);
	try {
		if (!await pty.isOrphaned()) {
			throw new Error('The terminal is already attached to a renderer');
		}
		await pty.attach();
		// Keep a brief post-RPC lease until the winning renderer has registered its Local/RemotePty
		// and can answer the next orphan question.
		orphanAttachClaims.set(resolvedId, Date.now() + 2_000);
		return resolvedId;
	} catch (error) {
		orphanAttachClaims.delete(resolvedId);
		throw error;
	}
}

/**
 * Whether a layout names every terminal a daemon is holding for its workspace.
 *
 * A window can hand over a layout that leaves out terminals a daemon is holding for this very
 * workspace, and taking that at face value is how the running processes lose their way back onto
 * the screen.
 *
 * Two ways it happens. A window that restored nothing — because taking the terminals back ran past
 * its deadline — saves an empty layout, and an empty layout is the signal telling the daemon to
 * forget the one it was keeping. And a window that revived from a saved screenful re-seeds the
 * layout it wrote before the update, in ids from a pty host that no longer exists; those ids are
 * small integers from a counter that restarts, so they land on today's terminals by coincidence
 * rather than missing cleanly.
 *
 * A layout that accounts for every terminal the daemon holds here is the whole picture and is
 * taken as such. One that does not is somebody's partial view, and there is nothing to gain by
 * writing it down.
 *
 * Holding none — the ordinary case, with the daemon off — makes this trivially true, so nothing
 * changes for anyone not using it. Terminals that are not persisted (extension terminals, the MCP
 * terminal, tasks without reconnection) never appear in a saved layout, so they are not counted
 * either; one of them open would otherwise make every layout look partial.
 *
 * @param handleOf `paradisHandleOf` (paradisTerminalProcessFactory.ts).
 */
export function paradisLayoutAccountsForHeldTerminals(ptys: ReadonlyMap<number, IParadisRevivePty>, args: ISetTerminalLayoutInfoArgs, handleOf: (id: number) => number | undefined): boolean {
	return paradisHeldTerminalsLeftOut(ptys, args, handleOf).size === 0;
}

/** The terminals a daemon holds for the layout's workspace that the layout does not name. */
function paradisHeldTerminalsLeftOut(ptys: ReadonlyMap<number, IParadisRevivePty>, args: ISetTerminalLayoutInfoArgs, handleOf: (id: number) => number | undefined): Set<number> {
	const held = new Set<number>();
	for (const [id, pty] of ptys) {
		if (pty.workspaceId === args.workspaceId && pty.shouldPersistTerminal && handleOf(id) !== undefined) {
			held.add(id);
		}
	}
	if (held.size === 0) {
		return held;
	}
	for (const tab of args.tabs ?? []) {
		for (const terminal of tab.terminals ?? []) {
			held.delete(terminal.terminal);
		}
	}
	for (const id of args.background ?? []) {
		held.delete(id);
	}
	// Editor terminals never appear in the layout (their tabs restore through the editor), so a
	// window naming them is accounting for them, not leaving them out. The ids are exact: a window
	// that failed to take a held terminal back names the shell it started instead, not the held one.
	for (const id of args.paradisEditorTerminals ?? []) {
		held.delete(id);
	}
	return held;
}

/**
 * The layout to record for `PtyService#setTerminalLayoutInfo`: the window's layout, with every
 * terminal the daemon holds here that it leaves out carried over from the layout recorded before.
 * `undefined` means "record nothing".
 *
 * Throwing the whole layout away whenever one held terminal was missing from it (what this did
 * before) made a single stray terminal freeze the layout for good: on a remote host the pty host
 * logged "Ignoring a layout" more than 30 times in a day, and every panel tab made or closed since
 * was lost on the next update. Only the terminals left out are in doubt, so only they keep their
 * old place; the rest is the window's.
 *
 * Carried over, a terminal keeps the tab it was in (with the others from that tab left out too),
 * appended after the window's own tabs and never active; a background one stays in the background.
 * A held terminal the earlier layout did not have either has no place to keep, and the daemon's
 * layout does not have it (the earlier layout is what adoption read from the daemon, or a later one
 * that accounted for everything held), so it stays out — it is not invented into a tab, where a
 * parked editor terminal of another space would come back as a panel tab of this one.
 *
 * With no earlier layout at all nothing can be carried, and the answer stays "record nothing":
 * reading the daemon's layout may simply have failed, and an empty layout from a window that
 * restored nothing is what tells the daemon to forget the one it keeps.
 *
 * @param previous What `PtyService` recorded for this workspace so far (`_workspaceLayoutInfos`).
 * @param handleOf `paradisHandleOf` (paradisTerminalProcessFactory.ts).
 */
export function paradisLayoutKeepingHeldTerminals(ptys: ReadonlyMap<number, IParadisRevivePty>, args: ISetTerminalLayoutInfoArgs, previous: ISetTerminalLayoutInfoArgs | undefined, handleOf: (id: number) => number | undefined): ISetTerminalLayoutInfoArgs | undefined {
	const leftOut = paradisHeldTerminalsLeftOut(ptys, args, handleOf);
	if (leftOut.size === 0) {
		return args;
	}
	if (!previous) {
		return undefined;
	}
	const carriedTabs: ITerminalTabLayoutInfoById[] = [];
	for (const tab of previous.tabs ?? []) {
		const terminals = (tab.terminals ?? []).filter(terminal => leftOut.has(terminal.terminal));
		if (terminals.length === 0) {
			continue;
		}
		const active = terminals.some(terminal => terminal.terminal === tab.activePersistentProcessId) ? tab.activePersistentProcessId : terminals[0].terminal;
		carriedTabs.push({ isActive: false, activePersistentProcessId: active, terminals });
	}
	const carriedBackground = (previous.background ?? []).filter(id => leftOut.has(id));
	if (carriedTabs.length === 0 && carriedBackground.length === 0) {
		return args;
	}
	return {
		...args,
		tabs: [...(args.tabs ?? []), ...carriedTabs],
		background: [...(args.background ?? []), ...carriedBackground],
	};
}

/**
 * The entries behind `PtyService#paradisListHeldTerminals`: everything this host is holding,
 * including terminals a window is attached to.
 *
 * `listProcesses` cannot answer that: it ends with `filter(entry => entry.isOrphan)`, because it
 * exists to offer terminals that can still be attached to. The pty daemon needs the other question
 * — what is being held right now — for the count it shows and for deciding when it may stop. See
 * vs/paradis/contrib/ptyDaemon.
 */
export function paradisHeldPtyEntries<T extends IParadisRevivePty>(ptys: ReadonlyMap<number, T>): [number, T][] {
	return Array.from(ptys.entries()).filter(([_, pty]) => pty.shouldPersistTerminal);
}

/**
 * The body of `PtyService#paradisListHeldWorkspaceNames`, the lightweight counterpart of
 * `paradisListHeldTerminals` for pollers that only need how many terminals are held and their
 * workspace names. `_buildProcessDetails` shells out per terminal (`getCwd` runs lsof on macOS)
 * and waits on the orphan barrier, which is pure waste when nothing but the name is going to be
 * read.
 */
export function paradisHeldPtyWorkspaceNames(ptys: ReadonlyMap<number, IParadisRevivePty>): { workspaceName: string }[] {
	const names: { workspaceName: string }[] = [];
	for (const [, data] of ptys.entries()) {
		if (data.shouldPersistTerminal) {
			names.push({ workspaceName: data.workspaceName });
		}
	}
	return names;
}

/** `listProcesses`: tag an orphan with the id it had before revive (paradisRevivedFromPersistentProcessId). */
export function paradisTagRevivedOrphan(processDetails: IProcessDetails, revivedFromPersistentProcessId: number | undefined): IProcessDetails {
	if (!processDetails.isOrphan) {
		return processDetails;
	}
	return revivedFromPersistentProcessId === undefined
		? processDetails
		: { ...processDetails, paradisRevivedFromPersistentProcessId: revivedFromPersistentProcessId };
}

/** The fork's fields of `PtyService#_buildProcessDetails`, in the order they are spread there. */
export function paradisProcessDetailsFields(persistentProcess: IParadisRevivePty, revivedFromPersistentProcessId: number | undefined): Partial<IProcessDetails> {
	// Mobile relay recovery: carry the exact token injected at PTY launch across revive and detach.
	const paneToken = persistentProcess.shellLaunchConfig.env?.PARA_CODE_TERMINAL_PANE_ID;
	return {
		// Tells readers keyed by persistent process id that this id says nothing about earlier
		// sessions. See IProcessDetails#paradisAdopted.
		...(persistentProcess.paradisAdopted ? { paradisAdopted: true } : {}),
		// The process outlives this pty host, see IProcessDetails#paradisHeldByDaemon
		...(persistentProcess.paradisHeldByDaemon ? { paradisHeldByDaemon: true } : {}),
		// Mobile relay recovery: include the validated pane token in process details
		...(typeof paneToken === 'string' && paneToken.length > 0 && paneToken.length <= 200 ? { paradisPaneToken: paneToken } : {}),
		...(revivedFromPersistentProcessId !== undefined ? { paradisRevivedFromPersistentProcessId: revivedFromPersistentProcessId } : {}),
	};
}
