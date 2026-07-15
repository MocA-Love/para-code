/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExactBrowserViewDescriptor } from '../../common/paradisAgentBrowser.js';
import { IParadisBindingAuthorityManifest, ParadisBindingAuthority } from '../../common/paradisBindingAuthority.js';
import { ParadisExactViewBackgroundThrottlingCoordinator } from '../../common/paradisExactViewBackgroundThrottling.js';
import { ParadisAgentBrowserChannel } from '../../node/paradisAgentBrowserChannel.js';
import { ParadisAgentBrowserService, ParadisDevtoolsGenerationCoordinator } from '../../node/paradisAgentBrowserService.js';
import { IParadisAgentHookEvent, onParadisAgentHookEvent } from '../../node/paradisAgentHookBus.js';

interface ITestBinding {
	readonly windowCtx: string;
	readonly pageId: string;
	readonly pageInfo: { readonly url: string; readonly title: string };
	readonly generation: number;
	readonly boundAt: number;
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly scope: { readonly kind: 'unscoped' };
}

class TestRequest extends EventEmitter {
	readonly headers: Record<string, string> = {};
	readonly socket = { remoteAddress: '127.0.0.1' };
	destroyed = false;
	destroyCalls = 0;

	constructor(readonly method: string, readonly url: string) {
		super();
	}

	destroy(): void {
		this.destroyCalls++;
		this.destroyed = true;
	}
}

class TestResponse extends EventEmitter {
	headersSent = false;
	writableEnded = false;
	statusCode: number | undefined;
	body = '';
	endCalls = 0;

	writeHead(statusCode: number): void {
		this.statusCode = statusCode;
		this.headersSent = true;
	}

	end(body?: string): void {
		this.endCalls++;
		this.writableEnded = true;
		this.body += body ?? '';
	}
}

function authorityManifest(
	revision: number,
	complete: boolean,
	panes: readonly { readonly token: string; readonly shellPid?: number }[],
	views: readonly string[] = [],
): IParadisBindingAuthorityManifest {
	return {
		revision,
		complete,
		panes: panes.map(pane => ({ ...pane, scope: { kind: 'unscoped' } })),
		browserViews: views.map(viewId => ({ viewId, scope: { kind: 'unscoped' } })),
	};
}

function mainManifest(revision: number, windowIds: readonly number[]): unknown {
	return {
		revision,
		entries: windowIds.map(windowId => ({
			windowId,
			rendererGeneration: 1,
			windowRevision: revision,
			claimed: false,
		})),
	};
}

function createFixture(): {
	readonly service: ParadisAgentBrowserService;
	readonly authority: ParadisBindingAuthority<string, object, IParadisExactBrowserViewDescriptor, ITestBinding>;
	readonly bindings: Map<string, ITestBinding>;
	readonly paneShells: Map<string, { windowCtx: string; token: string; shellPid: number }>;
	readonly quarantined: Set<ITestBinding>;
	readonly effects: string[];
	readonly mainCalls: { readonly command: string; readonly args: readonly unknown[] }[];
	readonly seedBinding: (token: string, windowCtx?: string, pageId?: string) => ITestBinding;
} {
	let ticket = 0;
	const authority = new ParadisBindingAuthority<string, object, IParadisExactBrowserViewDescriptor, ITestBinding>({
		now: () => 0,
		createTicketId: () => `ticket-${ticket++}`,
		copyDescriptor: descriptor => Object.freeze({ ...descriptor }),
	});
	const bindings = new Map<string, ITestBinding>();
	const paneShells = new Map<string, { windowCtx: string; token: string; shellPid: number }>();
	const quarantined = new Set<ITestBinding>();
	const effects: string[] = [];
	const mainCalls: { command: string; args: readonly unknown[] }[] = [];
	const backgroundThrottlingCoordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_bindings: bindings,
		_bindingAuthority: authority,
		_backgroundThrottlingCoordinator: backgroundThrottlingCoordinator,
		_ingressLeaseStates: new WeakMap<object, object>(),
		_quarantinedBindings: quarantined,
		_terminalExitedTokens: new Set<string>(),
		_paneShells: paneShells,
		_paneStatuses: new Map<string, { status: string; changedAt: number }>(),
		_activityApprovalTokens: new Set<string>(),
		_agentHookTokens: new Set<string>(),
		_seenTokens: new Set<string>(),
		_rendererConnections: new Map<string, object>(),
		_rendererConnectionContexts: new Map<object, string>(),
		_knownRendererContexts: new Set<string>(),
		_mainLiveWindowIds: new Set<number>(),
		_hasMainRendererManifest: false,
		_rendererManifestRevision: -1,
		_authorityFaulted: false,
		_nextBindingGeneration: 100,
		_devtoolsGenerationCoordinator: {
			setGeneration: (_token: string, generation: number) => effects.push(`generation:${generation}`),
			getGeneration: () => 1,
			isCurrentGeneration: () => true,
			runWithLease: async (_token: string, operation: () => Promise<unknown>) => operation(),
			forgetWhenIdle: (token: string, generation: number) => effects.push(`forget:${token}:${generation}`),
			dispose: () => effects.push('disposeCoordinator'),
		},
		_cdpGateway: {
			isGatewayHttpRequest: () => false,
			closeConnectionsForToken: (token: string) => effects.push(`close:${token}`),
			retireToken: (token: string) => effects.push(`retireGateway:${token}`),
		},
		_devtoolsProxy: {
			retire: (token: string, generation: number) => effects.push(`retire:${token}:${generation}`),
			listTools: async () => [],
			isProxiedTool: async () => false,
		},
		_onDidAcknowledgePane: { fire: (token: string) => effects.push(`ack:${token}`) },
		mainProcessService: {
			getChannel: () => ({
				call: (command: string, args: readonly unknown[] = []) => {
					effects.push(`main:${command}`);
					mainCalls.push({ command, args });
					return Promise.resolve(true);
				},
			}),
		},
		logService: { trace: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
		_mcpInstanceId: 'test-instance',
		_mcpServiceStartedAt: 1,
		_serverStartPromise: Promise.resolve(),
		_port: 47286,
		_serverDisposed: false,
		_activeRequestControllers: new Set<AbortController>(),
		_activeIngressRequestsByToken: new Map<string, number>(),
		_activeIngressRequestCount: 0,
		_store: {
			isDisposed: false,
			dispose() { this.isDisposed = true; },
		},
	}) as unknown as ParadisAgentBrowserService;
	return {
		service,
		authority,
		bindings,
		paneShells,
		quarantined,
		effects,
		mainCalls,
		seedBinding: (token, windowCtx = 'window:1', pageId = 'page-1') => {
			const binding: ITestBinding = {
				windowCtx,
				pageId,
				pageInfo: { url: 'https://example.test', title: 'Example' },
				generation: 1,
				boundAt: 1,
				exactView: { windowId: Number(windowCtx.slice('window:'.length)), viewId: pageId, targetId: `target-${pageId}`, viewLease: `lease-${pageId}` },
				scope: { kind: 'unscoped' },
			};
			bindings.set(token, binding);
			backgroundThrottlingCoordinator.setBinding(token, binding.exactView);
			authority.recordBindingMutation(token, binding);
			return binding;
		},
	};
}

suite('ParadisAgentBrowser authority integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('global channel exposes only strict zero-argument gateway endpoint', async () => {
		const fixture = createFixture();
		const globalChannel = new ParadisAgentBrowserChannel(fixture.service);

		assert.deepStrictEqual(await globalChannel.call('window:1', 'getGatewayEndpoint'), { port: 47286 });
		assert.deepStrictEqual(await globalChannel.call('window:1', 'getGatewayEndpoint', []), { port: 47286 });
		const hiddenArgs: unknown[] & { hidden?: boolean } = [];
		Object.defineProperty(hiddenArgs, 'hidden', { value: true, enumerable: false });
		const symbolArgs: unknown[] = [];
		Reflect.set(symbolArgs, Symbol('unexpected'), true);
		const hostileOwnKeys = new Proxy([], {
			ownKeys: () => { throw new Error('secret ownKeys failure'); },
		});
		for (const invalid of [[undefined], ['extra'], 1, {}, [1, 2], hiddenArgs, symbolArgs, hostileOwnKeys]) {
			assert.throws(() => globalChannel.call('window:1', 'getGatewayEndpoint', invalid), /protocol/i);
		}
		for (const command of ['bind', 'syncPaneShells', 'syncBindingAuthority', 'listBindings', 'setupMcp']) {
			assert.throws(() => globalChannel.call('window:1', command, []), /protocol/i);
		}
		let setupArgumentAccesses = 0;
		const hostileSetupArgument = new Proxy({}, {
			ownKeys: () => { setupArgumentAccesses++; throw new Error('secret'); },
			get: () => { setupArgumentAccesses++; throw new Error('secret'); },
		});
		assert.throws(() => globalChannel.call('window:1', 'setupMcp', hostileSetupArgument), /protocol/i);
		assert.strictEqual(setupArgumentAccesses, 0);
	});

	test('strictly registers canonical contexts and binds one connection object to one window', () => {
		const fixture = createFixture();
		for (const ctx of ['window:0', 'window:01', 'window:+1', 'window:1x', `window:${Number.MAX_SAFE_INTEGER + 1}`]) {
			assert.strictEqual(fixture.service.registerRendererConnection(ctx, {}), false);
		}
		const connection = {};
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', connection), true);
		assert.strictEqual(fixture.service.registerRendererConnection('window:2', connection), false);
		assert.strictEqual(fixture.service.isCurrentRendererConnection('window:1', connection), true);
	});

	test('requires the replacement first manifest and rejects stale sync read and mutation', async () => {
		const fixture = createFixture();
		const first = {};
		const replacement = {};
		fixture.service.registerRendererConnection('window:1', first);
		const firstChannel = new ParadisAgentBrowserChannel(fixture.service, first);
		await assert.rejects(firstChannel.call('window:1', 'listBindings'), /protocol/i);
		assert.deepStrictEqual(
			await firstChannel.call('window:1', 'syncBindingAuthority', [authorityManifest(1, true, [{ token: 'token' }])]),
			{ accepted: true, revision: 1 },
		);
		fixture.seedBinding('token');
		assert.strictEqual((await firstChannel.call<readonly unknown[]>('window:1', 'listBindings')).length, 1);

		fixture.service.registerRendererConnection('window:1', replacement);
		const replacementChannel = new ParadisAgentBrowserChannel(fixture.service, replacement);
		assert.throws(() => firstChannel.call('window:1', 'listBindings'), /protocol/i);
		await assert.rejects(replacementChannel.call('window:1', 'listBindings'), /protocol/i);
		assert.strictEqual(await replacementChannel.call('window:1', 'unbind', ['token']), false);
		await replacementChannel.call('window:1', 'syncBindingAuthority', [authorityManifest(1, false, [{ token: 'token' }])]);
		assert.strictEqual((await replacementChannel.call<readonly unknown[]>('window:1', 'listBindings')).length, 1);
	});

	test('rejects a stale connection before touching hostile arguments and genericizes current argument failures', () => {
		const fixture = createFixture();
		const stale = {};
		const current = {};
		fixture.service.registerRendererConnection('window:1', stale);
		const staleChannel = new ParadisAgentBrowserChannel(fixture.service, stale);
		fixture.service.registerRendererConnection('window:1', current);
		let manifestAccesses = 0;
		const hostileManifest = new Proxy({}, {
			get: () => {
				manifestAccesses++;
				throw new Error('secret manifest failure');
			},
			ownKeys: () => {
				manifestAccesses++;
				throw new Error('secret manifest failure');
			},
		});

		assert.throws(
			() => staleChannel.call('window:1', 'syncBindingAuthority', [hostileManifest]),
			(error: unknown) => error instanceof Error && error.message === 'Para Browser protocol rejected',
		);
		assert.strictEqual(manifestAccesses, 0);

		const currentChannel = new ParadisAgentBrowserChannel(fixture.service, current);
		const hostileArgs = new Proxy([], {
			get: (target, property, receiver) => {
				if (property === 'length') {
					throw new Error('secret length failure');
				}
				return Reflect.get(target, property, receiver);
			},
		});
		assert.throws(
			() => currentChannel.call('window:1', 'listBindings', hostileArgs),
			(error: unknown) => error instanceof Error && error.message === 'Para Browser protocol rejected',
		);
		assert.strictEqual(Reflect.get(fixture.authority, 'bindingStates').size, 0);
	});

	test('setupMcp is connection-scoped before the first manifest and accepts only an exact data record', async () => {
		const fixture = createFixture();
		const stale = {};
		const current = {};
		fixture.service.registerRendererConnection('window:1', stale);
		const staleChannel = new ParadisAgentBrowserChannel(fixture.service, stale);
		fixture.service.registerRendererConnection('window:1', current);
		const currentChannel = new ParadisAgentBrowserChannel(fixture.service, current);
		const received: unknown[] = [];
		Reflect.set(fixture.service, 'setupMcp', async (request: unknown) => {
			received.push(request);
			return { cli: 'claude', cliAvailable: true, servers: [] };
		});

		let hostileAccesses = 0;
		const hostile = new Proxy({}, {
			get: () => { hostileAccesses++; throw new Error('secret get'); },
			ownKeys: () => { hostileAccesses++; throw new Error('secret ownKeys'); },
			getOwnPropertyDescriptor: () => { hostileAccesses++; throw new Error('secret descriptor'); },
		});
		assert.throws(() => staleChannel.call('window:1', 'setupMcp', [hostile]), /protocol/i);
		assert.strictEqual(hostileAccesses, 0);

		await currentChannel.call('window:1', 'setupMcp', [{ cli: 'claude' }]);
		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], { cli: 'claude' });
		assert.strictEqual(Object.isFrozen(received[0]), true);

		const accessor = {};
		Object.defineProperty(accessor, 'cli', { enumerable: true, get: () => 'claude' });
		const inherited = Object.create({ cli: 'claude' }) as Record<string, unknown>;
		const nonEnumerableCli = {};
		Object.defineProperty(nonEnumerableCli, 'cli', { value: 'claude' });
		const hidden = { cli: 'claude' } as { cli: string; hidden?: boolean };
		Object.defineProperty(hidden, 'hidden', { value: true });
		const symbol = { cli: 'claude' } as Record<PropertyKey, unknown>;
		symbol[Symbol('hidden')] = true;
		for (const invalid of [
			{ cli: 'Claude' }, { cli: 'claude', shimPath: '/tmp/injected' }, accessor, inherited, nonEnumerableCli,
			hidden, symbol, ['claude'], { cli: Object('claude') }, hostile,
		]) {
			assert.throws(() => currentChannel.call('window:1', 'setupMcp', [invalid]), /protocol/i);
		}
		assert.strictEqual(received.length, 1);
	});

	test('strictly rejects malformed arity and scalar types without partial mutation', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		const channel = new ParadisAgentBrowserChannel(fixture.service, connection);
		await channel.call('window:1', 'syncBindingAuthority', [authorityManifest(1, true, [{ token: 'token' }])]);
		fixture.seedBinding('token');

		for (const action of [
			() => channel.call('window:1', 'listBindings', {}),
			() => channel.call('window:1', 'listBindings', ['extra']),
			() => channel.call('window:1', 'unbind', [1]),
			() => channel.call('window:1', 'unbind', ['token', 'extra']),
			() => channel.call('window:1', 'unbindIfCurrent', ['token', '1']),
			() => channel.call('window:1', 'unbindIfCurrent', ['token', 0]),
			() => channel.call('window:1', 'syncBindingAuthority', [authorityManifest(2, true, []), 'extra']),
			() => channel.call('window:1', 'unknown', []),
		]) {
			assert.throws(action, /protocol/i);
		}
		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.authority.isOwnedToken('token'), true);
	});

	test('rejects a malformed complete authority manifest atomically', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		fixture.seedBinding('token');

		await assert.rejects(fixture.service.syncBindingAuthority(connection, {
			revision: 2,
			complete: true,
			panes: 'malformed',
			browserViews: [],
		}), /protocol/i);
		assert.strictEqual(fixture.authority.isOwnedToken('token'), true);
		assert.strictEqual(fixture.bindings.has('token'), true);
		assert.strictEqual(fixture.authority.getCurrentAcceptedManifest(connection).revision, 1);
	});

	test('keeps revision PID and ownership atomic for late-invalid and owner-conflicting manifests', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token-a' }]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token-b', shellPid: 101 }]));

		await assert.rejects(fixture.service.syncBindingAuthority(connectionB, {
			revision: 2,
			complete: true,
			panes: [
				{ token: 'token-b', shellPid: 202, scope: { kind: 'unscoped' } },
				{ token: 'late-invalid', scope: { kind: 'managed', stateKey: '' } },
			],
			browserViews: [],
		}), /protocol/i);
		assert.strictEqual(fixture.authority.getCurrentAcceptedManifest(connectionB).revision, 1);
		assert.strictEqual(fixture.paneShells.get('token-b')?.shellPid, 101);
		assert.strictEqual(fixture.authority.isOwnedToken('late-invalid'), false);
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(2, true, [{ token: 'token-b', shellPid: 202 }]));

		await assert.rejects(fixture.service.syncBindingAuthority(connectionB, authorityManifest(3, true, [
			{ token: 'token-b', shellPid: 303 },
			{ token: 'token-a' },
		])), /protocol/i);
		assert.strictEqual(fixture.authority.getCurrentAcceptedManifest(connectionB).revision, 2);
		assert.strictEqual(fixture.paneShells.get('token-b')?.shellPid, 202);
		assert.strictEqual(fixture.authority.isCurrentOwnedToken(connectionA, 'token-a'), true);
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(3, true, [{ token: 'token-b', shellPid: 303 }]));
		assert.strictEqual(fixture.paneShells.get('token-b')?.shellPid, 303);
	});

	test('rejects duplicate shell PIDs across the full window projection before authority mutation', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token-a', shellPid: 501 }]));

		await assert.rejects(
			fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token-b', shellPid: 501 }])),
			/protocol/i,
		);
		assert.strictEqual(fixture.authority.isOwnedToken('token-b'), false);
		assert.strictEqual(fixture.paneShells.has('token-b'), false);
		await assert.rejects(
			fixture.service.syncBindingAuthority(connectionA, authorityManifest(2, true, [
				{ token: 'token-a', shellPid: 501 },
				{ token: 'token-c', shellPid: 501 },
			])),
			/protocol/i,
		);
		assert.strictEqual(fixture.authority.getCurrentAcceptedManifest(connectionA).revision, 1);
		assert.strictEqual(fixture.authority.isOwnedToken('token-c'), false);
	});

	test('fails closed for stale incomplete PID reuse until the old owner retires', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, false, [{ token: 'old-token', shellPid: 777 }]));
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(2, false, []));
		assert.strictEqual(fixture.paneShells.get('old-token')?.shellPid, 777);

		await assert.rejects(
			fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'new-token', shellPid: 777 }])),
			/protocol/i,
		);
		assert.strictEqual(Reflect.get(fixture.service, '_getTokenForShellPid').call(fixture.service, 777), 'old-token');

		// Even a corrupted legacy registry must never pick the first matching token.
		fixture.paneShells.set('corrupt-token', { windowCtx: 'window:2', token: 'corrupt-token', shellPid: 777 });
		fixture.authority.registerConnection('window:3', {});
		Reflect.get(fixture.authority, 'tokenOwners').set('corrupt-token', 'window:3');
		Reflect.get(fixture.authority, 'tokenOwnerLeases').set('corrupt-token', Object.freeze({ token: 'corrupt-token' }));
		assert.strictEqual(Reflect.get(fixture.service, '_getTokenForShellPid').call(fixture.service, 777), undefined);
		fixture.paneShells.delete('corrupt-token');

		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(3, true, []));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'new-token', shellPid: 777 }]));
		assert.strictEqual(Reflect.get(fixture.service, '_getTokenForShellPid').call(fixture.service, 777), 'new-token');
	});

	test('invalidates PID-derived ingress access whenever an accepted pane PID changes or disappears', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);

		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);
		assert.deepStrictEqual(fixture.effects, []);

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, [{ token: 'token', shellPid: 101 }]));
		assert.deepStrictEqual(fixture.effects, []);

		await fixture.service.syncBindingAuthority(connection, authorityManifest(3, true, [{ token: 'token', shellPid: 202 }]));
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 202);
		assert.deepStrictEqual(fixture.effects, ['close:token']);

		await fixture.service.syncBindingAuthority(connection, authorityManifest(4, true, [{ token: 'token' }]));
		assert.strictEqual(fixture.paneShells.has('token'), false);
		assert.deepStrictEqual(fixture.effects, ['close:token', 'close:token']);
	});

	test('scopes every list and mutation to current present owned tokens', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token-a' }]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token-b' }]));
		fixture.seedBinding('token-a', 'window:1', 'page-a');
		fixture.seedBinding('token-b', 'window:2', 'page-b');
		Reflect.get(fixture.service, '_seenTokens').add('token-a').add('token-b');
		Reflect.get(fixture.service, '_agentHookTokens').add('token-a').add('token-b');
		Reflect.get(fixture.service, '_paneStatuses').set('token-a', { status: 'working', changedAt: 1 }).set('token-b', { status: 'review', changedAt: 2 });

		assert.deepStrictEqual((await fixture.service.listBindings(connectionA)).map(binding => binding.token), ['token-a']);
		assert.deepStrictEqual(await fixture.service.listSeenTokens(connectionA), ['token-a']);
		assert.deepStrictEqual(await fixture.service.listAgentHookTokens(connectionA), ['token-a']);
		assert.deepStrictEqual((await fixture.service.listPaneStatuses(connectionA)).map(status => status.token), ['token-a']);
		assert.strictEqual(await fixture.service.unbind(connectionA, 'token-b'), false);
		assert.strictEqual(await fixture.service.unbind(connectionA, 'unknown-token'), false);
		assert.strictEqual(await fixture.service.notifyTerminalExit(connectionA, 'token-b'), false);
		assert.strictEqual(await fixture.service.acknowledgePaneStatus(connectionA, 'token-b'), false);
		assert.strictEqual(fixture.bindings.has('token-b'), true);
	});

	test('updates PID complements only from accepted owned manifests and preserves recovery omissions', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		const source = authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]);
		await fixture.service.syncBindingAuthority(connection, source);
		(source.panes[0] as { shellPid?: number }).shellPid = 999;
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, false, []));
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);
		assert.deepStrictEqual(await fixture.service.listSeenTokens(connection), []);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(3, false, [{ token: 'token' }]));
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(4, false, [{ token: 'token', shellPid: 202 }]));
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 202);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(5, true, []));
		assert.strictEqual(fixture.paneShells.has('token'), false);
	});

	test('terminal exit is scoped, idempotent, suppresses the owner lifecycle, and restores exact throttling once', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		const binding = fixture.seedBinding('token');

		assert.strictEqual(await fixture.service.notifyTerminalExit(connection, 'token'), true);
		const firstExitGeneration = Reflect.get(fixture.service, '_nextBindingGeneration');
		const firstExitBindingState = Reflect.get(fixture.authority, 'bindingStates').get('token');
		const firstExitEffects = [...fixture.effects];
		assert.strictEqual(await fixture.service.notifyTerminalExit(connection, 'token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_nextBindingGeneration'), firstExitGeneration);
		assert.strictEqual(Reflect.get(fixture.authority, 'bindingStates').get('token'), firstExitBindingState);
		assert.deepStrictEqual(fixture.effects, firstExitEffects);
		assert.strictEqual(fixture.authority.isOwnedToken('token'), true);
		assert.strictEqual(fixture.bindings.has('token'), false);
		assert.strictEqual(fixture.paneShells.has('token'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_terminalExitedTokens').has('token'), true);
		assert.deepStrictEqual(fixture.mainCalls, [{
			command: 'setExactViewBackgroundThrottling',
			args: [binding.exactView, true],
		}]);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, false, [{ token: 'token', shellPid: 303 }]));
		assert.strictEqual(Reflect.get(fixture.service, '_terminalExitedTokens').has('token'), true);
		assert.strictEqual(fixture.paneShells.has('token'), false);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(3, true, []));
		assert.strictEqual(Reflect.get(fixture.service, '_terminalExitedTokens').has('token'), false);
	});

	test('ingress leases are bounded, terminal-aware, fault-aware, and reject owner lifecycle ABA', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, false, [{ token: 'token' }]));
		const first = fixture.service.captureIngressLease('token');
		assert.ok(first);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(first), true);
		assert.strictEqual(fixture.service.captureIngressLease('x'.repeat(201)), undefined);

		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(2, false, []));
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(first), true);
		Reflect.get(fixture.service, '_terminalExitedTokens').add('token');
		assert.strictEqual(fixture.service.captureIngressLease('token'), undefined);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(first), false);
		Reflect.get(fixture.service, '_terminalExitedTokens').delete('token');

		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(3, true, []));
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(first), false);
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token' }]));
		const second = fixture.service.captureIngressLease('token');
		assert.ok(second);
		assert.notStrictEqual(second, first);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(first), false);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(second), true);

		Reflect.set(fixture.service, '_authorityFaulted', true);
		assert.strictEqual(fixture.service.captureIngressLease('token'), undefined);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(second), false);
	});

	test('rejects missing foreign exited faulted and oversized MCP ingress before reading a body', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'owned' }]));
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const cases: readonly [string, () => void][] = [
			['/', () => undefined],
			['/?pane=foreign', () => undefined],
			[`/?pane=${'x'.repeat(201)}`, () => undefined],
			['/?pane=owned', () => Reflect.get(fixture.service, '_terminalExitedTokens').add('owned')],
			['/?pane=owned', () => { Reflect.get(fixture.service, '_terminalExitedTokens').delete('owned'); Reflect.set(fixture.service, '_authorityFaulted', true); }],
		];
		let expectedBody: string | undefined;
		for (const [url, prepare] of cases) {
			prepare();
			const request = new TestRequest('POST', url);
			const response = new TestResponse();
			await handleRequest(request, response);
			assert.strictEqual(request.listenerCount('data'), 0);
			assert.strictEqual(response.statusCode, 404);
			expectedBody ??= response.body;
			assert.strictEqual(response.body, expectedBody);
		}
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').size, 0);
	});

	test('reserves MCP and hook ingress before body listeners and releases the shared per-token cap', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const stalled = Array.from({ length: 8 }, () => {
			const request = new TestRequest('POST', '/?pane=token');
			const response = new TestResponse();
			return { request, response, pending: handleRequest(request, response) };
		});
		assert.ok(stalled.every(entry => entry.request.listenerCount('data') === 1));

		const overflowRequest = new TestRequest('POST', '/agent-hook?pane=token&event=Stop');
		const overflowResponse = new TestResponse();
		await handleRequest(overflowRequest, overflowResponse);
		assert.strictEqual(overflowResponse.statusCode, 429);
		assert.strictEqual(overflowRequest.listenerCount('data'), 0);

		for (const entry of stalled) {
			entry.request.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}'));
			entry.request.emit('end');
		}
		await Promise.all(stalled.map(entry => entry.pending));
		assert.strictEqual(Reflect.get(fixture.service, '_activeIngressRequestCount'), 0);
		assert.strictEqual(Reflect.get(fixture.service, '_activeIngressRequestsByToken').size, 0);
	});

	test('bounds global ingress reservations and releases token churn without map growth', () => {
		const fixture = createFixture();
		const reserve = Reflect.get(fixture.service, '_reserveIngressRequest').bind(fixture.service) as (token: string) => { dispose(): void } | undefined;
		const reservations = Array.from({ length: 128 }, (_, index) => reserve(`token-${index}`));
		assert.ok(reservations.every(Boolean));
		assert.strictEqual(reserve('overflow'), undefined);
		for (const reservation of reservations) {
			reservation?.dispose();
			reservation?.dispose();
		}
		assert.strictEqual(Reflect.get(fixture.service, '_activeIngressRequestCount'), 0);
		assert.strictEqual(Reflect.get(fixture.service, '_activeIngressRequestsByToken').size, 0);
	});

	test('does not resurrect MCP or hook state when the owner retires during body read', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token' }]));
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;

		const mcpRequest = new TestRequest('POST', '/?pane=token');
		const mcpResponse = new TestResponse();
		const mcpPending = handleRequest(mcpRequest, mcpResponse);
		assert.strictEqual(mcpRequest.listenerCount('data'), 1);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(2, true, []));
		mcpRequest.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
		mcpRequest.emit('end');
		await mcpPending;
		assert.strictEqual(mcpResponse.statusCode, 404);
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').has('token'), false);

		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token' }]));
		const hookRequest = new TestRequest('POST', '/agent-hook?pane=token&event=Stop');
		const hookResponse = new TestResponse();
		const hookPending = handleRequest(hookRequest, hookResponse);
		assert.strictEqual(hookRequest.listenerCount('data'), 1);
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(2, true, []));
		hookRequest.emit('data', Buffer.from('{}'));
		hookRequest.emit('end');
		await hookPending;
		assert.strictEqual(hookResponse.statusCode, 404);
		assert.strictEqual(Reflect.get(fixture.service, '_agentHookTokens').has('token'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_paneStatuses').has('token'), false);
	});

	test('keeps health process-wide even when pane authority is faulted', async () => {
		const fixture = createFixture();
		Reflect.set(fixture.service, '_authorityFaulted', true);
		const request = new TestRequest('GET', '/paradis-mcp/health');
		const response = new TestResponse();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;

		await handleRequest(request, response);

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(request.listenerCount('data'), 0);
		assert.strictEqual(JSON.parse(response.body).instanceId, 'test-instance');
	});

	test('a throwing trace logger cannot prevent a hook response from settling once', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		Object.assign(Reflect.get(fixture.service, 'logService'), {
			trace: () => { throw new Error('private trace logger failure'); },
		});
		const request = new TestRequest('POST', '/agent-hook?pane=token&event=Stop');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{}'));
		request.emit('end');
		await pending;

		assert.strictEqual(response.statusCode, 200);
		assert.deepStrictEqual(JSON.parse(response.body), { ok: true });
		assert.strictEqual(response.endCalls, 1);
	});

	test('a throwing warn logger cannot prevent an internal JSON-RPC error from settling once', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		Reflect.set(fixture.service, '_dispatch', async () => { throw new Error('private dispatch failure'); });
		Object.assign(Reflect.get(fixture.service, 'logService'), {
			warn: () => { throw new Error('private warn logger failure'); },
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
		request.emit('end');
		await pending;

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body.includes('Internal error'), true);
		assert.strictEqual(response.body.includes('private'), false);
		assert.strictEqual(response.endCalls, 1);
	});

	test('the outer request failure handler settles once even when error logging throws', () => {
		const fixture = createFixture();
		Object.assign(Reflect.get(fixture.service, 'logService'), {
			error: () => { throw new Error('private error logger failure'); },
		});
		const response = new TestResponse();
		const settleUnexpectedRequestError = Reflect.get(fixture.service, '_settleUnexpectedRequestError').bind(fixture.service) as (response: TestResponse, error: unknown) => void;

		assert.doesNotThrow(() => settleUnexpectedRequestError(response, new Error('private request failure')));
		assert.doesNotThrow(() => settleUnexpectedRequestError(response, new Error('second private request failure')));

		assert.strictEqual(response.statusCode, 500);
		assert.strictEqual(response.body.includes('Internal error'), true);
		assert.strictEqual(response.body.includes('private'), false);
		assert.strictEqual(response.endCalls, 1);
	});

	test('settles oversized MCP and hook bodies once, removes listeners, and creates no pane state', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;

		for (const url of ['/?pane=token', '/agent-hook?pane=token&event=Stop']) {
			const request = new TestRequest('POST', url);
			const response = new TestResponse();
			const pending = handleRequest(request, response);
			request.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
			request.emit('end');
			await pending;

			assert.strictEqual(request.destroyed, true);
			assert.strictEqual(request.listenerCount('data'), 0);
			assert.strictEqual(request.listenerCount('end'), 0);
			assert.strictEqual(request.listenerCount('error'), 0);
			assert.strictEqual(response.statusCode, 413);
		}
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_agentHookTokens').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_paneStatuses').size, 0);
	});

	test('readBody rejects aborted and prematurely closed requests exactly once with no listeners retained', async () => {
		const fixture = createFixture();
		const readBody = Reflect.get(fixture.service, '_readBody').bind(fixture.service) as (request: TestRequest) => Promise<string>;
		for (const event of ['aborted', 'close'] as const) {
			const request = new TestRequest('POST', '/');
			const settlement = readBody(request).then(() => 'resolved', () => 'rejected');
			request.emit(event);
			const result = await Promise.race([
				settlement,
				new Promise<'timeout'>(resolve => setImmediate(() => resolve('timeout'))),
			]);
			assert.strictEqual(result, 'rejected');
			for (const listener of ['data', 'end', 'error', 'aborted', 'close']) {
				assert.strictEqual(request.listenerCount(listener), 0);
			}
		}
	});

	test('service disposal synchronously invalidates ingress and aborts an active MCP body read', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const lease = fixture.service.captureIngressLease('token');
		assert.ok(lease);
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const pending = handleRequest(request, response);
		assert.strictEqual(request.listenerCount('data'), 1);

		fixture.service.dispose();

		assert.strictEqual(fixture.service.captureIngressLease('token'), undefined);
		assert.strictEqual(fixture.service.isIngressLeaseCurrent(lease), false);
		assert.strictEqual(Reflect.get(fixture.service, '_activeRequestControllers').size, 0);
		const settled = await Promise.race([
			pending.then(() => true),
			new Promise<false>(resolve => setImmediate(() => resolve(false))),
		]);
		assert.strictEqual(settled, true);
		assert.strictEqual(request.destroyed, true);
		assert.strictEqual(request.destroyCalls, 1);
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').size, 0);
		for (const listener of ['data', 'end', 'error', 'aborted', 'close']) {
			assert.strictEqual(request.listenerCount(listener), 0);
		}
	});

	test('service disposal aborts an active hook read before event or status mutation', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const events: IParadisAgentHookEvent[] = [];
		const listener = onParadisAgentHookEvent(event => events.push(event));
		try {
			const request = new TestRequest('POST', '/agent-hook?pane=token&event=Stop');
			const response = new TestResponse();
			const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
			const pending = handleRequest(request, response);
			assert.strictEqual(request.listenerCount('data'), 1);

			fixture.service.dispose();
			request.emit('data', Buffer.from('{}'));
			request.emit('end');
			await pending;

			assert.deepStrictEqual(events, []);
			assert.strictEqual(Reflect.get(fixture.service, '_agentHookTokens').size, 0);
			assert.strictEqual(Reflect.get(fixture.service, '_paneStatuses').size, 0);
		} finally {
			listener.dispose();
		}
	});

	test('hook aliases are derived only from the bounded sanitized payload', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const events: IParadisAgentHookEvent[] = [];
		const listener = onParadisAgentHookEvent(event => events.push(event));
		try {
			const request = new TestRequest('POST', '/agent-hook?pane=token&event=MessageDisplay');
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({
				session_id: 's'.repeat(20_000),
				transcript_path: 'p'.repeat(20_000),
				cwd: 'c'.repeat(20_000),
				message: 'm'.repeat(20_000),
				tool_name: 't'.repeat(20_000),
				tool_input: { value: 'i'.repeat(20_000) },
				tool_use_id: 'u'.repeat(20_000),
				message_id: 'd'.repeat(20_000),
				delta: 'x'.repeat(20_000),
				index: -1,
				final: true,
			})));
			request.emit('end');
			await pending;

			assert.strictEqual(events.length, 1);
			const event = events[0];
			assert.strictEqual(event.sessionId, event.payload?.['session_id']);
			assert.strictEqual(event.transcriptPath, event.payload?.['transcript_path']);
			assert.strictEqual(event.cwd, event.payload?.['cwd']);
			assert.strictEqual(event.toolName, event.payload?.['tool_name']);
			assert.strictEqual(event.toolUseId, event.payload?.['tool_use_id']);
			assert.strictEqual(event.messageId, event.payload?.['message_id']);
			assert.strictEqual(event.messageDelta, event.payload?.['delta']);
			assert.deepStrictEqual(event.toolInput, event.payload?.['tool_input']);
			assert.strictEqual(event.sessionId?.length, 10_000);
			assert.strictEqual((event.toolInput as { value: string }).value.length, 10_000);
			assert.strictEqual(event.messageIndex, undefined);
			assert.strictEqual(event.messageFinal, true);
		} finally {
			listener.dispose();
		}
	});

	test('rejects an oversized hook event before reading the body without reflecting it', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const oversizedEvent = 'private-event-'.repeat(1_000);
		const request = new TestRequest('POST', `/agent-hook?pane=token&event=${oversizedEvent}`);
		const response = new TestResponse();

		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
		const bodyListenerCount = request.listenerCount('data');
		request.emit('end');
		await pending;

		assert.strictEqual(bodyListenerCount, 0);
		assert.strictEqual(response.statusCode, 400);
		assert.strictEqual(response.body.includes('private-event'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_agentHookTokens').size, 0);
	});

	test('suppresses a delayed DevTools tool list after its owner retires', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => notifyStarted = resolve);
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		Reflect.set(fixture.service, '_devtoolsProxy', {
			retire: () => undefined,
			listTools: async () => { notifyStarted(); await gate; return [{ name: 'secret_tool' }]; },
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const pending = handleRequest(request, response);
		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
		request.emit('end');
		await started;

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		release();
		await pending;

		assert.strictEqual(response.statusCode, 404);
		assert.strictEqual(response.body.includes('secret_tool'), false);
	});

	test('suppresses a delayed preview result after its owner retires', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => notifyStarted = resolve);
		let release!: (result: { readonly ok: boolean }) => void;
		const gate = new Promise<{ readonly ok: boolean }>(resolve => release = resolve);
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: () => { notifyStarted(); return gate; } }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const pending = handleRequest(request, response);
		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/example.txt"}}}'));
		request.emit('end');
		await started;

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		release({ ok: true });
		await pending;

		assert.strictEqual(response.statusCode, 404);
		assert.strictEqual(response.body.includes('/tmp/example.txt'), false);
	});

	test('genericizes renderer preview failures before returning them to MCP clients', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async () => ({ ok: false, error: 'renderer-private-marker' }) }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/example.txt"}}}'));
		request.emit('end');
		await pending;

		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body.includes('Failed to open the file in Para Code.'), true);
		assert.strictEqual(response.body.includes('renderer-private-marker'), false);
		assert.strictEqual(response.endCalls, 1);
	});

	test('service disposal aborts a delayed preview without waiting for IPC or mutating a response', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => notifyStarted = resolve);
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: () => { notifyStarted(); return new Promise(() => undefined); } }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		const pending = handleRequest(request, response);
		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/private.txt"}}}'));
		request.emit('end');
		await started;

		fixture.service.dispose();
		const settled = await Promise.race([
			pending.then(() => true),
			new Promise<false>(resolve => setImmediate(() => resolve(false))),
		]);

		assert.strictEqual(settled, true);
		assert.strictEqual(response.body.includes('/tmp/private.txt'), false);
	});

	test('generation coordinator disposal clears state and late operation settlement cannot recreate it', async () => {
		const forgotten: string[] = [];
		const coordinator = new ParadisDevtoolsGenerationCoordinator(token => forgotten.push(token));
		coordinator.setGeneration('token', 1);
		let release!: () => void;
		const operation = new Promise<void>(resolve => release = resolve);
		const pending = coordinator.runWithLease('token', () => operation);
		coordinator.forgetWhenIdle('token', 1);

		coordinator.dispose();
		const state = coordinator as unknown as {
			_generations: Map<string, number>;
			_activeLeases: Map<string, number>;
			_pendingForgetGenerations: Map<string, number>;
		};
		assert.strictEqual(coordinator.isCurrentGeneration('token', 1), false);
		assert.strictEqual(state._generations.size, 0);
		assert.strictEqual(state._activeLeases.size, 0);
		assert.strictEqual(state._pendingForgetGenerations.size, 0);
		release();
		await pending;
		assert.strictEqual(state._generations.size, 0);
		assert.strictEqual(state._activeLeases.size, 0);
		assert.strictEqual(state._pendingForgetGenerations.size, 0);
		assert.deepStrictEqual(forgotten, []);
	});

	test('returns false for an eligible token without an active binding and causes no mutation or cleanup', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const generation = Reflect.get(fixture.service, '_nextBindingGeneration');

		assert.strictEqual(await fixture.service.unbind(connection, 'token'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_nextBindingGeneration'), generation);
		assert.strictEqual(Reflect.get(fixture.authority, 'bindingStates').size, 0);
		assert.deepStrictEqual(fixture.effects, []);
	});

	test('restores one shared exact view only after the last owner retirement', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'token-a' }, { token: 'token-b' },
		]));
		const first = fixture.seedBinding('token-a', 'window:1', 'shared-page');
		fixture.seedBinding('token-b', 'window:1', 'shared-page');
		fixture.mainCalls.length = 0;
		fixture.effects.length = 0;

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));

		assert.deepStrictEqual(fixture.mainCalls, [{
			command: 'setExactViewBackgroundThrottling',
			args: [first.exactView, true],
		}]);
	});

	test('service disposal restores the last exact view binding', async () => {
		const fixture = createFixture();
		const binding = fixture.seedBinding('token', 'window:1', 'page');
		fixture.mainCalls.length = 0;
		fixture.effects.length = 0;

		fixture.service.dispose();

		assert.deepStrictEqual(fixture.mainCalls, [{
			command: 'setExactViewBackgroundThrottling',
			args: [binding.exactView, true],
		}]);
		assert.strictEqual(fixture.bindings.size, 0);
	});

	test('quarantines an external identity mismatch count-neutrally, consumes the handle, and latches fault', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		const original = fixture.seedBinding('token');
		const newer: ITestBinding = { windowCtx: 'window:1', pageId: 'new-page', pageInfo: { url: '', title: '' }, generation: 2, boundAt: 2, exactView: { windowId: 1, viewId: 'new-page', targetId: 'new-target', viewLease: 'new-lease' }, scope: { kind: 'unscoped' } };
		fixture.bindings.set('token', newer);
		fixture.mainCalls.length = 0;
		fixture.effects.length = 0;

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.quarantined.has(newer), true);
		assert.strictEqual(fixture.bindings.size + fixture.quarantined.size, 1);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), true);
		assert.deepStrictEqual(fixture.mainCalls, [{
			command: 'setExactViewBackgroundThrottling',
			args: [original.exactView, true],
		}]);
		await assert.rejects(
			fixture.service.syncBindingAuthority(connection, authorityManifest(3, true, [])),
			/protocol/i,
		);
		assert.strictEqual(await fixture.service.unbind(connection, 'token'), false);
		assert.strictEqual(fixture.service.registerRendererConnection('window:2', {}), false);
	});

	test('continues every retirement after a nonessential cleanup failure', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token-a' }, { token: 'token-b' }]));
		fixture.seedBinding('token-a', 'window:1', 'page-a');
		fixture.seedBinding('token-b', 'window:1', 'page-b');
		Object.assign(Reflect.get(fixture.service, '_cdpGateway'), {
			closeConnectionsForToken: (token: string) => {
				if (token === 'token-a') {
					throw new Error('cleanup failed');
				}
			},
		});

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.authority.isOwnedToken('token-a'), false);
		assert.strictEqual(fixture.authority.isOwnedToken('token-b'), false);
	});

	test('completes or abandons every mixed retirement handle and Main cleanup converges after fault', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'token-a' }, { token: 'token-b' }, { token: 'token-c' },
		]));
		fixture.seedBinding('token-a');
		fixture.seedBinding('token-b');
		fixture.seedBinding('token-c');
		const mismatched: ITestBinding = { windowCtx: 'window:1', pageId: 'new-page', pageInfo: { url: '', title: '' }, generation: 2, boundAt: 2, exactView: { windowId: 1, viewId: 'new-page', targetId: 'new-target', viewLease: 'new-lease' }, scope: { kind: 'unscoped' } };
		fixture.bindings.set('token-b', mismatched);
		const completeCalls: string[] = [];
		const abandonCalls: string[] = [];
		const complete = fixture.authority.completeBindingRetirement.bind(fixture.authority);
		const abandon = fixture.authority.abandonBindingRetirement.bind(fixture.authority);
		Object.assign(fixture.authority, {
			completeBindingRetirement: (retirement: { token: string }) => {
				completeCalls.push(retirement.token);
				return complete(retirement as never);
			},
			abandonBindingRetirement: (retirement: { token: string }) => {
				abandonCalls.push(retirement.token);
				return abandon(retirement as never);
			},
		});

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.deepStrictEqual(completeCalls, ['token-a', 'token-c']);
		assert.deepStrictEqual(abandonCalls, ['token-b']);
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.quarantined.has(mismatched), true);
		assert.strictEqual(Reflect.get(fixture.authority, 'bindingStates').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), true);

		fixture.service.observeRendererManifest(mainManifest(0, []) as never);
		assert.strictEqual(Reflect.get(fixture.service, '_knownRendererContexts').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_rendererConnections').size, 0);
		assert.strictEqual(Reflect.get(fixture.authority, 'windowStates').size, 0);
	});

	test('a false retirement claim preserves the ABA binding new owner and all token-local state', async () => {
		const fixture = createFixture();
		const first = {};
		fixture.service.registerRendererConnection('window:1', first);
		await fixture.service.syncBindingAuthority(first, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		const active = fixture.seedBinding('token');
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'working', changedAt: 1 });
		Reflect.get(fixture.service, '_seenTokens').add('token');
		const release = fixture.authority.destroyWindow('window:1');
		const replacement = {};
		fixture.authority.registerConnection('window:1', replacement);
		fixture.authority.acceptManifest(replacement, authorityManifest(1, true, [{ token: 'token' }]));
		fixture.authority.recordBindingMutation('token', undefined);
		fixture.authority.recordBindingMutation('token', active);

		Reflect.get(fixture.service, '_processOwnerRelease').call(fixture.service, release);
		assert.strictEqual(fixture.bindings.get('token'), active);
		assert.strictEqual(fixture.quarantined.size, 0);
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);
		assert.strictEqual(Reflect.get(fixture.service, '_paneStatuses').has('token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').has('token'), true);
		assert.strictEqual(fixture.authority.isCurrentOwnedToken(replacement, 'token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), true);
	});

	test('Main destroy cleanup preserves a binding and token-local state after a false retirement claim', async () => {
		const fixture = createFixture();
		fixture.service.observeRendererManifest(mainManifest(0, [1]) as never);
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		const active = fixture.seedBinding('token');
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'working', changedAt: 1 });
		Reflect.get(fixture.service, '_seenTokens').add('token');

		const destroyWindow = fixture.authority.destroyWindow.bind(fixture.authority);
		Object.assign(fixture.authority, {
			destroyWindow: (windowCtx: string) => {
				const release = destroyWindow(windowCtx);
				fixture.authority.recordBindingMutation('token', undefined);
				fixture.authority.recordBindingMutation('token', active);
				return release;
			},
		});

		fixture.service.observeRendererManifest(mainManifest(1, []) as never);
		assert.strictEqual(fixture.bindings.get('token'), active);
		assert.strictEqual(fixture.quarantined.size, 0);
		assert.strictEqual(fixture.paneShells.get('token')?.shellPid, 101);
		assert.strictEqual(Reflect.get(fixture.service, '_paneStatuses').has('token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_seenTokens').has('token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), true);
	});

	test('a throwing debug logger cannot stop the remaining retirement cohort', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token-a' }, { token: 'token-b' }]));
		fixture.seedBinding('token-a');
		fixture.seedBinding('token-b');
		Object.assign(Reflect.get(fixture.service, 'logService'), {
			debug: () => { throw new Error('logger failed'); },
		});

		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.authority.isOwnedToken('token-a'), false);
		assert.strictEqual(fixture.authority.isOwnedToken('token-b'), false);
		assert.strictEqual(Reflect.get(fixture.authority, 'bindingStates').size, 0);
	});

	test('status polling sweeps only tokens eligible to the caller window', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token-a' }]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token-b' }]));
		const statuses = Reflect.get(fixture.service, '_paneStatuses');
		statuses.set('token-a', { status: 'working', changedAt: 0, backgroundCompletionFallback: true });
		statuses.set('token-b', { status: 'working', changedAt: 0, backgroundCompletionFallback: true });

		assert.deepStrictEqual((await fixture.service.listPaneStatuses(connectionA)).map(status => status.status), ['review']);
		assert.strictEqual(statuses.get('token-b')?.status, 'working');
	});

	test('disconnect preserves owners while strict Main destruction retires PIDless unbound contexts', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.observeRendererManifest(mainManifest(0, [1]) as never);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', connection), true);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'pidless' }]));
		fixture.service.unregisterRendererConnection('window:1', connection);
		assert.strictEqual(fixture.authority.isOwnedToken('pidless'), true);

		fixture.service.observeRendererManifest(mainManifest(1, []) as never);
		assert.strictEqual(fixture.authority.isOwnedToken('pidless'), false);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), false);
		fixture.service.observeRendererManifest(mainManifest(2, [1]) as never);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), true);
	});

	test('rejects stale equal malformed and duplicate Main manifests atomically', () => {
		const fixture = createFixture();
		fixture.service.observeRendererManifest(mainManifest(0, [1]) as never);
		fixture.service.observeRendererManifest(mainManifest(0, []) as never);
		fixture.service.observeRendererManifest({ revision: 1, entries: [{ windowId: 1 }, { windowId: 1 }] } as never);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), true);
		assert.strictEqual(fixture.service.registerRendererConnection('window:2', {}), false);
		fixture.service.observeRendererManifest(mainManifest(1, [2]) as never);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), false);
		assert.strictEqual(fixture.service.registerRendererConnection('window:2', {}), true);
	});

	test('Main destruction continues across cleanup failures for every window and token', async () => {
		const fixture = createFixture();
		fixture.service.observeRendererManifest(mainManifest(0, [1, 2]) as never);
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'token-a' }]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'token-b' }]));
		fixture.seedBinding('token-a', 'window:1');
		fixture.seedBinding('token-b', 'window:2');
		Object.assign(Reflect.get(fixture.service, '_cdpGateway'), {
			closeConnectionsForToken: (token: string) => {
				if (token === 'token-a') {
					throw new Error('cleanup failed');
				}
			},
		});

		fixture.service.observeRendererManifest(mainManifest(1, []) as never);
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.authority.isOwnedToken('token-a'), false);
		assert.strictEqual(fixture.authority.isOwnedToken('token-b'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_knownRendererContexts').size, 0);
		assert.strictEqual(Reflect.get(fixture.authority, 'windowStates').size, 0);
	});

	test('Main-confirmed ID reuse requires a new connection first manifest and never revives the old channel', async () => {
		const fixture = createFixture();
		fixture.service.observeRendererManifest(mainManifest(0, [1]) as never);
		const oldConnection = {};
		fixture.service.registerRendererConnection('window:1', oldConnection);
		const oldChannel = new ParadisAgentBrowserChannel(fixture.service, oldConnection);
		await oldChannel.call('window:1', 'syncBindingAuthority', [authorityManifest(1, true, [])]);
		fixture.service.observeRendererManifest(mainManifest(1, []) as never);
		assert.throws(() => oldChannel.call('window:1', 'listBindings'), /protocol/i);

		fixture.service.observeRendererManifest(mainManifest(2, [1]) as never);
		const newConnection = {};
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', newConnection), true);
		const newChannel = new ParadisAgentBrowserChannel(fixture.service, newConnection);
		await assert.rejects(newChannel.call('window:1', 'listBindings'), /protocol/i);
		await newChannel.call('window:1', 'syncBindingAuthority', [authorityManifest(1, true, [])]);
		assert.deepStrictEqual(await newChannel.call('window:1', 'listBindings'), []);
		assert.throws(() => oldChannel.call('window:1', 'listBindings'), /protocol/i);
	});

	test('snapshots each Main manifest getter once before accepting its owned copy', () => {
		const fixture = createFixture();
		const reads = new Map<string, number>();
		const once = <T>(key: string, first: T, later: unknown): (() => unknown) => () => {
			const count = (reads.get(key) ?? 0) + 1;
			reads.set(key, count);
			return count === 1 ? first : later;
		};
		const entry = {
			get windowId() { return once('windowId', 1, '1')(); },
			get rendererGeneration() { return once('rendererGeneration', 1, 0)(); },
			get windowRevision() { return once('windowRevision', 0, -1)(); },
			get claimed() { return once('claimed', false, true)(); },
		};
		const manifest = {
			get revision() { return once('revision', 0, '0')(); },
			get entries() { return once('entries', [entry], [])(); },
		};

		fixture.service.observeRendererManifest(manifest as never);
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), true);
		assert.deepStrictEqual(Object.fromEntries(reads), {
			revision: 1,
			entries: 1,
			windowId: 1,
			rendererGeneration: 1,
			windowRevision: 1,
			claimed: 1,
		});
	});

	test('converges known and current renderer state over repeated Main-confirmed ID reuse', async () => {
		const fixture = createFixture();
		let revision = 0;
		for (let index = 0; index < 1_000; index++) {
			fixture.service.observeRendererManifest(mainManifest(revision++, [1]) as never);
			const connection = {};
			assert.strictEqual(fixture.service.registerRendererConnection('window:1', connection), true);
			await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, []));
			fixture.service.observeRendererManifest(mainManifest(revision++, []) as never);
		}
		assert.strictEqual(Reflect.get(fixture.service, '_knownRendererContexts').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_rendererConnections').size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_rendererConnectionContexts').size, 0);
		assert.strictEqual(Reflect.get(fixture.authority, 'windowStates').size, 0);
		assert.strictEqual(Reflect.get(fixture.authority, 'connectionStates').size, 0);
	});
});
