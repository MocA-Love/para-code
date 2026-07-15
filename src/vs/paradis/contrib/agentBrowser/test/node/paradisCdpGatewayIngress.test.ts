/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCdpGatewayDelegate, ParadisCdpGateway } from '../../node/paradisCdpGateway.js';
import { ParadisCdpUpstream } from '../../node/paradisCdpUpstream.js';

interface ITestLease {
	readonly token: string;
}

interface ITestResponse {
	readonly status: number;
	readonly body: unknown;
}

suite('Paradis CDP gateway ingress authority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	test('rejects every unowned JSON endpoint before upstream access with one generic response', async () => {
		for (const path of ['/json', '/json/list', '/json/version', '/json/protocol']) {
			const fixture = createHttpFixture(path, { owned: false });
			try {
				await fixture.gateway.handleRequest(fixture.request, fixture.response);
				assert.deepStrictEqual(fixture.result(), {
					status: 403,
					body: { error: 'Para Browser CDP access is unavailable.' },
				});
				assert.strictEqual(fixture.upstreamCalls(), 0);
				assert.strictEqual(fixture.ensureCalls(), 0);
			} finally {
				fixture.gateway.dispose();
			}
		}
	});

	test('does not materialize state or import WebSocket code for a huge unowned token', async () => {
		const hugeToken = 'x'.repeat(10_000);
		const fixture = createUpgradeFixture(`/devtools/browser/stored?pane=${hugeToken}`, { owned: false });
		try {
			await fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			const state = fixture.gateway as unknown as {
				_browserWsIds: Map<string, string>;
				_connectionAuthorities: Map<string, unknown>;
				_rawScreenshotAuthorities: { _coordinators: Map<string, unknown> };
				_socketTokens: WeakMap<object, string>;
			};
			assert.strictEqual(fixture.wsImports(), 0);
			assert.strictEqual(fixture.upstreamCalls(), 0);
			assert.strictEqual(fixture.ensureCalls(), 0);
			assert.strictEqual(state._browserWsIds.size, 0);
			assert.strictEqual(state._connectionAuthorities.size, 0);
			assert.strictEqual(state._rawScreenshotAuthorities._coordinators.size, 0);
			assert.strictEqual(state._socketTokens.has(fixture.socket), false);
			assert.strictEqual(fixture.destroyCalls(), 1);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('keeps every token-local gateway registry empty across ten thousand unknown tokens', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token', { owned: false });
		const state = fixture.gateway as unknown as {
			_captureIngressAccess(token: string): unknown;
			_browserWsIds: Map<string, string>;
			_connectionAuthorities: Map<string, unknown>;
			_connectionsByToken: Map<string, Set<unknown>>;
			_rawScreenshotAuthorities: { _coordinators: Map<string, unknown> };
		};
		try {
			for (let i = 0; i < 10_000; i++) {
				assert.strictEqual(state._captureIngressAccess(`unknown-${i}`), undefined);
			}
			assert.strictEqual(state._browserWsIds.size, 0);
			assert.strictEqual(state._connectionAuthorities.size, 0);
			assert.strictEqual(state._connectionsByToken.size, 0);
			assert.strictEqual(state._rawScreenshotAuthorities._coordinators.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('rechecks the lease after target resolution and suppresses a retired list request', async () => {
		let releaseEnsure!: () => void;
		const ensureGate = new Promise<void>(resolve => releaseEnsure = resolve);
		const fixture = createHttpFixture('/json/list', {
			ensure: async () => {
				await ensureGate;
				return 'target-1';
			},
		});
		try {
			const request = fixture.gateway.handleRequest(fixture.request, fixture.response);
			await fixture.ensureStarted;
			fixture.retire();
			releaseEnsure();
			await request;

			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
			assert.strictEqual(fixture.upstreamCalls(), 0);
		} finally {
			releaseEnsure();
			fixture.gateway.dispose();
		}
	});

	test('rechecks the lease after upstream JSON resolution and before returning data', async () => {
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>(resolve => releaseFetch = resolve);
		const fixture = createHttpFixture('/json/version', {
			fetch: async () => {
				await fetchGate;
				return { Browser: 'secret-upstream-value' };
			},
		});
		try {
			const request = fixture.gateway.handleRequest(fixture.request, fixture.response);
			await fixture.fetchStarted;
			fixture.retire();
			releaseFetch();
			await request;

			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
			const state = fixture.gateway as unknown as { _browserWsIds: Map<string, string> };
			assert.strictEqual(state._browserWsIds.size, 0);
		} finally {
			releaseFetch();
			fixture.gateway.dispose();
		}
	});

	test('does not return stale target metadata after a same-owner rebind during list fetch', async () => {
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>(resolve => releaseFetch = resolve);
		let rebindTarget!: (targetId: string) => void;
		const fixture = createHttpFixture('/json/list', {
			fetch: async () => {
				await fetchGate;
				return [{ id: 'target-1', title: 'private old page' }];
			},
			onAuthorityCreated: authority => { rebindTarget = authority.rebindTarget; },
		});
		try {
			const request = fixture.gateway.handleRequest(fixture.request, fixture.response);
			await fixture.fetchStarted;
			rebindTarget('target-2');
			releaseFetch();
			await request;

			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
			assert.strictEqual(JSON.stringify(fixture.result()).includes('private old page'), false);
		} finally {
			releaseFetch();
			fixture.gateway.dispose();
		}
	});

	test('keeps the generic authority response when retirement races an upstream failure', async () => {
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>(resolve => releaseFetch = resolve);
		const fixture = createHttpFixture('/json/protocol', {
			fetch: async () => {
				await fetchGate;
				throw new Error('upstream unavailable');
			},
		});
		try {
			const request = fixture.gateway.handleRequest(fixture.request, fixture.response);
			await fixture.fetchStarted;
			fixture.retire();
			releaseFetch();
			await request;

			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
		} finally {
			releaseFetch();
			fixture.gateway.dispose();
		}
	});

	test('never exposes raw upstream errors in an HTTP response', async () => {
		const fixture = createHttpFixture('/json/protocol', {
			fetch: async () => { throw new Error('https://secret.example/private?credential=token'); },
		});
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.deepStrictEqual(fixture.result(), {
				status: 502,
				body: { error: 'Para Browser CDP gateway is unavailable.' },
			});
			assert.strictEqual(JSON.stringify(fixture.result()).includes('secret.example'), false);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('settles an HTTP upstream failure even when warning diagnostics throw', async () => {
		const fixture = createHttpFixture('/json/protocol', {
			fetch: async () => { throw new Error('upstream unavailable'); },
			throwingWarn: true,
		});
		try {
			await assert.doesNotReject(fixture.gateway.handleRequest(fixture.request, fixture.response));
			assert.deepStrictEqual(fixture.result(), {
				status: 502,
				body: { error: 'Para Browser CDP gateway is unavailable.' },
			});
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('builds every advertised debugger URL from the trusted loopback socket instead of Host', async () => {
		for (const path of ['/json/version', '/json/list']) {
			const fixture = createHttpFixture(path, { host: 'attacker.example:61_337', localPort: 41_234 });
			try {
				await fixture.gateway.handleRequest(fixture.request, fixture.response);
				const serialized = JSON.stringify(fixture.result().body);
				assert.strictEqual(serialized.includes('attacker.example'), false);
				assert.match(serialized, /(?:ws|http):\/\/127\.0\.0\.1:41234\/cdp\/devtools\//);
			} finally {
				fixture.gateway.dispose();
			}
		}
	});

	test('invalidates a cached socket token before any later upstream access', async () => {
		const fixture = createHttpFixture('/json/protocol', { owned: false, includeQuery: false });
		const state = fixture.gateway as unknown as { _socketTokens: WeakMap<object, { token: string; lease: ITestLease }> };
		state._socketTokens.set(fixture.request.socket, { token: 'pane-token', lease: fixture.lease });
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.strictEqual(state._socketTokens.has(fixture.request.socket), false);
			assert.strictEqual(fixture.upstreamCalls(), 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('invalidates only PID-derived cached access when the shell mapping changes', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_captureIngressAccess(token: string, peerBound?: boolean): { token: string; lease: ITestLease; peerGeneration?: number } | undefined;
			_isIngressAccessCurrent(access: { token: string; lease: ITestLease; peerGeneration?: number }): boolean;
		};
		try {
			const explicitAccess = state._captureIngressAccess('pane-token');
			const peerAccess = state._captureIngressAccess('pane-token', true);
			assert.ok(explicitAccess);
			assert.ok(peerAccess);
			assert.strictEqual(state._isIngressAccessCurrent(explicitAccess), true);
			assert.strictEqual(state._isIngressAccessCurrent(peerAccess), true);

			fixture.gateway.closeConnectionsForToken('pane-token');

			assert.strictEqual(state._isIngressAccessCurrent(explicitAccess), true);
			assert.strictEqual(state._isIngressAccessCurrent(peerAccess), false);
			const refreshedPeerAccess = state._captureIngressAccess('pane-token', true);
			assert.ok(refreshedPeerAccess);
			assert.strictEqual(state._isIngressAccessCurrent(refreshedPeerAccess), true);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('authorizes a PID-resolved token only after capturing its live ingress lease', async () => {
		let lookupCalls = 0;
		const fixture = createHttpFixture('/json/protocol', {
			includeQuery: false,
			remotePort: 47_000,
			peerResolver: async (_remotePort, _ownPid, lookup) => {
				lookupCalls++;
				return lookup.getTokenForShellPid(321);
			},
		});
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.strictEqual(lookupCalls, 1);
			assert.deepStrictEqual(fixture.result(), { status: 200, body: {} });
			assert.strictEqual(fixture.upstreamCalls(), 1);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('does not upgrade a PID result to a replacement owner lifecycle', async () => {
		let replaceOwner!: () => void;
		const fixture = createHttpFixture('/json/protocol', {
			includeQuery: false,
			remotePort: 47_001,
			peerResolver: async (_remotePort, _ownPid, lookup) => {
				const token = lookup.getTokenForShellPid(322);
				replaceOwner();
				return token;
			},
			onAuthorityCreated: authority => { replaceOwner = authority.replaceOwner; },
		});
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
			assert.strictEqual(fixture.upstreamCalls(), 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('does not upgrade an env-resolved PID token after the resolution-start owner epoch changes', async () => {
		let replaceOwner!: () => void;
		const retireGatewayToken = () => fixture.gateway.retireToken('pane-token');
		const fixture = createHttpFixture('/json/protocol', {
			includeQuery: false,
			remotePort: 47_003,
			peerResolver: async () => {
				retireGatewayToken();
				replaceOwner();
				return 'pane-token';
			},
			onAuthorityCreated: authority => { replaceOwner = authority.replaceOwner; },
		});
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
			assert.strictEqual(fixture.upstreamCalls(), 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('keeps unresolved PID diagnostics from changing the generic denial', async () => {
		const fixture = createHttpFixture('/json/protocol', {
			includeQuery: false,
			remotePort: 47_002,
			peerResolver: async () => undefined,
			throwingDebug: true,
		});
		try {
			await assert.doesNotReject(fixture.gateway.handleRequest(fixture.request, fixture.response));
			assert.deepStrictEqual(fixture.result(), {
				status: 403,
				body: { error: 'Para Browser CDP access is unavailable.' },
			});
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('rejects a browser upgrade retired during upstream discovery before proxy creation', async () => {
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>(resolve => releaseFetch = resolve);
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token', {
			fetch: async () => {
				await fetchGate;
				return {
					value: { webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' },
					port: 41002,
				};
			},
		});
		try {
			const upgrade = fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			await fixture.fetchStarted;
			fixture.retire();
			releaseFetch();
			await upgrade;

			assert.deepStrictEqual(fixture.upstreamUrls, []);
			assert.strictEqual(fixture.destroyCalls(), 1);
		} finally {
			releaseFetch();
			fixture.gateway.dispose();
		}
	});

	test('destroys a failed upgrade even when warning diagnostics throw', async () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token', {
			fetch: async () => { throw new Error('upstream unavailable'); },
			throwingWarn: true,
		});
		try {
			await assert.doesNotReject(fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0)));
			assert.strictEqual(fixture.destroyCalls(), 1);
			assert.deepStrictEqual(fixture.upstreamUrls, []);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('completes token retirement when debug diagnostics throw', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token', { throwingDebug: true });
		const state = fixture.gateway as unknown as {
			_makeContext(access: { token: string; lease: ITestLease }): { isCurrentLease(): boolean; onOpen(ws: unknown): void };
			_browserWsIds: Map<string, string>;
			_connectionAuthorities: Map<string, unknown>;
			_connectionsByToken: Map<string, Set<unknown>>;
			_rawScreenshotAuthorities: { _coordinators: Map<string, unknown> };
		};
		let closeCalls = 0;
		const connection = {
			close: () => { closeCalls++; },
			on: () => undefined,
		};
		const ctx = state._makeContext({ token: 'pane-token', lease: fixture.lease });
		ctx.onOpen(connection);
		state._browserWsIds.set('pane-token', 'browser-id');
		try {
			assert.doesNotThrow(() => fixture.gateway.retireToken('pane-token'));
			assert.strictEqual(ctx.isCurrentLease(), false);
			assert.strictEqual(closeCalls, 1);
			assert.strictEqual(state._browserWsIds.size, 0);
			assert.strictEqual(state._connectionAuthorities.size, 0);
			assert.strictEqual(state._connectionsByToken.size, 1);
			assert.strictEqual(state._rawScreenshotAuthorities._coordinators.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('fails closed without upstream access after standalone gateway disposal', async () => {
		const fixture = createHttpFixture('/json/version');
		fixture.gateway.dispose();

		await fixture.gateway.handleRequest(fixture.request, fixture.response);

		assert.deepStrictEqual(fixture.result(), {
			status: 403,
			body: { error: 'Para Browser CDP access is unavailable.' },
		});
		assert.strictEqual(fixture.upstreamCalls(), 0);
	});

	test('suppresses a delayed HTTP result after standalone gateway disposal', async () => {
		let releaseFetch!: () => void;
		const fetchGate = new Promise<void>(resolve => releaseFetch = resolve);
		const fixture = createHttpFixture('/json/version', {
			fetch: async () => {
				await fetchGate;
				return { Browser: 'private result' };
			},
		});
		const pending = fixture.gateway.handleRequest(fixture.request, fixture.response);
		await fixture.fetchStarted;
		fixture.gateway.dispose();
		releaseFetch();
		await pending;

		assert.deepStrictEqual(fixture.result(), {
			status: 403,
			body: { error: 'Para Browser CDP access is unavailable.' },
		});
		assert.strictEqual(JSON.stringify(fixture.result()).includes('private result'), false);
	});

	test('standalone disposal invalidates contexts and clears every token registry', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_makeContext(access: { token: string; lease: ITestLease }): { isCurrentLease(): boolean; onOpen(ws: unknown): void };
			_socketTokens: WeakMap<object, { token: string; lease: ITestLease }>;
			_browserWsIds: Map<string, string>;
			_connectionAuthorities: Map<string, unknown>;
			_connectionsByToken: Map<string, Set<unknown>>;
			_rawScreenshotAuthorities: { _coordinators: Map<string, unknown> };
		};
		let terminateCalls = 0;
		const connection = { close: () => undefined, terminate: () => { terminateCalls++; }, on: () => undefined };
		const context = state._makeContext({ token: 'pane-token', lease: fixture.lease });
		context.onOpen(connection);
		state._browserWsIds.set('pane-token', 'browser-id');
		state._socketTokens.set(fixture.socket, { token: 'pane-token', lease: fixture.lease });
		assert.strictEqual(state._rawScreenshotAuthorities._coordinators.size, 1);

		fixture.gateway.dispose();

		assert.strictEqual(context.isCurrentLease(), false);
		assert.strictEqual(terminateCalls, 1);
		assert.strictEqual(state._browserWsIds.size, 0);
		assert.strictEqual(state._connectionAuthorities.size, 0);
		assert.strictEqual(state._connectionsByToken.size, 0);
		assert.strictEqual(state._rawScreenshotAuthorities._coordinators.size, 0);
		assert.strictEqual(state._socketTokens.has(fixture.socket), false);
	});

	test('makes existing contexts reject their next command when the delegate lease expires', async () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_makeContext(access: { token: string; lease: ITestLease }): {
				isCurrentLease(): boolean;
				boundTargetIds(): Set<string>;
				captureBoundPageScreenshot(options: object): Promise<string | undefined>;
				isBoundPageVisible(): Promise<boolean>;
				dispatchBoundPageInput(targetId: string, method: string, paramsJson: string): { response: Promise<unknown>; drained: Promise<void> };
			};
		};
		try {
			const ctx = state._makeContext({ token: 'pane-token', lease: fixture.lease });
			assert.strictEqual(ctx.isCurrentLease(), true);
			fixture.retire();
			assert.strictEqual(ctx.isCurrentLease(), false);
			assert.deepStrictEqual(ctx.boundTargetIds(), new Set());
			assert.strictEqual(await ctx.captureBoundPageScreenshot({}), undefined);
			assert.strictEqual(await ctx.isBoundPageVisible(), false);
			await ctx.dispatchBoundPageInput('target-1', 'Input.insertText', '{"text":"x"}').response;
			assert.strictEqual(fixture.inputDispatchCalls(), 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('composes browser-session route authority into the queued input lease', async () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_makeContext(access: { token: string; lease: ITestLease }): {
				dispatchBoundPageInput(targetId: string, method: string, paramsJson: string, isRouteCurrent: () => boolean): { response: Promise<unknown>; drained: Promise<void> };
			};
		};
		try {
			let routeCurrent = true;
			const ctx = state._makeContext({ token: 'pane-token', lease: fixture.lease });
			await ctx.dispatchBoundPageInput('target-1', 'Input.insertText', '{"text":"x"}', () => routeCurrent).response;
			assert.strictEqual(fixture.inputAuthorityCurrent(), true);
			routeCurrent = false;
			assert.strictEqual(fixture.inputAuthorityCurrent(), false);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('revokes the exact connection lease synchronously on WebSocket close', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_makeContext(access: { token: string; lease: ITestLease }): {
				isCurrentLease(): boolean;
				onOpen(ws: { on(event: string, listener: () => void): void }): void;
			};
		};
		let closeListener: (() => void) | undefined;
		try {
			const ctx = state._makeContext({ token: 'pane-token', lease: fixture.lease });
			ctx.onOpen({
				on: (event, listener) => {
					if (event === 'close') {
						closeListener = listener;
					}
				},
			});
			assert.strictEqual(ctx.isCurrentLease(), true);
			closeListener?.();
			assert.strictEqual(ctx.isCurrentLease(), false);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('configures a strict one MiB WebSocketServer payload limit', () => {
		const fixture = createHttpFixture('/json/version');
		let options: unknown;
		const state = fixture.gateway as unknown as {
			_getWss(ws: unknown): unknown;
		};
		try {
			state._getWss({
				WebSocket: class { },
				WebSocketServer: class {
					constructor(value: unknown) { options = value; }
				},
			});
			assert.deepStrictEqual(options, { noServer: true, maxPayload: 1024 * 1024 });
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('atomically caps WebSocket reservations per token and releases empty token counters', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): { releaseIfUnattached(): void } | undefined;
			_webSocketReservationCount: number;
			_webSocketReservationsByToken: Map<string, number>;
		};
		try {
			const reservations = Array.from({ length: 8 }, () => state._reserveWebSocket('pane-token'));
			assert.ok(reservations.every(Boolean));
			assert.strictEqual(state._reserveWebSocket('pane-token'), undefined);
			assert.strictEqual(state._webSocketReservationCount, 8);
			for (const reservation of reservations) {
				reservation?.releaseIfUnattached();
			}
			assert.strictEqual(state._webSocketReservationCount, 0);
			assert.strictEqual(state._webSocketReservationsByToken.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('releases an attached WebSocket reservation exactly once on close', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): { attach(ws: unknown): boolean; releaseIfUnattached(): void } | undefined;
			_webSocketReservationCount: number;
			_webSocketReservationsByToken: Map<string, number>;
		};
		let closeListener: (() => void) | undefined;
		try {
			const reservation = state._reserveWebSocket('pane-token');
			assert.ok(reservation);
			assert.strictEqual(reservation.attach({ once: (_event: string, listener: () => void) => { closeListener = listener; } }), true);
			reservation.releaseIfUnattached();
			assert.strictEqual(state._webSocketReservationCount, 1);
			closeListener?.();
			closeListener?.();
			assert.strictEqual(state._webSocketReservationCount, 0);
			assert.strictEqual(state._webSocketReservationsByToken.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('retains closing sockets and capacity until close, then terminates after a bounded grace', () => {
		const clock = sinon.useFakeTimers();
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): { releaseIfUnattached(): void } | undefined;
			_makeContext(access: { token: string; lease: ITestLease }, reservation: object): { onOpen(ws: unknown): void };
			_webSocketReservationCount: number;
			_webSocketReservationsByToken: Map<string, number>;
		};
		const events = new EventEmitter();
		let closeCalls = 0;
		let terminateCalls = 0;
		const socket = {
			close: () => { closeCalls++; },
			terminate: () => { terminateCalls++; },
			on: events.on.bind(events),
			once: events.once.bind(events),
		};
		try {
			const reservation = state._reserveWebSocket('pane-token');
			assert.ok(reservation);
			state._makeContext({ token: 'pane-token', lease: fixture.lease }, reservation).onOpen(socket);
			assert.strictEqual(state._webSocketReservationCount, 1);
			fixture.gateway.closeConnectionsForToken('pane-token');
			assert.strictEqual(closeCalls, 1);
			assert.strictEqual(state._webSocketReservationCount, 1);
			const additional = Array.from({ length: 7 }, () => state._reserveWebSocket('pane-token'));
			assert.ok(additional.every(Boolean));
			assert.strictEqual(state._reserveWebSocket('pane-token'), undefined);
			clock.tick(5_000);
			assert.strictEqual(terminateCalls, 1);
			assert.strictEqual(state._webSocketReservationCount, 8);
			events.emit('close');
			assert.strictEqual(state._webSocketReservationCount, 7);
			for (const pending of additional) {
				pending?.releaseIfUnattached();
			}
			assert.strictEqual(state._webSocketReservationCount, 0);
			assert.strictEqual(state._webSocketReservationsByToken.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('does not arm a grace timer when graceful close emits close synchronously', () => {
		const clock = sinon.useFakeTimers();
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): object;
			_makeContext(access: { token: string; lease: ITestLease }, reservation: object): { onOpen(ws: unknown): void };
			_webSocketReservationCount: number;
			_closingWebSockets: Set<unknown>;
			_webSocketCloseTimers: Map<unknown, unknown>;
		};
		const events = new EventEmitter();
		let terminateCalls = 0;
		const socket = {
			close: () => events.emit('close'),
			terminate: () => { terminateCalls++; },
			on: events.on.bind(events),
			once: events.once.bind(events),
		};
		try {
			const reservation = state._reserveWebSocket('pane-token');
			state._makeContext({ token: 'pane-token', lease: fixture.lease }, reservation).onOpen(socket);
			fixture.gateway.closeConnectionsForToken('pane-token');
			assert.strictEqual(state._webSocketReservationCount, 0);
			assert.strictEqual(state._closingWebSockets.size, 0);
			assert.strictEqual(state._webSocketCloseTimers.size, 0);
			clock.tick(5_000);
			assert.strictEqual(terminateCalls, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('dispose terminates attached sockets and releases their reservations', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): object;
			_makeContext(access: { token: string; lease: ITestLease }, reservation: object): { onOpen(ws: unknown): void };
			_webSocketReservationCount: number;
		};
		const events = new EventEmitter();
		let terminateCalls = 0;
		const socket = {
			close: () => undefined,
			terminate: () => { terminateCalls++; },
			on: events.on.bind(events),
			once: events.once.bind(events),
		};
		const reservation = state._reserveWebSocket('pane-token');
		state._makeContext({ token: 'pane-token', lease: fixture.lease }, reservation).onOpen(socket);
		fixture.gateway.dispose();
		assert.strictEqual(terminateCalls, 1);
		assert.strictEqual(state._webSocketReservationCount, 0);
	});

	test('caps total WebSocket reservations across distinct pane tokens', () => {
		const fixture = createUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		const state = fixture.gateway as unknown as {
			_reserveWebSocket(token: string): { releaseIfUnattached(): void } | undefined;
			_webSocketReservationCount: number;
			_webSocketReservationsByToken: Map<string, number>;
		};
		try {
			const reservations = Array.from({ length: 128 }, (_, index) => state._reserveWebSocket(`pane-${Math.floor(index / 8)}`));
			assert.ok(reservations.every(Boolean));
			assert.strictEqual(state._reserveWebSocket('pane-overflow'), undefined);
			for (const reservation of reservations) {
				reservation?.releaseIfUnattached();
			}
			assert.strictEqual(state._webSocketReservationCount, 0);
			assert.strictEqual(state._webSocketReservationsByToken.size, 0);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('reserves stalled upgrades before target resolution and rejects the ninth per-token waiter', async () => {
		let releaseEnsure!: () => void;
		const ensureGate = new Promise<void>(resolve => releaseEnsure = resolve);
		let started = 0;
		let notifyEightStarted!: () => void;
		const eightStarted = new Promise<void>(resolve => notifyEightStarted = resolve);
		const fixture = createUpgradeFixture('/devtools/page/target-1?pane=pane-token', {
			ensure: async () => {
				started++;
				if (started === 8) {
					notifyEightStarted();
				}
				await ensureGate;
				return 'target-1';
			},
		});
		try {
			const stalled = Array.from({ length: 8 }, () => fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0)));
			await eightStarted;
			await fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			assert.strictEqual(fixture.ensureCalls(), 8);
			assert.strictEqual(fixture.destroyCalls(), 1);
			releaseEnsure();
			await Promise.all(stalled);
			const state = fixture.gateway as unknown as { _webSocketReservationCount: number };
			assert.strictEqual(state._webSocketReservationCount, 8);
		} finally {
			releaseEnsure();
			fixture.gateway.dispose();
		}
	});

	test('caps unresolved PID-authorized upgrades before starting more peer resolvers', async () => {
		let releaseResolvers!: () => void;
		const resolverGate = new Promise<void>(resolve => releaseResolvers = resolve);
		let resolverCalls = 0;
		let notifyResolversStarted!: () => void;
		const resolversStarted = new Promise<void>(resolve => notifyResolversStarted = resolve);
		const fixture = createUpgradeFixture('/devtools/browser/stored', {
			peerResolver: async () => {
				resolverCalls++;
				if (resolverCalls === 32) {
					notifyResolversStarted();
				}
				await resolverGate;
				return undefined;
			},
		});
		try {
			const stalled = Array.from({ length: 32 }, () => fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0)));
			await resolversStarted;
			await fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			assert.strictEqual(resolverCalls, 32);
			assert.strictEqual(fixture.destroyCalls(), 1);
			releaseResolvers();
			await Promise.all(stalled);
			const state = fixture.gateway as unknown as { _activeWebSocketUpgrades: number };
			assert.strictEqual(state._activeWebSocketUpgrades, 0);
		} finally {
			releaseResolvers();
			fixture.gateway.dispose();
		}
	});

	test('rejects HTTP work above the concurrency cap before upstream and marks JSON no-store', async () => {
		const fixture = createHttpFixture('/json/protocol');
		const state = fixture.gateway as unknown as { _activeHttpRequests: number };
		state._activeHttpRequests = 32;
		try {
			await fixture.gateway.handleRequest(fixture.request, fixture.response);
			assert.deepStrictEqual(fixture.result(), { status: 503, body: { error: 'Para Browser CDP gateway is unavailable.' } });
			assert.strictEqual(fixture.upstreamCalls(), 0);
			assert.strictEqual(fixture.responseHeaders()['Cache-Control'], 'no-store');
		} finally {
			fixture.gateway.dispose();
		}
	});
});

function createDelegate(options: {
	readonly owned?: boolean;
	readonly ensure?: () => Promise<string | undefined>;
} = {}): {
	readonly delegate: IParadisCdpGatewayDelegate;
	readonly lease: ITestLease;
	readonly retire: () => void;
	readonly replaceOwner: () => void;
	readonly rebindTarget: (targetId: string) => void;
	readonly ensureCalls: () => number;
	readonly ensureStarted: Promise<void>;
	readonly inputDispatchCalls: () => number;
	readonly inputAuthorityCurrent: () => boolean | undefined;
} {
	const lease = Object.freeze({ token: 'pane-token' });
	let currentLease = lease;
	let owned = options.owned ?? true;
	let ensureCalls = 0;
	let inputDispatchCalls = 0;
	let inputAuthorityCheck: (() => boolean) | undefined;
	let targetId = 'target-1';
	let notifyEnsureStarted!: () => void;
	const ensureStarted = new Promise<void>(resolve => notifyEnsureStarted = resolve);
	const delegate = {
		captureIngressLease: (token: string) => owned && token === currentLease.token ? currentLease : undefined,
		isIngressLeaseCurrent: (candidate: ITestLease) => owned && candidate === currentLease,
		getBoundTargetId: () => targetId,
		ensureBoundTargetId: async () => {
			ensureCalls++;
			notifyEnsureStarted();
			return options.ensure ? options.ensure() : targetId;
		},
		getTokenForShellPid: () => currentLease.token,
		captureBoundPageScreenshot: async () => 'image',
		isBoundPageVisible: async () => true,
		dispatchBoundPageInput: (_token: string, _connection: object, _targetId: string, _method: string, _paramsJson: string, isConnectionCurrent: () => boolean) => {
			inputDispatchCalls++;
			inputAuthorityCheck = isConnectionCurrent;
			return { response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() };
		},
		closeInputConnection: () => undefined,
	} as unknown as IParadisCdpGatewayDelegate;
	return {
		delegate,
		lease,
		retire: () => { owned = false; },
		replaceOwner: () => { owned = true; currentLease = Object.freeze({ token: lease.token }); },
		rebindTarget: nextTargetId => { targetId = nextTargetId; },
		ensureCalls: () => ensureCalls,
		ensureStarted,
		inputDispatchCalls: () => inputDispatchCalls,
		inputAuthorityCurrent: () => inputAuthorityCheck?.(),
	};
}

function createHttpFixture(path: string, options: {
	readonly owned?: boolean;
	readonly includeQuery?: boolean;
	readonly ensure?: () => Promise<string | undefined>;
	readonly fetch?: (path: string) => Promise<unknown>;
	readonly remotePort?: number;
	readonly peerResolver?: TestPeerResolver;
	readonly onAuthorityCreated?: (authority: { readonly replaceOwner: () => void; readonly rebindTarget: (targetId: string) => void }) => void;
	readonly host?: string;
	readonly localPort?: number;
	readonly throwingDebug?: boolean;
	readonly throwingWarn?: boolean;
} = {}): {
	readonly gateway: ParadisCdpGateway;
	readonly request: import('http').IncomingMessage;
	readonly response: import('http').ServerResponse;
	readonly lease: ITestLease;
	readonly retire: () => void;
	readonly upstreamCalls: () => number;
	readonly ensureCalls: () => number;
	readonly ensureStarted: Promise<void>;
	readonly fetchStarted: Promise<void>;
	readonly result: () => ITestResponse;
	readonly responseHeaders: () => Record<string, string>;
} {
	const authority = createDelegate(options);
	options.onAuthorityCreated?.(authority);
	let upstreamCalls = 0;
	let notifyFetchStarted!: () => void;
	const fetchStarted = new Promise<void>(resolve => notifyFetchStarted = resolve);
	const upstream = {
		fetchJson: async (upstreamPath: string) => {
			upstreamCalls++;
			notifyFetchStarted();
			return options.fetch ? options.fetch(upstreamPath) : upstreamPath === '/json/list' ? [{ id: 'target-1' }] : {};
		},
	} as unknown as ParadisCdpUpstream;
	const GatewayWithPeerResolver = ParadisCdpGateway as unknown as new (
		delegate: IParadisCdpGatewayDelegate,
		upstream: ParadisCdpUpstream,
		logService: import('../../../../../platform/log/common/log.js').ILogService,
		peerResolver?: TestPeerResolver,
	) => ParadisCdpGateway;
	const gateway = new GatewayWithPeerResolver(authority.delegate, upstream, createLogService(options), options.peerResolver);
	const socket = { remoteAddress: '127.0.0.1', remotePort: options.remotePort, localPort: options.localPort ?? 4_000 };
	const query = options.includeQuery === false ? '' : `${path.includes('?') ? '&' : '?'}pane=pane-token`;
	const request = {
		url: `${path}${query}`,
		method: 'GET',
		headers: { host: options.host ?? '127.0.0.1:4000' },
		socket,
	} as unknown as import('http').IncomingMessage;
	let status = 0;
	let body: unknown;
	let headersSent = false;
	let responseHeaders: Record<string, string> = {};
	const response = {
		get headersSent() { return headersSent; },
		writeHead: (nextStatus: number, headers: Record<string, string>) => { status = nextStatus; responseHeaders = headers; headersSent = true; },
		end: (data: string) => { body = JSON.parse(data); },
	} as unknown as import('http').ServerResponse;
	return {
		gateway,
		request,
		response,
		lease: authority.lease,
		retire: authority.retire,
		upstreamCalls: () => upstreamCalls,
		ensureCalls: authority.ensureCalls,
		ensureStarted: authority.ensureStarted,
		fetchStarted,
		result: () => ({ status, body }),
		responseHeaders: () => responseHeaders,
	};
}

function createUpgradeFixture(path: string, options: {
	readonly owned?: boolean;
	readonly ensure?: () => Promise<string | undefined>;
	readonly fetch?: (path: string) => Promise<{ readonly value: { readonly webSocketDebuggerUrl: string }; readonly port: number }>;
	readonly peerResolver?: TestPeerResolver;
	readonly throwingDebug?: boolean;
	readonly throwingWarn?: boolean;
} = {}): {
	readonly gateway: ParadisCdpGateway;
	readonly request: import('http').IncomingMessage;
	readonly socket: import('stream').Duplex;
	readonly lease: ITestLease;
	readonly retire: () => void;
	readonly ensureCalls: () => number;
	readonly inputDispatchCalls: () => number;
	readonly inputAuthorityCurrent: () => boolean | undefined;
	readonly fetchStarted: Promise<void>;
	readonly upstreamCalls: () => number;
	readonly wsImports: () => number;
	readonly destroyCalls: () => number;
	readonly upstreamUrls: string[];
} {
	const authority = createDelegate({ owned: options.owned, ensure: options.ensure });
	let upstreamCalls = 0;
	let notifyFetchStarted!: () => void;
	const fetchStarted = new Promise<void>(resolve => notifyFetchStarted = resolve);
	const upstream = {
		fetchJsonWithPort: async (upstreamPath: string) => {
			upstreamCalls++;
			notifyFetchStarted();
			return options.fetch ? options.fetch(upstreamPath) : {
				value: { webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' },
				port: 41002,
			};
		},
	} as unknown as ParadisCdpUpstream;
	const GatewayWithPeerResolver = ParadisCdpGateway as unknown as new (
		delegate: IParadisCdpGatewayDelegate,
		upstream: ParadisCdpUpstream,
		logService: import('../../../../../platform/log/common/log.js').ILogService,
		peerResolver?: TestPeerResolver,
	) => ParadisCdpGateway;
	const gateway = new GatewayWithPeerResolver(authority.delegate, upstream, createLogService(options), options.peerResolver);
	let wsImports = 0;
	const upstreamUrls: string[] = [];
	class TestWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly readyState = TestWebSocket.CONNECTING;
		constructor(url?: string) {
			if (url) {
				upstreamUrls.push(url);
			}
		}
		close(): void { }
		on(): void { }
		once(): void { }
	}
	const ws = {
		WebSocket: TestWebSocket,
		WebSocketServer: class { },
	};
	Object.assign(gateway as object, {
		_getWsModule: async () => { wsImports++; return ws; },
		_getWss: () => ({
			handleUpgrade: (_request: unknown, _socket: unknown, _head: unknown, callback: (client: TestWebSocket) => void) => callback(new TestWebSocket()),
			close: () => undefined,
		}),
	});
	let destroyCalls = 0;
	const socket = {
		remoteAddress: '127.0.0.1',
		remotePort: 41_234,
		destroy: () => { destroyCalls++; },
	};
	const request = {
		url: path,
		method: 'GET',
		headers: {},
		socket,
	};
	return {
		gateway,
		request: request as never,
		socket: socket as never,
		lease: authority.lease,
		retire: authority.retire,
		ensureCalls: authority.ensureCalls,
		inputDispatchCalls: authority.inputDispatchCalls,
		inputAuthorityCurrent: authority.inputAuthorityCurrent,
		fetchStarted,
		upstreamCalls: () => upstreamCalls,
		wsImports: () => wsImports,
		destroyCalls: () => destroyCalls,
		upstreamUrls,
	};
}

function createLogService(options: { readonly throwingDebug?: boolean; readonly throwingWarn?: boolean } = {}): import('../../../../../platform/log/common/log.js').ILogService {
	return {
		trace: () => undefined,
		debug: () => { if (options.throwingDebug) { throw new Error('debug logger unavailable'); } },
		info: () => undefined,
		warn: () => { if (options.throwingWarn) { throw new Error('warn logger unavailable'); } },
	} as never;
}

type TestPeerResolver = (
	remotePort: number,
	ownPid: number,
	lookup: { getTokenForShellPid(pid: number): string | undefined },
) => Promise<string | undefined>;
