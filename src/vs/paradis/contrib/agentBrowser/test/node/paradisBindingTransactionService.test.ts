/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisBindingTicketRequest,
	IParadisExactBrowserViewDescriptor,
	IParadisPrepareBindRequest,
} from '../../common/paradisAgentBrowser.js';
import { ParadisBindingAuthority } from '../../common/paradisBindingAuthority.js';
import { ParadisExactViewBackgroundThrottlingCoordinator } from '../../common/paradisExactViewBackgroundThrottling.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

interface IPreparedDescriptor {
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly pageInfo: { readonly url: string; readonly title: string };
}

interface ITestBinding {
	readonly windowCtx: string;
	readonly pageId: string;
	readonly pageInfo: { readonly url: string; readonly title: string };
	readonly generation: number;
	readonly boundAt: number;
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly scope: { readonly kind: 'unscoped' };
}

const exactView = Object.freeze({ windowId: 1, viewId: 'view', targetId: 'target', viewLease: 'lease' });
const prepareRequest: IParadisPrepareBindRequest = Object.freeze({
	revision: 1,
	token: 'token',
	viewId: 'view',
	pageInfo: Object.freeze({ url: 'https://example.test', title: 'Example' }),
});

function authorityManifest(revision: number): unknown {
	return {
		revision,
		complete: true,
		panes: [{ token: 'token', scope: { kind: 'unscoped' } }],
		browserViews: [{ viewId: 'view', scope: { kind: 'unscoped' } }],
	};
}

function createFixture(): {
	readonly service: ParadisAgentBrowserService;
	readonly bindings: Map<string, ITestBinding>;
	readonly quarantinedBindings: Set<ITestBinding>;
	readonly coordinator: ParadisExactViewBackgroundThrottlingCoordinator;
	readonly authority: ParadisBindingAuthority<string, object, IPreparedDescriptor, ITestBinding>;
	readonly mainCalls: { readonly command: string; readonly args: readonly unknown[] }[];
	readonly gatewayCalls: { readonly command: string; readonly token: string }[];
	setResolveExact(operation: () => Promise<IParadisExactBrowserViewDescriptor | null>): void;
	setThrottlingOperation(operation: (descriptor: IParadisExactBrowserViewDescriptor, enabled: boolean) => Promise<boolean>): void;
} {
	let ticket = 0;
	const authority = new ParadisBindingAuthority<string, object, IPreparedDescriptor, ITestBinding>({
		now: () => 0,
		createTicketId: () => `ticket-${ticket++}`,
		copyDescriptor: descriptor => Object.freeze({
			exactView: Object.freeze({ ...descriptor.exactView }),
			pageInfo: Object.freeze({ ...descriptor.pageInfo }),
		}),
	});
	const bindings = new Map<string, ITestBinding>();
	const quarantinedBindings = new Set<ITestBinding>();
	const coordinator = new ParadisExactViewBackgroundThrottlingCoordinator();
	const mainCalls: { command: string; args: readonly unknown[] }[] = [];
	const gatewayCalls: { command: string; token: string }[] = [];
	let resolveExact: () => Promise<IParadisExactBrowserViewDescriptor | null> = async () => exactView;
	let throttlingOperation = async (_descriptor: IParadisExactBrowserViewDescriptor, _enabled: boolean): Promise<boolean> => true;
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_bindings: bindings,
		_quarantinedBindings: quarantinedBindings,
		_faultedTokens: new Set<string>(),
		_quarantinedTokenState: new Map(),
		_bindingAuthority: authority,
		_backgroundThrottlingCoordinator: coordinator,
		_pendingBindPreparations: 0,
		_ingressLeaseStates: new WeakMap<object, object>(),
		_terminalExitedTokens: new Set<string>(),
		_paneShells: new Map(),
		_paneStatuses: new Map(),
		_activityApprovalTokens: new Set(),
		_agentHookTokens: new Set(),
		_seenTokens: new Set(),
		_rendererConnections: new Map<string, object>(),
		_rendererConnectionContexts: new Map<object, string>(),
		_knownRendererContexts: new Set<string>(),
		_mainLiveWindowIds: new Set<number>(),
		_hasMainRendererManifest: false,
		_rendererManifestRevision: -1,
		_authorityFaulted: false,
		_serverDisposed: false,
		_nextBindingGeneration: 0,
		_devtoolsGenerationCoordinator: {
			setGeneration: () => undefined,
			getGeneration: () => 0,
			isCurrentGeneration: () => true,
			forgetWhenIdle: () => undefined,
		},
		_cdpGateway: {
			closeConnectionsForToken: (token: string) => gatewayCalls.push({ command: 'close', token }),
			retireToken: (token: string) => gatewayCalls.push({ command: 'retire', token }),
		},
		_devtoolsProxy: { retire: () => undefined },
		mainProcessService: {
			getChannel: () => ({
				call: async (command: string, args: readonly unknown[]) => {
					mainCalls.push({ command, args });
					switch (command) {
						case 'resolveExactViewDescriptor': return resolveExact();
						case 'setExactViewBackgroundThrottling': return throttlingOperation(args[0] as IParadisExactBrowserViewDescriptor, args[1] as boolean);
						case 'captureExactViewScreenshot': return 'image-data';
						case 'isExactViewVisible': return false;
						default: throw new Error(`legacy or unexpected Main call: ${command}`);
					}
				},
			}),
		},
		logService: { trace: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
	}) as unknown as ParadisAgentBrowserService;
	return {
		service,
		bindings,
		quarantinedBindings,
		coordinator,
		authority,
		mainCalls,
		gatewayCalls,
		setResolveExact: operation => resolveExact = operation,
		setThrottlingOperation: operation => throttlingOperation = operation,
	};
}

function prepareFor(token: string): IParadisPrepareBindRequest {
	return Object.freeze({ ...prepareRequest, token });
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (check()) {
			return;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('condition did not converge');
}

async function registerReady(fixture: ReturnType<typeof createFixture>, tokens: readonly string[] = ['token']): Promise<object> {
	const connection = {};
	assert.strictEqual(fixture.service.registerRendererConnection('window:1', connection), true);
	await fixture.service.syncBindingAuthority(connection, {
		revision: 1,
		complete: true,
		panes: tokens.map(token => ({ token, scope: { kind: 'unscoped' } })),
		browserViews: [{ viewId: 'view', scope: { kind: 'unscoped' } }],
	});
	return connection;
}

suite('Paradis binding transaction service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prepares through exact Main authority and publishes only after a synchronous commit', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);

		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		assert.deepStrictEqual(prepared, {
			ticketId: 'ticket-0',
			expiresAt: 10_000,
			revision: 1,
			scope: { kind: 'unscoped' },
		});
		assert.strictEqual(fixture.bindings.size, 0);
		assert.deepStrictEqual(fixture.mainCalls, [
			{ command: 'resolveExactViewDescriptor', args: [1, 'view'] },
		]);

		const committed = await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });
		assert.deepStrictEqual(committed, {
			committed: true,
			binding: {
				token: 'token',
				pageId: 'view',
				pageInfo: { url: 'https://example.test', title: 'Example' },
				generation: 1,
				boundAt: committed.binding.boundAt,
				scope: { kind: 'unscoped' },
			},
		});
		assert.deepStrictEqual(fixture.bindings.get('token')?.exactView, exactView);
		assert.deepStrictEqual(fixture.bindings.get('token')?.scope, { kind: 'unscoped' });
		assert.deepStrictEqual(fixture.mainCalls.at(-1), {
			command: 'setExactViewBackgroundThrottling',
			args: [exactView, false],
		});
	});

	test('invalidates a delayed preparation when the Renderer connection is replaced', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		let release!: () => void;
		let started!: () => void;
		const didStart = new Promise<void>(resolve => started = resolve);
		const gate = new Promise<void>(resolve => release = resolve);
		fixture.setResolveExact(async () => { started(); await gate; return exactView; });

		const pending = fixture.service.prepareBind(connection, prepareRequest);
		await didStart;
		assert.strictEqual(fixture.service.registerRendererConnection('window:1', {}), true);
		release();

		await assert.rejects(pending, /preparation|protocol|retry/i);
		assert.strictEqual(fixture.bindings.size, 0);
	});

	test('invalidates a delayed preparation when its accepted manifest changes', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		let release!: () => void;
		let started!: () => void;
		const didStart = new Promise<void>(resolve => started = resolve);
		const gate = new Promise<void>(resolve => release = resolve);
		fixture.setResolveExact(async () => { started(); await gate; return exactView; });

		const pending = fixture.service.prepareBind(connection, prepareRequest);
		await didStart;
		await fixture.service.syncBindingAuthority(connection, authorityManifest(2));
		release();

		await assert.rejects(pending, /preparation|protocol|retry/i);
		assert.strictEqual(fixture.bindings.size, 0);
	});

	test('checks external capacity before consuming a valid ticket', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		for (let index = 0; index < 4096; index++) {
			fixture.quarantinedBindings.add({ generation: index } as ITestBinding);
		}

		await assert.rejects(
			fixture.service.commitBind(connection, { ticketId: prepared.ticketId }),
			/capacity/i,
		);
		fixture.quarantinedBindings.delete(fixture.quarantinedBindings.values().next().value!);
		const committed = await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });

		assert.strictEqual(committed.committed, true);
		assert.strictEqual(committed.binding.token, 'token');
	});

	test('rejects coordinator drift before authority consumption and latches the service fault', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		fixture.coordinator.setBinding('orphan', exactView);

		await assert.rejects(
			fixture.service.commitBind(connection, { ticketId: prepared.ticketId }),
			/protocol|state|binding/i,
		);
		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(Reflect.get(fixture.service, '_nextBindingGeneration'), 0);
		assert.strictEqual(Reflect.get(fixture.service, '_authorityFaulted'), true);

		const authority = Reflect.get(fixture.service, '_bindingAuthority') as ParadisBindingAuthority<string, object, IPreparedDescriptor, ITestBinding>;
		assert.strictEqual(authority.prepareTicketCommit(connection, prepared.ticketId).token, 'token');
	});

	test('aborts a ticket exactly once and prevents a later commit', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		const ticket: IParadisBindingTicketRequest = { ticketId: prepared.ticketId };

		assert.deepStrictEqual(await fixture.service.abortBind(connection, ticket), { aborted: true });
		assert.deepStrictEqual(await fixture.service.abortBind(connection, ticket), { aborted: true });
		await assert.rejects(fixture.service.commitBind(connection, ticket), /protocol|ticket/i);
		assert.strictEqual(fixture.bindings.size, 0);
	});

	test('uses the committed exact descriptor for target, visibility, screenshot, and unbind throttling', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });

		const ensureTarget = Reflect.get(fixture.service, '_ensureBoundTargetId').bind(fixture.service) as (token: string) => Promise<string | undefined>;
		const isVisible = Reflect.get(fixture.service, '_isBoundPageVisible').bind(fixture.service) as (token: string) => Promise<boolean>;
		const capture = Reflect.get(fixture.service, '_captureBoundPageScreenshot').bind(fixture.service) as (token: string, options: object) => Promise<string | undefined>;
		assert.strictEqual(await ensureTarget('token'), 'target');
		assert.strictEqual(await isVisible('token'), false);
		assert.strictEqual(await capture('token', { format: 'png' }), 'image-data');
		assert.strictEqual(await fixture.service.unbind(connection, 'token'), true);

		assert.deepStrictEqual(fixture.mainCalls.map(call => call.command), [
			'resolveExactViewDescriptor',
			'setExactViewBackgroundThrottling',
			'isExactViewVisible',
			'captureExactViewScreenshot',
			'setExactViewBackgroundThrottling',
		]);
		assert.deepStrictEqual(fixture.mainCalls.slice(1).map(call => call.args[0]), [exactView, exactView, exactView, exactView]);
		assert.deepStrictEqual(fixture.mainCalls.at(-1)?.args, [exactView, true]);
	});

	test('disables a new lease before restoring the old lease during an exact rebind', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const first = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: first.ticketId });
		const replacement = Object.freeze({ ...exactView, viewLease: 'replacement-lease' });
		fixture.setResolveExact(async () => replacement);
		const second = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: second.ticketId });

		assert.deepStrictEqual(fixture.mainCalls.slice(-3), [
			{ command: 'resolveExactViewDescriptor', args: [1, 'view'] },
			{ command: 'setExactViewBackgroundThrottling', args: [replacement, false] },
			{ command: 'setExactViewBackgroundThrottling', args: [exactView, true] },
		]);
		assert.deepStrictEqual(fixture.bindings.get('token')?.exactView, replacement);
	});

	test('retires a committed binding when its exact view disappears between prepare and disable', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		let settleDisable!: (result: boolean) => void;
		const pendingDisable = new Promise<boolean>(resolve => settleDisable = resolve);
		fixture.setThrottlingOperation(async (_descriptor, enabled) => enabled ? true : pendingDisable);
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);

		await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });
		fixture.gatewayCalls.length = 0;
		settleDisable(false);
		await waitFor(() => fixture.bindings.size === 0);

		assert.strictEqual(fixture.coordinator.bindingCount, 0);
		assert.deepStrictEqual(fixture.gatewayCalls, [{ command: 'close', token: 'token' }]);
		assert.strictEqual((Reflect.get(fixture.authority, 'bindingStates') as Map<string, { identity?: unknown }>).get('token')?.identity, undefined);
	});

	test('retries a rejected disable boundedly and retires only the matching current generation', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		let disableAttempts = 0;
		fixture.setThrottlingOperation(async (_descriptor, enabled) => {
			if (!enabled) {
				disableAttempts++;
				throw new Error('Main unavailable');
			}
			return true;
		});
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);

		await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });
		await waitFor(() => fixture.bindings.size === 0);

		assert.strictEqual(disableAttempts, 3);
		assert.strictEqual(fixture.coordinator.bindingCount, 0);
		assert.deepStrictEqual(fixture.gatewayCalls, [
			{ command: 'close', token: 'token' },
			{ command: 'close', token: 'token' },
		]);
	});

	test('retries a rejected restore boundedly after unbind', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		let restoreAttempts = 0;
		fixture.setThrottlingOperation(async (_descriptor, enabled) => {
			if (!enabled) {
				return true;
			}
			restoreAttempts++;
			if (restoreAttempts < 3) {
				throw new Error('Main unavailable');
			}
			return true;
		});
		const prepared = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: prepared.ticketId });

		assert.strictEqual(await fixture.service.unbind(connection, 'token'), true);
		await waitFor(() => restoreAttempts === 3);

		assert.strictEqual(fixture.bindings.size, 0);
		assert.strictEqual(fixture.coordinator.bindingCount, 0);
	});

	test('applies the latest desired state after a rebind while restore is pending', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture);
		const enabledCalls: boolean[] = [];
		let settleRestore!: (result: boolean) => void;
		const pendingRestore = new Promise<boolean>(resolve => settleRestore = resolve);
		fixture.setThrottlingOperation(async (_descriptor, enabled) => {
			enabledCalls.push(enabled);
			return enabled ? pendingRestore : true;
		});
		const first = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: first.ticketId });
		await waitFor(() => enabledCalls.length === 1);
		assert.strictEqual(await fixture.service.unbind(connection, 'token'), true);
		await waitFor(() => enabledCalls.length === 2);

		const second = await fixture.service.prepareBind(connection, prepareRequest);
		await fixture.service.commitBind(connection, { ticketId: second.ticketId });
		settleRestore(true);
		await waitFor(() => enabledCalls.length === 3);

		assert.deepStrictEqual(enabledCalls, [false, true, false]);
		assert.strictEqual(fixture.bindings.get('token')?.generation, 3);
		assert.deepStrictEqual(fixture.bindings.get('token')?.exactView, exactView);
	});

	test('retires every current token sharing a missing exact view exactly once', async () => {
		const fixture = createFixture();
		const connection = await registerReady(fixture, ['token-a', 'token-b']);
		let settleDisable!: (result: boolean) => void;
		const pendingDisable = new Promise<boolean>(resolve => settleDisable = resolve);
		fixture.setThrottlingOperation(async (_descriptor, enabled) => enabled ? true : pendingDisable);

		const first = await fixture.service.prepareBind(connection, prepareFor('token-a'));
		await fixture.service.commitBind(connection, { ticketId: first.ticketId });
		const second = await fixture.service.prepareBind(connection, prepareFor('token-b'));
		await fixture.service.commitBind(connection, { ticketId: second.ticketId });
		assert.strictEqual(fixture.bindings.size, 2);
		fixture.gatewayCalls.length = 0;
		settleDisable(false);
		await waitFor(() => fixture.bindings.size === 0);

		assert.strictEqual(fixture.coordinator.bindingCount, 0);
		assert.deepStrictEqual(fixture.gatewayCalls, [
			{ command: 'close', token: 'token-a' },
			{ command: 'close', token: 'token-b' },
		]);
	});
});
