/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX } from '../../../../../platform/browserView/common/browserViewScreenshot.js';
import { IParadisCdpScreenshotOptions } from '../../common/paradisAgentBrowser.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { IParadisBoundContext, IParadisWsModule, ParadisRawScreenshotAuthorityRegistry, ParadisRawScreenshotCoordinator, paradisClassifyCaptureScreenshotParams, paradisDispatchCaptureScreenshotRequest, paradisForceCloseRawScreenshotUpstream, paradisMapCaptureScreenshotParams, paradisProxyBrowserUpgrade, paradisProxyPageUpgrade, paradisRegisterPageUpgrade, paradisResolveCaptureScreenshotRequest, paradisStartVisibleWebPCapture, paradisVisibleWebPScreenshotLogMessage } from '../../node/paradisCdpFilterProxy.js';
import { IParadisCdpGatewayDelegate, ParadisCdpGateway, paradisPageUpgradeTargetIsCurrent } from '../../node/paradisCdpGateway.js';
import { ParadisCdpUpstream } from '../../node/paradisCdpUpstream.js';

function context(overrides: Partial<IParadisBoundContext> = {}): IParadisBoundContext {
	return {
		boundTargetIds: () => new Set(['target-1']),
		isCurrentLease: () => true,
		onOpen: () => undefined,
		rawScreenshotCoordinator: new ParadisRawScreenshotCoordinator(),
		captureBoundPageScreenshot: async () => 'delegated-image',
		isBoundPageVisible: async () => true,
		dispatchBoundPageInput: () => ({ response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() }),
		closeInputConnection: () => undefined,
		...overrides,
	};
}

suite('Paradis CDP screenshot filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	test('maps viewport capture to the delegated PNG path', () => {
		assert.deepStrictEqual(paradisMapCaptureScreenshotParams(undefined), { format: 'png' });
	});

	test('maps full-page capture and JPEG quality', () => {
		assert.deepStrictEqual(paradisMapCaptureScreenshotParams({
			format: 'jpeg',
			quality: 72,
			captureBeyondViewport: true,
		}), { format: 'jpeg', quality: 72, fullPage: true });
	});

	test('routes element document clips through delegated capture', () => {
		assert.deepStrictEqual(paradisMapCaptureScreenshotParams({
			format: 'png',
			clip: { x: 10, y: 20, width: 30, height: 40, scale: 1 },
			captureBeyondViewport: true,
		}), {
			format: 'png',
			pageRect: { x: 10, y: 20, width: 30, height: 40 },
			captureBeyondViewport: true,
		});
	});

	test('maps a viewport-relative scale-1 clip', () => {
		assert.deepStrictEqual(paradisMapCaptureScreenshotParams({
			format: 'jpeg',
			clip: { x: 1, y: 2, width: 3, height: 4, scale: 1 },
		}), {
			format: 'jpeg',
			pageRect: { x: 1, y: 2, width: 3, height: 4 },
		});
	});

	test('explicitly rejects fromSurface false and non-unit clip scale', () => {
		assert.strictEqual(paradisMapCaptureScreenshotParams({ fromSurface: false }), undefined);
		const fromSurface = paradisClassifyCaptureScreenshotParams({ fromSurface: false });
		assert.strictEqual(fromSurface.kind, 'reject');
		assert.match(fromSurface.kind === 'reject' ? fromSurface.reason : '', /fromSurface: false/);
		assert.strictEqual(paradisMapCaptureScreenshotParams({ clip: { x: 0, y: 0, width: 10, height: 10, scale: 2 } }), undefined);
		const scaled = paradisClassifyCaptureScreenshotParams({ clip: { x: 0, y: 0, width: 10, height: 10, scale: 2 } });
		assert.strictEqual(scaled.kind, 'reject');
		assert.match(scaled.kind === 'reject' ? scaled.reason : '', /scale.*1/);
	});

	test('rejects malformed clip and quality values without throwing', () => {
		for (const clip of [null, [], 1, 'clip', { x: 0, y: 0, width: 0, height: 10, scale: 1 }]) {
			const policy = paradisClassifyCaptureScreenshotParams({ clip });
			assert.strictEqual(policy.kind, 'reject');
		}
		for (const quality of [Number.NaN, -1, 10.5, 101]) {
			const policy = paradisClassifyCaptureScreenshotParams({ format: 'jpeg', quality });
			assert.strictEqual(policy.kind, 'reject');
		}
		for (const clip of [
			{ x: 0, y: 0, width: 8_193, height: 1, scale: 1 },
			{ x: 0, y: 0, width: 4_096, height: 4_097, scale: 1 },
		]) {
			const policy = paradisClassifyCaptureScreenshotParams({ clip });
			assert.strictEqual(policy.kind, 'reject');
		}
	});

	test('classifies WebP for the visibility-gated raw path', () => {
		assert.strictEqual(paradisClassifyCaptureScreenshotParams({ format: 'webp' }).kind, 'raw-webp');
	});

	test('returns a delegated response with the original id and sessionId', async () => {
		let captured: IParadisCdpScreenshotOptions | undefined;
		const result = await paradisResolveCaptureScreenshotRequest({
			id: 17,
			sessionId: 'session-1',
			params: { format: 'png' },
		}, context({
			captureBoundPageScreenshot: async options => {
				captured = options;
				return 'delegated-image';
			}
		}));

		assert.deepStrictEqual(captured, { format: 'png' });
		assert.deepStrictEqual(result, {
			kind: 'respond',
			response: { id: 17, sessionId: 'session-1', result: { data: 'delegated-image' } },
		});
	});

	test('never falls back to raw CDP when delegated capture is empty or fails', async () => {
		for (const captureBoundPageScreenshot of [
			async () => undefined,
			async () => { throw new Error('transparent image'); },
		]) {
			const result = await paradisResolveCaptureScreenshotRequest({ id: 1, params: { format: 'png' } }, context({ captureBoundPageScreenshot }));
			assert.strictEqual(result.kind, 'respond');
			assert.match(result.kind === 'respond' ? result.response.error?.message ?? '' : '', /PARA_BROWSER_RETRYABLE/);
		}
	});

	test('preserves an encoded-size failure as an explicit non-retryable screenshot error', async () => {
		const message = `${BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX} encoded image exceeds the transport budget`;
		const result = await paradisResolveCaptureScreenshotRequest(
			{ id: 1, params: { format: 'png' } },
			context({ captureBoundPageScreenshot: async () => { throw new Error(message); } }),
		);
		assert.strictEqual(result.kind, 'respond');
		assert.strictEqual(result.kind === 'respond' ? result.response.error?.message : undefined, message);
		assert.doesNotMatch(result.kind === 'respond' ? result.response.error?.message ?? '' : '', /PARA_BROWSER_RETRYABLE/);
	});

	test('forwards WebP only while the bound page is visible', async () => {
		let captureCalls = 0;
		const visibleResult = await paradisResolveCaptureScreenshotRequest({ id: 1, params: { format: 'webp' } }, context({
			captureBoundPageScreenshot: async () => { captureCalls++; return 'unexpected'; },
			isBoundPageVisible: async () => true,
		}));
		assert.deepStrictEqual(visibleResult, { kind: 'forward' });
		assert.strictEqual(captureCalls, 0);

		const hiddenResult = await paradisResolveCaptureScreenshotRequest({ id: 2, params: { format: 'webp' } }, context({
			isBoundPageVisible: async () => false,
		}));
		assert.strictEqual(hiddenResult.kind, 'respond');
		assert.match(hiddenResult.kind === 'respond' ? hiddenResult.response.error?.message ?? '' : '', /PNG or JPEG/);
	});

	test('does not forward WebP if visibility lookup races a rebind', async () => {
		const result = await paradisResolveCaptureScreenshotRequest({ id: 1, params: { format: 'webp' } }, context({
			isBoundPageVisible: async () => { throw new Error('PARA_BROWSER_RETRYABLE: binding changed'); },
		}));
		assert.strictEqual(result.kind, 'respond');
		assert.match(result.kind === 'respond' ? result.response.error?.message ?? '' : '', /PARA_BROWSER_RETRYABLE/);
	});

	test('suppresses a delayed delegated response after the connection closes', async () => {
		let resolveCapture!: (value: string | undefined) => void;
		const capture = new Promise<string | undefined>(resolve => resolveCapture = resolve);
		let active = true;
		const forwarded: unknown[] = [];
		const responses: unknown[] = [];
		const dispatch = paradisDispatchCaptureScreenshotRequest(
			{ id: 9, sessionId: 'session-9', params: { format: 'png' } },
			context({ captureBoundPageScreenshot: () => capture }),
			{
				isActive: () => active,
				forward: request => forwarded.push(request),
				respond: response => responses.push(response),
			},
		);
		active = false;
		resolveCapture('late-image');
		await dispatch;
		assert.deepStrictEqual(forwarded, []);
		assert.deepStrictEqual(responses, []);
	});

	test('settles an empty delegated request exactly once as an error without raw forwarding', async () => {
		const forwarded: unknown[] = [];
		const responses: Array<{ error?: { message?: string } }> = [];
		await paradisDispatchCaptureScreenshotRequest(
			{ id: 10, params: { format: 'png' } },
			context({ captureBoundPageScreenshot: async () => undefined }),
			{
				isActive: () => true,
				forward: request => forwarded.push(request),
				respond: response => responses.push(response),
			},
		);
		assert.deepStrictEqual(forwarded, []);
		assert.strictEqual(responses.length, 1);
		assert.match(responses[0].error?.message ?? '', /PARA_BROWSER_RETRYABLE/);
	});

	test('does not reject when a closing transport throws while settling', async () => {
		await assert.doesNotReject(paradisDispatchCaptureScreenshotRequest(
			{ id: 11, params: { format: 'png' } },
			context(),
			{
				isActive: () => true,
				forward: () => undefined,
				respond: () => { throw new Error('socket closed'); },
			},
		));
		await assert.doesNotReject(paradisDispatchCaptureScreenshotRequest(
			{ id: 12, params: { format: 'webp' } },
			context(),
			{
				isActive: () => true,
				forward: () => { throw new Error('socket closed'); },
				respond: () => undefined,
			},
		));
		await assert.doesNotReject(paradisDispatchCaptureScreenshotRequest(
			{ id: 13, params: { format: 'png' } },
			context(),
			{
				isActive: () => { throw new Error('binding disposed'); },
				forward: () => undefined,
				respond: () => undefined,
			},
		));
	});

	test('discards a screenshot result when the binding generation changes during main-process capture', async () => {
		let resolveCapture!: (value: string | null) => void;
		const capture = new Promise<string | null>(resolve => resolveCapture = resolve);
		const fixture = createScreenshotServiceFixture(() => capture);
		const request = fixture.capture('token', { format: 'png' });
		fixture.rebind();
		resolveCapture('stale-image');

		await assert.rejects(request, /PARA_BROWSER_RETRYABLE: the browser binding changed/);
	});

	test('discards visibility when the binding generation changes during main-process lookup', async () => {
		let resolveVisibility!: (value: boolean | null) => void;
		const visibility = new Promise<boolean | null>(resolve => resolveVisibility = resolve);
		const fixture = createScreenshotServiceFixture(() => visibility);
		const request = fixture.visible('token');
		fixture.rebind();
		resolveVisibility(true);

		await assert.rejects(request, /PARA_BROWSER_RETRYABLE: the browser binding changed/);
	});

	test('logs delegated screenshot lifecycle without leaking pane tokens or raw channel errors', async () => {
		const success = createScreenshotServiceFixture(async () => 'image');
		assert.strictEqual(await success.capture('token', { format: 'png' }), 'image');
		assert.strictEqual(success.traces.length, 2);
		assert.match(success.traces[0], /screenshot start .*generation=1 .*page=page-1 .*route=viewport/);
		assert.match(success.traces[1], /screenshot complete .*durationMs=/);
		assert.strictEqual(success.traces.some(message => message.includes('pane=token')), false);

		const failure = createScreenshotServiceFixture(async () => { throw new Error('https://secret.example/private'); });
		await assert.rejects(failure.capture('token', { format: 'png' }), /PARA_BROWSER_RETRYABLE/);
		assert.strictEqual(failure.warnings.length, 1);
		assert.match(failure.warnings[0], /reason=channel-error/);
		assert.strictEqual(failure.warnings[0].includes('secret.example'), false);
	});

	test('preserves a non-retryable encoded-size error through the Main channel boundary', async () => {
		const message = `${BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX} encoded image exceeds the transport budget`;
		const fixture = createScreenshotServiceFixture(async () => { throw new Error(message); });
		await assert.rejects(fixture.capture('token', { format: 'png' }), error => error instanceof Error && error.message === message);
		assert.strictEqual(fixture.warnings.length, 1);
		assert.match(fixture.warnings[0], /reason=encoded-size/);
	});

	test('returns only the target fixed by the committed exact descriptor without a Main lookup', async () => {
		type TargetServiceInternals = { _ensureBoundTargetId(token: string): Promise<string | undefined> };
		const original = {
			pageId: 'page-old',
			generation: 1,
			exactView: { windowId: 1, viewId: 'page-old', targetId: 'target-old', viewLease: 'lease-old' },
		};
		const bindings = new Map<string, object>([['token', original]]);
		const ingressLease = Object.freeze({ token: 'token' });
		let mainCalls = 0;
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_bindings: bindings,
			captureIngressLease: (token: string) => token === ingressLease.token ? ingressLease : undefined,
			isIngressLeaseCurrent: (lease: unknown) => lease === ingressLease,
			mainProcessService: { getChannel: () => ({ call: () => { mainCalls++; throw new Error('unexpected'); } }) },
			logService: { warn: () => undefined },
		}) as unknown as TargetServiceInternals;

		assert.strictEqual(await service._ensureBoundTargetId('token'), 'target-old');
		assert.strictEqual(mainCalls, 0);
	});

	test('authorizes a page upgrade only when requested, resolved, and current target ids still match', () => {
		assert.strictEqual(paradisPageUpgradeTargetIsCurrent('target-1', 'target-1', 'target-1'), true);
		assert.strictEqual(paradisPageUpgradeTargetIsCurrent('target-1', 'target-1', undefined), false);
		assert.strictEqual(paradisPageUpgradeTargetIsCurrent('target-1', 'target-1', 'target-2'), false);
		assert.strictEqual(paradisPageUpgradeTargetIsCurrent('target-1', 'target-2', 'target-2'), false);
	});

	test('browser upgrade uses the port paired with its refreshed version response', async () => {
		const fixture = createGatewayUpgradeFixture('/devtools/browser/stored?pane=pane-token');
		try {
			await fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			assert.strictEqual(fixture.resolvePortCalls(), 0);
			assert.deepStrictEqual(fixture.fetchPaths, ['/json/version']);
			assert.deepStrictEqual(fixture.upstreamUrls(), ['ws://127.0.0.1:41002/devtools/browser/live']);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('stored page upgrade health-refreshes and opens the successful current port', async () => {
		const fixture = createGatewayUpgradeFixture('/devtools/page/target-1?pane=pane-token');
		try {
			await fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
			assert.strictEqual(fixture.resolvePortCalls(), 0);
			assert.deepStrictEqual(fixture.fetchPaths, ['/json/version']);
			assert.deepStrictEqual(fixture.upstreamUrls(), ['ws://127.0.0.1:41002/devtools/page/target-1']);
		} finally {
			fixture.gateway.dispose();
		}
	});

	test('page and browser upgrades reject a generation revoked during the health check', async () => {
		for (const url of [
			'/devtools/page/target-1?pane=pane-token',
			'/devtools/browser/stored?pane=pane-token',
		]) {
			let notifyFetchStarted!: () => void;
			const fetchStarted = new Promise<void>(resolve => notifyFetchStarted = resolve);
			let finishFetch!: () => void;
			const fetchGate = new Promise<void>(resolve => finishFetch = resolve);
			const fixture = createGatewayUpgradeFixture(url, async path => {
				fixture.fetchPaths.push(path);
				notifyFetchStarted();
				await fetchGate;
				return {
					value: { webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' },
					port: 41002,
				};
			});
			try {
				const upgrade = fixture.gateway.handleUpgrade(fixture.request, fixture.socket, Buffer.alloc(0));
				await fetchStarted;
				fixture.gateway.closeConnectionsForToken('pane-token');
				finishFetch();
				await upgrade;

				assert.deepStrictEqual(fixture.upstreamUrls(), []);
				assert.strictEqual(fixture.destroyCalls(), 1);
			} finally {
				finishFetch();
				fixture.gateway.dispose();
			}
		}
	});

	test('rechecks a page binding after connection registration before creating its upstream', () => {
		let targetId = 'target-old';
		let upstreamCreated = false;
		let closed = false;
		const clientWs = { close: () => { closed = true; } };
		const result = paradisRegisterPageUpgrade(
			'target-old',
			clientWs as never,
			context({
				onOpen: () => { targetId = 'target-new'; },
				boundTargetIds: () => new Set([targetId]),
			}),
			() => { upstreamCreated = true; return 'upstream'; },
		);

		assert.strictEqual(result, undefined);
		assert.strictEqual(upstreamCreated, false);
		assert.strictEqual(closed, true);
	});

	test('gateway revokes a connection lease synchronously before WebSocket close completes', () => {
		const ingressLease = Object.freeze({ token: 'pane-token' });
		const delegate: IParadisCdpGatewayDelegate = {
			captureIngressLease: token => token === ingressLease.token ? ingressLease : undefined,
			isIngressLeaseCurrent: lease => lease === ingressLease,
			getBoundTargetId: () => 'target-1',
			ensureBoundTargetId: async () => 'target-1',
			getTokenForShellPid: () => undefined,
			captureBoundPageScreenshot: async () => 'image',
			isBoundPageVisible: async () => true,
			dispatchBoundPageInput: () => ({ response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() }),
			closeInputConnection: () => undefined,
		};
		const gateway = new ParadisCdpGateway(delegate, {} as ParadisCdpUpstream, { debug: () => undefined } as never);
		const internals = gateway as unknown as {
			_makeContext(access: { token: string; lease: typeof ingressLease }): IParadisBoundContext;
			_connectionsByToken: Map<string, Set<unknown>>;
		};
		const ctx = internals._makeContext({ token: 'pane-token', lease: ingressLease });
		const connection = new TestWebSocket();
		ctx.onOpen(connection as never);

		assert.strictEqual(ctx.isCurrentLease(), true);
		gateway.closeConnectionsForToken('pane-token');
		assert.strictEqual(ctx.isCurrentLease(), false);
		assert.strictEqual(connection.closeCalls, 1);
		const lateConnection = new TestWebSocket();
		ctx.onOpen(lateConnection as never);
		assert.strictEqual(lateConnection.closeCalls, 1);
		assert.strictEqual(internals._connectionsByToken.has('pane-token'), true);
		connection.emit('close');
		assert.strictEqual(internals._connectionsByToken.has('pane-token'), false);
		gateway.dispose();
	});

	test('page proxy never flushes a buffered command after its connection lease is revoked', () => {
		let current = true;
		const fixture = createProxyFixture(context({ isCurrentLease: () => current }));
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Runtime.evaluate' })));
		current = false;
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');

		assert.deepStrictEqual(fixture.upstream.sent, []);
		assert.strictEqual(fixture.client.closeCalls, 1);
	});

	test('page proxy forwards every frame as a text WebSocket frame (never binary)', () => {
		const fixture = createProxyFixture(context());
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);

		// Buffered while CONNECTING, flushed on open.
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } })));
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		// Forwarded directly while OPEN.
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '2' } })));
		// Upstream response forwarded back to the client.
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 1, result: {} })));

		assert.strictEqual(fixture.upstream.sent.length, 2);
		assert.strictEqual(fixture.client.sent.length, 1);
		assert.ok([...fixture.upstream.sentOptions, ...fixture.client.sentOptions].every(options => options?.binary === false));
	});

	test('browser proxy closes the connection when the bound target is force-detached upstream', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		publishAllowedSession(fixture, 'primary-session');
		fixture.client.sent.length = 0;
		fixture.client.sentOptions.length = 0;

		// The upstream detaches the bound target's session; the event must reach the client and close the transport.
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.detachedFromTarget',
			params: { sessionId: 'primary-session' },
		})));

		const detach = parseSent(fixture.client).find(message => (message as { method?: string }).method === 'Target.detachedFromTarget');
		assert.ok(detach, 'detach event was forwarded to the client');
		assert.ok(fixture.client.closeCalls >= 1, 'connection was closed so the child reconnects');
	});

	test('browser proxy does not close on detach of an out-of-scope (non-bound) target', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		// A child session attached under the bound target, then detached: not the bound target itself.
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.attachedToTarget',
			params: { sessionId: 'child-session', targetInfo: { targetId: 'child-target', type: 'iframe', openerId: 'target-1' } },
		})));
		fixture.client.sent.length = 0;
		fixture.client.sentOptions.length = 0;

		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.detachedFromTarget',
			params: { sessionId: 'child-session' },
		})));

		const detach = parseSent(fixture.client).find(message => (message as { method?: string }).method === 'Target.detachedFromTarget');
		assert.ok(detach, 'detach event was forwarded to the client');
		assert.strictEqual(fixture.client.closeCalls, 0, 'the shared connection stays open for out-of-scope churn');
	});

	test('browser proxy rejects all new client commands after its connection lease is revoked', async () => {
		let current = true;
		const fixture = createProxyFixture(context({ isCurrentLease: () => current }));
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		current = false;
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Target.getTargets' })));

		assert.deepStrictEqual(fixture.upstream.sent, []);
		assert.strictEqual(fixture.client.closeCalls, 1);
	});

	test('browser proxy fail-closes every command with an invalid request id before upstream access', async () => {
		const commands: ReadonlyArray<{ readonly method: string; readonly params?: Record<string, unknown> }> = [
			{ method: 'Browser.getVersion' },
			{ method: 'Target.getTargets' },
			{ method: 'Target.createTarget', params: { url: 'https://example.test' } },
			{ method: 'Target.attachToTarget', params: { targetId: 'target-1', flatten: true } },
			{ method: 'Target.activateTarget', params: { targetId: 'target-1' } },
			{ method: 'Target.detachFromTarget', params: { sessionId: 'session-1' } },
			{ method: 'Target.getTargetInfo', params: { targetId: 'target-1' } },
		];
		const invalidIds: readonly unknown[] = ['1', undefined, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
		for (const command of commands) {
			for (const invalidId of invalidIds) {
				const fixture = await createOpenBrowserProxyFixture();
				const frame = invalidId === undefined ? command : { id: invalidId, ...command };
				fixture.client.emit('message', Buffer.from(JSON.stringify(frame)));
				assert.deepStrictEqual(fixture.upstream.sent, [], `${command.method} accepted id=${String(invalidId)}`);
				assert.strictEqual(fixture.client.closeCalls, 1, `${command.method} did not close for id=${String(invalidId)}`);
			}
		}
	});

	test('browser proxy fail-closes invalid JSON and non-command records', async () => {
		const frames = [
			'not-json',
			'null',
			'[]',
			'"text"',
			JSON.stringify({ id: 1 }),
			JSON.stringify({ id: 1, method: 'Browser.getVersion', params: [] }),
		];
		for (const frame of frames) {
			const fixture = await createOpenBrowserProxyFixture();
			fixture.client.emit('message', Buffer.from(frame));
			assert.deepStrictEqual(fixture.upstream.sent, []);
			assert.strictEqual(fixture.client.closeCalls, 1, `frame did not fail closed: ${frame}`);
		}
	});

	test('browser proxy closes on an in-flight duplicate client id without replacing the first policy', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 7, method: 'Target.getTargets' })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 7, method: 'Browser.getVersion' })));

		assert.deepStrictEqual(parseSent(fixture.upstream), [{ id: 7, method: 'Target.getTargets' }]);
		assert.strictEqual(fixture.client.closeCalls, 1);
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			id: 7,
			result: { targetInfos: [{ targetId: 'target-1' }, { targetId: 'secret-target', title: 'private' }] },
		})));
		assert.deepStrictEqual(fixture.client.sent, []);
	});

	test('browser proxy closes on unknown duplicate and late upstream response ids', async () => {
		const unknown = await createOpenBrowserProxyFixture();
		unknown.upstream.emit('message', Buffer.from(JSON.stringify({ id: 999, result: { secret: 'private' } })));
		assert.deepStrictEqual(unknown.client.sent, []);
		assert.strictEqual(unknown.client.closeCalls, 1);

		const duplicate = await createOpenBrowserProxyFixture();
		duplicate.client.emit('message', Buffer.from(JSON.stringify({ id: 8, method: 'Browser.getVersion' })));
		duplicate.upstream.emit('message', Buffer.from(JSON.stringify({ id: 8, result: { product: 'Chrome/1' } })));
		duplicate.upstream.emit('message', Buffer.from(JSON.stringify({ id: 8, result: { secret: 'late-private' } })));
		assert.deepStrictEqual(parseSent(duplicate.client), [{ id: 8, result: { product: 'Chrome/1' } }]);
		assert.strictEqual(duplicate.client.closeCalls, 1);
	});

	test('browser proxy requires an exact response session for every client request', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		publishAllowedSession(fixture, 'session-1');
		fixture.client.sent.length = 0;
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 9, sessionId: 'session-1', method: 'Runtime.evaluate', params: { expression: '1' } })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 9, result: { value: 'wrong-route' } })));

		assert.deepStrictEqual(fixture.client.sent, []);
		assert.strictEqual(fixture.client.closeCalls, 1);
	});

	test('browser proxy isolates negative internal ids from client ids and suppresses internal responses', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		const clientId = 0x7fff0001;
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: clientId, method: 'Browser.getVersion' })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.targetCreated',
			params: { targetInfo: { targetId: 'target-1', type: 'page', attached: false } },
		})));
		const upstreamFrames = parseSent(fixture.upstream) as Array<{ id?: number; method?: string }>;
		const internal = upstreamFrames.find(frame => frame.method === 'Target.attachToTarget');
		assert.ok(internal);
		assert.strictEqual(typeof internal.id, 'number');
		assert.ok((internal.id as number) < 0);
		assert.notStrictEqual(internal.id, clientId);

		fixture.client.sent.length = 0;
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: clientId, result: { product: 'Chrome/1' } })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: internal.id, result: { sessionId: 'internal-session' } })));
		assert.deepStrictEqual(parseSent(fixture.client), [{ id: clientId, result: { product: 'Chrome/1' } }]);

		fixture.client.sent.length = 0;
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.attachedToTarget',
			params: { sessionId: 'outside-session', targetInfo: { targetId: 'outside-target', type: 'page' } },
		})));
		const sessionInternal = (parseSent(fixture.upstream) as Array<{ id?: number; method?: string; sessionId?: string }>).filter(frame => frame.id !== undefined && frame.id < 0 && frame.id !== internal.id);
		assert.strictEqual(sessionInternal.length, 2);
		for (const frame of sessionInternal) {
			fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: frame.id, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}), result: {} })));
		}
		assert.deepStrictEqual(fixture.client.sent, []);
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: internal.id, result: {} })));
		assert.strictEqual(fixture.client.closeCalls, 1);
	});

	test('browser root exposes only the Puppeteer-safe initialization surface', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Target.getBrowserContexts' })));
		assert.deepStrictEqual(parseSent(fixture.client), [{ id: 1, result: { browserContextIds: [] } }]);
		assert.deepStrictEqual(fixture.upstream.sent, []);

		for (const frame of [
			{ id: 2, method: 'Target.setDiscoverTargets', params: { discover: true, filter: [{ type: 'page' }] } },
			{ id: 3, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: 'page' }] } },
			{ id: 4, method: 'Browser.getVersion' },
		]) {
			fixture.client.emit('message', Buffer.from(JSON.stringify(frame)));
		}
		const upstream = parseSent(fixture.upstream) as Array<{ id: number; method: string; params?: Record<string, unknown> }>;
		assert.deepStrictEqual(upstream.map(frame => [frame.id, frame.method]), [
			[2, 'Target.setDiscoverTargets'],
			[3, 'Target.setAutoAttach'],
			[4, 'Browser.getVersion'],
		]);
		assert.strictEqual(Object.hasOwn(upstream[0].params ?? {}, 'filter'), false);
		assert.strictEqual(Object.hasOwn(upstream[1].params ?? {}, 'filter'), false);
	});

	test('browser root preserves scoped target discovery attach and detach commands', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Target.getTargets' })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			id: 1,
			result: { targetInfos: [{ targetId: 'target-1', type: 'webview' }, { targetId: 'private-target', type: 'page' }] },
		})));
		assert.deepStrictEqual(parseSent(fixture.client), [{ id: 1, result: { targetInfos: [{ targetId: 'target-1', type: 'page' }] } }]);

		fixture.client.sent.length = 0;
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Target.getTargetInfo', params: { targetId: 'target-1' } })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 2, result: { targetInfo: { targetId: 'target-1', type: 'webview' } } })));
		assert.deepStrictEqual(parseSent(fixture.client), [{ id: 2, result: { targetInfo: { targetId: 'target-1', type: 'page' } } }]);

		fixture.client.sent.length = 0;
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 3, method: 'Target.attachToTarget', params: { targetId: 'target-1', flatten: true } })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 3, result: { sessionId: 'session-1' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 4, method: 'Target.detachFromTarget', params: { sessionId: 'session-1' } })));

		assert.deepStrictEqual(parseSent(fixture.client), [{ id: 3, result: { sessionId: 'session-1' } }]);
		assert.deepStrictEqual((parseSent(fixture.upstream) as Array<{ id?: number; method?: string }>).slice(-1).map(frame => [frame.id, frame.method]), [
			[4, 'Target.detachFromTarget'],
		]);
	});

	test('browser session preserves only filtered auto-attach setup for nested targets', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		publishAllowedSession(fixture, 'session-1');
		fixture.client.sent.length = 0;
		fixture.upstream.sent.length = 0;
		fixture.client.emit('message', Buffer.from(JSON.stringify({
			id: 1,
			sessionId: 'session-1',
			method: 'Target.setAutoAttach',
			params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: 'page' }] },
		})));

		const upstream = parseSent(fixture.upstream) as Array<{ id: number; sessionId?: string; method: string; params?: Record<string, unknown> }>;
		assert.deepStrictEqual(upstream.map(frame => [frame.id, frame.sessionId, frame.method]), [[1, 'session-1', 'Target.setAutoAttach']]);
		assert.strictEqual(Object.hasOwn(upstream[0].params ?? {}, 'filter'), false);
	});

	test('browser root rejects global and target lifecycle methods outside its allowlist', async () => {
		const deniedMethods = [
			'Target.createTarget',
			'Target.closeTarget',
			'Target.activateTarget',
			'Target.createBrowserContext',
			'Target.disposeBrowserContext',
			'Target.setRemoteLocations',
			'Target.exposeDevToolsProtocol',
			'Target.openDevTools',
			'Target.sendMessageToTarget',
			'Storage.getCookies',
			'Storage.setCookies',
			'Storage.getUsageAndQuota',
			'Storage.deleteStorageBucket',
			'CacheStorage.deleteCache',
			'IndexedDB.deleteDatabase',
			'DOMStorage.removeDOMStorageItem',
			'ServiceWorker.stopWorker',
			'Browser.grantPermissions',
			'Browser.setPermission',
			'Browser.resetPermissions',
			'Browser.setDownloadBehavior',
			'Browser.getBrowserCommandLine',
			'Network.getAllCookies',
			'Network.setCookie',
			'Network.setCookies',
			'Network.deleteCookies',
			'Runtime.evaluate',
		];
		const fixture = await createOpenBrowserProxyFixture();
		for (let index = 0; index < deniedMethods.length; index++) {
			fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 100 + index, method: deniedMethods[index], params: { targetId: 'target-1' } })));
		}
		assert.deepStrictEqual(fixture.upstream.sent, []);
		const responses = parseSent(fixture.client) as Array<{ id: number; error?: unknown }>;
		assert.deepStrictEqual(responses.map(response => response.id), deniedMethods.map((_method, index) => 100 + index));
		assert.ok(responses.every(response => response.error !== undefined));
	});

	test('page and browser-session routes reject shared cookies permissions downloads and global security', async () => {
		const deniedMethods = [
			'Storage.getCookies',
			'Storage.setCookies',
			'Storage.getUsageAndQuota',
			'Storage.deleteStorageBucket',
			'CacheStorage.deleteCache',
			'IndexedDB.deleteDatabase',
			'DOMStorage.removeDOMStorageItem',
			'ServiceWorker.stopWorker',
			'Network.getAllCookies',
			'Network.getCookies',
			'Network.setCookie',
			'Network.setCookies',
			'Network.deleteCookies',
			'Browser.grantPermissions',
			'Browser.setPermission',
			'Browser.resetPermissions',
			'Browser.setDownloadBehavior',
			'Browser.getBrowserCommandLine',
			'Page.setDownloadBehavior',
			'Security.setIgnoreCertificateErrors',
			'Target.createTarget',
			'Target.activateTarget',
			'Target.createBrowserContext',
			'Target.disposeBrowserContext',
			'Target.setRemoteLocations',
			'Target.exposeDevToolsProtocol',
			'Target.openDevTools',
			'Target.setDiscoverTargets',
			'Target.getBrowserContexts',
			'Target.getTargets',
			'Target.sendMessageToTarget',
		];

		for (const method of deniedMethods) {
			const page = createProxyFixture(context());
			paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), page.ws, page.wss, 41001, 'target-1', page.ctx, page.logService);
			page.upstream.readyState = TestWebSocket.OPEN;
			page.upstream.emit('open');
			page.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method, params: { urls: ['https://private.example'] } })));
			assert.deepStrictEqual(page.upstream.sent, [], `page forwarded ${method}`);
			assert.strictEqual((parseSent(page.client)[0] as { error?: unknown } | undefined)?.error !== undefined, true);

			const browser = await createOpenBrowserProxyFixture();
			publishAllowedSession(browser, 'session-1');
			browser.client.sent.length = 0;
			browser.upstream.sent.length = 0;
			browser.client.emit('message', Buffer.from(JSON.stringify({
				id: 1, sessionId: 'session-1', method, params: {
					urls: ['https://private.example'],
					targetId: 'target-1',
					sessionId: 'session-1',
					message: JSON.stringify({ id: 99, method: 'Storage.getCookies' }),
				}
			})));
			assert.deepStrictEqual(browser.upstream.sent, [], `session forwarded ${method}`);
			assert.strictEqual((parseSent(browser.client)[0] as { error?: unknown } | undefined)?.error !== undefined, true);
		}
	});

	test('browser root bounds in-flight requests and its pre-open buffer under ten thousand frames', async () => {
		const fixture = createProxyFixture(context());
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		for (let id = 0; id < 10_000; id++) {
			fixture.client.emit('message', Buffer.from(JSON.stringify({ id, method: 'Browser.getVersion' })));
		}
		assert.ok(fixture.client.closeCalls >= 1);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		assert.ok(fixture.upstream.sent.length <= 1_024);
	});

	test('rejects oversized client frames and bounded CDP identifiers before forwarding', async () => {
		for (const frame of [
			Buffer.alloc(1024 * 1024 + 1, 0x20),
			Buffer.from(JSON.stringify({ id: 1, method: 'X'.repeat(257) })),
			Buffer.from(JSON.stringify({ id: 1, method: 'Browser.getVersion', sessionId: 's'.repeat(513) })),
		]) {
			const fixture = await createOpenBrowserProxyFixture();
			fixture.client.emit('message', frame);
			assert.ok(fixture.client.closeCalls >= 1);
			assert.deepStrictEqual(fixture.upstream.sent, []);
		}
	});

	test('bounds the connecting queue by aggregate encoded bytes', async () => {
		const fixture = createProxyFixture(context());
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		const payload = 'x'.repeat(900_000);
		for (let id = 0; id < 8; id++) {
			fixture.client.emit('message', Buffer.from(JSON.stringify({ id, method: 'Browser.getVersion', params: { payload } })));
		}
		assert.ok(fixture.client.closeCalls >= 1);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		assert.ok(fixture.upstream.sent.length <= 4);
	});

	test('fail-closes OPEN transports when either direction exceeds buffered backpressure', async () => {
		const upstreamBlocked = await createOpenBrowserProxyFixture();
		upstreamBlocked.upstream.bufferedAmount = 4 * 1024 * 1024;
		upstreamBlocked.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
		assert.ok(upstreamBlocked.client.closeCalls >= 1);
		assert.deepStrictEqual(upstreamBlocked.upstream.sent, []);

		const clientBlocked = await createOpenBrowserProxyFixture();
		clientBlocked.client.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Browser.getVersion' })));
		clientBlocked.client.bufferedAmount = 4 * 1024 * 1024;
		clientBlocked.upstream.emit('message', Buffer.from(JSON.stringify({ id: 2, result: { product: 'Chrome/1' } })));
		assert.ok(clientBlocked.client.closeCalls >= 1);
	});

	test('bounds target registries and permits repeated create-destroy retirement', async () => {
		const bounded = await createOpenBrowserProxyFixture();
		for (let index = 0; index < 5_000 && bounded.client.closeCalls === 0; index++) {
			bounded.upstream.emit('message', Buffer.from(JSON.stringify({
				method: 'Target.targetCreated',
				params: { targetInfo: { targetId: `child-${index}`, openerId: 'target-1', type: 'page', attached: true } },
			})));
		}
		assert.ok(bounded.client.closeCalls >= 1);

		const retired = await createOpenBrowserProxyFixture();
		for (let index = 0; index < 5_000; index++) {
			const targetId = `retired-${index}`;
			retired.upstream.emit('message', Buffer.from(JSON.stringify({
				method: 'Target.targetCreated',
				params: { targetInfo: { targetId, openerId: 'target-1', type: 'page', attached: true } },
			})));
			retired.upstream.emit('message', Buffer.from(JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId } })));
		}
		assert.strictEqual(retired.client.closeCalls, 0);
	});

	test('rejects oversized ordinary upstream frames but permits a bounded raw screenshot response', async () => {
		const ordinary = await createOpenBrowserProxyFixture();
		ordinary.upstream.emit('message', Buffer.alloc(1024 * 1024 + 1, 0x20));
		assert.ok(ordinary.client.closeCalls >= 1);

		const screenshot = createProxyFixture(context());
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), screenshot.ws, screenshot.wss, 41001, 'target-1', screenshot.ctx, screenshot.logService);
		screenshot.upstream.readyState = TestWebSocket.OPEN;
		screenshot.upstream.emit('open');
		screenshot.client.emit('message', Buffer.from(JSON.stringify({ id: 7, method: 'Page.captureScreenshot', params: { format: 'webp' } })));
		await Promise.resolve();
		await Promise.resolve();
		const frame = Buffer.from(JSON.stringify({ id: 7, result: { data: 'x'.repeat(2 * 1024 * 1024) } }));
		screenshot.upstream.emit('message', frame);
		assert.strictEqual(screenshot.client.closeCalls, 0);
		assert.ok(screenshot.client.sent.length >= 1);
	});

	test('transport cleanup survives a throwing diagnostic logger', async () => {
		const fixture = createProxyFixture(context());
		const throwingLog = {
			trace: () => { throw new Error('logger unavailable'); },
			debug: () => { throw new Error('logger unavailable'); },
			warn: () => { throw new Error('logger unavailable'); },
		} as never;
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, throwingLog);
		assert.doesNotThrow(() => fixture.upstream.emit('error', new Error('private upstream URL')));
		assert.ok(fixture.client.closeCalls >= 1);
	});

	test('browser root bounds internal requests under ten thousand target events', async () => {
		const fixture = await createOpenBrowserProxyFixture();
		for (let index = 0; index < 10_000; index++) {
			fixture.upstream.emit('message', Buffer.from(JSON.stringify({
				method: 'Target.targetCreated',
				params: { targetInfo: { targetId: 'target-1', type: 'page', attached: false } },
			})));
		}
		assert.ok(fixture.client.closeCalls >= 1);
		assert.ok(fixture.upstream.sent.length <= 1_024);
	});

	test('page proxy suppresses a delegated screenshot response completed after lease revocation', async () => {
		let current = true;
		let resolveCapture!: (value: string | undefined) => void;
		const capture = new Promise<string | undefined>(resolve => resolveCapture = resolve);
		const fixture = createProxyFixture(context({
			isCurrentLease: () => current,
			captureBoundPageScreenshot: () => capture,
		}));
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 3, method: 'Page.captureScreenshot', params: { format: 'png' } })));
		current = false;
		resolveCapture('stale-image');
		await capture;
		await Promise.resolve();

		assert.deepStrictEqual(fixture.client.sent, []);
		assert.deepStrictEqual(fixture.upstream.sent, []);
	});

	test('holds timed-out raw WebP authority until its matching response settles', async () => {
		const responses: Array<{ error?: { message?: string } }> = [];
		let closes = 0;
		let timeoutLogs = 0;
		const coordinator = new ParadisRawScreenshotCoordinator(10);
		const owner = {};
		const callbacks = {
			respond: (response: { error?: { message?: string } }) => responses.push(response),
			closeTransport: () => { closes++; coordinator.markClosing(owner); },
			onTimeout: () => { timeoutLogs++; },
		};
		assert.strictEqual(paradisStartVisibleWebPCapture(coordinator, owner, { id: 1, sessionId: 'session-1' }, callbacks), true);
		assert.strictEqual(paradisStartVisibleWebPCapture(coordinator, {}, { id: 2 }, callbacks), false);
		assert.match(responses[0].error?.message ?? '', /still in progress for this Para Code pane/);
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(responses.length, 2);
		assert.match(responses[1].error?.message ?? '', /timed out/);
		assert.strictEqual(closes, 1);
		assert.strictEqual(timeoutLogs, 1);
		assert.strictEqual(coordinator.hasActiveRequest, true);
		assert.strictEqual(paradisStartVisibleWebPCapture(coordinator, {}, { id: 2 }, callbacks), false);
		const lateCompletion = coordinator.complete(owner, 1, 'session-1');
		assert.strictEqual(lateCompletion.handled, true);
		assert.strictEqual(lateCompletion.suppress, true);
		assert.strictEqual(coordinator.begin(owner, { id: 2 }, { onTimeout: () => undefined }), true);
		assert.strictEqual(coordinator.complete(owner, 2, undefined).handled, true);
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(closes, 1);
	});

	test('holds a closing owner lease without a timer until upstream close is confirmed', async () => {
		const coordinator = new ParadisRawScreenshotCoordinator(10);
		const firstOwner = {};
		const secondOwner = {};
		let timeouts = 0;
		assert.strictEqual(coordinator.begin(firstOwner, { id: 1 }, { onTimeout: () => { timeouts++; } }), true);
		coordinator.markClosing(firstOwner);
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(timeouts, 0);
		assert.strictEqual(coordinator.begin(secondOwner, { id: 2 }, { onTimeout: () => undefined }), false);

		coordinator.release(firstOwner); // upstream close confirmation
		assert.strictEqual(coordinator.begin(secondOwner, { id: 2 }, { onTimeout: () => undefined }), true);
		coordinator.release(secondOwner);
	});

	test('force-closes raw screenshot upstream with terminate and safe fallbacks', () => {
		const calls: string[] = [];
		const open = {
			readyState: 1,
			terminate: () => { calls.push('terminate'); },
			close: () => { calls.push('close'); },
		};
		assert.strictEqual(paradisForceCloseRawScreenshotUpstream(open, 1, 3), false);
		assert.deepStrictEqual(calls, ['terminate']);

		calls.length = 0;
		const fallback = {
			readyState: 1,
			terminate: () => { calls.push('terminate'); throw new Error('not open'); },
			close: () => { calls.push('close'); },
		};
		assert.strictEqual(paradisForceCloseRawScreenshotUpstream(fallback, 1, 3), false);
		assert.deepStrictEqual(calls, ['terminate', 'close']);

		calls.length = 0;
		assert.strictEqual(paradisForceCloseRawScreenshotUpstream({
			readyState: 1,
			close: () => { calls.push('close'); },
		}, 1, 3), false);
		assert.deepStrictEqual(calls, ['close']);

		calls.length = 0;
		assert.strictEqual(paradisForceCloseRawScreenshotUpstream({ ...open, readyState: 3 }, 1, 3), true);
		assert.deepStrictEqual(calls, []);
	});

	test('shares raw WebP authority across page and browser connections and rejects a non-owner id collision', () => {
		const registry = new ParadisRawScreenshotAuthorityRegistry(100);
		const pageCoordinator = registry.forAuthority('token-1');
		const browserCoordinator = registry.forAuthority('token-1');
		assert.strictEqual(pageCoordinator, browserCoordinator);

		const pageOwner = {};
		const browserOwner = {};
		const pageResponses: Array<{ id: number; sessionId?: string }> = [];
		const browserResponses: Array<{ id: number; sessionId?: string; error?: { message: string } }> = [];
		assert.strictEqual(paradisStartVisibleWebPCapture(pageCoordinator, pageOwner, { id: 7, sessionId: 'page-session' }, {
			respond: response => pageResponses.push(response),
			closeTransport: () => undefined,
		}), true);
		assert.strictEqual(paradisStartVisibleWebPCapture(browserCoordinator, browserOwner, { id: 7, sessionId: 'browser-session' }, {
			respond: response => browserResponses.push(response),
			closeTransport: () => undefined,
		}), false);
		assert.deepStrictEqual(browserResponses.map(response => ({ id: response.id, sessionId: response.sessionId })), [{ id: 7, sessionId: 'browser-session' }]);
		assert.match(browserResponses[0].error?.message ?? '', /still in progress for this Para Code pane/);

		assert.strictEqual(browserCoordinator.complete(browserOwner, 7, 'page-session').handled, false);
		assert.strictEqual(pageCoordinator.hasActiveRequest, true);
		assert.strictEqual(pageCoordinator.complete(pageOwner, 7, 'page-session').handled, true);
		assert.deepStrictEqual(pageResponses, []);
		registry.dispose();
	});

	test('releases only the closing connection raw WebP lease and clears authority timers on retirement', async () => {
		const registry = new ParadisRawScreenshotAuthorityRegistry(10);
		const coordinator = registry.forAuthority('token-1');
		const firstOwner = {};
		const secondOwner = {};
		let timeouts = 0;
		assert.strictEqual(coordinator.begin(firstOwner, { id: 1 }, { onTimeout: () => { timeouts++; } }), true);
		coordinator.release(secondOwner);
		assert.strictEqual(coordinator.hasActiveRequest, true);
		coordinator.release(firstOwner);
		assert.strictEqual(coordinator.hasActiveRequest, false);
		assert.strictEqual(coordinator.begin(secondOwner, { id: 2 }, { onTimeout: () => { timeouts++; } }), true);

		registry.retire('token-1');
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(timeouts, 0);
		const replacement = registry.forAuthority('token-1');
		assert.notStrictEqual(replacement, coordinator);
		assert.strictEqual(replacement.begin({}, { id: 3 }, { onTimeout: () => { timeouts++; } }), true);
		registry.dispose();
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(timeouts, 0);
	});

	test('emits safe raw WebP start and successful completion logs with duration only', () => {
		const logs: string[] = [];
		const coordinator = new ParadisRawScreenshotCoordinator(100);
		const owner = {};
		assert.strictEqual(paradisStartVisibleWebPCapture(coordinator, owner, {
			id: 3,
			sessionId: 'secret-session',
			params: { url: 'https://secret.example', token: 'secret-token' },
		}, {
			respond: () => undefined,
			closeTransport: () => undefined,
			onStart: () => logs.push(paradisVisibleWebPScreenshotLogMessage('start', 'page')),
			onComplete: durationMs => logs.push(paradisVisibleWebPScreenshotLogMessage('complete', 'page', durationMs)),
		}), true);
		assert.strictEqual(coordinator.complete(owner, 3, 'secret-session').handled, true);
		assert.strictEqual(logs.length, 2);
		assert.match(logs[0], /start route=visible-webp transport=page/);
		assert.match(logs[1], /complete route=visible-webp transport=page durationMs=\d+/);
		assert.strictEqual(logs.some(message => /secret|https:|token|session/.test(message)), false);
	});

	test('dispatches page Input locally and keeps a subsequent non-input command behind its drain barrier', async () => {
		let releaseDrain!: () => void;
		const drained = new Promise<void>(resolve => releaseDrain = resolve);
		const inputCalls: Array<{ targetId: string; method: string; paramsJson: string }> = [];
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: (targetId, method, paramsJson) => {
				inputCalls.push({ targetId, method, paramsJson });
				return { response: Promise.resolve({ status: 'success', result: { applied: true } }), drained };
			},
		}));
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');

		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Input.insertText', params: { text: 'hello' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' } })));
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(inputCalls, [{ targetId: 'target-1', method: 'Input.insertText', paramsJson: '{"text":"hello"}' }]);
		assert.deepStrictEqual(parseSent(fixture.upstream), []);
		assert.deepStrictEqual(parseSent(fixture.client), [{ id: 1, result: { applied: true } }]);

		releaseDrain();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(parseSent(fixture.upstream), [{ id: 2, method: 'Runtime.evaluate', params: { expression: '1' } }]);
	});

	test('waits for the snapshotted prior page request response before committing direct Input', async () => {
		let dispatches = 0;
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: () => {
				dispatches++;
				return { response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() };
			},
		}));
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');

		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 21, method: 'Runtime.evaluate', params: { expression: 'prepare()' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 22, method: 'Input.insertText', params: { text: 'after' } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 0);
		assert.deepStrictEqual(parseSent(fixture.upstream), [{ id: 21, method: 'Runtime.evaluate', params: { expression: 'prepare()' } }]);

		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 21, result: { ready: true } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 1);
	});

	test('returns retryable without page Input dispatch when the prior response barrier times out', async () => {
		const clock = sinon.useFakeTimers();
		let dispatches = 0;
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: () => {
				dispatches++;
				return { response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() };
			},
		}));
		paradisProxyPageUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'target-1', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 31, method: 'Runtime.evaluate', params: { expression: 'never()' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 32, method: 'Input.insertText', params: { text: 'blocked' } })));

		await clock.tickAsync(5_000);
		assert.strictEqual(dispatches, 0);
		const response = parseSent(fixture.client).find(message => (message as { id?: number }).id === 32) as { error?: { message?: string } };
		assert.match(response.error?.message ?? '', /^PARA_BROWSER_RETRYABLE:.*prior CDP request/i);
	});

	test('permits browser-session Input only for the bound primary and returns local outcome errors', async () => {
		let dispatches = 0;
		let isInputRouteCurrent: (() => boolean) | undefined;
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: (_targetId, _method, _paramsJson, isRouteCurrent) => {
				dispatches++;
				isInputRouteCurrent = isRouteCurrent;
				return {
					response: Promise.resolve({ status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: debugger completion was not observed' }),
					drained: Promise.resolve(),
				};
			},
		}));
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		publishAllowedSession(fixture, 'primary-session');

		fixture.client.emit('message', Buffer.from(JSON.stringify({
			id: 11,
			sessionId: 'primary-session',
			method: 'Input.dispatchMouseEvent',
			params: { type: 'mouseMoved', x: 1, y: 2 },
		})));
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.strictEqual(dispatches, 1);
		assert.strictEqual(isInputRouteCurrent?.(), true);
		assert.strictEqual(parseSent(fixture.upstream).some(message => (message as { id?: number }).id === 11), false);
		const response = parseSent(fixture.client).find(message => (message as { id?: number }).id === 11) as { error?: { message?: string } };
		assert.match(response.error?.message ?? '', /^PARA_BROWSER_OUTCOME_UNKNOWN:/);
		// Detaching the bound primary session revokes the input route (and now closes the transport so the child reconnects).
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.detachedFromTarget',
			params: { sessionId: 'primary-session' },
		})));
		assert.strictEqual(isInputRouteCurrent?.(), false);
		assert.ok(fixture.client.closeCalls >= 1);

		// A non-bound (child) session's Input is denied, verified on a fresh connection.
		const child = await createOpenBrowserProxyFixture();
		publishAllowedSession(child, 'primary-session');
		child.upstream.emit('message', Buffer.from(JSON.stringify({
			method: 'Target.attachedToTarget',
			params: { sessionId: 'child-session', targetInfo: { targetId: 'child-target', type: 'iframe', openerId: 'target-1' } },
		})));
		child.client.emit('message', Buffer.from(JSON.stringify({
			id: 12,
			sessionId: 'child-session',
			method: 'Input.insertText',
			params: { text: 'blocked' },
		})));
		await new Promise(resolve => setTimeout(resolve, 0));
		const denied = parseSent(child.client).find(message => (message as { id?: number }).id === 12) as { error?: { message?: string } };
		assert.match(denied.error?.message ?? '', /bound primary BrowserView session/);
	});

	test('waits for prior browser-session responses and rechecks route authority before Input commit', async () => {
		let dispatches = 0;
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: () => {
				dispatches++;
				return { response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() };
			},
		}));
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		publishAllowedSession(fixture, 'primary-session');

		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 41, sessionId: 'primary-session', method: 'Runtime.evaluate', params: { expression: 'prepare()' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 42, sessionId: 'primary-session', method: 'Input.insertText', params: { text: 'after' } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 0);
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 41, sessionId: 'primary-session', result: { ready: true } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 1);

		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 43, sessionId: 'primary-session', method: 'Runtime.evaluate', params: { expression: 'again()' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 44, sessionId: 'primary-session', method: 'Input.insertText', params: { text: 'blocked' } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'primary-session' } })));
		fixture.upstream.emit('message', Buffer.from(JSON.stringify({ id: 43, sessionId: 'primary-session', result: {} })));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 1);
	});

	test('does not commit browser Input after the connection closes during a prior response barrier', async () => {
		let dispatches = 0;
		const fixture = createProxyFixture(context({
			dispatchBoundPageInput: () => {
				dispatches++;
				return { response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() };
			},
		}));
		await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
		fixture.upstream.readyState = TestWebSocket.OPEN;
		fixture.upstream.emit('open');
		publishAllowedSession(fixture, 'primary-session');
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 51, sessionId: 'primary-session', method: 'Runtime.evaluate', params: { expression: 'never()' } })));
		fixture.client.emit('message', Buffer.from(JSON.stringify({ id: 52, sessionId: 'primary-session', method: 'Input.insertText', params: { text: 'blocked' } })));
		await new Promise(resolve => setTimeout(resolve, 0));
		fixture.client.emit('close');
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(dispatches, 0);
	});
});

function createScreenshotServiceFixture(call: (command: string) => Promise<string | boolean | null>): {
	readonly capture: (token: string, options: IParadisCdpScreenshotOptions) => Promise<string | undefined>;
	readonly visible: (token: string) => Promise<boolean>;
	readonly rebind: () => void;
	readonly traces: readonly string[];
	readonly warnings: readonly string[];
} {
	type ScreenshotServiceInternals = {
		_captureBoundPageScreenshot(token: string, options: IParadisCdpScreenshotOptions): Promise<string | undefined>;
		_isBoundPageVisible(token: string): Promise<boolean>;
	};
	const bindings = new Map<string, object>();
	const original = {
		pageId: 'page-1',
		generation: 1,
		exactView: { windowId: 1, viewId: 'page-1', targetId: 'target-1', viewLease: 'lease-1' },
	};
	const traces: string[] = [];
	const warnings: string[] = [];
	const ingressLease = Object.freeze({ token: 'token' });
	bindings.set('token', original);
	const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
		_bindings: bindings,
		captureIngressLease: (token: string) => token === ingressLease.token ? ingressLease : undefined,
		isIngressLeaseCurrent: (lease: unknown) => lease === ingressLease,
		mainProcessService: {
			getChannel: () => ({ call: (command: string) => call(command) }),
		},
		logService: {
			trace: (message: string) => traces.push(message),
			warn: (message: string) => warnings.push(message),
		},
	}) as unknown as ScreenshotServiceInternals;
	return {
		capture: (token, options) => service._captureBoundPageScreenshot(token, options),
		visible: token => service._isBoundPageVisible(token),
		rebind: () => bindings.set('token', {
			pageId: 'page-2',
			generation: 2,
			exactView: { windowId: 1, viewId: 'page-2', targetId: 'target-2', viewLease: 'lease-2' },
		}),
		traces,
		warnings,
	};
}

class TestWebSocket extends EventEmitter {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = TestWebSocket.CONNECTING;
	bufferedAmount = 0;
	readonly sent: unknown[] = [];
	readonly sentOptions: Array<{ binary?: boolean } | undefined> = [];
	closeCalls = 0;

	send(data: unknown, options?: { binary?: boolean }): void {
		this.sent.push(data);
		this.sentOptions.push(options);
	}

	close(): void {
		this.closeCalls++;
		this.readyState = TestWebSocket.CLOSING;
	}

	terminate(): void {
		this.closeCalls++;
		this.readyState = TestWebSocket.CLOSED;
	}
}

function createProxyFixture(ctx: IParadisBoundContext): {
	readonly ctx: IParadisBoundContext;
	readonly client: TestWebSocket;
	readonly upstream: TestWebSocket;
	readonly ws: IParadisWsModule;
	readonly wss: import('ws').WebSocketServer;
	readonly logService: import('../../../../../platform/log/common/log.js').ILogService;
} {
	const client = new TestWebSocket();
	client.readyState = TestWebSocket.OPEN;
	let upstream: TestWebSocket | undefined;
	class UpstreamWebSocket extends TestWebSocket {
		constructor(_url: string) {
			super();
			upstream = this;
		}
	}
	const ws = {
		WebSocket: Object.assign(UpstreamWebSocket, {
			CONNECTING: TestWebSocket.CONNECTING,
			OPEN: TestWebSocket.OPEN,
			CLOSING: TestWebSocket.CLOSING,
			CLOSED: TestWebSocket.CLOSED,
		}) as never,
		WebSocketServer: class { } as never,
	};
	const wss = {
		handleUpgrade: (_req: unknown, _socket: unknown, _head: unknown, callback: (socket: TestWebSocket) => void) => callback(client),
	} as never;
	const logService = {
		trace: () => undefined,
		debug: () => undefined,
		warn: () => undefined,
	} as never;
	// The proxy constructors synchronously create the upstream from handleUpgrade's callback.
	return new Proxy({ ctx, client, ws, wss, logService } as object, {
		get(target, property) {
			if (property === 'upstream') {
				assert.ok(upstream);
				return upstream;
			}
			return Reflect.get(target, property);
		},
	}) as never;
}

async function createOpenBrowserProxyFixture(): Promise<ReturnType<typeof createProxyFixture>> {
	const fixture = createProxyFixture(context());
	await paradisProxyBrowserUpgrade({} as never, {} as never, Buffer.alloc(0), fixture.ws, fixture.wss, 41001, 'ws://127.0.0.1:41001/devtools/browser/live', fixture.ctx, fixture.logService);
	fixture.upstream.readyState = TestWebSocket.OPEN;
	fixture.upstream.emit('open');
	return fixture;
}

function parseSent(socket: TestWebSocket): unknown[] {
	return socket.sent.map(frame => JSON.parse(String(frame)));
}

function publishAllowedSession(fixture: ReturnType<typeof createProxyFixture>, sessionId: string): void {
	fixture.upstream.emit('message', Buffer.from(JSON.stringify({
		method: 'Target.attachedToTarget',
		params: {
			sessionId,
			targetInfo: { targetId: 'target-1', type: 'page' },
		},
	})));
}

function createGatewayUpgradeFixture(
	url: string,
	fetchJsonWithPort?: (path: string) => Promise<{ readonly value: { readonly webSocketDebuggerUrl: string }; readonly port: number }>,
): {
	readonly gateway: ParadisCdpGateway;
	readonly request: import('http').IncomingMessage;
	readonly socket: import('stream').Duplex;
	readonly fetchPaths: string[];
	readonly resolvePortCalls: () => number;
	readonly upstreamUrls: () => readonly string[];
	readonly destroyCalls: () => number;
} {
	const fetchPaths: string[] = [];
	let legacyResolvePortCalls = 0;
	const upstream = {
		resolvePort: async () => {
			legacyResolvePortCalls++;
			return 41001;
		},
		fetchJsonWithPort: fetchJsonWithPort ?? (async (path: string) => {
			fetchPaths.push(path);
			return {
				value: { webSocketDebuggerUrl: 'ws://127.0.0.1:41002/devtools/browser/live' },
				port: 41002,
			};
		}),
	} as unknown as ParadisCdpUpstream;
	const ingressLease = Object.freeze({ token: 'pane-token' });
	const delegate: IParadisCdpGatewayDelegate = {
		captureIngressLease: token => token === ingressLease.token ? ingressLease : undefined,
		isIngressLeaseCurrent: lease => lease === ingressLease,
		getBoundTargetId: () => 'target-1',
		ensureBoundTargetId: async () => 'target-1',
		getTokenForShellPid: () => undefined,
		captureBoundPageScreenshot: async () => 'image',
		isBoundPageVisible: async () => true,
		dispatchBoundPageInput: () => ({ response: Promise.resolve({ status: 'success', result: {} }), drained: Promise.resolve() }),
		closeInputConnection: () => undefined,
	};
	const logService = {
		trace: () => undefined,
		debug: () => undefined,
		info: () => undefined,
		warn: () => undefined,
	} as never;
	const gateway = new ParadisCdpGateway(delegate, upstream, logService);
	const client = new TestWebSocket();
	client.readyState = TestWebSocket.OPEN;
	const upstreamUrls: string[] = [];
	class GatewayUpstreamWebSocket extends TestWebSocket {
		constructor(upstreamUrl: string) {
			super();
			upstreamUrls.push(upstreamUrl);
		}
	}
	const ws: IParadisWsModule = {
		WebSocket: Object.assign(GatewayUpstreamWebSocket, {
			CONNECTING: TestWebSocket.CONNECTING,
			OPEN: TestWebSocket.OPEN,
			CLOSING: TestWebSocket.CLOSING,
			CLOSED: TestWebSocket.CLOSED,
		}) as never,
		WebSocketServer: class { } as never,
	};
	const wss = {
		handleUpgrade: (_request: unknown, _socket: unknown, _head: unknown, callback: (socket: TestWebSocket) => void) => callback(client),
		close: () => undefined,
	};
	Object.assign(gateway as object, {
		_wsModulePromise: Promise.resolve(ws),
		_wss: wss,
	});
	let socketDestroyCalls = 0;
	const socket = {
		remoteAddress: '127.0.0.1',
		destroy: () => { socketDestroyCalls++; },
	};
	const request = {
		url,
		method: 'GET',
		headers: {},
		socket,
	};
	return {
		gateway,
		request: request as never,
		socket: socket as never,
		fetchPaths,
		resolvePortCalls: () => legacyResolvePortCalls,
		upstreamUrls: () => upstreamUrls,
		destroyCalls: () => socketDestroyCalls,
	};
}
