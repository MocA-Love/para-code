/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { TerminalShellType } from '../../../../platform/terminal/common/terminal.js';

export type ParadisTerminalHistoryWaitResult<T> =
	| { readonly kind: 'completed'; readonly value: T | undefined }
	| { readonly kind: 'cancelled' };

interface IParadisTerminalHistoryWaiter<T> {
	settled: boolean;
	cancellationListener: IDisposable | undefined;
	readonly owner: Set<IParadisTerminalHistoryWaiter<T>>;
	readonly resolve: (result: ParadisTerminalHistoryWaitResult<T>) => void;
	readonly reject: (error: unknown) => void;
}

interface IParadisTerminalHistorySharedGeneration<T> {
	readonly id: number;
	readonly waiters: Set<IParadisTerminalHistoryWaiter<T>>;
}

interface IParadisTerminalHistoryFlight<T> {
	readonly generation: number;
	readonly startedAt: number;
	readonly waiters: Set<IParadisTerminalHistoryWaiter<T>>;
}

interface IParadisTerminalHistoryCacheState<T> {
	cached: { readonly value: T | undefined; readonly expiresAt: number } | undefined;
	readonly activeFlights: Set<IParadisTerminalHistoryFlight<T>>;
	authoritativeFlight: IParadisTerminalHistoryFlight<T> | undefined;
	nextGeneration: number;
}

export function paradisTerminalHistoryCacheKey(shellType: TerminalShellType, resource: URI): string {
	return JSON.stringify([shellType, resource.toString()]);
}

export class ParadisTerminalHistorySharedValue<T> extends Disposable {
	private _waiters = new Set<IParadisTerminalHistoryWaiter<T>>();
	private _isDisposed = false;
	private _nextGeneration = 0;
	private _pendingGeneration: IParadisTerminalHistorySharedGeneration<T> | undefined;
	private _hasValue = false;
	private _value: T | undefined;

	constructor(
		private readonly _loader: () => Promise<T | undefined>,
		private readonly _cacheCompleted: boolean = true,
	) {
		super();
	}

	get(token: CancellationToken): Promise<ParadisTerminalHistoryWaitResult<T>> {
		if (this._isDisposed || token.isCancellationRequested) {
			return Promise.resolve({ kind: 'cancelled' });
		}
		if (this._hasValue) {
			return Promise.resolve({ kind: 'completed', value: this._value });
		}

		let generation = this._pendingGeneration;
		if (generation) {
			return this._waitForGeneration(generation, token);
		}

		generation = {
			id: ++this._nextGeneration,
			waiters: new Set(),
		};
		this._pendingGeneration = generation;
		this._waiters = generation.waiters;
		const result = this._waitForGeneration(generation, token);

		let loaderPromise: Promise<T | undefined>;
		try {
			loaderPromise = this._loader();
		} catch (error) {
			loaderPromise = Promise.reject(error);
		}
		loaderPromise.then(
			value => this._settleGeneration(generation, value),
			error => this._rejectGeneration(generation, error),
		);
		return result;
	}

	private _waitForGeneration(generation: IParadisTerminalHistorySharedGeneration<T>, token: CancellationToken): Promise<ParadisTerminalHistoryWaitResult<T>> {
		return new Promise((resolve, reject) => {
			const waiter: IParadisTerminalHistoryWaiter<T> = {
				settled: false,
				cancellationListener: undefined,
				owner: generation.waiters,
				resolve,
				reject,
			};
			generation.waiters.add(waiter);
			const listener = token.onCancellationRequested(() => this._resolveWaiter(waiter, { kind: 'cancelled' }));
			waiter.cancellationListener = listener;
			if (waiter.settled) {
				listener.dispose();
			}
			if (token.isCancellationRequested) {
				this._resolveWaiter(waiter, { kind: 'cancelled' });
			}
		});
	}

	private _settleGeneration(generation: IParadisTerminalHistorySharedGeneration<T>, value: T | undefined): void {
		if (this._isDisposed || this._pendingGeneration !== generation) {
			return;
		}
		const settledWaiters = generation.waiters;
		this._waiters = new Set();
		this._pendingGeneration = undefined;
		if (this._cacheCompleted) {
			this._hasValue = true;
			this._value = value;
		}
		for (const waiter of settledWaiters) {
			this._resolveWaiter(waiter, { kind: 'completed', value });
		}
	}

	private _rejectGeneration(generation: IParadisTerminalHistorySharedGeneration<T>, error: unknown): void {
		if (this._isDisposed || this._pendingGeneration !== generation) {
			return;
		}
		const settledWaiters = generation.waiters;
		this._waiters = new Set();
		this._pendingGeneration = undefined;
		for (const waiter of settledWaiters) {
			this._rejectWaiter(waiter, error);
		}
	}

	private _resolveWaiter(waiter: IParadisTerminalHistoryWaiter<T>, result: ParadisTerminalHistoryWaitResult<T>): void {
		if (waiter.settled) {
			return;
		}
		waiter.settled = true;
		waiter.owner.delete(waiter);
		waiter.cancellationListener?.dispose();
		waiter.resolve(result);
	}

	private _rejectWaiter(waiter: IParadisTerminalHistoryWaiter<T>, error: unknown): void {
		if (waiter.settled) {
			return;
		}
		waiter.settled = true;
		waiter.owner.delete(waiter);
		waiter.cancellationListener?.dispose();
		waiter.reject(error);
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		const waiters = this._waiters;
		this._waiters = new Set();
		this._pendingGeneration = undefined;
		this._hasValue = false;
		this._value = undefined;
		for (const waiter of waiters) {
			this._resolveWaiter(waiter, { kind: 'cancelled' });
		}
		super.dispose();
	}
}

export class ParadisTerminalHistoryCache<T> extends Disposable {
	private readonly _states = new Map<string, IParadisTerminalHistoryCacheState<T>>();
	private _isDisposed = false;

	constructor(
		private readonly _ttlMs: number,
		private readonly _maxFlightAgeMs: number,
		private readonly _now: () => number = Date.now,
	) {
		super();
	}

	get(key: string, token: CancellationToken, loader: () => Promise<T | undefined>): Promise<ParadisTerminalHistoryWaitResult<T>> {
		if (this._isDisposed || token.isCancellationRequested) {
			return Promise.resolve({ kind: 'cancelled' });
		}

		const now = this._now();
		let state = this._states.get(key);
		if (state?.cached && now < state.cached.expiresAt) {
			return Promise.resolve({ kind: 'completed', value: state.cached.value });
		}

		if (!state) {
			state = {
				cached: undefined,
				activeFlights: new Set(),
				authoritativeFlight: undefined,
				nextGeneration: 0,
			};
			this._states.set(key, state);
		} else {
			state.cached = undefined;
		}

		const authoritativeFlight = state.authoritativeFlight;
		if (authoritativeFlight) {
			const shouldReplace = now - authoritativeFlight.startedAt >= this._maxFlightAgeMs && state.activeFlights.size === 1;
			if (!shouldReplace) {
				return this._waitForFlight(authoritativeFlight, token);
			}
		}

		return this._startFlight(key, state, now, token, loader);
	}

	private _startFlight(
		key: string,
		state: IParadisTerminalHistoryCacheState<T>,
		startedAt: number,
		token: CancellationToken,
		loader: () => Promise<T | undefined>,
	): Promise<ParadisTerminalHistoryWaitResult<T>> {
		const flight: IParadisTerminalHistoryFlight<T> = {
			generation: ++state.nextGeneration,
			startedAt,
			waiters: new Set(),
		};
		state.activeFlights.add(flight);
		state.authoritativeFlight = flight;
		const result = this._waitForFlight(flight, token);

		let loaderPromise: Promise<T | undefined>;
		try {
			loaderPromise = loader();
		} catch (error) {
			loaderPromise = Promise.reject(error);
		}
		loaderPromise.then(
			value => this._settleFlight(key, state, flight, value),
			() => this._settleFlight(key, state, flight, undefined),
		);
		return result;
	}

	private _waitForFlight(flight: IParadisTerminalHistoryFlight<T>, token: CancellationToken): Promise<ParadisTerminalHistoryWaitResult<T>> {
		return new Promise((resolve, reject) => {
			const waiter: IParadisTerminalHistoryWaiter<T> = {
				settled: false,
				cancellationListener: undefined,
				owner: flight.waiters,
				resolve,
				reject,
			};
			flight.waiters.add(waiter);
			const listener = token.onCancellationRequested(() => this._resolveWaiter(waiter, { kind: 'cancelled' }));
			waiter.cancellationListener = listener;
			if (waiter.settled) {
				listener.dispose();
			}
			if (token.isCancellationRequested) {
				this._resolveWaiter(waiter, { kind: 'cancelled' });
			}
		});
	}

	private _settleFlight(
		key: string,
		state: IParadisTerminalHistoryCacheState<T>,
		flight: IParadisTerminalHistoryFlight<T>,
		value: T | undefined,
	): void {
		state.activeFlights.delete(flight);
		for (const waiter of flight.waiters) {
			this._resolveWaiter(waiter, { kind: 'completed', value });
		}
		if (this._isDisposed || this._states.get(key) !== state || state.authoritativeFlight !== flight) {
			return;
		}
		state.authoritativeFlight = undefined;
		state.cached = { value, expiresAt: this._now() + this._ttlMs };
	}

	private _resolveWaiter(waiter: IParadisTerminalHistoryWaiter<T>, result: ParadisTerminalHistoryWaitResult<T>): void {
		if (waiter.settled) {
			return;
		}
		waiter.settled = true;
		waiter.owner.delete(waiter);
		waiter.cancellationListener?.dispose();
		waiter.resolve(result);
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		for (const state of this._states.values()) {
			for (const flight of state.activeFlights) {
				for (const waiter of flight.waiters) {
					this._resolveWaiter(waiter, { kind: 'cancelled' });
				}
			}
		}
		this._states.clear();
		super.dispose();
	}
}
