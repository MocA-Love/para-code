/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IParadisExactBrowserViewDescriptor,
	paradisParseExactBrowserViewDescriptor,
} from './paradisAgentBrowser.js';

/** Shared-process external binding cap mirrored by this coordinator. */
export const PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS = 4096;
/** Defensive cap for independently referenced exact BrowserViews. */
export const PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EXACT_VIEWS = 4096;

const PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_TOKEN_LENGTH = 200;

/** Stable failure categories for rejected state transitions. */
export type ParadisExactViewBackgroundThrottlingErrorReason =
	| 'invalidToken'
	| 'invalidDescriptor'
	| 'bindingCapacity'
	| 'exactViewCapacity'
	| 'stateMismatch';

/** Input, capacity, or invariant failure raised before coordination state is mutated. */
export class ParadisExactViewBackgroundThrottlingError extends Error {
	constructor(readonly reason: ParadisExactViewBackgroundThrottlingErrorReason) {
		super(`Exact BrowserView background throttling coordination failed: ${reason}`);
		this.name = 'ParadisExactViewBackgroundThrottlingError';
	}
}

/** One copy-owned Electron Main background-throttling operation. */
export interface IParadisExactViewBackgroundThrottlingEffect {
	readonly descriptor: IParadisExactBrowserViewDescriptor;
	readonly enabled: boolean;
}

const PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EFFECT_STATES =
	PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EXACT_VIEWS * 2;
const PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_ATTEMPTS = 3;

export interface IParadisExactViewBackgroundThrottlingDispatcherOptions {
	readonly apply: (effect: IParadisExactViewBackgroundThrottlingEffect) => Promise<boolean>;
	readonly onDisableFailure: (descriptor: IParadisExactBrowserViewDescriptor) => void;
	readonly onDiagnostic?: (error: unknown, effect: IParadisExactViewBackgroundThrottlingEffect) => void;
	readonly maximumPendingExactViews?: number;
	readonly maximumAttempts?: number;
}

interface IParadisExactViewBackgroundThrottlingDispatchState {
	readonly descriptor: IParadisExactBrowserViewDescriptor;
	desiredEnabled: boolean;
	revision: number;
	running: boolean;
}

/**
 * Serializes Main operations per concrete BrowserView and retains only the latest desired state.
 * A stale async result may have reached Main, so the current desired state is always applied after
 * it; stale failures never trigger binding cleanup.
 */
export class ParadisExactViewBackgroundThrottlingDispatcher {
	private readonly states = new Map<string, IParadisExactViewBackgroundThrottlingDispatchState>();
	private readonly maximumPendingExactViews: number;
	private readonly maximumAttempts: number;
	private idlePromise: Promise<void> | undefined;
	private resolveIdlePromise: (() => void) | undefined;
	private disposed = false;

	constructor(private readonly options: IParadisExactViewBackgroundThrottlingDispatcherOptions) {
		this.maximumPendingExactViews = options.maximumPendingExactViews
			?? PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EFFECT_STATES;
		this.maximumAttempts = options.maximumAttempts
			?? PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_ATTEMPTS;
		if (!isValidLimit(this.maximumPendingExactViews, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EFFECT_STATES)) {
			throw new RangeError('maximumPendingExactViews must be a positive safe integer within the effect-state cap');
		}
		if (!isValidLimit(this.maximumAttempts, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_ATTEMPTS)) {
			throw new RangeError('maximumAttempts must be a positive safe integer within the retry cap');
		}
	}

	get pendingExactViewCount(): number {
		return this.states.size;
	}

	dispatchEffects(effects: readonly IParadisExactViewBackgroundThrottlingEffect[]): void {
		if (this.disposed) {
			return;
		}
		for (const effectValue of effects) {
			const descriptor = paradisParseExactBrowserViewDescriptor(effectValue?.descriptor);
			if (descriptor === undefined || typeof effectValue?.enabled !== 'boolean') {
				continue;
			}
			const effect = createEffect(descriptor, effectValue.enabled);
			const key = exactViewKey(descriptor);
			let state = this.states.get(key);
			if (state === undefined) {
				if (this.states.size >= this.maximumPendingExactViews) {
					this.safeDiagnostic(new Error('Exact BrowserView background throttling dispatch capacity reached'), effect);
					if (!effect.enabled) {
						this.safeDisableFailure(descriptor, effect);
					}
					continue;
				}
				state = { descriptor, desiredEnabled: effect.enabled, revision: 1, running: false };
				this.states.set(key, state);
			} else {
				if (state.desiredEnabled === effect.enabled) {
					continue;
				}
				state.desiredEnabled = effect.enabled;
				state.revision++;
			}
			if (!state.running) {
				state.running = true;
				void this.runState(key, state);
			}
		}
	}

	whenIdle(): Promise<void> {
		if (this.states.size === 0 || this.disposed) {
			return Promise.resolve();
		}
		return this.idlePromise ??= new Promise<void>(resolve => this.resolveIdlePromise = resolve);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.states.clear();
		this.resolveIdleWaiters();
	}

	private async runState(key: string, state: IParadisExactViewBackgroundThrottlingDispatchState): Promise<void> {
		while (!this.disposed && this.states.get(key) === state) {
			const revision = state.revision;
			const effect = createEffect(state.descriptor, state.desiredEnabled);
			let result: boolean | undefined;
			let rejected = false;

			for (let attempt = 0; attempt < this.maximumAttempts; attempt++) {
				if (this.disposed || this.states.get(key) !== state || state.revision !== revision) {
					break;
				}
				try {
					const applied = await this.options.apply(effect);
					if (typeof applied !== 'boolean') {
						throw new TypeError('Exact BrowserView background throttling returned a non-boolean result');
					}
					result = applied;
					rejected = false;
					break;
				} catch (error) {
					rejected = true;
					this.safeDiagnostic(error, effect);
				}
			}

			if (this.disposed || this.states.get(key) !== state) {
				return;
			}
			if (state.revision !== revision) {
				continue;
			}
			if (!effect.enabled && (result === false || rejected)) {
				this.safeDisableFailure(state.descriptor, effect);
				if (this.disposed || this.states.get(key) !== state) {
					return;
				}
				if (state.revision !== revision) {
					continue;
				}
			}

			this.states.delete(key);
			this.resolveIdleWaitersIfIdle();
			return;
		}
	}

	private safeDisableFailure(
		descriptor: IParadisExactBrowserViewDescriptor,
		effect: IParadisExactViewBackgroundThrottlingEffect,
	): void {
		try {
			this.options.onDisableFailure(descriptor);
		} catch (error) {
			this.safeDiagnostic(error, effect);
		}
	}

	private safeDiagnostic(error: unknown, effect: IParadisExactViewBackgroundThrottlingEffect): void {
		try {
			this.options.onDiagnostic?.(error, effect);
		} catch {
			// Dispatch and cleanup must remain non-throwing even when diagnostics are unavailable.
		}
	}

	private resolveIdleWaitersIfIdle(): void {
		if (this.states.size === 0) {
			this.resolveIdleWaiters();
		}
	}

	private resolveIdleWaiters(): void {
		const resolve = this.resolveIdlePromise;
		this.idlePromise = undefined;
		this.resolveIdlePromise = undefined;
		resolve?.();
	}
}

/** Testable limits, each bounded by the production service cap. */
export interface IParadisExactViewBackgroundThrottlingCoordinatorOptions {
	readonly maximumBindings?: number;
	readonly maximumExactViews?: number;
}

interface IExactViewReference {
	readonly descriptor: IParadisExactBrowserViewDescriptor;
	refCount: number;
}

const EMPTY_EFFECTS: readonly IParadisExactViewBackgroundThrottlingEffect[] = Object.freeze([]);

function isValidLimit(value: number, safeMaximum: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= safeMaximum;
}

function exactViewKey(descriptor: IParadisExactBrowserViewDescriptor): string {
	return JSON.stringify([descriptor.windowId, descriptor.viewId, descriptor.targetId, descriptor.viewLease]);
}

function createEffect(
	descriptor: IParadisExactBrowserViewDescriptor,
	enabled: boolean,
): IParadisExactViewBackgroundThrottlingEffect {
	return Object.freeze({ descriptor, enabled });
}

/**
 * Owns synchronous binding/refcount state and returns the Electron Main side effects that the
 * caller may dispatch asynchronously. No external call is made while coordination state changes.
 */
export class ParadisExactViewBackgroundThrottlingCoordinator {
	private readonly tokenBindings = new Map<string, string>();
	private readonly exactReferences = new Map<string, IExactViewReference>();
	private readonly maximumBindings: number;
	private readonly maximumExactViews: number;

	constructor(options: IParadisExactViewBackgroundThrottlingCoordinatorOptions = {}) {
		const maximumBindings = options.maximumBindings ?? PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS;
		const maximumExactViews = options.maximumExactViews ?? PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EXACT_VIEWS;
		if (!isValidLimit(maximumBindings, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_BINDINGS)) {
			throw new RangeError('maximumBindings must be a positive safe integer within the service binding cap');
		}
		if (!isValidLimit(maximumExactViews, PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_EXACT_VIEWS)) {
			throw new RangeError('maximumExactViews must be a positive safe integer within the service binding cap');
		}
		this.maximumBindings = maximumBindings;
		this.maximumExactViews = maximumExactViews;
	}

	get bindingCount(): number {
		return this.tokenBindings.size;
	}

	get exactViewCount(): number {
		return this.exactReferences.size;
	}

	/**
	 * Verifies that the complete external binding registry is exactly mirrored here and that the
	 * immediately following set is capacity-safe. This method never mutates coordinator state.
	 */
	assertCanSetBinding(
		currentBindings: Iterable<readonly [string, unknown]>,
		token: string,
		descriptorValue: unknown,
	): void {
		const descriptor = this.parseDescriptor(descriptorValue);
		this.requireToken(token);

		const expectedTokenBindings = new Map<string, string>();
		const expectedExactReferences = new Map<string, { refCount: number }>();
		try {
			for (const entry of currentBindings) {
				if (!Array.isArray(entry) || entry.length !== 2 || expectedTokenBindings.size >= this.maximumBindings) {
					throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
				}
				const [currentToken, currentDescriptorValue] = entry;
				if (!this.isValidToken(currentToken) || expectedTokenBindings.has(currentToken)) {
					throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
				}
				const currentDescriptor = paradisParseExactBrowserViewDescriptor(currentDescriptorValue);
				if (currentDescriptor === undefined) {
					throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
				}
				const key = exactViewKey(currentDescriptor);
				expectedTokenBindings.set(currentToken, key);
				const reference = expectedExactReferences.get(key);
				if (reference === undefined) {
					expectedExactReferences.set(key, { refCount: 1 });
				} else {
					reference.refCount++;
				}
			}
		} catch (error) {
			if (error instanceof ParadisExactViewBackgroundThrottlingError) {
				throw error;
			}
			throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
		}

		if (expectedTokenBindings.size !== this.tokenBindings.size
			|| expectedExactReferences.size !== this.exactReferences.size) {
			throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
		}
		for (const [currentToken, expectedKey] of expectedTokenBindings) {
			if (this.tokenBindings.get(currentToken) !== expectedKey) {
				throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
			}
		}
		for (const [key, expectedReference] of expectedExactReferences) {
			const reference = this.exactReferences.get(key);
			if (reference === undefined
				|| reference.refCount !== expectedReference.refCount
				|| exactViewKey(reference.descriptor) !== key) {
				throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
			}
		}

		this.assertOwnedSetAccepted(token, descriptor);
	}

	/** Creates or replaces one token binding and returns its ordered external effects. */
	setBinding(token: string, descriptorValue: unknown): readonly IParadisExactViewBackgroundThrottlingEffect[] {
		this.requireToken(token);
		const descriptor = this.parseDescriptor(descriptorValue);
		this.assertOwnedSetAccepted(token, descriptor);

		const newKey = exactViewKey(descriptor);
		const oldKey = this.tokenBindings.get(token);
		if (oldKey === newKey) {
			return EMPTY_EFFECTS;
		}

		const oldReference = oldKey === undefined ? undefined : this.exactReferences.get(oldKey);
		const newReference = this.exactReferences.get(newKey);

		const effects: IParadisExactViewBackgroundThrottlingEffect[] = [];
		if (newReference === undefined) {
			this.exactReferences.set(newKey, { descriptor, refCount: 1 });
			effects.push(createEffect(descriptor, false));
		} else {
			newReference.refCount++;
		}
		this.tokenBindings.set(token, newKey);

		if (oldKey !== undefined && oldReference !== undefined) {
			oldReference.refCount--;
			if (oldReference.refCount === 0) {
				this.exactReferences.delete(oldKey);
				effects.push(createEffect(oldReference.descriptor, true));
			}
		}

		return effects.length === 0 ? EMPTY_EFFECTS : Object.freeze(effects);
	}

	/** Releases one token binding; unknown or already released tokens are idempotent no-ops. */
	releaseBinding(token: string): readonly IParadisExactViewBackgroundThrottlingEffect[] {
		const key = this.tokenBindings.get(token);
		if (key === undefined) {
			return EMPTY_EFFECTS;
		}

		this.tokenBindings.delete(token);
		const reference = this.exactReferences.get(key);
		if (reference === undefined) {
			return EMPTY_EFFECTS;
		}
		reference.refCount--;
		if (reference.refCount !== 0) {
			return EMPTY_EFFECTS;
		}

		this.exactReferences.delete(key);
		return Object.freeze([createEffect(reference.descriptor, true)]);
	}

	private isValidToken(token: unknown): token is string {
		return typeof token === 'string'
			&& token.length > 0
			&& token.length <= PARADIS_EXACT_VIEW_BACKGROUND_THROTTLING_MAX_TOKEN_LENGTH;
	}

	private requireToken(token: unknown): asserts token is string {
		if (!this.isValidToken(token)) {
			throw new ParadisExactViewBackgroundThrottlingError('invalidToken');
		}
	}

	private parseDescriptor(value: unknown): IParadisExactBrowserViewDescriptor {
		const descriptor = paradisParseExactBrowserViewDescriptor(value);
		if (descriptor === undefined) {
			throw new ParadisExactViewBackgroundThrottlingError('invalidDescriptor');
		}
		return descriptor;
	}

	private assertOwnedSetAccepted(token: string, descriptor: IParadisExactBrowserViewDescriptor): void {
		const newKey = exactViewKey(descriptor);
		const oldKey = this.tokenBindings.get(token);
		if (oldKey === newKey) {
			return;
		}
		if (oldKey === undefined && this.tokenBindings.size >= this.maximumBindings) {
			throw new ParadisExactViewBackgroundThrottlingError('bindingCapacity');
		}

		const oldReference = oldKey === undefined ? undefined : this.exactReferences.get(oldKey);
		if (oldKey !== undefined && oldReference === undefined) {
			throw new ParadisExactViewBackgroundThrottlingError('stateMismatch');
		}
		const newReference = this.exactReferences.get(newKey);
		const projectedExactViewCount = this.exactReferences.size
			+ (newReference === undefined ? 1 : 0)
			- (oldReference?.refCount === 1 ? 1 : 0);
		if (projectedExactViewCount > this.maximumExactViews) {
			throw new ParadisExactViewBackgroundThrottlingError('exactViewCapacity');
		}
	}
}
