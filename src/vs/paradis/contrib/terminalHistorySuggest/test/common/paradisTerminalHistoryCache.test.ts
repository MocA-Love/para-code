/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { ParadisTerminalHistoryCache, paradisTerminalHistoryCacheKey, ParadisTerminalHistorySharedValue, ParadisTerminalHistoryWaitResult } from '../../common/paradisTerminalHistoryCache.js';

type SharedValueBoundary = { readonly _waiters: ReadonlySet<object> };
type CacheFlightBoundary = { readonly waiters: ReadonlySet<object> };
type CacheBoundary = {
	readonly _states: ReadonlyMap<string, {
		readonly activeFlights: ReadonlySet<CacheFlightBoundary>;
		readonly authoritativeFlight: CacheFlightBoundary | undefined;
	}>;
};

function getSharedBoundary<T>(value: ParadisTerminalHistorySharedValue<T>): SharedValueBoundary {
	return value as unknown as SharedValueBoundary;
}

function getCacheBoundary<T>(cache: ParadisTerminalHistoryCache<T>): CacheBoundary {
	return cache as unknown as CacheBoundary;
}

class TrackedDeferred<T> {
	private _resolve!: (value: T | PromiseLike<T>) => void;
	private _reject!: (error: unknown) => void;
	private readonly _source = new Promise<T>((resolve, reject) => {
		this._resolve = resolve;
		this._reject = reject;
	});
	readonly promise: Promise<T>;
	thenCount = 0;

	constructor() {
		const source = this._source;
		const self = this;
		this.promise = new class implements Promise<T> {
			readonly [Symbol.toStringTag] = 'Promise';
			then<TResult1 = T, TResult2 = never>(
				onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
			): Promise<TResult1 | TResult2> {
				self.thenCount++;
				return source.then(onfulfilled, onrejected);
			}
			catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
				return source.catch(onrejected);
			}
			finally(onfinally?: (() => void) | null): Promise<T> {
				return source.finally(onfinally);
			}
		}();
	}

	resolve(value: T): void {
		this._resolve(value);
	}

	reject(error: unknown): void {
		this._reject(error);
	}
}

class CountingCancellationToken implements CancellationToken {
	private readonly _listeners = new Set<(event: void) => unknown>();
	private _isCancellationRequested = false;
	activeListeners = 0;
	disposeCount = 0;
	cancelFireCount = 0;
	onListenerDispose: (() => void) | undefined;
	cancelOnRegistration = false;
	cancelOnListenerDispose = false;

	get isCancellationRequested(): boolean {
		return this._isCancellationRequested;
	}

	readonly onCancellationRequested: Event<void> = (listener, thisArgs) => {
		const callback = thisArgs ? listener.bind(thisArgs) : listener;
		let disposed = false;
		this._listeners.add(callback);
		this.activeListeners++;
		if (this.cancelOnRegistration) {
			this.cancel();
		} else if (this._isCancellationRequested) {
			callback(undefined);
		}
		return {
			dispose: () => {
				this.disposeCount++;
				if (disposed) {
					return;
				}
				disposed = true;
				if (this.cancelOnListenerDispose) {
					this._isCancellationRequested = true;
					this.cancelFireCount++;
					callback(undefined);
				}
				if (this._listeners.delete(callback)) {
					this.activeListeners--;
				}
				this.onListenerDispose?.();
			},
		};
	};

	cancel(): void {
		if (this._isCancellationRequested) {
			return;
		}
		this._isCancellationRequested = true;
		for (const listener of [...this._listeners]) {
			this.cancelFireCount++;
			listener(undefined);
		}
	}
}

function trackSettlement<T>(promise: Promise<T>): { readonly promise: Promise<T>; readonly count: () => number } {
	let count = 0;
	return {
		promise: promise.then(value => {
			count++;
			return value;
		}, error => {
			count++;
			throw error;
		}),
		count: () => count,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

suite('ParadisTerminalHistoryCache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shares one loader handler and detaches one hundred cancelled waiters', async () => {
		// Catches waiter-specific loader reactions and cancelled waiters retained by the shared generation.
		const deferred = new TrackedDeferred<string | undefined>();
		let loaderCount = 0;
		const shared = new ParadisTerminalHistorySharedValue(() => {
			loaderCount++;
			return deferred.promise;
		});
		const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
		const tracked = tokens.map(token => trackSettlement(shared.get(token)));

		assert.deepStrictEqual({ loaderCount, thenCount: deferred.thenCount, waiters: getSharedBoundary(shared)._waiters.size }, { loaderCount: 1, thenCount: 1, waiters: 100 });
		for (const token of tokens) {
			token.cancel();
		}
		const cancelled = await Promise.all(tracked.map(item => item.promise));
		assert.deepStrictEqual({
			results: cancelled,
			listeners: tokens.map(token => token.activeListeners),
			waiters: getSharedBoundary(shared)._waiters.size,
			settlements: tracked.map(item => item.count()),
		}, {
			results: Array.from({ length: 100 }, () => ({ kind: 'cancelled' })),
			listeners: Array.from({ length: 100 }, () => 0),
			waiters: 0,
			settlements: Array.from({ length: 100 }, () => 1),
		});

		const location = 'resolved location';
		deferred.resolve(location);
		await flushMicrotasks();
		assert.deepStrictEqual(await shared.get(CancellationToken.None), { kind: 'completed', value: location });
		assert.deepStrictEqual({ loaderCount, thenCount: deferred.thenCount }, { loaderCount: 1, thenCount: 1 });
		shared.dispose();

		const rejected = new TrackedDeferred<string | undefined>();
		let retryCount = 0;
		const retried = new TrackedDeferred<string | undefined>();
		const retryingShared = new ParadisTerminalHistorySharedValue(() => (++retryCount === 1 ? rejected : retried).promise);
		const rejectedToken = new CountingCancellationToken();
		const rejectedWait = retryingShared.get(rejectedToken);
		rejectedToken.cancel();
		await rejectedWait;
		rejected.reject(new Error('late rejection'));
		await flushMicrotasks();
		const retryWait = retryingShared.get(CancellationToken.None);
		assert.strictEqual(retryCount, 2);
		retried.resolve('retried value');
		assert.deepStrictEqual(await retryWait, { kind: 'completed', value: 'retried value' });
		retryingShared.dispose();
	});

	test('settles a shared value waiter once when cancellation wins the same-tick race', async () => {
		// Catches deletion of the waiter settled gate after cancellation wins before loader completion.
		const deferred = new TrackedDeferred<string | undefined>();
		const token = new CountingCancellationToken();
		token.cancelOnListenerDispose = true;
		const shared = new ParadisTerminalHistorySharedValue(() => deferred.promise);
		const tracked = trackSettlement(shared.get(token));

		token.cancel();
		deferred.resolve('late completed value');
		const result = await tracked.promise;
		await flushMicrotasks();

		assert.deepStrictEqual({
			result,
			settlementCallbacks: tracked.count(),
			listenerDisposeCalls: token.disposeCount,
			cancelCallbacks: token.cancelFireCount,
			waiters: getSharedBoundary(shared)._waiters.size,
		}, {
			result: { kind: 'cancelled' },
			settlementCallbacks: 1,
			listenerDisposeCalls: 1,
			cancelCallbacks: 2,
			waiters: 0,
		});
		shared.dispose();
	});

	test('settles a shared value waiter once when completion wins the same-tick race', async () => {
		// Catches reentrant cancellation from listener disposal after completion settlement starts.
		const deferred = new TrackedDeferred<string | undefined>();
		const token = new CountingCancellationToken();
		token.cancelOnListenerDispose = true;
		const shared = new ParadisTerminalHistorySharedValue(() => deferred.promise);
		const tracked = trackSettlement(shared.get(token));

		deferred.resolve('completed value');
		const result = await tracked.promise;
		await flushMicrotasks();

		assert.deepStrictEqual({
			result,
			settlementCallbacks: tracked.count(),
			listenerDisposeCalls: token.disposeCount,
			cancelCallbacks: token.cancelFireCount,
			waiters: getSharedBoundary(shared)._waiters.size,
		}, {
			result: { kind: 'completed', value: 'completed value' },
			settlementCallbacks: 1,
			listenerDisposeCalls: 1,
			cancelCallbacks: 1,
			waiters: 0,
		});
		shared.dispose();
	});

	test('disposes pending shared waiters and ignores late settlement', async () => {
		// Catches disposal that resolves promises but leaves waiter/listener state attached.
		for (const outcome of ['resolve', 'reject'] as const) {
			const deferred = new TrackedDeferred<string | undefined>();
			let loaderCount = 0;
			const shared = new ParadisTerminalHistorySharedValue(() => {
				loaderCount++;
				return deferred.promise;
			});
			const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
			const waits = tokens.map(token => shared.get(token));
			shared.dispose();
			assert.deepStrictEqual({
				results: await Promise.all(waits),
				listeners: tokens.map(token => token.activeListeners),
				waiters: getSharedBoundary(shared)._waiters.size,
			}, {
				results: Array.from({ length: 100 }, () => ({ kind: 'cancelled' })),
				listeners: Array.from({ length: 100 }, () => 0),
				waiters: 0,
			});
			if (outcome === 'resolve') {
				deferred.resolve('late');
			} else {
				deferred.reject(new Error('late'));
			}
			await flushMicrotasks();
			assert.deepStrictEqual({ result: await shared.get(CancellationToken.None), loaderCount }, { result: { kind: 'cancelled' }, loaderCount: 1 });
		}
	});

	test('distinguishes completed undefined and retries the same rejection', async () => {
		// Catches cancelled/negative conflation and rejection normalization in SharedValue.
		let undefinedLoads = 0;
		const undefinedShared = new ParadisTerminalHistorySharedValue<string>(async () => {
			undefinedLoads++;
			return undefined;
		});
		assert.deepStrictEqual(await undefinedShared.get(CancellationToken.None), { kind: 'completed', value: undefined });
		assert.deepStrictEqual(await undefinedShared.get(CancellationToken.None), { kind: 'completed', value: undefined });
		assert.strictEqual(undefinedLoads, 1);
		undefinedShared.dispose();

		for (const kind of ['sync', 'async'] as const) {
			const error = new Error(`${kind} error`);
			let loaderCount = 0;
			const shared = new ParadisTerminalHistorySharedValue<string>(() => {
				loaderCount++;
				if (kind === 'sync') {
					throw error;
				}
				return Promise.reject(error);
			});
			const first = await Promise.allSettled([shared.get(CancellationToken.None), shared.get(CancellationToken.None)]);
			assert.deepStrictEqual(first, [
				{ status: 'rejected', reason: error },
				{ status: 'rejected', reason: error },
			]);
			await Promise.allSettled([shared.get(CancellationToken.None)]);
			assert.strictEqual(loaderCount, 2);
			shared.dispose();
		}
	});

	test('shares only a pending generation when completed caching is disabled', async () => {
		// Catches fulfilled caching, all-cancel eviction, and post-notification state publication.
		for (const outcome of ['value', 'undefined', 'reject'] as const) {
			const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
			let loaderCount = 0;
			const shared = new ParadisTerminalHistorySharedValue(() => deferreds[loaderCount++].promise, false);
			const waits = [shared.get(CancellationToken.None), shared.get(CancellationToken.None)];
			const error = new Error('pending-only error');
			if (outcome === 'value') {
				deferreds[0].resolve('value');
				assert.deepStrictEqual(await Promise.all(waits), [{ kind: 'completed', value: 'value' }, { kind: 'completed', value: 'value' }]);
			} else if (outcome === 'undefined') {
				deferreds[0].resolve(undefined);
				assert.deepStrictEqual(await Promise.all(waits), [{ kind: 'completed', value: undefined }, { kind: 'completed', value: undefined }]);
			} else {
				deferreds[0].reject(error);
				assert.deepStrictEqual(await Promise.allSettled(waits), [{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
			}
			const next = shared.get(CancellationToken.None);
			assert.strictEqual(loaderCount, 2);
			deferreds[1].resolve('next');
			assert.deepStrictEqual(await next, { kind: 'completed', value: 'next' });
			shared.dispose();
		}

		const first = new TrackedDeferred<string | undefined>();
		let loads = 0;
		const shared = new ParadisTerminalHistorySharedValue(() => {
			loads++;
			return first.promise;
		}, false);
		const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
		const cancelledWaits = tokens.map(token => shared.get(token));
		for (const token of tokens) {
			token.cancel();
		}
		await Promise.all(cancelledWaits);
		const fresh = shared.get(CancellationToken.None);
		assert.strictEqual(loads, 1);
		first.resolve('joined');
		assert.deepStrictEqual(await fresh, { kind: 'completed', value: 'joined' });
		shared.dispose();

		const disposingDeferred = new TrackedDeferred<string | undefined>();
		const disposingShared = new ParadisTerminalHistorySharedValue(() => disposingDeferred.promise, false);
		const disposingToken = new CountingCancellationToken();
		disposingToken.onListenerDispose = () => disposingShared.dispose();
		const disposingWait = disposingShared.get(disposingToken);
		disposingDeferred.resolve('must not publish');
		assert.deepStrictEqual(await disposingWait, { kind: 'completed', value: 'must not publish' });
		assert.deepStrictEqual(await disposingShared.get(CancellationToken.None), { kind: 'cancelled' });
	});

	test('keeps a reentrant next-generation waiter out of the settling waiter snapshot', async () => {
		// Catches iteration over a live waiter Set after a pending-only generation becomes idle.
		for (const outcome of ['value', 'undefined', 'reject'] as const) {
			const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
			let loaderCount = 0;
			const shared = new ParadisTerminalHistorySharedValue(() => deferreds[loaderCount++].promise, false);
			const reentrantToken = new CountingCancellationToken();
			const triggeringToken = new CountingCancellationToken();
			let reentrant: ReturnType<typeof trackSettlement<ParadisTerminalHistoryWaitResult<string>>> | undefined;
			triggeringToken.onListenerDispose = () => {
				triggeringToken.onListenerDispose = undefined;
				reentrant = trackSettlement(shared.get(reentrantToken));
			};
			const oldWaits = [shared.get(triggeringToken), shared.get(CancellationToken.None)];
			const oldWaiters = getSharedBoundary(shared)._waiters;
			const oldError = new Error('E1');
			if (outcome === 'value') {
				deferreds[0].resolve('old value');
				assert.deepStrictEqual(await Promise.all(oldWaits), [{ kind: 'completed', value: 'old value' }, { kind: 'completed', value: 'old value' }]);
			} else if (outcome === 'undefined') {
				deferreds[0].resolve(undefined);
				assert.deepStrictEqual(await Promise.all(oldWaits), [{ kind: 'completed', value: undefined }, { kind: 'completed', value: undefined }]);
			} else {
				deferreds[0].reject(oldError);
				assert.deepStrictEqual(await Promise.allSettled(oldWaits), [{ status: 'rejected', reason: oldError }, { status: 'rejected', reason: oldError }]);
			}
			assert.ok(reentrant);
			const currentWaiters = getSharedBoundary(shared)._waiters;
			assert.deepStrictEqual({
				oldWaiters: oldWaiters.size,
				detached: currentWaiters !== oldWaiters,
				loaderCount,
				handlerCount: deferreds.reduce((total, deferred) => total + deferred.thenCount, 0),
				currentWaiters: currentWaiters.size,
				reentrantSettlements: reentrant.count(),
			}, { oldWaiters: 0, detached: true, loaderCount: 2, handlerCount: 2, currentWaiters: 1, reentrantSettlements: 0 });
			deferreds[1].resolve('new value');
			assert.deepStrictEqual(await reentrant.promise, { kind: 'completed', value: 'new value' });
			assert.strictEqual(getSharedBoundary(shared)._waiters.size, 0);
			shared.dispose();
		}
	});

	test('single-flights one hundred waiters and reuses the completed identity', async () => {
		// Catches delayed in-flight registration and cache payload cloning.
		let now = 0;
		const deferred = new TrackedDeferred<Readonly<{ readonly commands: readonly string[] }> | undefined>();
		let loaderCount = 0;
		const value = Object.freeze({ commands: Object.freeze(['one', 'two']) });
		const cache = new ParadisTerminalHistoryCache(30_000, 30_000, () => now);
		const waits = Array.from({ length: 100 }, () => cache.get('same key', CancellationToken.None, () => {
			loaderCount++;
			return deferred.promise;
		}));
		const tracked = waits.map(trackSettlement);
		assert.deepStrictEqual({ loaderCount, thenCount: deferred.thenCount, settlements: tracked.map(item => item.count()) }, {
			loaderCount: 1,
			thenCount: 1,
			settlements: Array.from({ length: 100 }, () => 0),
		});
		deferred.resolve(value);
		const results = await Promise.all(tracked.map(item => item.promise));
		assert.deepStrictEqual(results, Array.from({ length: 100 }, () => ({ kind: 'completed', value })));
		assert.ok(results.every(result => result.kind === 'completed' && result.value === value));
		now = 29_999;
		const hit = await cache.get('same key', CancellationToken.None, () => {
			loaderCount++;
			return Promise.resolve(undefined);
		});
		assert.deepStrictEqual({ hit, sameIdentity: hit.kind === 'completed' && hit.value === value, loaderCount }, {
			hit: { kind: 'completed', value },
			sameIdentity: true,
			loaderCount: 1,
		});
		cache.dispose();
	});

	test('expires positive and every negative outcome from finish at the exact boundary', async () => {
		// Catches start-based TTL, inclusive expiry, and positive-only cache publication.
		for (const outcome of ['positive', 'undefined', 'reject', 'throw'] as const) {
			let now = 0;
			let loaderCount = 0;
			const first = new TrackedDeferred<string | undefined>();
			const second = new TrackedDeferred<string | undefined>();
			const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
			const load = () => {
				loaderCount++;
				if (outcome === 'throw' && loaderCount === 1) {
					throw new Error('sync negative');
				}
				return (loaderCount === 1 ? first : second).promise;
			};
			const initial = cache.get('ttl', CancellationToken.None, load);
			now = 25_000;
			if (outcome === 'positive') {
				first.resolve('positive value');
			} else if (outcome === 'undefined') {
				first.resolve(undefined);
			} else if (outcome === 'reject') {
				first.reject(new Error('async negative'));
			}
			const expected = outcome === 'positive' ? { kind: 'completed', value: 'positive value' } : { kind: 'completed', value: undefined };
			assert.deepStrictEqual(await initial, expected);
			now = 54_999;
			assert.deepStrictEqual({ result: await cache.get('ttl', CancellationToken.None, load), loaderCount }, { result: expected, loaderCount: 1 });
			now = 55_000;
			const boundary = cache.get('ttl', CancellationToken.None, load);
			assert.strictEqual(loaderCount, 2);
			second.resolve('boundary reload');
			assert.deepStrictEqual(await boundary, { kind: 'completed', value: 'boundary reload' });
			cache.dispose();
		}
	});

	test('keys by shell and canonical full URI', () => {
		// Catches omission of shell, scheme, authority, path, query, or fragment from the tuple.
		const variants: readonly [PosixShellType, URI][] = [
			[PosixShellType.Zsh, URI.from({ scheme: 'file', path: '/home/a/.zsh_history' })],
			[PosixShellType.Bash, URI.from({ scheme: 'file', path: '/home/a/.zsh_history' })],
			[PosixShellType.Zsh, URI.from({ scheme: 'vscode-remote', path: '/home/a/.zsh_history' })],
			[PosixShellType.Zsh, URI.from({ scheme: 'file', authority: 'server-a', path: '/home/a/.zsh_history' })],
			[PosixShellType.Zsh, URI.from({ scheme: 'file', path: '/home/b/.zsh_history' })],
			[PosixShellType.Zsh, URI.from({ scheme: 'file', path: '/home/a/.zsh_history', query: 'one' })],
			[PosixShellType.Zsh, URI.from({ scheme: 'file', path: '/home/a/.zsh_history', fragment: 'one' })],
		];
		const keys = variants.map(([shell, resource]) => paradisTerminalHistoryCacheKey(shell, resource));
		assert.strictEqual(paradisTerminalHistoryCacheKey(PosixShellType.Zsh, variants[0][1]), keys[0]);
		assert.strictEqual(new Set(keys).size, variants.length);
		assert.strictEqual(keys[0], JSON.stringify([PosixShellType.Zsh, 'file:///home/a/.zsh_history']));
	});

	test('detaches one file waiter without cancelling the flight or its peer', async () => {
		// Catches cancellation of the shared loader/peer and cancelled waiter retention.
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000);
		const deferred = new TrackedDeferred<string | undefined>();
		let loaderCount = 0;
		const token = new CountingCancellationToken();
		const cancelledWait = cache.get('one', token, () => {
			loaderCount++;
			return deferred.promise;
		});
		const peer = trackSettlement(cache.get('one', CancellationToken.None, () => {
			loaderCount++;
			return deferred.promise;
		}));
		const flight = getCacheBoundary(cache)._states.get('one')?.authoritativeFlight;
		assert.ok(flight);
		assert.strictEqual(flight.waiters.size, 2);
		token.cancel();
		assert.deepStrictEqual(await cancelledWait, { kind: 'cancelled' });
		assert.deepStrictEqual({ waiters: flight.waiters.size, peerSettlements: peer.count(), loaderCount }, { waiters: 1, peerSettlements: 0, loaderCount: 1 });
		deferred.resolve('peer value');
		assert.deepStrictEqual(await peer.promise, { kind: 'completed', value: 'peer value' });
		assert.strictEqual(flight.waiters.size, 0);

		const allDeferred = new TrackedDeferred<string | undefined>();
		const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
		const waits = tokens.map(item => cache.get('all', item, () => allDeferred.promise));
		const allFlight = getCacheBoundary(cache)._states.get('all')?.authoritativeFlight;
		assert.ok(allFlight);
		for (const item of tokens) {
			item.cancel();
		}
		assert.deepStrictEqual(await Promise.all(waits), Array.from({ length: 100 }, () => ({ kind: 'cancelled' })));
		assert.strictEqual(allFlight.waiters.size, 0);
		cache.dispose();
	});

	test('does not start for an already-cancelled waiter and distinguishes negative completion', async () => {
		// Catches loader dispatch for cancelled callers and bare-undefined cancellation results.
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000);
		let loaderCount = 0;
		assert.deepStrictEqual(await cache.get('cancelled', CancellationToken.Cancelled, async () => {
			loaderCount++;
			return 'unexpected';
		}), { kind: 'cancelled' });
		assert.deepStrictEqual(await cache.get('negative', CancellationToken.None, async () => {
			loaderCount++;
			return undefined;
		}), { kind: 'completed', value: undefined });
		assert.strictEqual(loaderCount, 1);
		cache.dispose();
	});

	test('disposes each cancellation listener exactly once without double settlement', async () => {
		// Catches registration-time cancellation and late completion double settlement/disposal.
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000);
		const deferred = new TrackedDeferred<string | undefined>();
		const token = new CountingCancellationToken();
		token.cancelOnRegistration = true;
		const tracked = trackSettlement(cache.get('race', token, () => deferred.promise));
		assert.deepStrictEqual(await tracked.promise, { kind: 'cancelled' });
		deferred.resolve('late');
		await flushMicrotasks();
		assert.deepStrictEqual({ activeListeners: token.activeListeners, disposeCount: token.disposeCount, settlements: tracked.count() }, {
			activeListeners: 0,
			disposeCount: 1,
			settlements: 1,
		});
		cache.dispose();
	});

	test('settles a keyed cache waiter once when cancellation wins the same-tick race', async () => {
		// Catches deletion of the waiter settled gate after cancellation wins before loader completion.
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000);
		const deferred = new TrackedDeferred<string | undefined>();
		const token = new CountingCancellationToken();
		token.cancelOnListenerDispose = true;
		const tracked = trackSettlement(cache.get('cancel-first race', token, () => deferred.promise));
		const flight = getCacheBoundary(cache)._states.get('cancel-first race')?.authoritativeFlight;
		assert.ok(flight);

		token.cancel();
		deferred.resolve('late completed value');
		const result = await tracked.promise;
		await flushMicrotasks();

		assert.deepStrictEqual({
			result,
			settlementCallbacks: tracked.count(),
			listenerDisposeCalls: token.disposeCount,
			cancelCallbacks: token.cancelFireCount,
			waiters: flight.waiters.size,
		}, {
			result: { kind: 'cancelled' },
			settlementCallbacks: 1,
			listenerDisposeCalls: 1,
			cancelCallbacks: 2,
			waiters: 0,
		});
		cache.dispose();
	});

	test('settles a keyed cache waiter once when completion wins the same-tick race', async () => {
		// Catches reentrant cancellation from listener disposal after completion settlement starts.
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000);
		const deferred = new TrackedDeferred<string | undefined>();
		const token = new CountingCancellationToken();
		token.cancelOnListenerDispose = true;
		const tracked = trackSettlement(cache.get('completion-first race', token, () => deferred.promise));
		const flight = getCacheBoundary(cache)._states.get('completion-first race')?.authoritativeFlight;
		assert.ok(flight);

		deferred.resolve('completed value');
		const result = await tracked.promise;
		await flushMicrotasks();

		assert.deepStrictEqual({
			result,
			settlementCallbacks: tracked.count(),
			listenerDisposeCalls: token.disposeCount,
			cancelCallbacks: token.cancelFireCount,
			waiters: flight.waiters.size,
		}, {
			result: { kind: 'completed', value: 'completed value' },
			settlementCallbacks: 1,
			listenerDisposeCalls: 1,
			cancelCallbacks: 1,
			waiters: 0,
		});
		cache.dispose();
	});

	test('publishes late positive and negative after all one hundred waiters cancel', async () => {
		// Catches state eviction or publication suppression when the last waiter cancels.
		for (const outcome of ['positive', 'negative'] as const) {
			let now = 0;
			let loaderCount = 0;
			const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
			const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
			const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
			const load = () => deferreds[loaderCount++].promise;
			const waits = tokens.map(token => cache.get('late', token, load));
			const flight = getCacheBoundary(cache)._states.get('late')?.authoritativeFlight;
			assert.ok(flight);
			for (const token of tokens) {
				token.cancel();
			}
			await Promise.all(waits);
			assert.deepStrictEqual({ waiters: flight.waiters.size, listeners: tokens.map(token => token.activeListeners), loaderCount }, {
				waiters: 0,
				listeners: Array.from({ length: 100 }, () => 0),
				loaderCount: 1,
			});
			now = 25_000;
			if (outcome === 'positive') {
				deferreds[0].resolve('late value');
			} else {
				deferreds[0].reject(new Error('late negative'));
			}
			await flushMicrotasks();
			const expected = outcome === 'positive' ? { kind: 'completed', value: 'late value' } : { kind: 'completed', value: undefined };
			now = 54_999;
			assert.deepStrictEqual({ result: await cache.get('late', CancellationToken.None, load), loaderCount }, { result: expected, loaderCount: 1 });
			now = 55_000;
			const expired = cache.get('late', CancellationToken.None, load);
			assert.strictEqual(loaderCount, 2);
			deferreds[1].resolve('reload');
			assert.deepStrictEqual(await expired, { kind: 'completed', value: 'reload' });
			cache.dispose();
		}
	});

	test('starts one replacement at 30000ms and never exceeds two active loaders', async () => {
		// Catches unbounded age-based replacement and replacement before the exact boundary.
		let now = 0;
		const deferreds: TrackedDeferred<string | undefined>[] = [];
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
		const load = () => {
			const deferred = new TrackedDeferred<string | undefined>();
			deferreds.push(deferred);
			return deferred.promise;
		};
		const s1 = cache.get('one', CancellationToken.None, load);
		now = 29_999;
		const s1Peer = cache.get('one', CancellationToken.None, load);
		assert.strictEqual(deferreds.length, 1);
		now = 30_000;
		const s2 = cache.get('one', CancellationToken.None, load);
		assert.strictEqual(deferreds.length, 2);
		now = 60_000;
		const s2Peer = cache.get('one', CancellationToken.None, load);
		assert.deepStrictEqual({ loaders: deferreds.length, active: getCacheBoundary(cache)._states.get('one')?.activeFlights.size }, { loaders: 2, active: 2 });
		deferreds[0].resolve('S1');
		assert.deepStrictEqual(await Promise.all([s1, s1Peer]), [{ kind: 'completed', value: 'S1' }, { kind: 'completed', value: 'S1' }]);
		const s3 = cache.get('one', CancellationToken.None, load);
		assert.deepStrictEqual({ loaders: deferreds.length, active: getCacheBoundary(cache)._states.get('one')?.activeFlights.size }, { loaders: 3, active: 2 });
		cache.dispose();
		assert.deepStrictEqual(await Promise.all([s2, s2Peer, s3]), [{ kind: 'cancelled' }, { kind: 'cancelled' }, { kind: 'cancelled' }]);

		now = 0;
		const combined = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
		const pending: TrackedDeferred<string | undefined>[] = [];
		const combinedLoad = () => {
			const deferred = new TrackedDeferred<string | undefined>();
			pending.push(deferred);
			return deferred.promise;
		};
		const waits = [combined.get('zsh', CancellationToken.None, combinedLoad), combined.get('bash', CancellationToken.None, combinedLoad)];
		now = 30_000;
		waits.push(combined.get('zsh', CancellationToken.None, combinedLoad), combined.get('bash', CancellationToken.None, combinedLoad));
		assert.deepStrictEqual({
			loaders: pending.length,
			zsh: getCacheBoundary(combined)._states.get('zsh')?.activeFlights.size,
			bash: getCacheBoundary(combined)._states.get('bash')?.activeFlights.size,
		}, { loaders: 4, zsh: 2, bash: 2 });
		combined.dispose();
		await Promise.all(waits);
	});

	test('keeps S2 authoritative after stale S1 success or rejection', async () => {
		// Catches stale success/rejection/finally clearing the authoritative flight identity.
		for (const outcome of ['success', 'rejection'] as const) {
			let now = 0;
			const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
			let loaderCount = 0;
			const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
			const load = () => deferreds[loaderCount++].promise;
			const s1 = cache.get('stale', CancellationToken.None, load);
			now = 30_000;
			const s2 = cache.get('stale', CancellationToken.None, load);
			now = 31_000;
			if (outcome === 'success') {
				deferreds[0].resolve('S1 stale');
				assert.deepStrictEqual(await s1, { kind: 'completed', value: 'S1 stale' });
			} else {
				deferreds[0].reject(new Error('S1 stale rejection'));
				assert.deepStrictEqual(await s1, { kind: 'completed', value: undefined });
			}
			const joinedS2 = cache.get('stale', CancellationToken.None, load);
			assert.strictEqual(loaderCount, 2);
			deferreds[1].resolve('S2 current');
			assert.deepStrictEqual(await Promise.all([s2, joinedS2]), [{ kind: 'completed', value: 'S2 current' }, { kind: 'completed', value: 'S2 current' }]);
			cache.dispose();
		}
	});

	test('keeps all authoritative S2 negative variants over stale S1 outcomes', async () => {
		// Catches stale positive/negative publication over an authoritative resolved/rejected negative.
		for (const s2Outcome of ['undefined', 'rejection'] as const) {
			for (const s1Outcome of ['success', 'rejection'] as const) {
				let now = 0;
				const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
				let loaderCount = 0;
				const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
				const load = () => deferreds[loaderCount++].promise;
				const s1 = cache.get('negative', CancellationToken.None, load);
				now = 30_000;
				const s2 = cache.get('negative', CancellationToken.None, load);
				now = 31_000;
				if (s2Outcome === 'undefined') {
					deferreds[1].resolve(undefined);
				} else {
					deferreds[1].reject(new Error('S2 negative'));
				}
				assert.deepStrictEqual(await s2, { kind: 'completed', value: undefined });
				now = 32_000;
				if (s1Outcome === 'success') {
					deferreds[0].resolve('S1 stale');
				} else {
					deferreds[0].reject(new Error('S1 stale negative'));
				}
				await s1;
				now = 60_999;
				assert.deepStrictEqual({ result: await cache.get('negative', CancellationToken.None, load), loaderCount }, {
					result: { kind: 'completed', value: undefined },
					loaderCount: 2,
				});
				cache.dispose();
			}
		}
	});

	test('keeps S3 positive publication over every late older outcome', async () => {
		// Catches an older generation overwriting the latest positive cache after slot release.
		for (const lingering of ['S1', 'S2'] as const) {
			for (const lateOutcome of ['success', 'rejection'] as const) {
				let now = 0;
				const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
				let loaderCount = 0;
				const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
				const load = () => deferreds[loaderCount++].promise;
				const s1 = cache.get('positive', CancellationToken.None, load);
				now = 30_000;
				const s2 = cache.get('positive', CancellationToken.None, load);
				if (lingering === 'S2') {
					now = 60_000;
					deferreds[0].resolve('S1 slot release');
					await s1;
				} else {
					deferreds[1].resolve('S2 old publication');
					await s2;
					now = 60_000;
				}
				const s3 = cache.get('positive', CancellationToken.None, load);
				assert.strictEqual(loaderCount, 3);
				now = 61_000;
				deferreds[2].resolve('S3 authoritative');
				assert.deepStrictEqual(await s3, { kind: 'completed', value: 'S3 authoritative' });
				const lateIndex = lingering === 'S1' ? 0 : 1;
				if (lateOutcome === 'success') {
					deferreds[lateIndex].resolve(`${lingering} late`);
				} else {
					deferreds[lateIndex].reject(new Error(`${lingering} late rejection`));
				}
				await (lingering === 'S1' ? s1 : s2);
				now = 61_001;
				assert.deepStrictEqual({ result: await cache.get('positive', CancellationToken.None, load), loaderCount }, {
					result: { kind: 'completed', value: 'S3 authoritative' },
					loaderCount: 3,
				});
				cache.dispose();
			}
		}
	});

	test('cancels and detaches both stale and authoritative generations on cache disposal', async () => {
		// Catches disposal that visits only the authoritative flight and late state regeneration.
		let now = 0;
		let loaderCount = 0;
		const deferreds = [new TrackedDeferred<string | undefined>(), new TrackedDeferred<string | undefined>()];
		const cache = new ParadisTerminalHistoryCache<string>(30_000, 30_000, () => now);
		const tokens = [new CountingCancellationToken(), new CountingCancellationToken()];
		const load = () => deferreds[loaderCount++].promise;
		const s1Wait = cache.get('dispose', tokens[0], load);
		const s1 = getCacheBoundary(cache)._states.get('dispose')?.authoritativeFlight;
		assert.ok(s1);
		now = 30_000;
		const s2Wait = cache.get('dispose', tokens[1], load);
		const state = getCacheBoundary(cache)._states.get('dispose');
		const s2 = state?.authoritativeFlight;
		assert.ok(s2);
		assert.notStrictEqual(s1, s2);
		cache.dispose();
		assert.deepStrictEqual({
			results: await Promise.all([s1Wait, s2Wait]),
			listeners: tokens.map(token => token.activeListeners),
			s1Waiters: s1.waiters.size,
			s2Waiters: s2.waiters.size,
			states: getCacheBoundary(cache)._states.size,
		}, {
			results: [{ kind: 'cancelled' }, { kind: 'cancelled' }],
			listeners: [0, 0],
			s1Waiters: 0,
			s2Waiters: 0,
			states: 0,
		});
		deferreds[0].resolve('late success');
		deferreds[1].reject(new Error('late rejection'));
		await flushMicrotasks();
		assert.deepStrictEqual({
			states: getCacheBoundary(cache)._states.size,
			authoritativeUnchanged: state.authoritativeFlight === s2,
			result: await cache.get('dispose', CancellationToken.None, load),
			loaderCount,
		}, { states: 0, authoritativeUnchanged: true, result: { kind: 'cancelled' }, loaderCount: 2 });
	});
});
