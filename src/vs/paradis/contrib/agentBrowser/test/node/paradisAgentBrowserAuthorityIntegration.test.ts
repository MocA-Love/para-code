/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisExactBrowserViewDescriptor, paradisIsAgentHookReleaseEvent, paradisNormalizeAgentHookEvent } from '../../common/paradisAgentBrowser.js';
import { IParadisBindingAuthorityManifest, ParadisBindingAuthority } from '../../common/paradisBindingAuthority.js';
import { ParadisExactViewBackgroundThrottlingCoordinator } from '../../common/paradisExactViewBackgroundThrottling.js';
import { ParadisAgentBrowserChannel } from '../../node/paradisAgentBrowserChannel.js';
import { ParadisAgentBrowserService, ParadisDevtoolsGenerationCoordinator } from '../../node/paradisAgentBrowserService.js';
import { ParadisCursorPacingLedger } from '../../node/paradisCursorPacing.js';
import { ParadisRemoteFileTransfer } from '../../node/paradisRemoteFileTransfer.js';
import { IParadisAgentHookEvent, onParadisAgentHookEvent } from '../../node/paradisAgentHookBus.js';
import { IParadisMcpToolCallContext } from '../../common/paradisMcpToolProvider.js';
import { ParadisAgentHookOwnership } from '../../node/paradisAgentHookOwnership.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { paradisAgentHookSpoolHash } from '../../node/paradisAgentHookSpoolStore.js';
import { paradisDevtoolsUserTemporaryFolders } from '../../node/paradisDevtoolsPathPolicy.js';
import { paradisAgentTabScopeKey } from '../../common/paradisAgentTabScope.js';

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
	panes: readonly { readonly token: string; readonly shellPid?: number; readonly remoteAuthority?: string }[],
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
	readonly faultedTokens: Set<string>;
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
	const faultedTokens = new Set<string>();
	const quarantinedTokenState = new Map<string, { readonly binding: ITestBinding | undefined; readonly shellPid: number | undefined }>();
	const effects: string[] = [];
	const mainCalls: { command: string; args: readonly unknown[] }[] = [];
	const backgroundThrottlingCoordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_bindings: bindings,
		_agentTabGrants: new Map(),
		_selectedTabs: new Map<string, string>(),
		_tabScopes: new Map(),
		_gatewayScopedLeases: new WeakMap<object, object>(),
		_inputRejections: { forget: () => undefined, record: () => undefined, recent: () => undefined },
		_cursorPacing: new ParadisCursorPacingLedger(),
		_cursorStatusRuns: new Map(),
		_rawCaptureViews: new Map(),
		_bindingAuthority: authority,
		_backgroundThrottlingCoordinator: backgroundThrottlingCoordinator,
		_ingressLeaseStates: new WeakMap<object, object>(),
		_quarantinedBindings: quarantined,
		_faultedTokens: faultedTokens,
		_quarantinedTokenState: quarantinedTokenState,
		_terminalExitedTokens: new Set<string>(),
		_paneShells: paneShells,
		_paneRemoteAuthorities: new Map<string, string>(),
		_remotePaneWindows: new Map<string, string>(),
		_remoteFileTransfer: new ParadisRemoteFileTransfer(() => undefined),
		_paneStatuses: new Map<string, { status: string; changedAt: number }>(),
		_userTurnStarts: new Map<string, number>(),
		_announcedReviews: new Map<string, { turn: number; certain: boolean }>(),
		_paneSessions: new Map(),
		_activityApprovalTokens: new Set<string>(),
		_awaitingUserTokens: new Set<string>(),
		// hook の控え（W2-20）。無いフォルダを指すので、流し直しは何も読まない。
		_hookSpoolDir: '/nonexistent/paradis-agent-hook-spool',
		_hookSpoolPruned: Promise.resolve(),
		_hookSpoolCheckedTokens: new Set<string>(),
		_replayedPrompts: new Map<string, unknown>(),
		_hookSpoolReplayAfter: 0,
		_recentHookIds: new Set<string>(),
		_hookSyncGraceSince: 0,
		_agentHookTokens: new Set<string>(),
		_hookReportedTokens: new Set<string>(),
		_unconfirmedReleaseTokens: new Set<string>(),
		_unconfirmableTokens: new Set<string>(),
		_callerClassifications: new WeakMap<object, Map<string, string>>(),
		// プロセス表なし = 発信元不特定の fail-closed ポリシー（同一/無transcriptは素通し）。
		_hookOwnership: new ParadisAgentHookOwnership({ snapshot: async () => undefined }),
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
		_pageOps: { releaseOwner: () => undefined },
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
		_activeHookRequestsByToken: new Map<string, number>(),
		_activeHookRequestCount: 0,
		_activeModRequestsByToken: new Map<string, number>(),
		_activeModRequestCount: 0,
		_activeMobileVoiceRequestCount: 0,
		_activeMobileVoiceBytes: 0,
		_mobileVoiceTickets: new Map<string, unknown>(),
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
		faultedTokens,
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

	test('status snapshot channel accepts only strict zero arguments and rejects stale connections first', async () => {
		const fixture = createFixture();
		const first = {};
		const replacement = {};
		fixture.service.registerRendererConnection('window:1', first);
		await fixture.service.syncBindingAuthority(first, authorityManifest(1, true, [{ token: 'token' }]));
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'working', changedAt: 9 });
		Reflect.get(fixture.service, '_agentHookTokens').add('token');
		const firstChannel = new ParadisAgentBrowserChannel(fixture.service, first);

		for (const args of [undefined, []]) {
			assert.deepStrictEqual(await firstChannel.call('window:1', 'listAgentStatusSnapshot', args), {
				paneStatuses: [{ token: 'token', status: 'working', changedAt: 9 }],
				agentHookTokens: ['token'],
			});
		}
		const hiddenArgs: unknown[] & { hidden?: boolean } = [];
		Object.defineProperty(hiddenArgs, 'hidden', { value: true });
		const symbolArgs: unknown[] = [];
		Reflect.set(symbolArgs, Symbol('unexpected'), true);
		for (const invalid of [[undefined], ['extra'], 1, {}, hiddenArgs, symbolArgs]) {
			assert.throws(() => firstChannel.call('window:1', 'listAgentStatusSnapshot', invalid), /protocol/i);
		}

		fixture.service.registerRendererConnection('window:1', replacement);
		let argumentAccesses = 0;
		const hostileArgs = new Proxy([], {
			get: (target, property, receiver) => {
				argumentAccesses++;
				return Reflect.get(target, property, receiver);
			},
			ownKeys: target => {
				argumentAccesses++;
				return Reflect.ownKeys(target);
			},
		});
		assert.throws(() => firstChannel.call('window:1', 'listAgentStatusSnapshot', hostileArgs), /protocol/i);
		assert.strictEqual(argumentAccesses, 0);
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

	test('a pane\'s page overrides are released at the new generation when its sharing ends', async () => {
		const fixture = createFixture();
		const released: string[] = [];
		Reflect.set(fixture.service, '_pageOps', { releaseOwner: (token: string, generation: number) => released.push(`${token}:${generation}`) });
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }]));
		fixture.seedBinding('token');
		const generationBefore = Reflect.get(fixture.service, '_nextBindingGeneration') as number;
		assert.strictEqual(await fixture.service.unbind(connection, 'token'), true);
		// The release carries the generation that retired the binding, so main drops everything set before it.
		assert.deepStrictEqual(released, [`token:${generationBefore + 1}`]);
	});

	test('returns one status snapshot scoped to the caller connection including owned hook-only tokens', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [
			{ token: 'status-a' },
			{ token: 'hook-only-a' },
		]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [
			{ token: 'status-b' },
			{ token: 'hook-only-b' },
		]));
		Reflect.get(fixture.service, '_paneStatuses')
			.set('status-a', { status: 'permission', changedAt: 11, cwd: '/repo/a' })
			.set('status-b', { status: 'review', changedAt: 22, cwd: '/repo/b' });
		Reflect.get(fixture.service, '_agentHookTokens')
			.add('status-a')
			.add('hook-only-a')
			.add('status-b')
			.add('hook-only-b');

		assert.deepStrictEqual(await fixture.service.listAgentStatusSnapshot(connectionA), {
			paneStatuses: [{ token: 'status-a', status: 'permission', changedAt: 11, cwd: '/repo/a' }],
			agentHookTokens: ['status-a', 'hook-only-a'],
		});
	});

	// 再起動後に復元したタブから前の会話を続けるための手がかり。hook の session_id を
	// ペインごとに控え、会話を終えた（SessionEnd）ら外す。呼び出し元のウィンドウの分だけを返す。
	test('reports the conversation running in each pane of the caller and drops it once the session ends', async () => {
		const fixture = createFixture();
		const connectionA = {};
		const connectionB = {};
		fixture.service.registerRendererConnection('window:1', connectionA);
		fixture.service.registerRendererConnection('window:2', connectionB);
		await fixture.service.syncBindingAuthority(connectionA, authorityManifest(1, true, [{ token: 'claude-a' }, { token: 'codex-a' }, { token: 'ended-a' }]));
		await fixture.service.syncBindingAuthority(connectionB, authorityManifest(1, true, [{ token: 'claude-b' }]));
		const record = (token: string, event: string, sessionId: string | undefined, transcriptPath: string | undefined, cwd?: string) =>
			Reflect.apply(Reflect.get(fixture.service, '_recordPaneSession'), fixture.service, [token, event, sessionId, transcriptPath, cwd]);
		record('claude-a', 'UserPromptSubmit', 'session-claude', '/Users/example/.claude/projects/repo/session-claude.jsonl', '/repo/a');
		// ツールが cd した後の hook。分岐は会話を始めたフォルダで行うので、最初の cwd を保つ。
		record('claude-a', 'PostToolUse', 'session-claude', '/Users/example/.claude/projects/repo/session-claude.jsonl', '/repo/a/packages/web');
		record('codex-a', 'Stop', 'session-codex', '/Users/example/.codex/sessions/2026/rollout-session-codex.jsonl');
		record('ended-a', 'UserPromptSubmit', 'session-ended', '/Users/example/.claude/projects/repo/session-ended.jsonl');
		record('ended-a', 'SessionEnd', 'session-ended', undefined);
		record('claude-b', 'UserPromptSubmit', 'session-b', '/Users/example/.claude/projects/repo/session-b.jsonl');

		const snapshot = await fixture.service.listAgentStatusSnapshot(connectionA);
		assert.deepStrictEqual(snapshot.paneSessions?.map(session => ({ ...session, at: typeof session.at })), [
			{ token: 'claude-a', agent: 'claude', sessionId: 'session-claude', cwd: '/repo/a', at: 'number' },
			{ token: 'codex-a', agent: 'codex', sessionId: 'session-codex', at: 'number' },
		]);
	});

	// Para Code が止まっている間の hook の控え（W2-20）は、ペインの同期の後に流し直す。完了は鳴らさない印、
	// 許可要求は画面を確かめてもらうまで状態にもカードにもしない。この起動で本物の hook が届いたペインと
	// 古すぎる許可要求は触らない。
	test('replays spooled hooks after the pane sync: a quiet completion mark, and a permission only once the screen shows it', async function () {
		this.timeout(10_000);
		const fixture = createFixture();
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-replay-'));
		const events: IParadisAgentHookEvent[] = [];
		const subscription = onParadisAgentHookEvent(event => events.push(event));
		try {
			Reflect.set(fixture.service, '_hookSpoolDir', dir);
			const now = Math.floor(Date.now() / 1000);
			const spool = (token: string, lines: readonly object[]) => fs.writeFile(join(dir, `pane-${paradisAgentHookSpoolHash(token)}.jsonl`), lines.map(line => JSON.stringify({ v: 1, ...line })).join('\n') + '\n');
			await spool('done', [{ event: 'UserPromptSubmit', t: now - 60, payload: { session_id: 's-done' } }, { event: 'Stop', t: now - 30, payload: { session_id: 's-done', cwd: '/repo' } }]);
			await spool('asking', [{ event: 'PermissionRequest', t: now - 10, payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } }]);
			await spool('stale', [{ event: 'PermissionRequest', t: now - 3_600, payload: null }]);
			await spool('live', [{ event: 'Stop', t: now - 5, payload: null }]);
			Reflect.get(fixture.service, '_hookReportedTokens').add('live');
			// 前の Para Code が生きていた間（返事が遅れて控えた重複の恐れ）と、この起動で既に届いた ID は流さない。
			await spool('before-exit', [{ event: 'Stop', t: now - 50, payload: null }]);
			await spool('duplicate', [{ id: 'already-seen', event: 'Stop', t: now - 20, payload: null }]);
			Reflect.set(fixture.service, '_hookSpoolReplayAfter', (now - 45) * 1000);
			Reflect.get(fixture.service, '_recentHookIds').add('already-seen');
			const connection = {};
			fixture.service.registerRendererConnection('window:1', connection);
			await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'done' }, { token: 'asking' }, { token: 'stale' }, { token: 'live' }, { token: 'before-exit' }, { token: 'duplicate' }]));
			for (let attempt = 0; attempt < 100 && (await fs.readdir(dir)).length > 0; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			await new Promise(resolve => setTimeout(resolve, 20));

			const before = await fixture.service.listAgentStatusSnapshot(connection);
			const confirmedUnknown = await fixture.service.confirmReplayedPrompt(connection, 'stale');
			const confirmed = await fixture.service.confirmReplayedPrompt(connection, 'asking');
			const after = await fixture.service.listAgentStatusSnapshot(connection);
			assert.deepStrictEqual({
				left: await fs.readdir(dir),
				statusesBefore: before.paneStatuses,
				promptsBefore: before.replayedPrompts,
				confirmedUnknown,
				confirmed,
				statusesAfter: after.paneStatuses.map(status => ({ token: status.token, status: status.status, quiet: status.quiet })),
				promptsAfter: after.replayedPrompts,
				events: events.map(event => ({ token: event.token, event: event.event, toolName: event.toolName })),
			}, {
				left: [],
				statusesBefore: [{ token: 'done', status: 'review', changedAt: (now - 30) * 1000, cwd: '/repo', quiet: true }],
				promptsBefore: [{ token: 'asking', status: 'permission' }],
				confirmedUnknown: false,
				confirmed: true,
				statusesAfter: [{ token: 'done', status: 'review', quiet: true }, { token: 'asking', status: 'permission', quiet: undefined }],
				promptsAfter: undefined,
				events: [{ token: 'asking', event: 'PermissionRequest', toolName: 'Bash' }],
			});
		} finally {
			subscription.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	// レビュー M3: 知らないトークンの hook に「まだ同期していない」（503、控える）と答えるのは、起動とウィンドウの
	// 接続の直後だけ。終わったペインと、猶予を過ぎて知らないペインは 404（控えない）。
	test('tells a not-yet-synced pane from an unknown or retired one', () => {
		const fixture = createFixture();
		const possiblyUnsynced = (token: string) => Reflect.apply(Reflect.get(fixture.service, '_isHookTokenPossiblyUnsynced'), fixture.service, [token]) as boolean;
		fixture.service.registerRendererConnection('window:1', {});
		Reflect.get(fixture.service, '_terminalExitedTokens').add('exited');
		const justConnected = { unknown: possiblyUnsynced('unknown'), exited: possiblyUnsynced('exited') };
		Reflect.set(fixture.service, '_hookSyncGraceSince', Date.now() - 61_000);
		assert.deepStrictEqual({ justConnected, later: possiblyUnsynced('unknown') }, { justConnected: { unknown: true, exited: false }, later: false });
	});

	test('resolves eligibility and sweeps stale fallback status once for one atomic snapshot', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'stale-status' },
			{ token: 'hook-only' },
		]));
		Reflect.get(fixture.service, '_paneStatuses').set('stale-status', {
			status: 'working',
			changedAt: 0,
			backgroundCompletionFallback: true,
		});
		Reflect.get(fixture.service, '_agentHookTokens').add('stale-status').add('hook-only');
		const currentEligibleTokens = Reflect.get(fixture.service, '_currentEligibleTokens').bind(fixture.service) as (connection: object) => ReadonlySet<string>;
		const sweepStalePaneStatuses = Reflect.get(fixture.service, '_sweepStalePaneStatuses').bind(fixture.service) as (eligibleTokens: ReadonlySet<string>) => void;
		let eligibleResolutions = 0;
		let staleSweeps = 0;
		Reflect.set(fixture.service, '_currentEligibleTokens', (candidate: object) => {
			eligibleResolutions++;
			return currentEligibleTokens(candidate);
		});
		Reflect.set(fixture.service, '_sweepStalePaneStatuses', (eligibleTokens: ReadonlySet<string>) => {
			staleSweeps++;
			sweepStalePaneStatuses(eligibleTokens);
		});

		const before = Date.now();
		const snapshot = await fixture.service.listAgentStatusSnapshot(connection);
		const after = Date.now();
		assert.deepStrictEqual(snapshot.agentHookTokens, ['stale-status', 'hook-only']);
		assert.strictEqual(snapshot.paneStatuses.length, 1);
		assert.deepStrictEqual(
			{ token: snapshot.paneStatuses[0].token, status: snapshot.paneStatuses[0].status },
			{ token: 'stale-status', status: 'review' },
		);
		assert.strictEqual(snapshot.paneStatuses[0].changedAt >= before, true);
		assert.strictEqual(snapshot.paneStatuses[0].changedAt <= after, true);
		assert.strictEqual(eligibleResolutions, 1);
		assert.strictEqual(staleSweeps, 1);
	});

	test('moves a pane waiting for permission to idle when the agent stops for the user, and leaves a completed pane alone', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'denied-token' }, { token: 'review-token' }]));
		Reflect.get(fixture.service, '_paneStatuses')
			.set('denied-token', { status: 'permission', changedAt: 3 })
			.set('review-token', { status: 'review', changedAt: 4 });
		// モバイルが繋がっていない構成（デスクトップ専用の承認はペインの状態に数えない）でも動くこと
		const settle = (token: string) => (fixture.service as unknown as { _settlePaneAwaitingUser(token: string): void })._settlePaneAwaitingUser(token);
		settle('denied-token');
		settle('review-token');
		const statuses = await fixture.service.listPaneStatuses(connection);
		// 画面側が状態の消滅を完了と数えないよう、次に状態が付くまで知らせる
		const whileStopped = (await fixture.service.listAgentStatusSnapshot(connection)).awaitingUserTokens;
		Reflect.get(fixture.service, '_paneStatuses').set('denied-token', { status: 'working', changedAt: 5 });
		const afterNextTurn = (await fixture.service.listAgentStatusSnapshot(connection)).awaitingUserTokens;
		Reflect.get(fixture.service, '_paneStatuses').delete('denied-token');
		const afterNextTurnEnds = (await fixture.service.listAgentStatusSnapshot(connection)).awaitingUserTokens;

		assert.deepStrictEqual({ statuses, whileStopped, afterNextTurn, afterNextTurnEnds }, {
			statuses: [{ token: 'review-token', status: 'review', changedAt: 4 }],
			whileStopped: ['denied-token'],
			afterNextTurn: undefined,
			afterNextTurnEnds: undefined,
		});
	});

	test('clears a pending permission or question when the agent CLI exits, but not on a plain turn end', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		const tokens = ['perm-exit', 'question-exit', 'perm-turn', 'working-exit'];
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, tokens.map(token => ({ token }))));
		Reflect.get(fixture.service, '_paneStatuses')
			.set('perm-exit', { status: 'permission', changedAt: 1 })
			.set('question-exit', { status: 'question', changedAt: 2 })
			.set('perm-turn', { status: 'permission', changedAt: 3 })
			.set('working-exit', { status: 'working', changedAt: 4 });
		const turnEnded = (token: string, cause: 'turn' | 'cli-exit') => (fixture.service as unknown as { _settlePaneTurnEnded(token: string, at: number, cause: 'turn' | 'cli-exit'): void })._settlePaneTurnEnded(token, 10, cause);
		turnEnded('perm-exit', 'cli-exit');
		turnEnded('question-exit', 'cli-exit');
		turnEnded('perm-turn', 'turn');
		turnEnded('working-exit', 'cli-exit');

		assert.deepStrictEqual({
			statuses: await fixture.service.listPaneStatuses(connection),
			awaitingUser: (await fixture.service.listAgentStatusSnapshot(connection)).awaitingUserTokens,
		}, {
			statuses: [
				{ token: 'perm-turn', status: 'permission', changedAt: 3 },
				{ token: 'working-exit', status: 'review', changedAt: 10 },
			],
			awaitingUser: ['perm-exit', 'question-exit'],
		});
	});

	test('keeps legacy status and hook-token list commands independently available', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'status-token' },
			{ token: 'hook-only-token' },
		]));
		Reflect.get(fixture.service, '_paneStatuses').set('status-token', { status: 'working', changedAt: 17 });
		Reflect.get(fixture.service, '_agentHookTokens').add('status-token').add('hook-only-token');

		assert.deepStrictEqual(await fixture.service.listPaneStatuses(connection), [
			{ token: 'status-token', status: 'working', changedAt: 17 },
		]);
		assert.deepStrictEqual(await fixture.service.listAgentHookTokens(connection), ['status-token', 'hook-only-token']);
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

	test('answers a voice ingress that arrives while shutting down with 503 so the remote side plays it, and other requests with 404', async () => {
		const fixture = createFixture();
		const handleRequest = Reflect.get(fixture.service, '_handleRequest').bind(fixture.service) as (request: TestRequest, response: TestResponse) => Promise<void>;
		Reflect.set(fixture.service, '_serverDisposed', true);
		const statuses: Array<number | undefined> = [];
		try {
			for (const url of ['/paradis-mcp/mobile-voice', '/paradis-mcp/mobile-voice-ticket', '/?pane=owned']) {
				const request = new TestRequest('POST', url);
				const response = new TestResponse();
				await handleRequest(request, response);
				statuses.push(response.statusCode);
			}
		} finally {
			Reflect.set(fixture.service, '_serverDisposed', false);
		}
		assert.deepStrictEqual(statuses, [503, 404, 404]);
	});

	test('reserves MCP ingress before body listeners, caps it per token, and keeps hooks on a separate cap', async () => {
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

		const overflowRequest = new TestRequest('POST', '/?pane=token');
		const overflowResponse = new TestResponse();
		await handleRequest(overflowRequest, overflowResponse);
		assert.strictEqual(overflowResponse.statusCode, 429);
		assert.strictEqual(overflowRequest.listenerCount('data'), 0);

		// Hooks keep their own cap, so long MCP requests (such as wait tools) cannot starve them.
		const hookRequest = new TestRequest('POST', '/agent-hook?pane=token&event=Stop');
		const hookResponse = new TestResponse();
		const hookPending = handleRequest(hookRequest, hookResponse);
		assert.strictEqual(hookRequest.listenerCount('data'), 1);
		hookRequest.emit('data', Buffer.from('{}'));
		hookRequest.emit('end');
		await hookPending;
		assert.notStrictEqual(hookResponse.statusCode, 429);
		assert.strictEqual(Reflect.get(fixture.service, '_activeHookRequestCount'), 0);

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
			assert.strictEqual(event.sessionId, event.payload?.session_id);
			assert.strictEqual(event.transcriptPath, event.payload?.transcript_path);
			assert.strictEqual(event.cwd, event.payload?.cwd);
			assert.strictEqual(event.toolName, event.payload?.tool_name);
			assert.strictEqual(event.toolUseId, event.payload?.tool_use_id);
			assert.strictEqual(event.messageId, event.payload?.message_id);
			assert.strictEqual(event.messageDelta, event.payload?.delta);
			assert.deepStrictEqual(event.toolInput, event.payload?.tool_input);
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

	test('browser tools that ask the user or change profiles refuse a caller that cannot be verified, without reaching the window', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		let windowCalls = 0;
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async () => { windowCalls++; return { ok: true }; } }),
		});
		const bodies: string[] = [];
		for (const name of ['request_browser_page', 'open_browser_profile', 'delete_browser_profile']) {
			// The test socket has no peer port, so the caller cannot be verified.
			const request = new TestRequest('POST', '/?pane=token');
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { profile: 'PRD' } } })));
			request.emit('end');
			await pending;
			bodies.push(response.body);
		}
		assert.deepStrictEqual({ refused: bodies.every(body => body.includes('could not confirm')), windowCalls }, { refused: true, windowCalls: 0 });
	});

	test('the extra browser operations refuse a caller that cannot be verified, without reaching electron-main', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		fixture.seedBinding('token');
		const before = fixture.mainCalls.length;
		const bodies: string[] = [];
		for (const [name, args] of [
			['set_http_credentials', { origin: 'https://intranet.example.com', username: 'u', password: 'p' }],
			['set_request_rules', { rules: [] }],
			['mouse_action', { action: 'wheel', x: 1, y: 1, delta_y: 10 }],
			['get_page_network_overrides', {}],
		] as const) {
			// The test socket has no peer port, so the caller cannot be verified.
			const request = new TestRequest('POST', '/?pane=token');
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })));
			request.emit('end');
			await pending;
			bodies.push(response.body);
		}
		assert.deepStrictEqual({ refused: bodies.every(body => body.includes('could not confirm')), mainCalls: fixture.mainCalls.length - before }, { refused: true, mainCalls: 0 });
	});

	test('the unconfirmed release mark outlives the status entry when the viewer acknowledges the review', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'review', changedAt: 1 });
		Reflect.get(fixture.service, '_unconfirmedReleaseTokens').add('token');
		Reflect.get(fixture.service, '_unconfirmableTokens').add('token');
		await fixture.service.acknowledgePaneStatus(connection, 'token');
		const lease = fixture.service.captureIngressLease('token');
		const context = Reflect.get(fixture.service, '_toolCallContext').call(fixture.service, lease, undefined) as IParadisMcpToolCallContext;
		assert.deepStrictEqual({
			statusGone: Reflect.get(fixture.service, '_paneStatuses').has('token') === false,
			status: context.getPaneAgentStatus('token'),
			mark: context.getUnconfirmedRelease('token'),
		}, { statusGone: true, status: undefined, mark: 'unverifiable' });
	});

	test('keeps the remote mark when an incomplete manifest carries a remote pane over', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 4242, remoteAuthority: 'ssh-remote+dev' }]));
		// After a reload the pane is listed before its terminal is back: no shell PID, no remote authority.
		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, false, [{ token: 'token' }]));
		assert.deepStrictEqual(fixture.paneShells.get('token'), { windowCtx: 'window:1', token: 'token', shellPid: 4242, remoteAuthority: 'ssh-remote+dev' });
	});

	test('hooks that cannot be verified after a transcript release still reach the hook bus and keep the release unconfirmed', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'working', changedAt: 1 });
		Reflect.get(fixture.service, '_unconfirmedReleaseTokens').add('token');
		const events: IParadisAgentHookEvent[] = [];
		const listener = onParadisAgentHookEvent(event => events.push(event));
		try {
			for (const event of ['PostToolUse', 'Stop']) {
				const request = new TestRequest('POST', `/agent-hook?pane=token&event=${event}`);
				const response = new TestResponse();
				const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
				request.emit('data', Buffer.from('{}'));
				request.emit('end');
				await pending;
			}
			assert.deepStrictEqual({
				events: events.map(event => event.event),
				status: Reflect.get(fixture.service, '_paneStatuses').get('token')?.status,
				stillUnconfirmed: Reflect.get(fixture.service, '_unconfirmedReleaseTokens').has('token'),
				unconfirmable: Reflect.get(fixture.service, '_unconfirmableTokens').has('token'),
			}, { events: ['PostToolUse', 'Stop'], status: 'review', stillUnconfirmed: true, unconfirmable: true });
		} finally {
			listener.dispose();
		}
	});

	async function sendHook(service: ParadisAgentBrowserService, token: string, event: string, payload = '{}'): Promise<string> {
		const request = new TestRequest('POST', `/agent-hook?pane=${token}&event=${event}`);
		const response = new TestResponse();
		const pending = Reflect.get(service, '_handleRequest').call(service, request, response) as Promise<void>;
		request.emit('data', Buffer.from(payload));
		request.emit('end');
		await pending;
		return response.body;
	}

	// tmux のサーバー配下や WSL の中のエージェントの hook は、送り主がペインのシェルの子孫に見えず確かめを通れない。
	// 解除の hook まで捨てると、承認しても許可待ちのまま残っていた（M4）。
	test('in a pane whose hooks cannot be verified, a release hook clears the wait it entered and leaves the pane refusing input', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'perm', shellPid: 123 }, { token: 'question', shellPid: 124 }]));
		const statuses = Reflect.get(fixture.service, '_paneStatuses') as Map<string, { status: string }>;
		const steps: string[] = [];
		const step = async (token: string, event: string, payload?: string) => {
			const body = await sendHook(fixture.service, token, event, payload);
			steps.push(`${token}:${event}:${JSON.parse(body).ok}:${statuses.get(token)?.status ?? 'none'}`);
		};
		await step('perm', 'PermissionRequest');
		await step('perm', 'PostToolUse');
		await step('perm', 'Stop');
		// HTTP の TerminalExit はトークンを持つ誰でも送れるので、入力を断る印は外さない
		await step('perm', 'TerminalExit');
		await step('question', 'PreToolUse', '{"tool_name":"AskUserQuestion"}');
		await step('question', 'Stop');
		const lease = fixture.service.captureIngressLease('perm');
		const context = Reflect.get(fixture.service, '_toolCallContext').call(fixture.service, lease, undefined) as IParadisMcpToolCallContext;
		assert.deepStrictEqual({ steps, marks: [context.getUnconfirmedRelease('perm'), context.getUnconfirmedRelease('question')] }, {
			steps: [
				'perm:PermissionRequest:true:permission',
				'perm:PostToolUse:true:working',
				'perm:Stop:true:review',
				'perm:TerminalExit:true:none',
				'question:PreToolUse:true:question',
				'question:Stop:true:review',
			],
			marks: ['unverifiable', 'unverifiable'],
		});
	});

	// 普通の手元のペイン（許可要求の hook はシェルの子孫から届き、確かめられた）で、トークンを読んだ別プロセスが
	// 偽の Stop → TerminalExit → Stop で許可待ちを解き、IDE 操作ツールに Enter を送らせる経路。
	test('a spoofed Stop, TerminalExit and Stop cannot release a wait that a verified hook entered', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'perm', shellPid: 123 }]));
		let verdict = 'pane';
		Reflect.set(fixture.service, '_classifyCaller', async () => verdict);
		const statuses = Reflect.get(fixture.service, '_paneStatuses') as Map<string, { status: string }>;
		const events: IParadisAgentHookEvent[] = [];
		const listener = onParadisAgentHookEvent(event => events.push(event));
		try {
			const entered = JSON.parse(await sendHook(fixture.service, 'perm', 'PermissionRequest')).ok;
			verdict = 'unverified';
			const spoofed: string[] = [];
			for (const event of ['Stop', 'TerminalExit', 'Stop', 'PostToolUse']) {
				spoofed.push(await sendHook(fixture.service, 'perm', event));
			}
			assert.deepStrictEqual({
				entered,
				spoofed: new Set(spoofed),
				events: events.map(event => event.event),
				status: statuses.get('perm')?.status,
				unconfirmed: Reflect.get(fixture.service, '_unconfirmedReleaseTokens').has('perm'),
			}, {
				entered: true,
				spoofed: new Set(['{"ok":false,"reason":"caller not verified"}']),
				events: ['PermissionRequest'],
				status: 'permission',
				unconfirmed: false,
			});
		} finally {
			listener.dispose();
		}
	});

	// 偽の許可要求が本物と競っても、確かめられた待ちの記録を「確かめられなかった」へ書き換えない（送り主の確かめを
	// 待つ間と、所有権の分類を待つ間の両方）
	test('a spoofed wait-entering hook racing a verified one cannot mark the wait as unverified', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'perm', shellPid: 123 }]));
		const statuses = Reflect.get(fixture.service, '_paneStatuses') as Map<string, { status: string; changedAt: number; waitEntryUnverified?: true }>;
		const snapshot = () => { const entry = statuses.get('perm'); return entry ? `${entry.status}:${entry.waitEntryUnverified === true ? 'unverified-entry' : 'verified-entry'}` : 'none'; };
		const verdicts: Promise<string>[] = [];
		let classifications = 0;
		Reflect.set(fixture.service, '_classifyCaller', () => { classifications++; return verdicts.shift() ?? Promise.resolve('unverified'); });
		const waitFor = async (condition: () => boolean) => {
			while (!condition()) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		};

		// 1) 送り主の確かめを待つ間に、本物（確かめられた）の許可要求が先に状態を付けた
		let releaseSpoof!: (kind: string) => void;
		verdicts.push(new Promise<string>(resolve => releaseSpoof = resolve), Promise.resolve('pane'));
		const spoofed = sendHook(fixture.service, 'perm', 'PermissionRequest');
		await waitFor(() => classifications === 1);
		const real = await sendHook(fixture.service, 'perm', 'PermissionRequest');
		releaseSpoof('unverified');
		const spoofedBody = await spoofed;
		const afterClassifyRace = snapshot();
		const stopAfterClassifyRace = await sendHook(fixture.service, 'perm', 'Stop');

		// 2) 所有権の分類を待つ間に、本物の許可要求が状態を付けた
		statuses.delete('perm');
		let releaseOwner!: (value: { origin: 'owner' }) => void;
		const ownership = Reflect.get(fixture.service, '_hookOwnership');
		Reflect.set(fixture.service, '_hookOwnership', { classify: () => new Promise(resolve => releaseOwner = resolve), clear: () => undefined });
		const spoofedLate = sendHook(fixture.service, 'perm', 'PermissionRequest');
		await waitFor(() => releaseOwner !== undefined);
		statuses.set('perm', { status: 'permission', changedAt: 5 });
		releaseOwner({ origin: 'owner' });
		const spoofedLateBody = await spoofedLate;
		Reflect.set(fixture.service, '_hookOwnership', ownership);

		assert.deepStrictEqual({
			bodies: [real, spoofedBody, stopAfterClassifyRace, spoofedLateBody],
			afterClassifyRace,
			afterOwnershipRace: snapshot(),
		}, {
			bodies: ['{"ok":true}', '{"ok":false,"reason":"caller not verified"}', '{"ok":false,"reason":"caller not verified"}', '{"ok":false,"reason":"caller not verified"}'],
			afterClassifyRace: 'permission:verified-entry',
			afterOwnershipRace: 'permission:verified-entry',
		});
	});

	test('the unconfirmed release marks survive an HTTP TerminalExit and are lifted only by the window\'s terminal exit', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.get(fixture.service, '_paneStatuses').set('token', { status: 'review', changedAt: 1 });
		Reflect.get(fixture.service, '_unconfirmedReleaseTokens').add('token');
		Reflect.get(fixture.service, '_unconfirmableTokens').add('token');
		await sendHook(fixture.service, 'token', 'TerminalExit');
		const afterHttpExit = [Reflect.get(fixture.service, '_unconfirmedReleaseTokens').has('token'), Reflect.get(fixture.service, '_unconfirmableTokens').has('token')];
		await fixture.service.notifyTerminalExit(connection, 'token');
		const afterWindowExit = [Reflect.get(fixture.service, '_unconfirmedReleaseTokens').has('token'), Reflect.get(fixture.service, '_unconfirmableTokens').has('token')];
		assert.deepStrictEqual({ afterHttpExit, afterWindowExit }, { afterHttpExit: [true, true], afterWindowExit: [false, false] });
	});

	// Interrupt (Codex's Esc) returns the pane to no status (idle); it never enters a wait.
	test('the hooks accepted without a verified caller only ever move a pane toward working, review or no status', () => {
		const events = ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'UserPromptSubmit', 'task_started', 'Stop', 'StopFailure', 'SubagentStop', 'agent-turn-complete', 'task_complete', 'SessionEnd', 'Interrupt', 'SubagentStart',
			'PreToolUse', 'PermissionRequest', 'Notification', 'exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'permission.ask', 'TerminalExit', 'SessionStart', 'Start'];
		assert.deepStrictEqual(
			events.filter(paradisIsAgentHookReleaseEvent).map(event => `${event}:${paradisNormalizeAgentHookEvent(event, 'needs permission') ?? 'unchanged'}`),
			['PostToolUse:working', 'PostToolUseFailure:working', 'PermissionDenied:working', 'UserPromptSubmit:working', 'task_started:working', 'Stop:review', 'StopFailure:review', 'SubagentStop:unchanged', 'agent-turn-complete:review', 'task_complete:review', 'SessionEnd:review', 'Interrupt:idle'],
		);
	});

	test('a hook that cannot be verified still cannot put or keep a pane in permission, nor clear it by a terminal exit', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'perm', shellPid: 123 }]));
		Reflect.get(fixture.service, '_paneStatuses').set('perm', { status: 'permission', changedAt: 1 });
		const events: IParadisAgentHookEvent[] = [];
		const listener = onParadisAgentHookEvent(event => events.push(event));
		try {
			const bodies: string[] = [];
			for (const [event, payload] of [
				['PermissionRequest', '{}'],
				['Notification', '{"message":"Claude needs your permission"}'],
				['PreToolUse', '{"tool_name":"AskUserQuestion"}'],
				['PreToolUse', '{"tool_name":"Bash"}'],
				['TerminalExit', '{}'],
				['SomethingUnknown', '{}'],
			]) {
				const request = new TestRequest('POST', `/agent-hook?pane=perm&event=${event}`);
				const response = new TestResponse();
				const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
				request.emit('data', Buffer.from(payload));
				request.emit('end');
				await pending;
				bodies.push(response.body);
			}
			assert.deepStrictEqual({
				bodies: new Set(bodies),
				events: events.length,
				status: Reflect.get(fixture.service, '_paneStatuses').get('perm')?.status,
				unconfirmed: Reflect.get(fixture.service, '_unconfirmedReleaseTokens').has('perm'),
			}, {
				bodies: new Set(['{"ok":false,"reason":"caller not verified"}']),
				events: 0,
				status: 'permission',
				unconfirmed: false,
			});
		} finally {
			listener.dispose();
		}
	});

	test('tells the caller a preview was queued for a space that is not on screen', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async () => ({ ok: true, deferred: true, spaceName: 'Design\nSystem' }) }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/example.txt"}}}'));
		request.emit('end');
		await pending;

		assert.strictEqual(response.statusCode, 200);
		// スペース名は1行へ均してから文言に埋める（renderer 由来の生の改行を応答へ通さない）
		assert.strictEqual(response.body.includes('the \\"Design System\\" space'), true);
		assert.strictEqual(response.body.includes('do not assume the user has seen the file'), true);
	});

	test('asks the caller to retry a preview requested during a space switch', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async () => ({ ok: false, reason: 'switching', error: 'renderer-private-marker' }) }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/example.txt"}}}'));
		request.emit('end');
		await pending;

		assert.strictEqual(response.body.includes('PARA_BROWSER_RETRYABLE'), true);
		assert.strictEqual(response.body.includes('renderer-private-marker'), false);
	});

	test('does not ask the caller to retry a preview for a space that cannot be reached', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 123 }]));
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async () => ({ ok: false, reason: 'unreachableSpace' }) }),
		});
		const request = new TestRequest('POST', '/?pane=token');
		const response = new TestResponse();
		const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;

		request.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_file","arguments":{"path":"/tmp/example.txt"}}}'));
		request.emit('end');
		await pending;

		// 再試行しても状況は変わらないので、retryable マーカーを付けずにユーザーへ伝えさせる
		assert.strictEqual(response.body.includes('PARA_BROWSER_RETRYABLE'), false);
		assert.strictEqual(response.body.includes('Tell the user the path instead'), true);
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

	suite('agent tab grants (tab_id)', () => {
		async function grantFixture() {
			const fixture = createFixture();
			Reflect.set(fixture.service, '_pendingBindPreparations', 0);
			Reflect.set(fixture.service, 'mainProcessService', {
				getChannel: () => ({
					call: (command: string, args: readonly unknown[] = []) => {
						fixture.effects.push(`main:${command}`);
						fixture.mainCalls.push({ command, args });
						return command === 'resolveExactViewDescriptor'
							? Promise.resolve({ windowId: args[0], viewId: args[1], targetId: `target-${args[1]}`, viewLease: `lease-${args[1]}` })
							: Promise.resolve(true);
					},
				}),
			});
			const connection = {};
			fixture.service.registerRendererConnection('window:1', connection);
			await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token' }, { token: 'other' }], ['page-user', 'tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e', 'tab-f']));
			const grant = (viewId: string, token = 'token', revision = 1) => fixture.service.grantAgentTab(connection, { revision, token, viewId, pageInfo: { url: `https://${viewId}.test`, title: viewId } });
			const bindingForKey = (key: string) => (Reflect.get(fixture.service, '_bindingForKey') as (key: string) => ITestBinding | undefined).call(fixture.service, key);
			const scopeToolCall = (args: unknown) => (Reflect.get(fixture.service, '_scopeToolCall') as (lease: unknown, args: unknown) => { lease?: { token: string; pageKey?: string }; args?: unknown; ok: boolean; error?: { content: { text: string }[] } })
				.call(fixture.service, fixture.service.captureIngressLease('token'), args);
			return { fixture, connection, grant, bindingForKey, scopeToolCall };
		}

		test('a granted tab is reachable by its scope key next to the shared page, and only from its own pane', async () => {
			const { fixture, grant, bindingForKey } = await grantFixture();
			fixture.seedBinding('token', 'window:1', 'page-user');

			assert.strictEqual(await grant('tab-a'), true);
			assert.deepStrictEqual({
				shared: bindingForKey('token')?.exactView.targetId,
				sharedByTab: bindingForKey(paradisAgentTabScopeKey('token', 'page-user'))?.exactView.targetId,
				granted: bindingForKey(paradisAgentTabScopeKey('token', 'tab-a'))?.exactView.targetId,
				notGranted: bindingForKey(paradisAgentTabScopeKey('token', 'tab-b')),
				otherPane: bindingForKey(paradisAgentTabScopeKey('other', 'tab-a')),
			}, {
				shared: 'target-page-user',
				sharedByTab: 'target-page-user',
				granted: 'target-tab-a',
				notGranted: undefined,
				otherPane: undefined,
			});
		});

		test('tab_id picks the tab, the default follows the selected tab, and an unusable tab is refused', async () => {
			const { fixture, grant, scopeToolCall } = await grantFixture();
			fixture.seedBinding('token', 'window:1', 'page-user');
			assert.strictEqual(await grant('tab-a'), true);

			const explicit = scopeToolCall({ tab_id: 'tab-a', uid: 'e1' });
			const sharedDefault = scopeToolCall({ uid: 'e1' });
			Reflect.get(fixture.service, '_selectedTabs').set('token', 'tab-a');
			const selectedDefault = scopeToolCall({});
			const refused = scopeToolCall({ tab_id: 'tab-b' });
			assert.deepStrictEqual({
				explicit: [explicit.lease?.pageKey, explicit.args],
				sharedDefault: sharedDefault.lease?.pageKey,
				selectedDefault: selectedDefault.lease?.pageKey,
				refused: refused.error?.content[0].text.startsWith('Tab tab-b is not a tab this terminal pane can use'),
				leaseCurrent: fixture.service.isIngressLeaseCurrent(explicit.lease as { token: string }),
			}, {
				explicit: [paradisAgentTabScopeKey('token', 'tab-a'), { uid: 'e1' }],
				sharedDefault: paradisAgentTabScopeKey('token', 'page-user'),
				selectedDefault: paradisAgentTabScopeKey('token', 'tab-a'),
				refused: true,
				leaseCurrent: true,
			});
		});

		test('changing the shared page retires only the shared page\'s tab scope, and revoking a grant retires only that tab', async () => {
			const { fixture, connection, grant, scopeToolCall } = await grantFixture();
			fixture.seedBinding('token', 'window:1', 'page-user');
			assert.strictEqual(await grant('tab-a'), true);
			scopeToolCall({ tab_id: 'tab-a' });
			scopeToolCall({});
			fixture.effects.length = 0;

			assert.strictEqual(await fixture.service.unbind(connection, 'token'), true);
			const tabKey = paradisAgentTabScopeKey('token', 'tab-a');
			const sharedKey = paradisAgentTabScopeKey('token', 'page-user');
			assert.deepStrictEqual({
				sharedRetired: fixture.effects.includes(`retireGateway:${sharedKey}`),
				tabTouched: fixture.effects.some(effect => effect.includes(tabKey)),
			}, { sharedRetired: true, tabTouched: false });

			fixture.effects.length = 0;
			assert.strictEqual(await fixture.service.revokeAgentTab(connection, 'token', 'tab-a'), true);
			assert.deepStrictEqual({
				tabRetired: fixture.effects.includes(`retireGateway:${tabKey}`),
				refusedAfterRevoke: scopeToolCall({ tab_id: 'tab-a' }).error !== undefined,
			}, { tabRetired: true, refusedAfterRevoke: true });
		});

		test('caps grants per pane, refuses a foreign pane, and drops grants when the tab leaves the window', async () => {
			const { fixture, connection, grant, bindingForKey } = await grantFixture();
			const results = [];
			for (const viewId of ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e', 'tab-f']) {
				results.push(await grant(viewId));
			}
			const otherConnection = {};
			fixture.service.registerRendererConnection('window:2', otherConnection);
			await fixture.service.syncBindingAuthority(otherConnection, authorityManifest(1, true, [{ token: 'foreign' }]));
			const foreign = await fixture.service.grantAgentTab(otherConnection, { revision: 1, token: 'foreign', viewId: 'tab-a', pageInfo: { url: 'https://x.test', title: 'x' } });

			await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, [{ token: 'token' }, { token: 'other' }], ['page-user', 'tab-b', 'tab-c', 'tab-d', 'tab-e', 'tab-f']));
			assert.deepStrictEqual({
				results,
				foreign,
				listed: (await fixture.service.listAgentTabGrants(connection)).map(entry => entry.pageId),
				retiredTab: bindingForKey(paradisAgentTabScopeKey('token', 'tab-a')),
			}, {
				results: [true, true, true, true, true, false],
				foreign: false,
				listed: ['tab-b', 'tab-c', 'tab-d', 'tab-e'],
				retiredTab: undefined,
			});
		});

		test('a reloaded window (new renderer connection) and a tab moved to another space drop the grants', async () => {
			const { fixture, connection, grant } = await grantFixture();
			assert.strictEqual(await grant('tab-a'), true);
			assert.strictEqual(await grant('tab-b'), true);
			// tab-b が別のスペースへ移った（確定したスコープが変わった）
			await fixture.service.syncBindingAuthority(connection, {
				revision: 2,
				complete: true,
				panes: [{ token: 'token', scope: { kind: 'unscoped' } }, { token: 'other', scope: { kind: 'unscoped' } }],
				browserViews: ['page-user', 'tab-a', 'tab-b'].map(viewId => ({ viewId, scope: viewId === 'tab-b' ? { kind: 'managed', stateKey: 'space-x' } : { kind: 'unscoped' } })),
			});
			const afterMove = (await fixture.service.listAgentTabGrants(connection)).map(entry => entry.pageId);
			const reloaded = {};
			fixture.service.registerRendererConnection('window:1', reloaded);
			await fixture.service.syncBindingAuthority(reloaded, authorityManifest(3, true, [{ token: 'token' }, { token: 'other' }], ['page-user', 'tab-a', 'tab-b']));
			assert.deepStrictEqual({ afterMove, afterReload: await fixture.service.listAgentTabGrants(reloaded) }, { afterMove: ['tab-a'], afterReload: [] });
		});

		test('a terminal exit forgets every grant and the selected tab of that pane', async () => {
			const { fixture, connection, grant } = await grantFixture();
			assert.strictEqual(await grant('tab-a'), true);
			assert.strictEqual(await grant('tab-b', 'other'), true);
			Reflect.get(fixture.service, '_selectedTabs').set('token', 'tab-a');

			assert.strictEqual(await fixture.service.notifyTerminalExit(connection, 'token'), true);
			assert.deepStrictEqual({
				grants: (await fixture.service.listAgentTabGrants(connection)).map(entry => `${entry.token}:${entry.pageId}`),
				selected: Reflect.get(fixture.service, '_selectedTabs').has('token'),
			}, { grants: ['other:tab-b'], selected: false });
		});
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

	test('quarantines an external identity mismatch count-neutrally and isolates only that token', async () => {
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
		// The drifted token is isolated per-token; the authority itself is NOT globally faulted.
		assert.strictEqual(fixture.faultedTokens.has('token'), true);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), false);
		assert.deepStrictEqual(fixture.mainCalls, [{
			command: 'setExactViewBackgroundThrottling',
			args: [original.exactView, true],
		}]);
		// The quarantined token can neither rebind nor capture non-Renderer ingress.
		await assert.rejects(
			fixture.service.prepareBind(connection, { token: 'token', viewId: 'page-1', revision: 2, pageInfo: { url: 'https://example.test', title: 'Example' } } as never),
			/preparation rejected/i,
		);
		assert.strictEqual(fixture.service.captureIngressLease('token'), undefined);
		// A later manifest and a fresh window registration still succeed: the authority stays live.
		assert.strictEqual(
			(await fixture.service.syncBindingAuthority(connection, authorityManifest(3, true, []))).accepted,
			true,
		);
		assert.strictEqual(fixture.service.registerRendererConnection('window:2', {}), true);
	});

	test('an isolated token blocks only its own rebind and ingress while other panes keep sharing', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token-a', shellPid: 101 }, { token: 'token-b', shellPid: 102 }]));
		fixture.seedBinding('token-a', 'window:1', 'page-a');
		fixture.seedBinding('token-b', 'window:1', 'page-b');
		// Simulate a prior per-token quarantine of token-a (binding removed, token isolated).
		fixture.bindings.delete('token-a');
		fixture.faultedTokens.add('token-a');

		// token-a cannot capture ingress or issue a fresh bind ticket...
		assert.strictEqual(fixture.service.captureIngressLease('token-a'), undefined);
		await assert.rejects(
			fixture.service.prepareBind(connection, { token: 'token-a', viewId: 'page-a', revision: 1, pageInfo: { url: 'https://example.test', title: 'Example' } } as never),
			/preparation rejected/i,
		);
		// ...but token-b is unaffected and keeps sharing, and the authority is never globally faulted.
		assert.notStrictEqual(fixture.service.captureIngressLease('token-b'), undefined);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), false);
	});

	test('notifyTerminalExit lifts a per-token quarantine when the pane lifecycle resets', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		fixture.seedBinding('token');
		fixture.faultedTokens.add('token');
		assert.strictEqual(fixture.service.captureIngressLease('token'), undefined);

		assert.strictEqual(await fixture.service.notifyTerminalExit(connection, 'token'), true);
		// The shell process is gone, so the token is released from quarantine (a fresh lifecycle can rebind).
		assert.strictEqual(fixture.faultedTokens.has('token'), false);
	});

	test('a terminal exit lifts a quarantine even when the closed window left the token ineligible', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		fixture.seedBinding('token');
		const newer: ITestBinding = { windowCtx: 'window:1', pageId: 'new-page', pageInfo: { url: '', title: '' }, generation: 2, boundAt: 2, exactView: { windowId: 1, viewId: 'new-page', targetId: 'new-target', viewLease: 'new-lease' }, scope: { kind: 'unscoped' } };
		fixture.bindings.set('token', newer);
		// Identity mismatch on the empty-manifest retirement quarantines the token and retires its owner,
		// so the token is no longer eligible (mirrors a closed window that also dropped its connection).
		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.strictEqual(fixture.faultedTokens.has('token'), true);
		assert.strictEqual(fixture.quarantined.has(newer), true);

		// The release runs before the eligibility gate, so a dead shell never stays quarantined.
		assert.strictEqual(await fixture.service.notifyTerminalExit(connection, 'token'), false);
		assert.strictEqual(fixture.faultedTokens.has('token'), false);
		// W2: the quarantined binding's capacity is reclaimed on release.
		assert.strictEqual(fixture.quarantined.has(newer), false);
		assert.strictEqual(fixture.quarantined.size, 0);
	});

	test('a reopened pane under a new shell PID lifts a quarantine, but the same shell keeps it', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [{ token: 'token', shellPid: 101 }]));
		fixture.seedBinding('token');
		const newer: ITestBinding = { windowCtx: 'window:1', pageId: 'new-page', pageInfo: { url: '', title: '' }, generation: 2, boundAt: 2, exactView: { windowId: 1, viewId: 'new-page', targetId: 'new-target', viewLease: 'new-lease' }, scope: { kind: 'unscoped' } };
		fixture.bindings.set('token', newer);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(2, true, []));
		assert.strictEqual(fixture.faultedTokens.has('token'), true);

		// The same shell PID re-syncing must NOT lift the quarantine (would nullify the isolation).
		await fixture.service.syncBindingAuthority(connection, authorityManifest(3, true, [{ token: 'token', shellPid: 101 }]));
		assert.strictEqual(fixture.faultedTokens.has('token'), true);
		assert.strictEqual(fixture.quarantined.has(newer), true);

		// A genuinely new shell PID (the pane was reopened) is a new lifecycle: lift and reclaim capacity.
		await fixture.service.syncBindingAuthority(connection, authorityManifest(4, true, [{ token: 'token', shellPid: 202 }]));
		assert.strictEqual(fixture.faultedTokens.has('token'), false);
		assert.strictEqual(fixture.quarantined.has(newer), false);
		assert.strictEqual(fixture.quarantined.size, 0);
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
		// Only the mismatched token is quarantined; the authority is not globally faulted.
		assert.strictEqual(fixture.faultedTokens.has('token-b'), true);
		assert.strictEqual(fixture.faultedTokens.has('token-a'), false);
		assert.strictEqual(fixture.faultedTokens.has('token-c'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), false);

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
		// The preserved binding is a valid new owner (ABA), so the token is not quarantined and the
		// authority is not globally faulted.
		assert.strictEqual(fixture.faultedTokens.has('token'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), false);
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
		// Preserved valid owner: neither quarantined nor globally faulted.
		assert.strictEqual(fixture.faultedTokens.has('token'), false);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), false);
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

	test('local file arguments of the embedded DevTools tools are refused for a remote pane before reaching the bridge (upload_file reads the remote machine through the owning window instead), and forwarded for a local pane', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'remote', shellPid: 4242, remoteAuthority: 'ssh-remote+dev' },
			{ token: 'local', shellPid: 123 },
		]));
		const forwarded: { token: string; name: string; args: unknown }[] = [];
		Reflect.set(fixture.service, '_toolProviders', []);
		Reflect.set(fixture.service, '_callDevtoolsTool', async (lease: { token: string }, name: string, args: unknown) => {
			forwarded.push({ token: lease.token, name, args });
			return { content: [{ type: 'text', text: 'ok' }] };
		});
		// upload_file from the remote pane asks the owning window to read the file on the remote machine;
		// the window decides whether the path may be read (here it refuses).
		const windowCalls: unknown[] = [];
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async (method: string, args: unknown) => { windowCalls.push([method, args]); return { ok: false, reason: 'outsideAllowedFolders' }; } }),
		});
		const call = async (token: string, name: string, args: unknown) => {
			const request = new TestRequest('POST', `/?pane=${token}`);
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })));
			request.emit('end');
			await pending;
			return response.body.includes('remote window (SSH, WSL, container)') ? 'refused'
				: response.body.includes('outside the folders Para Code may use') ? 'refusedByWindow'
					: response.body.includes('"ok"') ? 'passed' : response.body;
		};
		const outcomes = {
			remoteEvaluate: await call('remote', 'evaluate_script', { function: '() => 1', filePath: '/Users/example/.zshrc' }),
			remoteUpload: await call('remote', 'upload_file', { uid: '1', filePath: '/Users/example/.ssh/id_rsa' }),
			remoteNavigateFile: await call('remote', 'navigate_page', { type: 'url', url: 'file:///etc/passwd' }),
			remoteNoPath: await call('remote', 'take_snapshot', {}),
			localPath: await call('local', 'take_snapshot', { filePath: '/repos/a/snapshot.txt' }),
		};
		assert.deepStrictEqual({ outcomes, forwarded: forwarded.map(entry => `${entry.token}:${entry.name}`), windowCalls }, {
			outcomes: { remoteEvaluate: 'refused', remoteUpload: 'refusedByWindow', remoteNavigateFile: 'refused', remoteNoPath: 'passed', localPath: 'passed' },
			forwarded: ['remote:take_snapshot', 'local:take_snapshot'],
			windowCalls: [['paradisReadRemoteFile', ['remote', 'ssh-remote+dev', '/Users/example/.ssh/id_rsa', 64 * 1024 * 1024]]],
		});
	});

	test('preview_file accepts filePath and reaches the window of a remote pane whose shell PID is not known yet', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'remote', remoteAuthority: 'ssh-remote+dev' },
		]));
		const windowCalls: unknown[] = [];
		let answer: unknown = { ok: true };
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async (method: string, args: unknown) => { windowCalls.push([method, args]); return answer; } }),
		});
		const call = async (args: unknown) => {
			const request = new TestRequest('POST', '/?pane=remote');
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preview_file', arguments: args } })));
			request.emit('end');
			await pending;
			return response.body;
		};
		const opened = await call({ filePath: '/home/example/report.html' });
		answer = { ok: false, reason: 'notFound' };
		const missing = await call({ path: '/home/example/missing.html' });
		const noPath = await call({});
		assert.deepStrictEqual({
			opened: opened.includes('Opened /home/example/report.html'),
			missing: missing.includes('the file does not exist'),
			noPath: noPath.includes('preview_file requires `path`'),
			windowCalls,
		}, {
			opened: true,
			missing: true,
			noPath: true,
			windowCalls: [
				['previewFile', ['remote', '/home/example/report.html', 'ssh-remote+dev']],
				['previewFile', ['remote', '/home/example/missing.html', 'ssh-remote+dev']],
			],
		});
	});

	test('roots for the embedded DevTools bridge come from the owning window for local panes only', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'remote', shellPid: 4242, remoteAuthority: 'ssh-remote+dev' },
			{ token: 'local', shellPid: 123 },
		]));
		let windowAnswer: () => Promise<unknown> = async () => ['/repos/a', 'relative/folder', 7];
		const windowCalls: unknown[] = [];
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async (method: string, args: unknown) => { windowCalls.push([method, args]); return windowAnswer(); } }),
		});
		const resolve = (token: string) => Reflect.get(fixture.service, '_resolveDevtoolsRoots').call(fixture.service, token) as Promise<unknown>;
		const temporary = paradisDevtoolsUserTemporaryFolders();
		const local = await resolve('local');
		windowAnswer = async () => { throw new Error('window reloading'); };
		const windowFailed = await resolve('local');
		assert.deepStrictEqual({
			remote: await resolve('remote'),
			unknown: await resolve('nobody'),
			local,
			windowFailed,
			windowCalls,
		}, {
			remote: { folders: [], complete: true },
			unknown: { folders: temporary, complete: false },
			local: { folders: ['/repos/a', ...temporary], complete: true },
			windowFailed: { folders: temporary, complete: false },
			windowCalls: [['paneRoots', ['local']], ['paneRoots', ['local']]],
		});
	});

	test('a remote pane stays remote while its manifest has no shell PID, and unknown tokens count as remote at the gateway', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'remote-reloading', remoteAuthority: 'ssh-remote+dev' },
			{ token: 'local', shellPid: 123 },
		]));
		const gatewayRemote = (token: string) => Reflect.get(fixture.service, '_isRemotePaneForGateway').call(fixture.service, token) as boolean;
		assert.deepStrictEqual({
			inShellLedger: fixture.paneShells.has('remote-reloading'),
			gateway: { remote: gatewayRemote('remote-reloading'), local: gatewayRemote('local'), unknown: gatewayRemote('nobody') },
			pathCaller: await Reflect.get(fixture.service, '_devtoolsPathCaller').call(fixture.service, 'remote-reloading', undefined),
			roots: await Reflect.get(fixture.service, '_resolveDevtoolsRoots').call(fixture.service, 'remote-reloading'),
		}, {
			inShellLedger: false,
			gateway: { remote: true, local: false, unknown: true },
			pathCaller: { paneKnown: false, remote: true },
			roots: { folders: [], complete: true },
		});
	});

	test('preview_file from a remote pane asks the window to open the path on that remote machine', async () => {
		const fixture = createFixture();
		const connection = {};
		fixture.service.registerRendererConnection('window:1', connection);
		await fixture.service.syncBindingAuthority(connection, authorityManifest(1, true, [
			{ token: 'remote', shellPid: 4242, remoteAuthority: 'ssh-remote+dev' },
			{ token: 'local', shellPid: 123 },
			{ token: 'local-reloading' },
		]));
		Reflect.set(fixture.service, '_toolProviders', []);
		const windowCalls: unknown[] = [];
		Reflect.set(fixture.service, 'ipcServer', {
			connections: [{ ctx: 'window:1' }],
			getChannel: () => ({ call: async (method: string, args: unknown) => { windowCalls.push([method, args]); return { ok: true }; } }),
		});
		const bodies: string[] = [];
		for (const token of ['remote', 'local', 'local-reloading']) {
			const request = new TestRequest('POST', `/?pane=${token}`);
			const response = new TestResponse();
			const pending = Reflect.get(fixture.service, '_handleRequest').call(fixture.service, request, response) as Promise<void>;
			request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preview_file', arguments: { path: '/home/example/notes.md' } } })));
			request.emit('end');
			await pending;
			bodies.push(response.body);
		}
		assert.deepStrictEqual({ windowCalls, unregisteredRefused: bodies[2].includes('has not registered this terminal pane yet') }, {
			windowCalls: [
				['previewFile', ['remote', '/home/example/notes.md', 'ssh-remote+dev']],
				['previewFile', ['local', '/home/example/notes.md']],
			],
			unregisteredRefused: true,
		});
	});
});
