/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISerializedGrid } from '../../../../base/browser/ui/grid/grid.js';
import { ISessionTerminalGridLayoutEntry, ISessionTerminalGridTerminalGeneration, SessionTerminalGridIdentity, sessionIsValidGridLayoutEntry, sessionMergeGridLayoutEntries, sessionParseGridLayoutStorage, sessionPruneGridLayout, sessionRekeyOwnedGridLayoutEntries, sessionSerializeGridLayoutStorage } from './sessionTerminalGridLayout.js';

/** A grid group that takes part in the persisted snapshot. */
export interface ISessionTerminalGridLayoutSource {
	/** The group's layout, or `undefined` while it has fewer than two panes or unresolved processes. */
	getGridLayoutEntry(): ISessionTerminalGridLayoutEntry | undefined;
	/** How the ids of this group's terminals map from the session that persisted them to this one. */
	getGridLayoutTerminalGenerations(): readonly ISessionTerminalGridTerminalGeneration[];
	/**
	 * The stable identities of this group's live panes.
	 *
	 * The generations above only carry numeric ids, so they cannot speak for a v2 (nonce-keyed) entry.
	 * Without this, a group that stops reporting a layout — the user closed a pane and only one is
	 * left — leaves its stored entry naming identities nothing claims, and the merge keeps it forever
	 * as another window's. Those corpses then compete for the entry budget with the layouts of spaces
	 * that have not been visited yet.
	 */
	getGridLayoutTerminalNonces(): readonly string[];
}

export interface ISessionTerminalGridLayoutService {
	readonly _serviceBrand: undefined;
	/** Registers a group whose layout takes part in the persisted snapshot. */
	registerSource(source: ISessionTerminalGridLayoutSource): IDisposable;
	/** Asks for the layouts to be saved, at most once per {@link SAVE_DELAY_MS} window. */
	scheduleSave(): void;
	/** Claims the persisted layout of the group made of `terminalIds`, if there is one. */
	takeRestoredLayout(terminalIds: ReadonlySet<SessionTerminalGridIdentity>): ISerializedGrid | undefined;
}

export const ISessionTerminalGridLayoutService = createDecorator<ISessionTerminalGridLayoutService>('sessionTerminalGridLayoutService');

const SAVE_DELAY_MS = 500;

/**
 * Persists the 2D layout of every terminal grid group of this window.
 *
 * The snapshot lives next to (not inside) upstream's terminal layout info: upstream only knows how
 * to store a flat list of terminals per tab, so the grid tree has to be kept separately and matched
 * back onto the restored terminals by persistent process id. Parked groups of other spaces are not
 * restored until that space is visited again, so entries that no live group claims are preserved
 * rather than overwritten (see `sessionMergeGridLayoutEntries`).
 */
export class SessionTerminalGridLayoutService extends Disposable implements ISessionTerminalGridLayoutService {

	declare readonly _serviceBrand: undefined;

	/**
	 * Where nonce-keyed (v2) layouts are written.
	 *
	 * **Never write these back to the legacy key.** An older build's `isValidEntryTerminals` only
	 * accepts numeric ids, so it drops every v2 entry on parse and then persists that pruned set,
	 * silently destroying the layouts; the "keep what another window stored" merge cannot save them
	 * because they never survive the read. A separate key lets both builds keep their own snapshot.
	 */
	private static readonly STORAGE_KEY = 'paradis.terminalGrid.layouts.v2';

	/** The numeric-id era key. Read **only**, for the one-time migration. */
	private static readonly LEGACY_STORAGE_KEY = 'paradis.terminalGrid.layouts';

	private readonly _sources = new Set<ISessionTerminalGridLayoutSource>();
	private readonly _saveScheduler = this._register(new RunOnceScheduler(() => this.flush(), SAVE_DELAY_MS));

	/**
	 * The snapshot from the previous session, consumed as groups claim their layout. Entries stay
	 * here until claimed so a group whose terminals come back later (a space visited after startup)
	 * can still find its own layout.
	 */
	private _pendingRestore: ISessionTerminalGridLayoutEntry[] | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		// The debounced save never runs during shutdown, so the last resize before quitting would be
		// lost without an explicit flush here.
		this._register(lifecycleService.onWillShutdown(() => this.flush()));
	}

	registerSource(source: ISessionTerminalGridLayoutSource): IDisposable {
		this._sources.add(source);
		return toDisposable(() => this._sources.delete(source));
	}

	scheduleSave(): void {
		if (!this._saveScheduler.isScheduled()) {
			this._saveScheduler.schedule();
		}
	}

	/**
	 * Claims the persisted layout for a group made of `terminalIds`, restricted to the terminals that
	 * actually came back. Returns `undefined` unless the whole group is covered by a single stored
	 * entry, so an unrelated group can never inherit someone else's layout.
	 */
	takeRestoredLayout(terminalIds: ReadonlySet<SessionTerminalGridIdentity>): ISerializedGrid | undefined {
		if (terminalIds.size < 2) {
			return undefined;
		}
		const entries = this._restoreEntries();
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const matched = entry.terminals.filter(terminal => terminalIds.has(terminal));
			if (matched.length !== terminalIds.size) {
				continue;
			}
			const pruned = sessionPruneGridLayout(entry.layout, terminalIds);
			entries.splice(index, 1);
			return pruned;
		}
		return undefined;
	}

	/** Writes the current layouts through immediately. */
	flush(): void {
		this._saveScheduler.cancel();
		const live: ISessionTerminalGridLayoutEntry[] = [];
		const generations: ISessionTerminalGridTerminalGeneration[] = [];
		const liveNonces: string[] = [];
		for (const source of this._sources) {
			// A group with no usable layout (fewer than two panes, no process ids yet, never laid out)
			// is simply left out; its stored entry, if any, is preserved by the merge below.
			const entry = source.getGridLayoutEntry();
			if (sessionIsValidGridLayoutEntry(entry)) {
				live.push(entry);
			}
			generations.push(...source.getGridLayoutTerminalGenerations());
			liveNonces.push(...source.getGridLayoutTerminalNonces());
		}

		// Entries that no group has claimed are still keyed by the ids of the session that wrote them.
		// The ones this window can account for are rewritten to its ids on the way out so that
		// everything it stores shares one namespace, while the in-memory copy stays as it is — a group
		// restoring later still looks itself up by the id it was revived from.
		const unclaimed = sessionRekeyOwnedGridLayoutEntries(this._restoreEntries(), generations);

		// Every id this window speaks for, in both generations, so that the merge can recognise its
		// own older copies in storage instead of mistaking them for another window's groups. Entries
		// it cannot account for are deliberately absent: whatever is stored for them now is newer than
		// this window's startup snapshot, so it is kept rather than written back.
		const ownedTerminals = new Set<SessionTerminalGridIdentity>();
		for (const { restored, current } of generations) {
			ownedTerminals.add(restored);
			ownedTerminals.add(current);
		}
		for (const entry of live) {
			for (const terminal of entry.terminals) {
				ownedTerminals.add(terminal);
			}
		}
		// A nonce names one terminal instance, and that instance lives in exactly one window, so
		// claiming it here cannot take another window's entry. Groups that no longer describe a layout
		// still speak for their panes, which is what lets their stale entry be dropped.
		for (const nonce of liveNonces) {
			ownedTerminals.add(nonce);
		}

		// A group that reports a layout but never claimed the stored one (its panes no longer match any
		// single entry) would otherwise be described twice, wasting a slot and shadowing the live entry
		// for a future lookup. The live description is the current one, so the stored one gives way.
		const liveTerminals = new Set(live.flatMap(entry => [...entry.terminals]));
		const stillUnclaimed = unclaimed.filter(entry => !entry.terminals.some(terminal => liveTerminals.has(terminal)));

		// Re-read rather than reusing the startup snapshot: another window on the same workspace may
		// have stored or updated its own groups in the meantime, and those must survive this write.
		const merged = sessionMergeGridLayoutEntries([...live, ...stillUnclaimed], this._readStoredEntries(), ownedTerminals);
		const raw = sessionSerializeGridLayoutStorage(merged);
		if (raw === undefined) {
			return;
		}
		this._storageService.store(SessionTerminalGridLayoutService.STORAGE_KEY, raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _readStoredEntries(): ISessionTerminalGridLayoutEntry[] {
		const raw = this._storageService.get(SessionTerminalGridLayoutService.STORAGE_KEY, StorageScope.WORKSPACE);
		const entries = (raw ? sessionParseGridLayoutStorage(raw) : undefined) ?? [];
		if (entries.length > 0 || raw !== undefined) {
			return entries;
		}
		// Adopt the pre-v2 snapshot once. Afterwards only the new key matters; the legacy key is left
		// untouched so an older build still finds the layout it last wrote.
		const legacyRaw = this._storageService.get(SessionTerminalGridLayoutService.LEGACY_STORAGE_KEY, StorageScope.WORKSPACE);
		return (legacyRaw ? sessionParseGridLayoutStorage(legacyRaw) : undefined) ?? [];
	}

	private _restoreEntries(): ISessionTerminalGridLayoutEntry[] {
		this._pendingRestore ??= this._readStoredEntries();
		return this._pendingRestore;
	}
}

registerSingleton(ISessionTerminalGridLayoutService, SessionTerminalGridLayoutService, InstantiationType.Delayed);
