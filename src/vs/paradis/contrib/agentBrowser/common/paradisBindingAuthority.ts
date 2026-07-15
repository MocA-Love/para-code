/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

const MAX_PANE_ENTRIES = 4096;
const MAX_BROWSER_VIEW_ENTRIES = 4096;
const MAX_TOKEN_LENGTH = 200;
const MAX_VIEW_ID_LENGTH = 512;
const MAX_STATE_KEY_LENGTH = 4096;
const TICKET_LIFETIME_MS = 10_000;
const MAX_LIVE_TICKETS = 2048;
const MAX_TICKET_RECORDS = 4096;

export type ParadisBindingAuthorityScope =
	| { readonly kind: 'managed'; readonly stateKey: string }
	| { readonly kind: 'unscoped' }
	| { readonly kind: 'pending' };

export interface IParadisBindingAuthorityPane {
	readonly token: string;
	readonly shellPid?: number;
	readonly scope: ParadisBindingAuthorityScope;
}

export interface IParadisBindingAuthorityBrowserView {
	readonly viewId: string;
	readonly scope: ParadisBindingAuthorityScope;
}

export interface IParadisBindingAuthorityManifest {
	readonly revision: number;
	readonly complete: boolean;
	readonly panes: readonly IParadisBindingAuthorityPane[];
	readonly browserViews: readonly IParadisBindingAuthorityBrowserView[];
}

export type ParadisBindingAuthorityStableScope = Exclude<ParadisBindingAuthorityScope, { readonly kind: 'pending' }>;

export type ParadisBindingAuthorityErrorReason =
	| 'invalidManifest'
	| 'staleConnection'
	| 'connectionAlreadyRegistered'
	| 'staleRevision'
	| 'manifestRequired'
	| 'ownerConflict'
	| 'revisionMismatch'
	| 'missingEntry'
	| 'pendingScope'
	| 'scopeMismatch'
	| 'staleSnapshot'
	| 'invalidTicket'
	| 'expiredTicket'
	| 'staleTicket'
	| 'activeTicketCapacity'
	| 'totalTicketCapacity'
	| 'ticketIdCollision';

export class ParadisBindingAuthorityError extends Error {
	constructor(readonly reason: ParadisBindingAuthorityErrorReason) {
		super(`Binding authority rejected: ${reason}`);
		this.name = 'ParadisBindingAuthorityError';
	}
}

export interface IParadisBindingAuthorityOptions<TDescriptor> {
	readonly now: () => number;
	readonly createTicketId: () => string;
	/** Returns an immutable, copy-owned descriptor that shares no mutable references with the input. */
	readonly copyDescriptor: (descriptor: TDescriptor) => TDescriptor;
}

export interface IParadisBindingRetirement<TBindingIdentity> {
	readonly token: string;
	readonly bindingIdentity: TBindingIdentity | undefined;
}

export interface IParadisBindingManifestAcceptance<TBindingIdentity> {
	readonly accepted: true;
	readonly revision: number;
	readonly retiredTokens: readonly string[];
	readonly retiredViewIds: readonly string[];
	readonly bindingRetirements: readonly IParadisBindingRetirement<TBindingIdentity>[];
}

export interface IParadisBindingOwnerRelease<TBindingIdentity> {
	readonly retiredTokens: readonly string[];
	readonly retiredViewIds: readonly string[];
	readonly bindingRetirements: readonly IParadisBindingRetirement<TBindingIdentity>[];
}

/** Internal opaque identity for one uninterrupted token-owner lifecycle. */
export interface IParadisBindingOwnedTokenLease {
	readonly token: string;
}

export interface IParadisBindingPrepareSnapshot {
	readonly revision: number;
	readonly token: string;
	readonly viewId: string;
	readonly scope: ParadisBindingAuthorityStableScope;
}

export interface IParadisBindingTicket {
	readonly id: string;
	readonly expiresAt: number;
}

export interface IParadisBindingCommit<TDescriptor> {
	readonly token: string;
	readonly viewId: string;
	readonly descriptor: TDescriptor;
	readonly scope: ParadisBindingAuthorityStableScope;
}

/**
 * Opaque, authority-issued view of a live ticket used for external capacity preflight.
 * Runtime authenticity is enforced by object identity; structurally identical objects are rejected.
 */
export interface IParadisBindingCommitPreparation<TDescriptor> extends IParadisBindingCommit<TDescriptor> { }

interface IParadisBindingWindowState<TWindow, TConnection extends object> {
	readonly window: TWindow;
	readonly connection: TConnection;
	manifest: IParadisBindingAuthorityManifest | undefined;
}

interface IParadisBindingPrepareSnapshotState<TWindow, TConnection extends object, TBindingIdentity> {
	readonly window: TWindow;
	readonly connection: TConnection;
	readonly manifest: IParadisBindingAuthorityManifest;
	readonly tokenScope: ParadisBindingAuthorityStableScope;
	readonly viewScope: ParadisBindingAuthorityStableScope;
	readonly tokenEpoch: number;
	readonly bindingIdentity: TBindingIdentity | undefined;
}

interface IParadisBindingState<TBindingIdentity> {
	readonly epoch: number;
	readonly identity: TBindingIdentity | undefined;
}

interface IParadisBindingRetirementState<TBindingIdentity> extends IParadisBindingState<TBindingIdentity> {
	readonly token: string;
	readonly bindingState: IParadisBindingState<TBindingIdentity>;
}

interface IParadisBindingTicketRecord<TWindow, TConnection extends object, TDescriptor, TBindingIdentity>
	extends IParadisBindingPrepareSnapshotState<TWindow, TConnection, TBindingIdentity> {
	readonly id: string;
	readonly expiresAt: number;
	readonly token: string;
	readonly viewId: string;
	readonly descriptor: TDescriptor;
	readonly scope: ParadisBindingAuthorityStableScope;
	status: 'live' | 'tombstone';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Reflect.ownKeys(record);
	return required.every(key => Object.hasOwn(record, key))
		&& keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseScope(value: unknown): ParadisBindingAuthorityScope | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const kind = value.kind;
	if (kind === 'managed') {
		if (!hasExactKeys(value, ['kind', 'stateKey'])) {
			return undefined;
		}
		const stateKey = value.stateKey;
		if (!isBoundedNonEmptyString(stateKey, MAX_STATE_KEY_LENGTH)) {
			return undefined;
		}
		return Object.freeze({ kind: 'managed', stateKey });
	}
	if ((kind === 'unscoped' || kind === 'pending') && hasExactKeys(value, ['kind'])) {
		return Object.freeze({ kind });
	}
	return undefined;
}

function parsePane(value: unknown): IParadisBindingAuthorityPane | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ['token', 'scope'], ['shellPid'])) {
		return undefined;
	}
	const token = value.token;
	const scopeValue = value.scope;
	const scope = parseScope(scopeValue);
	if (!isBoundedNonEmptyString(token, MAX_TOKEN_LENGTH)
		|| scope === undefined) {
		return undefined;
	}
	if (Object.hasOwn(value, 'shellPid')) {
		const shellPid = value.shellPid;
		if (!isPositiveSafeInteger(shellPid)) {
			return undefined;
		}
		return Object.freeze({ token, shellPid, scope });
	}
	return Object.freeze({ token, scope });
}

function parseBrowserView(value: unknown): IParadisBindingAuthorityBrowserView | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ['viewId', 'scope'])) {
		return undefined;
	}
	const viewId = value.viewId;
	const scopeValue = value.scope;
	const scope = parseScope(scopeValue);
	if (!isBoundedNonEmptyString(viewId, MAX_VIEW_ID_LENGTH) || scope === undefined) {
		return undefined;
	}
	return Object.freeze({ viewId, scope });
}

/** Strictly validates and copy-owns a Renderer binding authority manifest. */
export function paradisParseBindingAuthorityManifest(value: unknown): IParadisBindingAuthorityManifest {
	try {
		return paradisParseBindingAuthorityManifestUnsafe(value);
	} catch {
		throw new Error('Invalid binding authority manifest');
	}
}

function paradisParseBindingAuthorityManifestUnsafe(value: unknown): IParadisBindingAuthorityManifest {
	if (!isRecord(value)
		|| !hasExactKeys(value, ['revision', 'complete', 'panes', 'browserViews'])) {
		throw new Error('Invalid binding authority manifest');
	}
	const revision = value.revision;
	const complete = value.complete;
	const paneValues = value.panes;
	const browserViewValues = value.browserViews;
	if (!isPositiveSafeInteger(revision)
		|| typeof complete !== 'boolean'
		|| !Array.isArray(paneValues)
		|| !Array.isArray(browserViewValues)
		|| paneValues.length > MAX_PANE_ENTRIES
		|| browserViewValues.length > MAX_BROWSER_VIEW_ENTRIES) {
		throw new Error('Invalid binding authority manifest');
	}

	const panes: IParadisBindingAuthorityPane[] = [];
	const tokens = new Set<string>();
	const shellPids = new Set<number>();
	for (const valuePane of paneValues) {
		const pane = parsePane(valuePane);
		if (pane === undefined
			|| tokens.has(pane.token)
			|| (pane.shellPid !== undefined && shellPids.has(pane.shellPid))) {
			throw new Error('Invalid binding authority manifest');
		}
		tokens.add(pane.token);
		if (pane.shellPid !== undefined) {
			shellPids.add(pane.shellPid);
		}
		panes.push(pane);
	}

	const browserViews: IParadisBindingAuthorityBrowserView[] = [];
	const viewIds = new Set<string>();
	for (const valueBrowserView of browserViewValues) {
		const browserView = parseBrowserView(valueBrowserView);
		if (browserView === undefined || viewIds.has(browserView.viewId)) {
			throw new Error('Invalid binding authority manifest');
		}
		viewIds.add(browserView.viewId);
		browserViews.push(browserView);
	}

	return Object.freeze({
		revision,
		complete,
		panes: Object.freeze(panes),
		browserViews: Object.freeze(browserViews),
	});
}

/** Pure owner and manifest authority used by the shared-process binding transaction. */
export class ParadisBindingAuthority<TWindow, TConnection extends object, TDescriptor, TBindingIdentity> {
	private readonly windowStates = new Map<TWindow, IParadisBindingWindowState<TWindow, TConnection>>();
	private readonly connectionStates = new Map<TConnection, IParadisBindingWindowState<TWindow, TConnection>>();
	private readonly tokenOwners = new Map<string, TWindow>();
	private readonly tokenOwnerLeases = new Map<string, IParadisBindingOwnedTokenLease>();
	private readonly viewOwners = new Map<string, TWindow>();
	private readonly prepareSnapshots = new WeakMap<IParadisBindingPrepareSnapshot, IParadisBindingPrepareSnapshotState<TWindow, TConnection, TBindingIdentity>>();
	private readonly bindingStates = new Map<string, IParadisBindingState<TBindingIdentity>>();
	private readonly bindingRetirementStates = new WeakMap<IParadisBindingRetirement<TBindingIdentity>, IParadisBindingRetirementState<TBindingIdentity>>();
	private readonly tickets = new Map<string, IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>>();
	private readonly commitPreparations = new WeakMap<IParadisBindingCommitPreparation<TDescriptor>, IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>>();
	private liveTicketCount = 0;

	constructor(private readonly options: IParadisBindingAuthorityOptions<TDescriptor>) { }

	registerConnection(window: TWindow, connection: TConnection): void {
		const registeredState = this.connectionStates.get(connection);
		if (registeredState !== undefined && registeredState.window !== window) {
			throw new ParadisBindingAuthorityError('connectionAlreadyRegistered');
		}
		this.cleanupExpiredTickets(this.options.now());
		const previousState = this.windowStates.get(window);
		if (previousState?.connection === connection) {
			return;
		}
		if (previousState !== undefined) {
			this.invalidateTickets(ticket => ticket.connection === previousState.connection);
			this.connectionStates.delete(previousState.connection);
		}
		const state: IParadisBindingWindowState<TWindow, TConnection> = { window, connection, manifest: undefined };
		this.windowStates.set(window, state);
		this.connectionStates.set(connection, state);
	}

	/** Returns the exact immutable object accepted for the current connection. */
	getCurrentAcceptedManifest(connection: TConnection): IParadisBindingAuthorityManifest {
		const manifest = this.requireCurrentConnection(connection).manifest;
		if (manifest === undefined) {
			throw new ParadisBindingAuthorityError('manifestRequired');
		}
		return manifest;
	}

	/** Lists only tokens present in the current accepted manifest and still owned by this connection's window. */
	listCurrentOwnedTokens(connection: TConnection): readonly string[] {
		const state = this.requireCurrentConnection(connection);
		const manifest = state.manifest;
		if (manifest === undefined) {
			throw new ParadisBindingAuthorityError('manifestRequired');
		}
		return Object.freeze(manifest.panes
			.filter(pane => this.tokenOwners.get(pane.token) === state.window)
			.map(pane => pane.token));
	}

	/** Tests present-manifest eligibility without disclosing another owner's identity. */
	isCurrentOwnedToken(connection: TConnection, token: string): boolean {
		if (!isBoundedNonEmptyString(token, MAX_TOKEN_LENGTH)) {
			return false;
		}
		const state = this.requireCurrentConnection(connection);
		const manifest = state.manifest;
		if (manifest === undefined) {
			throw new ParadisBindingAuthorityError('manifestRequired');
		}
		return this.tokenOwners.get(token) === state.window
			&& manifest.panes.some(pane => pane.token === token);
	}

	/** Internal service query for owner-locked tokens, including incomplete-manifest omissions. */
	isOwnedToken(token: string): boolean {
		return isBoundedNonEmptyString(token, MAX_TOKEN_LENGTH) && this.tokenOwners.has(token);
	}

	/** Captures an opaque lease that changes only after full retirement and reacquisition. */
	captureOwnedTokenLease(token: string): IParadisBindingOwnedTokenLease | undefined {
		return isBoundedNonEmptyString(token, MAX_TOKEN_LENGTH) && this.tokenOwners.has(token)
			? this.tokenOwnerLeases.get(token)
			: undefined;
	}

	/** Revalidates a previously captured owner lifecycle without accepting a token string again. */
	isOwnedTokenLeaseCurrent(lease: IParadisBindingOwnedTokenLease): boolean {
		return this.tokenOwners.has(lease.token) && this.tokenOwnerLeases.get(lease.token) === lease;
	}

	acceptManifest(connection: TConnection, value: unknown): IParadisBindingManifestAcceptance<TBindingIdentity> {
		this.cleanupExpiredTickets(this.options.now());
		const state = this.requireCurrentConnection(connection);
		let manifest: IParadisBindingAuthorityManifest;
		try {
			manifest = paradisParseBindingAuthorityManifest(value);
		} catch {
			throw new ParadisBindingAuthorityError('invalidManifest');
		}
		if (state.manifest !== undefined && manifest.revision <= state.manifest.revision) {
			throw new ParadisBindingAuthorityError('staleRevision');
		}

		for (const pane of manifest.panes) {
			this.requireOwnerAvailable(this.tokenOwners, pane.token, state.window);
		}
		for (const browserView of manifest.browserViews) {
			this.requireOwnerAvailable(this.viewOwners, browserView.viewId, state.window);
		}

		const manifestTokens = new Set(manifest.panes.map(pane => pane.token));
		const manifestViewIds = new Set(manifest.browserViews.map(browserView => browserView.viewId));
		const retiredTokens = manifest.complete
			? this.findOmittedOwners(this.tokenOwners, state.window, manifestTokens)
			: [];
		const retiredViewIds = manifest.complete
			? this.findOmittedOwners(this.viewOwners, state.window, manifestViewIds)
			: [];
		const bindingRetirements = retiredTokens.map(token => this.createBindingRetirement(token));

		const retiredTokenSet = new Set(retiredTokens);
		this.invalidateTickets(ticket => ticket.connection === connection || retiredTokenSet.has(ticket.token));
		for (const token of retiredTokens) {
			this.tokenOwners.delete(token);
			this.tokenOwnerLeases.delete(token);
		}
		for (const viewId of retiredViewIds) {
			this.viewOwners.delete(viewId);
		}
		for (const token of manifestTokens) {
			if (!this.tokenOwners.has(token)) {
				this.tokenOwnerLeases.set(token, Object.freeze({ token }));
			}
			this.tokenOwners.set(token, state.window);
		}
		for (const viewId of manifestViewIds) {
			this.viewOwners.set(viewId, state.window);
		}
		state.manifest = manifest;

		return Object.freeze({
			accepted: true,
			revision: manifest.revision,
			retiredTokens: Object.freeze(retiredTokens),
			retiredViewIds: Object.freeze(retiredViewIds),
			bindingRetirements: Object.freeze(bindingRetirements),
		});
	}

	destroyWindow(window: TWindow): IParadisBindingOwnerRelease<TBindingIdentity> {
		this.cleanupExpiredTickets(this.options.now());
		const state = this.windowStates.get(window);
		const retiredTokens = this.findOmittedOwners(this.tokenOwners, window, new Set());
		const retiredViewIds = this.findOmittedOwners(this.viewOwners, window, new Set());
		const bindingRetirements = retiredTokens.map(token => this.createBindingRetirement(token));
		if (state !== undefined) {
			this.invalidateTickets(ticket => ticket.connection === state.connection);
		}
		const retiredTokenSet = new Set(retiredTokens);
		this.invalidateTickets(ticket => retiredTokenSet.has(ticket.token));
		for (const token of retiredTokens) {
			this.tokenOwners.delete(token);
			this.tokenOwnerLeases.delete(token);
		}
		for (const viewId of retiredViewIds) {
			this.viewOwners.delete(viewId);
		}
		if (state !== undefined) {
			this.connectionStates.delete(state.connection);
			this.windowStates.delete(window);
		}
		return Object.freeze({
			retiredTokens: Object.freeze(retiredTokens),
			retiredViewIds: Object.freeze(retiredViewIds),
			bindingRetirements: Object.freeze(bindingRetirements),
		});
	}

	capturePrepareSnapshot(connection: TConnection, revision: number, token: string, viewId: string): IParadisBindingPrepareSnapshot {
		const state = this.requireCurrentConnection(connection);
		const manifest = state.manifest;
		if (manifest === undefined) {
			throw new ParadisBindingAuthorityError('manifestRequired');
		}
		if (manifest.revision !== revision) {
			throw new ParadisBindingAuthorityError('revisionMismatch');
		}
		const pane = manifest.panes.find(entry => entry.token === token);
		const browserView = manifest.browserViews.find(entry => entry.viewId === viewId);
		if (pane === undefined || browserView === undefined
			|| this.tokenOwners.get(token) !== state.window
			|| this.viewOwners.get(viewId) !== state.window) {
			throw new ParadisBindingAuthorityError('missingEntry');
		}
		if (pane.scope.kind === 'pending' || browserView.scope.kind === 'pending') {
			throw new ParadisBindingAuthorityError('pendingScope');
		}
		if (pane.scope.kind !== browserView.scope.kind
			|| (pane.scope.kind === 'managed' && browserView.scope.kind === 'managed' && pane.scope.stateKey !== browserView.scope.stateKey)) {
			throw new ParadisBindingAuthorityError('scopeMismatch');
		}

		const bindingState = this.getBindingState(token);
		const snapshot = Object.freeze({ revision, token, viewId, scope: pane.scope });
		this.prepareSnapshots.set(snapshot, {
			window: state.window,
			connection,
			manifest,
			tokenScope: pane.scope,
			viewScope: browserView.scope,
			tokenEpoch: bindingState.epoch,
			bindingIdentity: bindingState.identity,
		});
		return snapshot;
	}

	issueTicket(snapshot: IParadisBindingPrepareSnapshot, descriptor: TDescriptor): IParadisBindingTicket {
		const now = this.options.now();
		this.cleanupExpiredTickets(now);
		const snapshotState = this.prepareSnapshots.get(snapshot);
		if (snapshotState === undefined || !this.isSnapshotCurrent(snapshot, snapshotState)) {
			throw new ParadisBindingAuthorityError('staleSnapshot');
		}
		if (this.liveTicketCount >= MAX_LIVE_TICKETS) {
			throw new ParadisBindingAuthorityError('activeTicketCapacity');
		}
		if (this.tickets.size >= MAX_TICKET_RECORDS) {
			throw new ParadisBindingAuthorityError('totalTicketCapacity');
		}

		const ownedDescriptor = this.options.copyDescriptor(descriptor);
		const id = this.options.createTicketId();
		if (this.tickets.has(id)) {
			throw new ParadisBindingAuthorityError('ticketIdCollision');
		}
		const expiresAt = now + TICKET_LIFETIME_MS;
		this.tickets.set(id, {
			...snapshotState,
			id,
			expiresAt,
			token: snapshot.token,
			viewId: snapshot.viewId,
			descriptor: ownedDescriptor,
			scope: snapshot.scope,
			status: 'live',
		});
		this.liveTicketCount++;
		return Object.freeze({ id, expiresAt });
	}

	prepareTicketCommit(connection: TConnection, id: string): IParadisBindingCommitPreparation<TDescriptor> {
		this.requireCurrentConnection(connection);
		const now = this.options.now();
		const ticket = this.tickets.get(id);
		if (ticket === undefined || ticket.connection !== connection) {
			throw new ParadisBindingAuthorityError('invalidTicket');
		}
		if (ticket !== undefined && ticket.status === 'live' && now >= ticket.expiresAt) {
			this.removeTicketRecord(ticket);
			this.cleanupExpiredTickets(now);
			throw new ParadisBindingAuthorityError('expiredTicket');
		}
		this.cleanupExpiredTickets(now);
		if (ticket.status !== 'live') {
			throw new ParadisBindingAuthorityError('invalidTicket');
		}
		if (!this.isTicketCurrent(ticket)) {
			this.markTicketTombstone(ticket);
			throw new ParadisBindingAuthorityError('staleTicket');
		}

		const preparation = Object.freeze({
			token: ticket.token,
			viewId: ticket.viewId,
			descriptor: ticket.descriptor,
			scope: ticket.scope,
		});
		this.commitPreparations.set(preparation, ticket);
		return preparation;
	}

	commitPreparedTicket(
		connection: TConnection,
		preparation: IParadisBindingCommitPreparation<TDescriptor>,
		nextBindingIdentity: TBindingIdentity,
	): IParadisBindingCommit<TDescriptor> {
		this.requireCurrentConnection(connection);
		const ticket = this.commitPreparations.get(preparation);
		if (ticket === undefined || ticket.connection !== connection) {
			throw new ParadisBindingAuthorityError('invalidTicket');
		}

		const now = this.options.now();
		if (now >= ticket.expiresAt) {
			if (this.tickets.get(ticket.id) === ticket) {
				this.removeTicketRecord(ticket);
			}
			this.commitPreparations.delete(preparation);
			this.cleanupExpiredTickets(now);
			throw new ParadisBindingAuthorityError('expiredTicket');
		}
		this.cleanupExpiredTickets(now);
		if (this.tickets.get(ticket.id) !== ticket || ticket.status !== 'live') {
			this.commitPreparations.delete(preparation);
			throw new ParadisBindingAuthorityError('invalidTicket');
		}
		if (!this.isTicketCurrent(ticket)) {
			this.markTicketTombstone(ticket);
			this.commitPreparations.delete(preparation);
			throw new ParadisBindingAuthorityError('staleTicket');
		}

		this.markTicketTombstone(ticket);
		this.commitPreparations.delete(preparation);
		this.bindingStates.set(ticket.token, {
			epoch: ticket.tokenEpoch + 1,
			identity: nextBindingIdentity,
		});
		this.invalidateTickets(sibling => sibling.token === ticket.token);
		return preparation;
	}

	commitTicket(connection: TConnection, id: string, nextBindingIdentity: TBindingIdentity): IParadisBindingCommit<TDescriptor> {
		return this.commitPreparedTicket(connection, this.prepareTicketCommit(connection, id), nextBindingIdentity);
	}

	/**
	 * Records an ordinary bind, unbind, or external binding mutation.
	 * Task 3B must use the owner-release handle with {@link completeBindingRetirement} instead.
	 */
	recordBindingMutation(token: string, bindingIdentity: TBindingIdentity | undefined): void {
		this.cleanupExpiredTickets(this.options.now());
		const current = this.getBindingState(token);
		this.bindingStates.set(token, { epoch: current.epoch + 1, identity: bindingIdentity });
		this.invalidateTickets(ticket => ticket.token === token);
	}

	/**
	 * Claims a Task 3B retirement only when the handle's binding identity and mutation epoch are still current.
	 * Task 3B must call this pure-authority operation with the owner-release handle and, only when it returns
	 * true, retire the external binding matching `retirement.bindingIdentity` in the same synchronous call stack
	 * without awaiting. The external registry is expected to use a non-throwing `Map.delete` operation.
	 * A false result means the caller must not touch the current external binding.
	 */
	completeBindingRetirement(retirement: IParadisBindingRetirement<TBindingIdentity>): boolean {
		this.cleanupExpiredTickets(this.options.now());
		const retirementState = this.bindingRetirementStates.get(retirement);
		if (retirementState === undefined) {
			return false;
		}
		this.bindingRetirementStates.delete(retirement);

		const bindingState = this.bindingStates.get(retirementState.token);
		if (bindingState !== retirementState.bindingState
			|| bindingState.epoch !== retirementState.epoch
			|| !Object.is(bindingState.identity, retirementState.identity)) {
			return false;
		}

		this.invalidateTickets(ticket => ticket.token === retirementState.token);
		if (!this.tokenOwners.has(retirementState.token)) {
			this.bindingStates.delete(retirementState.token);
			return true;
		}

		this.bindingStates.set(retirementState.token, {
			epoch: bindingState.epoch + 1,
			identity: undefined,
		});
		return true;
	}

	/**
	 * Authenticates and consumes a retirement that cannot safely be completed by the external registry.
	 * Only an ownerless, still-exact materialized state is removed; reacquired or mutated state is preserved.
	 */
	abandonBindingRetirement(retirement: IParadisBindingRetirement<TBindingIdentity>): 'abandoned' | 'superseded' | 'invalid' {
		this.cleanupExpiredTickets(this.options.now());
		const retirementState = this.bindingRetirementStates.get(retirement);
		if (retirementState === undefined) {
			return 'invalid';
		}
		this.bindingRetirementStates.delete(retirement);

		const bindingState = this.bindingStates.get(retirementState.token);
		if (bindingState !== retirementState.bindingState
			|| bindingState.epoch !== retirementState.epoch
			|| !Object.is(bindingState.identity, retirementState.identity)
			|| this.tokenOwners.has(retirementState.token)) {
			return 'superseded';
		}

		this.bindingStates.delete(retirementState.token);
		return 'abandoned';
	}

	abortTicket(connection: TConnection, id: string): void {
		this.requireCurrentConnection(connection);
		const ticket = this.tickets.get(id);
		if (ticket === undefined || ticket.connection !== connection) {
			throw new ParadisBindingAuthorityError('invalidTicket');
		}
		const now = this.options.now();
		if (now >= ticket.expiresAt) {
			this.removeTicketRecord(ticket);
			this.cleanupExpiredTickets(now);
			throw new ParadisBindingAuthorityError('invalidTicket');
		}
		this.cleanupExpiredTickets(now);
		if (ticket.status === 'live') {
			this.markTicketTombstone(ticket);
		}
	}

	private requireCurrentConnection(connection: TConnection): IParadisBindingWindowState<TWindow, TConnection> {
		const state = this.connectionStates.get(connection);
		if (state === undefined || this.windowStates.get(state.window) !== state) {
			throw new ParadisBindingAuthorityError('staleConnection');
		}
		return state;
	}

	private requireOwnerAvailable(owners: ReadonlyMap<string, TWindow>, id: string, window: TWindow): void {
		const owner = owners.get(id);
		if (owner !== undefined && owner !== window) {
			throw new ParadisBindingAuthorityError('ownerConflict');
		}
	}

	private findOmittedOwners(owners: ReadonlyMap<string, TWindow>, window: TWindow, retained: ReadonlySet<string>): string[] {
		const omitted: string[] = [];
		for (const [id, owner] of owners) {
			if (owner === window && !retained.has(id)) {
				omitted.push(id);
			}
		}
		return omitted;
	}

	private getBindingState(token: string): IParadisBindingState<TBindingIdentity> {
		return this.bindingStates.get(token) ?? { epoch: 0, identity: undefined };
	}

	private createBindingRetirement(token: string): IParadisBindingRetirement<TBindingIdentity> {
		let bindingState = this.bindingStates.get(token);
		if (bindingState === undefined) {
			bindingState = { epoch: 0, identity: undefined };
			this.bindingStates.set(token, bindingState);
		}
		const retirement = Object.freeze({ token, bindingIdentity: bindingState.identity });
		this.bindingRetirementStates.set(retirement, {
			token,
			bindingState,
			epoch: bindingState.epoch,
			identity: bindingState.identity,
		});
		return retirement;
	}

	private isSnapshotCurrent(
		snapshot: IParadisBindingPrepareSnapshot,
		snapshotState: IParadisBindingPrepareSnapshotState<TWindow, TConnection, TBindingIdentity>,
	): boolean {
		const currentState = this.connectionStates.get(snapshotState.connection);
		if (currentState === undefined
			|| currentState.window !== snapshotState.window
			|| currentState.manifest !== snapshotState.manifest
			|| this.tokenOwners.get(snapshot.token) !== snapshotState.window
			|| this.viewOwners.get(snapshot.viewId) !== snapshotState.window) {
			return false;
		}
		const pane = currentState.manifest.panes.find(entry => entry.token === snapshot.token);
		const browserView = currentState.manifest.browserViews.find(entry => entry.viewId === snapshot.viewId);
		const bindingState = this.getBindingState(snapshot.token);
		return pane !== undefined
			&& browserView !== undefined
			&& this.scopesEqual(pane.scope, snapshotState.tokenScope)
			&& this.scopesEqual(browserView.scope, snapshotState.viewScope)
			&& bindingState.epoch === snapshotState.tokenEpoch
			&& Object.is(bindingState.identity, snapshotState.bindingIdentity);
	}

	private isTicketCurrent(ticket: IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>): boolean {
		return this.isSnapshotCurrent(
			{ revision: ticket.manifest.revision, token: ticket.token, viewId: ticket.viewId, scope: ticket.scope },
			ticket,
		);
	}

	private scopesEqual(left: ParadisBindingAuthorityScope, right: ParadisBindingAuthorityScope): boolean {
		return left.kind === right.kind
			&& (left.kind !== 'managed' || (right.kind === 'managed' && left.stateKey === right.stateKey));
	}

	private invalidateTickets(
		predicate: (ticket: IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>) => boolean,
	): void {
		for (const ticket of this.tickets.values()) {
			if (ticket.status === 'live' && predicate(ticket)) {
				this.markTicketTombstone(ticket);
			}
		}
	}

	private markTicketTombstone(ticket: IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>): void {
		if (ticket.status === 'live') {
			ticket.status = 'tombstone';
			this.liveTicketCount--;
		}
	}

	private cleanupExpiredTickets(now: number): void {
		for (const ticket of this.tickets.values()) {
			if (now >= ticket.expiresAt) {
				this.removeTicketRecord(ticket);
			}
		}
	}

	private removeTicketRecord(ticket: IParadisBindingTicketRecord<TWindow, TConnection, TDescriptor, TBindingIdentity>): void {
		if (this.tickets.delete(ticket.id) && ticket.status === 'live') {
			this.liveTicketCount--;
		}
	}
}
