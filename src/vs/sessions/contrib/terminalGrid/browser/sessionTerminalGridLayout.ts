/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Pure helpers backing the persistence of 2D terminal grid layouts (see `sessionTerminalGridGroup.ts`).
//
// Why this exists: upstream only persists a terminal group as a flat, single-axis list of
// `{ relativeSize, terminal }` entries (`ITerminalTabLayoutInfoById`), which cannot express a 2D
// layout. Restoring a grid group from that alone always rebuilds it as a single row, so a 2x2
// layout silently degrades on every window reload / app restart. The grid therefore keeps its own
// snapshot of the `Grid` widget's serialized tree next to upstream's layout info.
//
// Everything here is a pure function over plain JSON so it can be unit tested without a DOM.

import { ISerializedGrid, ISerializedLeafNode, ISerializedNode, Orientation, orthogonal } from '../../../../base/browser/ui/grid/grid.js';

/** Upper bounds mirroring the defensive parsing used by the terminal scope ledger. */
const MAX_STORAGE_LENGTH = 262_144;
const MAX_ENTRIES = 32;
const MAX_LEAVES_PER_ENTRY = 64;
const MAX_NODE_DEPTH = 32;

/**
 * What a grid cell writes into its serialized leaf. The id is the terminal's **current generation**
 * `persistentProcessId`; matching a restored instance back onto it is the caller's job (see
 * `sessionResolveGridLayoutTerminalId`).
 */
export interface ISessionTerminalGridLeafData {
	readonly terminal: number;
}

/** One persisted grid group: its serialized layout plus the terminals it was made of. */
export interface ISessionTerminalGridLayoutEntry {
	readonly terminals: readonly number[];
	readonly layout: ISerializedGrid;
}

function isValidTerminalId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Reads the terminal id out of a serialized leaf, or `undefined` when the leaf is not ours. */
export function sessionReadGridLayoutLeafTerminal(data: unknown): number | undefined {
	if (typeof data !== 'object' || data === null) {
		return undefined;
	}
	const terminal = (data as Partial<ISessionTerminalGridLeafData>).terminal;
	return isValidTerminalId(terminal) ? terminal : undefined;
}

function isValidNode(node: unknown, depth: number, leaves: { count: number }): node is ISerializedNode {
	if (depth > MAX_NODE_DEPTH || typeof node !== 'object' || node === null) {
		return false;
	}
	const candidate = node as Partial<ISerializedNode>;
	if (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size) || candidate.size < 0) {
		return false;
	}
	if (candidate.type === 'leaf') {
		leaves.count++;
		return leaves.count <= MAX_LEAVES_PER_ENTRY && sessionReadGridLayoutLeafTerminal((candidate as ISerializedLeafNode).data) !== undefined;
	}
	if (candidate.type !== 'branch' || !Array.isArray(candidate.data) || candidate.data.length === 0) {
		return false;
	}
	return candidate.data.every(child => isValidNode(child, depth + 1, leaves));
}

/**
 * The parts of an `ITerminalInstance` needed to match it against a persisted leaf.
 */
export interface ISessionTerminalGridLayoutInstanceLike {
	readonly shellLaunchConfig: {
		readonly attachPersistentProcess?: {
			readonly id: number;
			readonly paradisRevivedFromPersistentProcessId?: number;
			readonly paradisAdopted?: boolean;
		};
	};
}

/**
 * The id a terminal restored from the previous session has to be looked up by, or `undefined` for a
 * terminal that was created in this session.
 *
 * A layout is written with the terminals' **current** persistent process ids, while a restored
 * instance carries the id of the generation it was revived from: the pty host restarts its id
 * counter on every app restart, so `attachPersistentProcess.id` is a fresh id and
 * `paradisRevivedFromPersistentProcessId` is the one the previous session persisted. Reloads keep
 * the same id, in which case both agree.
 *
 * Terminals created in this session are deliberately not resolvable at all. Their ids come from the
 * same restarted counter, so a freshly created pane could otherwise collide with the id of an
 * unrelated terminal of the previous session and claim (and consume) a layout that belongs to a
 * space which has not been restored yet.
 *
 * A terminal taken back from a daemon that outlived the app falls in the same bucket, and for the
 * same reason: it was handed a fresh id and, unlike a revived terminal, cannot say what its id was
 * before — nothing in what the daemon holds records it. Placing it by that id would be the very
 * collision described above, so it goes unplaced instead.
 */
export function sessionResolveGridLayoutTerminalId(instance: ISessionTerminalGridLayoutInstanceLike): number | undefined {
	const attachTarget = instance.shellLaunchConfig.attachPersistentProcess;
	if (attachTarget === undefined) {
		return undefined;
	}
	if (attachTarget.paradisRevivedFromPersistentProcessId === undefined && attachTarget.paradisAdopted === true) {
		return undefined;
	}
	const terminal = attachTarget.paradisRevivedFromPersistentProcessId ?? attachTarget.id;
	return isValidTerminalId(terminal) ? terminal : undefined;
}

/** Whether a layout is well-formed enough to be persisted and later handed to `Grid.deserialize`. */
export function sessionIsValidGridLayout(layout: unknown): layout is ISerializedGrid {
	return isValidLayout(layout);
}

function isValidLayout(layout: unknown): layout is ISerializedGrid {
	if (typeof layout !== 'object' || layout === null) {
		return false;
	}
	const candidate = layout as Partial<ISerializedGrid>;
	if (candidate.orientation !== Orientation.VERTICAL && candidate.orientation !== Orientation.HORIZONTAL) {
		return false;
	}
	if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number'
		|| !Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)
		|| candidate.width <= 0 || candidate.height <= 0) {
		return false;
	}
	// `GridView.deserialize` hard-requires a branch root, so anything else must be rejected here
	// rather than thrown at restore time.
	return isValidNode(candidate.root, 0, { count: 0 }) && (candidate.root as ISerializedNode).type === 'branch';
}

/** Collects every terminal id referenced by a layout, in traversal order. */
export function sessionCollectGridLayoutTerminals(layout: ISerializedGrid): number[] {
	const result: number[] = [];
	const visit = (node: ISerializedNode): void => {
		if (node.type === 'leaf') {
			const terminal = sessionReadGridLayoutLeafTerminal(node.data);
			if (terminal !== undefined) {
				result.push(terminal);
			}
			return;
		}
		for (const child of node.data) {
			visit(child);
		}
	};
	visit(layout.root);
	return result;
}

/**
 * Drops every leaf whose terminal is not in `keep` and collapses the branches that are left with a
 * single child.
 *
 * A `GridView` alternates orientation on every level (a branch's children are always laid out along
 * the orthogonal axis of their parent), so a branch cannot simply be replaced by its only child:
 * doing so would reinterpret that child's own children along the wrong axis. Instead the surviving
 * grandchildren are lifted into the grandparent's list, where they already line up with its axis.
 */
function pruneNodes(nodes: readonly ISerializedNode[], keep: ReadonlySet<number>): ISerializedNode[] {
	const result: ISerializedNode[] = [];
	for (const node of nodes) {
		if (node.type === 'leaf') {
			const terminal = sessionReadGridLayoutLeafTerminal(node.data);
			if (terminal !== undefined && keep.has(terminal)) {
				result.push(node);
			}
			continue;
		}
		const children = pruneNodes(node.data, keep);
		if (children.length === 0) {
			continue;
		}
		if (children.length === 1) {
			const only = children[0];
			// A leaf can take the branch's place directly (leaves have no axis of their own); a
			// branch has to be flattened into this level, which is exactly where its children belong.
			result.push(...(only.type === 'leaf' ? [{ ...only, size: node.size }] : only.data));
			continue;
		}
		result.push({ type: 'branch', data: children, size: node.size });
	}
	return result;
}

/**
 * Restricts a persisted layout to the terminals that actually came back. Returns `undefined` when
 * nothing is left to restore.
 */
export function sessionPruneGridLayout(layout: ISerializedGrid, keep: ReadonlySet<number>): ISerializedGrid | undefined {
	if (layout.root.type !== 'branch') {
		return undefined;
	}
	const children = pruneNodes(layout.root.data, keep);
	if (children.length === 0) {
		return undefined;
	}
	if (children.length === 1 && children[0].type === 'branch') {
		// The root lost a level, so the remaining branch is now laid out one axis up.
		return { ...layout, root: children[0], orientation: orthogonal(layout.orientation) };
	}
	return { ...layout, root: { type: 'branch', data: children, size: layout.root.size } };
}

/**
 * A layout only describes an arrangement once it has at least two panes, and the ids have to be
 * unique: a duplicate would make a lookup believe an entry covers more panes than it does.
 */
function isValidEntryTerminals(terminals: unknown): terminals is number[] {
	return Array.isArray(terminals)
		&& terminals.length >= 2
		&& terminals.every(isValidTerminalId)
		&& new Set(terminals).size === terminals.length;
}

/**
 * Whether an entry is self-consistent: the terminal list is what lookups match against, so a list
 * that disagrees with the tree it describes would hand out (and consume) a layout for the wrong set
 * of panes.
 */
export function sessionIsValidGridLayoutEntry(entry: Partial<ISessionTerminalGridLayoutEntry> | undefined): entry is ISessionTerminalGridLayoutEntry {
	if (entry === undefined || !isValidEntryTerminals(entry.terminals) || !isValidLayout(entry.layout)) {
		return false;
	}
	const leaves = sessionCollectGridLayoutTerminals(entry.layout);
	return leaves.length === entry.terminals.length && entry.terminals.every(terminal => leaves.includes(terminal));
}

/**
 * Parses the persisted snapshot, skipping the entries that are malformed.
 *
 * One unusable entry says nothing about the others, and dropping them all would throw away the
 * layouts of every space that has not been restored yet.
 */
export function sessionParseGridLayoutStorage(raw: string): ISessionTerminalGridLayoutEntry[] | undefined {
	if (raw.length > MAX_STORAGE_LENGTH) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
	const entries: ISessionTerminalGridLayoutEntry[] = [];
	for (const value of parsed.slice(0, MAX_ENTRIES)) {
		const entry = typeof value === 'object' && value !== null ? value as Partial<ISessionTerminalGridLayoutEntry> : undefined;
		if (sessionIsValidGridLayoutEntry(entry)) {
			entries.push({ terminals: [...entry.terminals], layout: entry.layout });
		}
	}
	return entries;
}

/** Serializes the snapshot, dropping anything the reader would reject. */
export function sessionSerializeGridLayoutStorage(entries: readonly ISessionTerminalGridLayoutEntry[]): string | undefined {
	const raw = JSON.stringify(entries.filter(entry => sessionIsValidGridLayoutEntry(entry)).slice(0, MAX_ENTRIES));
	return raw.length <= MAX_STORAGE_LENGTH ? raw : undefined;
}

/** The id a live terminal was persisted under last session, and the one it has now. */
export interface ISessionTerminalGridTerminalGeneration {
	readonly restored: number;
	readonly current: number;
}

/**
 * Rewrites the persisted entries this window can account for to its own terminal ids, and returns
 * only those.
 *
 * Ids are generation-local: the pty host restarts its counter on every app restart, so the ids in a
 * stored entry only mean anything against the session that wrote them. Leaving them alone would
 * make them collide by sheer coincidence with the ids of this session — both are small counters
 * starting from the same place — and every later comparison (which entry belongs to which group,
 * which entries a save may replace) would silently mix up unrelated terminals.
 *
 * Re-keying as soon as the mapping is known keeps every id this window stores in one namespace: the
 * current one. It also keeps the entry of a group that is restored but never visited usable across
 * further restarts, which is otherwise lost the moment its ids go two generations stale.
 *
 * An entry is only rewritten when the whole of it can be: panes with no live terminal behind them
 * are dropped from the arrangement first, so an entry never ends up mixing two generations of ids.
 * Entries that name none of this window's terminals belong to somebody else — another window on the
 * same workspace, or a group whose terminals did not come back — and are left out entirely rather
 * than written back from a snapshot that may be older than what is stored now.
 *
 * That last rule also means an entry whose terminals are simply gone (every pane closed) is never
 * rewritten and stays in storage, in the namespace of the session that wrote it, until the entry
 * limit pushes it out. Claiming one requires an exact match on the whole set of ids, so a stale
 * entry can only ever be ignored, never mistaken for a live group's.
 */
export function sessionRekeyOwnedGridLayoutEntries(entries: readonly ISessionTerminalGridLayoutEntry[], generations: readonly ISessionTerminalGridTerminalGeneration[]): ISessionTerminalGridLayoutEntry[] {
	// The mapping has to stay one-to-one in both directions: two leaves rewritten onto the same id
	// would make the entry name a terminal twice, which is rejected on the way out — silently losing
	// the arrangement and, with it, the older copy the merge has already decided to replace.
	const currentByRestored = new Map<number, number>();
	const restoredByCurrent = new Map<number, number>();
	const ambiguous = new Set<number>();
	for (const { restored, current } of generations) {
		const knownCurrent = currentByRestored.get(restored);
		const knownRestored = restoredByCurrent.get(current);
		if ((knownCurrent !== undefined && knownCurrent !== current) || (knownRestored !== undefined && knownRestored !== restored)) {
			// Two live terminals laying claim to the same id proves neither of them owns it.
			ambiguous.add(restored);
			if (knownRestored !== undefined) {
				ambiguous.add(knownRestored);
			}
			continue;
		}
		currentByRestored.set(restored, current);
		restoredByCurrent.set(current, restored);
	}
	for (const restored of ambiguous) {
		currentByRestored.delete(restored);
	}

	const rekeyNode = (node: ISerializedNode): ISerializedNode => {
		if (node.type === 'branch') {
			return { ...node, data: node.data.map(rekeyNode) };
		}
		const terminal = sessionReadGridLayoutLeafTerminal(node.data);
		const current = terminal === undefined ? undefined : currentByRestored.get(terminal);
		return current === undefined ? node : { ...node, data: { terminal: current } satisfies ISessionTerminalGridLeafData };
	};

	const owned: ISessionTerminalGridLayoutEntry[] = [];
	for (const entry of entries) {
		const known = new Set(entry.terminals.filter(terminal => currentByRestored.has(terminal)));
		if (known.size === 0) {
			continue;
		}
		const pruned = known.size === entry.terminals.length ? entry.layout : sessionPruneGridLayout(entry.layout, known);
		if (pruned === undefined) {
			continue;
		}
		const layout = { ...pruned, root: rekeyNode(pruned.root) };
		const terminals = sessionCollectGridLayoutTerminals(layout);
		// A single pane carries no arrangement worth restoring.
		if (terminals.length >= 2) {
			owned.push({ terminals, layout });
		}
	}
	return owned;
}

/**
 * Assembles the snapshot to store: everything this window has an answer for, plus whatever else is
 * already stored.
 *
 * The two have to be told apart by terminal, not by entry: the same group may be stored under the
 * ids of an earlier session (see {@link sessionRekeyOwnedGridLayoutEntries}), and leaving that older copy
 * behind would both waste an entry slot and leave a stale layout for a future lookup to match.
 * `ownedTerminals` therefore has to name every id this window speaks for — in each generation it
 * knows about — while entries naming none of them belong to another window on the same workspace and
 * must be preserved.
 */
export function sessionMergeGridLayoutEntries(owned: readonly ISessionTerminalGridLayoutEntry[], stored: readonly ISessionTerminalGridLayoutEntry[], ownedTerminals: ReadonlySet<number>): ISessionTerminalGridLayoutEntry[] {
	const foreign = stored.filter(entry => !entry.terminals.some(terminal => ownedTerminals.has(terminal)));
	return [...owned, ...foreign].slice(0, MAX_ENTRIES);
}
