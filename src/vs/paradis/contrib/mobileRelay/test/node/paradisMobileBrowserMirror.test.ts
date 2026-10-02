/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisCdpFrameEvent, IParadisCdpFrameSubscription } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { ParadisCdpUpstream } from '../../../agentBrowser/node/paradisCdpUpstream.js';
import { ParadisMobileBrowserMirror } from '../../node/paradisMobileBrowserMirror.js';

suite('ParadisMobileBrowserMirror', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('同じpush JPEGを一度だけ送り重複通知も購読生存として扱う', () => {
		const frames = store.add(new Emitter<IParadisCdpFrameEvent>());
		const subscription: IParadisCdpFrameSubscription = {
			onDidFrame: frames.event,
			startFrameSubscription: async () => true,
			stopFrameSubscription: async () => undefined,
			resolveTargetWindowId: async () => 1,
			resolveTargetId: async () => null,
			resolveUpstreamPort: async () => null,
			armMirrorCapture: async () => undefined,
		};
		const delivered: Uint8Array[] = [];
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(
			new ParadisCdpUpstream('', logService),
			subscription,
			undefined,
			logService,
		));
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a',
			nextId: 1,
			viewWidth: 0,
			viewHeight: 0,
			captureTimer: undefined,
			captureInFlight: false,
			lastFrameData: undefined,
			handlers: new Map(),
			pushMode: true,
			pushStarted: false,
			lastPushFrameAt: 0,
			lastMetricsAt: 0,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { sessions: Map<string, typeof session> }).sessions.set('mobile', session);
		const jpeg = 'A'.repeat(128 * 1024);

		frames.fire({ targetId: 'target-a', data: jpeg, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 1);
		const deliveredBytes = delivered[0].byteLength;
		session.lastPushFrameAt = 0;
		for (let i = 1; i < 60; i++) {
			frames.fire({ targetId: 'target-a', data: jpeg, w: 1200, h: 800 });
		}

		assert.strictEqual(delivered.length, 1);
		assert.strictEqual(delivered.reduce((sum, payload) => sum + payload.byteLength, 0), deliveredBytes);
		assert.ok(session.lastPushFrameAt > 0);

		frames.fire({ targetId: 'target-a', data: `${jpeg}B`, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 2);
		assert.strictEqual(JSON.parse(new TextDecoder().decode(delivered[1])).data, `${jpeg}B`);

		frames.fire({ targetId: 'target-b', data: `${jpeg}C`, w: 1200, h: 800 });
		session.pushMode = false;
		frames.fire({ targetId: 'target-a', data: `${jpeg}D`, w: 1200, h: 800 });
		assert.strictEqual(delivered.length, 2);
	});

	test('明示要求したセッションだけJPEGを可逆なbinary v1で送る', async () => {
		const frames = store.add(new Emitter<IParadisCdpFrameEvent>());
		const subscription: IParadisCdpFrameSubscription = {
			onDidFrame: frames.event,
			startFrameSubscription: async () => true,
			stopFrameSubscription: async () => undefined,
			resolveTargetWindowId: async () => 1,
			resolveTargetId: async () => null,
			resolveUpstreamPort: async () => null,
			armMirrorCapture: async () => undefined,
		};
		const logService = new NullLogService();
		const upstream = new ParadisCdpUpstream('', logService);
		// start は targetId が /json/list の http(s) のページかを確かめる
		(upstream as unknown as { fetchJson: () => Promise<unknown> }).fetchJson = async () => [{ id: 'target-a', type: 'page', url: 'https://a.example/' }];
		const mirror = store.add(new ParadisMobileBrowserMirror(
			upstream,
			subscription,
			undefined,
			logService,
		));

		const negotiated: Array<boolean | undefined> = [];
		(mirror as unknown as { start: (mobileId: string, targetId: string, send: (payload: Uint8Array) => void, binaryFrames?: boolean) => Promise<void> }).start
			= async (_mobileId, _targetId, _send, binaryFrames) => { negotiated.push(binaryFrames); };
		const replies: Uint8Array[] = [];
		await mirror.handleRequest('new-mobile', new TextEncoder().encode(JSON.stringify({
			t: 'start', id: 'new', targetId: 'target-a', frameEncoding: 'jpeg-binary-v1',
		})), payload => replies.push(payload));
		await mirror.handleRequest('old-mobile', new TextEncoder().encode(JSON.stringify({
			t: 'start', id: 'old', targetId: 'target-a',
		})), payload => replies.push(payload));
		assert.deepStrictEqual(negotiated, [true, false]);
		assert.deepStrictEqual(replies.map(payload => JSON.parse(new TextDecoder().decode(payload)).t), ['started', 'started']);

		const delivered: Uint8Array[] = [];
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a', nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
			handlers: new Map(), pushMode: true, pushStarted: false,
			lastPushFrameAt: 0, lastMetricsAt: 0, binaryFrames: true,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { sessions: Map<string, typeof session> }).sessions.set('new-mobile', session);
		const jpegBase64 = '/9gAAX+A/v/Z';
		frames.fire({ targetId: 'target-a', data: jpegBase64, w: 1200, h: 800 });

		assert.strictEqual(delivered.length, 1);
		assert.deepStrictEqual([...delivered[0].subarray(0, 4)], [0x50, 0x4a, 0x46, 0x01]);
		const view = new DataView(delivered[0].buffer, delivered[0].byteOffset, delivered[0].byteLength);
		assert.strictEqual(view.getUint32(4, false), 1200);
		assert.strictEqual(view.getUint32(8, false), 800);
		assert.deepStrictEqual([...delivered[0].subarray(12)], [0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xd9]);
		assert.ok(delivered[0].byteLength < new TextEncoder().encode(JSON.stringify({ t: 'frame', data: jpegBase64, w: 1200, h: 800 })).byteLength);

		assert.doesNotThrow(() => frames.fire({ targetId: 'target-a', data: 'invalid!', w: 1200, h: 800 }));
		assert.strictEqual(delivered.length, 2);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(delivered[1])), { t: 'frame', data: 'invalid!', w: 1200, h: 800 });
	});

	test('fallback captureも交渉済みセッションではbinary v1を送る', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(
			new ParadisCdpUpstream('', logService),
			undefined,
			undefined,
			logService,
		));
		const delivered: Uint8Array[] = [];
		const session = {
			socket: { close: () => undefined, readyState: 1 } as unknown as WebSocket,
			targetId: 'target-a', nextId: 1, viewWidth: 0, viewHeight: 0,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
			handlers: new Map(), pushMode: false, pushStarted: false,
			lastPushFrameAt: 0, lastMetricsAt: 0, binaryFrames: true,
			send: (payload: Uint8Array) => delivered.push(payload),
		};
		(mirror as unknown as { cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void }).cdpCall
			= (_session, method, _params, handler) => {
				if (method === 'Page.getLayoutMetrics') {
					handler({ cssVisualViewport: { clientWidth: 640, clientHeight: 360 } });
				} else if (method === 'Page.captureScreenshot') {
					handler({ data: '/9gAAX+A/v/Z' });
				}
			};

		(mirror as unknown as { captureFrame: (target: typeof session) => void }).captureFrame(session);

		assert.strictEqual(delivered.length, 1);
		assert.deepStrictEqual([...delivered[0].subarray(0, 4)], [0x50, 0x4a, 0x46, 0x01]);
		const view = new DataView(delivered[0].buffer, delivered[0].byteOffset, delivered[0].byteLength);
		assert.strictEqual(view.getUint32(4, false), 640);
		assert.strictEqual(view.getUint32(8, false), 360);
		assert.deepStrictEqual([...delivered[0].subarray(12)], [0xff, 0xd8, 0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0xd9]);
	});

	function fakeSession(sentCdp: { method: string; params: Record<string, unknown> }[], delivered: unknown[]) {
		return {
			socket: {
				close: () => undefined, readyState: 1,
				send: (data: string) => { const message = JSON.parse(data); sentCdp.push({ method: message.method, params: message.params }); },
			} as unknown as WebSocket,
			targetId: 'target-a', nextId: 1, viewWidth: 800, viewHeight: 600,
			captureTimer: undefined, captureInFlight: false, lastFrameData: undefined,
			handlers: new Map(), pushMode: true, pushStarted: false,
			lastPushFrameAt: Date.now(), lastMetricsAt: 0, binaryFrames: false,
			send: (payload: Uint8Array) => delivered.push(JSON.parse(new TextDecoder().decode(payload))),
			mainFrameId: 'frame-main',
			page: { url: '', title: '', loading: false, progress: 1, canGoBack: false, canGoForward: false },
			focusSeq: 0,
			focusContextId: 7,
			lastTapAt: 0,
		};
	}

	test('targets は windowId と ws があればそのスペースのページだけを返し、無ければ全件（古いアプリ）', async () => {
		const logService = new NullLogService();
		const upstream = new ParadisCdpUpstream('', logService);
		(upstream as unknown as { fetchJson: (path: string) => Promise<unknown> }).fetchJson = async () => [
			{ id: 't1', type: 'page', title: 'A', url: 'https://a.example/' },
			{ id: 't2', type: 'page', title: 'B', url: 'https://b.example/' },
			{ id: 't3', type: 'iframe', title: 'C', url: 'https://c.example/' },
		];
		const asked: [number, string][] = [];
		const mirror = store.add(new ParadisMobileBrowserMirror(upstream, undefined, undefined, logService, {
			resolveSpaceTargetIds: async (windowId, ws) => { asked.push([windowId, ws]); return ws === 'unknown' ? undefined : new Set(['t1']); },
		}));
		const replies: unknown[] = [];
		const request = async (body: object) => mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify(body)), payload => replies.push(JSON.parse(new TextDecoder().decode(payload))));
		await request({ t: 'targets', id: 'r1', windowId: 1, ws: 'repo' });
		await request({ t: 'targets', id: 'r2' });
		await request({ t: 'targets', id: 'r3', windowId: 1, ws: 'unknown' });
		await request({ t: 'targets', id: 'r4', windowId: '1', ws: 'repo' });
		await request({ t: 'targets', id: 'r5', windowId: 1, ws: 'w'.repeat(4097) });
		assert.deepStrictEqual({ asked, replies }, {
			asked: [[1, 'repo'], [1, 'unknown']],
			replies: [
				{ id: 'r1', t: 'targets', scoped: true, targets: [{ targetId: 't1', title: 'A', url: 'https://a.example/' }] },
				{ id: 'r2', t: 'targets', targets: [{ targetId: 't1', title: 'A', url: 'https://a.example/' }, { targetId: 't2', title: 'B', url: 'https://b.example/' }] },
				{ id: 'r3', t: 'targets', targets: [{ targetId: 't1', title: 'A', url: 'https://a.example/' }, { targetId: 't2', title: 'B', url: 'https://b.example/' }] },
				// スペースを付けてきたのに読めないときは、黙って全件に戻さず断る
				{ id: 'r4', error: 'invalid-scope' },
				{ id: 'r5', error: 'invalid-scope' },
			],
		});
	});

	test('CDP のイベントからページの状態とフォーカスを組み立て、変わったときだけ送る', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(new ParadisCdpUpstream('', logService), undefined, undefined, logService));
		const sentCdp: { method: string; params: Record<string, unknown> }[] = [];
		const delivered: unknown[] = [];
		const session = fakeSession(sentCdp, delivered);
		const internals = mirror as unknown as {
			sessions: Map<string, typeof session>;
			cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void;
			onCdpEvent: (target: typeof session, method: string, params: Record<string, unknown>) => void;
		};
		internals.sessions.set('m', session);
		internals.cdpCall = (_session, method, _params, handler) => {
			if (method === 'Page.getNavigationHistory') {
				handler({ currentIndex: 1, entries: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }] });
			}
		};
		internals.onCdpEvent(session, 'Page.frameStartedLoading', { frameId: 'frame-sub' });
		internals.onCdpEvent(session, 'Page.frameStartedLoading', { frameId: 'frame-main' });
		internals.onCdpEvent(session, 'Page.lifecycleEvent', { frameId: 'frame-main', name: 'DOMContentLoaded' });
		internals.onCdpEvent(session, 'Page.lifecycleEvent', { frameId: 'frame-main', name: 'DOMContentLoaded' });
		internals.onCdpEvent(session, 'Page.frameStoppedLoading', { frameId: 'frame-main' });
		session.lastTapAt = Date.now();
		internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: '__paraMobileFocus', executionContextId: 7, payload: JSON.stringify({ focused: true, fieldId: 1, field: 'text', inputType: 'search', value: 'abc', reason: 'focus' }) });
		internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: '__paraMobileFocus', executionContextId: 7, payload: JSON.stringify({ focused: true, fieldId: 1, field: 'text', inputType: 'search', value: 'abc', reason: 'input' }) });
		internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: 'other', executionContextId: 7, payload: '{}' });
		// iframe の中のワールド・ほかの文脈からの報告は捨てる
		internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: '__paraMobileFocus', executionContextId: 99, payload: JSON.stringify({ focused: true, fieldId: 1, field: 'text', value: 'iframe', reason: 'focus' }) });
		internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: '__paraMobileFocus', executionContextId: 7, payload: JSON.stringify({ focused: false, reason: 'focus' }) });
		const page = { t: 'page', targetId: 'target-a', canGoBack: false, canGoForward: false, url: '', title: '' };
		assert.deepStrictEqual(delivered, [
			{ ...page, loading: true, progress: 0.1 },
			{ ...page, loading: true, progress: 0.6 },
			{ ...page, loading: false, progress: 1 },
			{ ...page, loading: false, progress: 1, url: 'https://b.example/', title: 'B', canGoBack: true },
			{ t: 'focus', targetId: 'target-a', seq: 1, focused: true, fieldId: 1, field: 'text', inputType: 'search', value: 'abc', fromTap: true },
			{ t: 'focus', targetId: 'target-a', seq: 2, focused: false },
		]);
	});

	test('入力 stop・open・replace を CDP に直す', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(new ParadisCdpUpstream('', logService), undefined, undefined, logService, { resolveSearchEngine: () => 'duckduckgo' }));
		const sentCdp: { method: string; params: Record<string, unknown> }[] = [];
		const delivered: unknown[] = [];
		const session = fakeSession(sentCdp, delivered);
		const internals = mirror as unknown as {
			sessions: Map<string, typeof session>;
			cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void;
		};
		internals.sessions.set('m', session);
		const evaluated: string[] = [];
		internals.cdpCall = (_session, method, params, handler) => {
			if (method === 'Runtime.evaluate') {
				const expression = String((params as { expression?: string }).expression);
				evaluated.push(`${(params as { contextId?: number }).contextId}:${expression.includes('__paraMobileFocusSelect(5)') ? 'select5' : expression.includes('__paraMobileFocusSelect(6)') ? 'select6' : 'other'}`);
				// 欄 5 にはフォーカスがある、欄 6 にはもう無い
				handler({ result: { value: expression.includes('__paraMobileFocusSelect(5)') } });
			}
		};
		const input = (body: object) => mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify({ t: 'input', ...body })), () => undefined);
		void input({ kind: 'stop' });
		void input({ kind: 'open', text: 'para code' });
		void input({ kind: 'open', text: 'localhost:5173/app' });
		void input({ kind: 'open', text: 'javascript:alert(1)' });
		void input({ kind: 'replace', text: '置換', fieldId: 5 });
		void input({ kind: 'replace', text: '別の欄の文字', fieldId: 6 });
		void input({ kind: 'replace', text: '欄を名指ししない' });
		void input({ kind: 'replace', text: 'x'.repeat(8193), fieldId: 5 });
		void input({ kind: 'text', text: 'y'.repeat(8193) });
		void input({ kind: 'unknown-kind' });
		assert.deepStrictEqual({
			cdp: sentCdp.map(({ method, params }) => [method, (params as { expression?: string }).expression !== undefined ? 'expression' : params]),
			evaluated,
			delivered,
		}, {
			cdp: [
				['Page.stopLoading', {}],
				['Page.navigate', { url: 'https://duckduckgo.com/?q=para+code' }],
				['Page.navigate', { url: 'http://localhost:5173/app' }],
				['Input.insertText', { text: '置換' }],
				// 欄 6 は置き換えず、今のフォーカスを知らせ直させる
				['Runtime.evaluate', 'expression'],
			],
			evaluated: ['7:select5', '7:select6'],
			delivered: [
				{ t: 'inputRejected', targetId: 'target-a', kind: 'replace', reason: 'field-changed' },
				{ t: 'inputRejected', targetId: 'target-a', kind: 'replace', reason: 'field-changed' },
				{ t: 'inputRejected', targetId: 'target-a', kind: 'replace', reason: 'too-long' },
				{ t: 'inputRejected', targetId: 'target-a', kind: 'text', reason: 'too-long' },
			],
		});
	});

	test('start は形式・/json/list の http(s) のページ・スペースの中のものかを確かめ、違えば断る', async () => {
		const logService = new NullLogService();
		const upstream = new ParadisCdpUpstream('', logService);
		(upstream as unknown as { fetchJson: (path: string) => Promise<unknown>; resolvePort: () => Promise<number | undefined> }).fetchJson = async () => [
			{ id: 't1', type: 'page', url: 'https://a.example/' },
			{ id: 't2', type: 'page', url: 'https://b.example/' },
			{ id: 't3', type: 'page', url: 'vscode-file://workbench' },
		];
		// 確かめを通ったものは CDP のポートを探しに行く（ここでは無いので失敗する）
		(upstream as unknown as { resolvePort: () => Promise<number | undefined> }).resolvePort = async () => undefined;
		const mirror = store.add(new ParadisMobileBrowserMirror(upstream, undefined, undefined, logService, {
			resolveSpaceTargetIds: async () => new Set(['t1']),
		}));
		const replies: { id?: string; error?: string }[] = [];
		const request = async (body: object) => mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify({ t: 'start', ...body })), payload => replies.push(JSON.parse(new TextDecoder().decode(payload))));
		await request({ id: 'a', targetId: '../browser' });
		await request({ id: 'b', targetId: 'missing' });
		await request({ id: 'c', targetId: 't3' });
		await request({ id: 'd', targetId: 't2', windowId: 1, ws: 'repo' });
		await request({ id: 'e', targetId: 't2', windowId: 1 });
		await request({ id: 'f', targetId: 't1', windowId: 1, ws: 'repo' });
		await request({ id: 'g', targetId: 't2' });
		assert.deepStrictEqual(replies.map(reply => [reply.id, reply.error]), [
			['a', 'invalid target'],
			['b', 'unknown target'],
			['c', 'unknown target'],
			['d', 'target-not-in-space'],
			['e', 'invalid-scope'],
			['f', 'ブラウザのCDPエンドポイントが見つかりません'],
			['g', 'ブラウザのCDPエンドポイントが見つかりません'],
		]);
	});

	test('フォーカスは広告したアプリにだけ見張り、前のミラーの分離ワールドを使い回し、止めるときにリスナーを外す', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(new ParadisCdpUpstream('', logService), undefined, undefined, logService));
		const sentCdp: { method: string; params: Record<string, unknown> }[] = [];
		const session = { ...fakeSession(sentCdp, []), focusContextId: undefined as number | undefined, focusTracking: true };
		const internals = mirror as unknown as {
			sessions: Map<string, typeof session>;
			cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void;
			onCdpEvent: (target: typeof session, method: string, params: Record<string, unknown>) => void;
			startFocusTracking: (target: typeof session, frameId: string) => void;
		};
		internals.sessions.set('m', session);
		const called: string[] = [];
		internals.cdpCall = (target, method, _params, handler) => {
			called.push(method);
			if (method === 'Runtime.enable') {
				// Runtime.enable は今ある文脈を知らせてから応答する。前のミラーのワールド（メインフレーム）と、iframe の同名のワールド。
				internals.onCdpEvent(target, 'Runtime.executionContextCreated', { context: { id: 31, name: '__paraMobileFocusWorld', auxData: { frameId: 'frame-sub' } } });
				internals.onCdpEvent(target, 'Runtime.executionContextCreated', { context: { id: 12, name: '__paraMobileFocusWorld', auxData: { frameId: 'frame-main' } } });
				handler({});
			}
		};
		internals.startFocusTracking(session, 'frame-main');
		const reused = session.focusContextId;
		mirror.stopSession('m');
		assert.deepStrictEqual({
			called,
			reused,
			sent: sentCdp.map(({ method, params }) => [method, (params as { contextId?: number }).contextId ?? (params as { name?: string }).name ?? (params as { worldName?: string }).worldName]),
		}, {
			called: ['Runtime.enable'],
			reused: 12,
			sent: [
				['Runtime.addBinding', '__paraMobileFocus'],
				['Page.addScriptToEvaluateOnNewDocument', '__paraMobileFocusWorld'],
				['Runtime.evaluate', 12],
				// 後片付け（リスナーを外す）
				['Runtime.evaluate', 12],
			],
		});
	});

	test('メインフレームの文書が替わったらフォーカスが外れたと知らせ、新しい文書の同じ中身の報告も落とさない。断った後の知らせ直しも落とさない', () => {
		const logService = new NullLogService();
		const mirror = store.add(new ParadisMobileBrowserMirror(new ParadisCdpUpstream('', logService), undefined, undefined, logService));
		const sentCdp: { method: string; params: Record<string, unknown> }[] = [];
		const delivered: { t?: string; seq?: number; focused?: boolean; fieldId?: number }[] = [];
		const session = { ...fakeSession(sentCdp, delivered as unknown[]), focusTracking: true };
		const internals = mirror as unknown as {
			sessions: Map<string, typeof session>;
			cdpCall: (target: typeof session, method: string, params: object, handler: (result: unknown) => void) => void;
			onCdpEvent: (target: typeof session, method: string, params: Record<string, unknown>) => void;
		};
		internals.sessions.set('m', session);
		internals.cdpCall = (_session, method, _params, handler) => handler(method === 'Runtime.evaluate' ? { result: { value: false } } : undefined);
		const focusReport = (fieldId: number) => internals.onCdpEvent(session, 'Runtime.bindingCalled', { name: '__paraMobileFocus', executionContextId: 7, payload: JSON.stringify({ focused: true, fieldId, field: 'text', value: 'x', reason: 'input' }) });
		focusReport(1);
		// iframe の遷移は文書の替わりではない
		internals.onCdpEvent(session, 'Page.frameNavigated', { frame: { id: 'frame-sub', parentId: 'frame-main', url: 'https://ads.example/' } });
		internals.onCdpEvent(session, 'Page.frameNavigated', { frame: { id: 'frame-main', url: 'https://a.example/next' } });
		// 新しい文書でも同じ番号・同じ中身が届きうる（番号の起点は乱数だが）。落とさずに送る
		focusReport(1);
		internals.onCdpEvent(session, 'Runtime.executionContextsCleared', {});
		// 新しい文書の分離ワールドができた（文脈 ID が届いた）
		internals.onCdpEvent(session, 'Runtime.executionContextCreated', { context: { id: 7, name: '__paraMobileFocusWorld', auxData: { frameId: 'frame-main' } } });
		focusReport(1);
		focusReport(1);
		// 断った後の知らせ直しは、同じ中身でも送る
		void mirror.handleRequest('m', new TextEncoder().encode(JSON.stringify({ t: 'input', kind: 'replace', text: 'y', fieldId: 1 })), () => undefined);
		focusReport(1);
		assert.deepStrictEqual(delivered.filter(message => message.t === 'focus' || message.t === 'inputRejected').map(message => message.t === 'focus' ? `${message.seq}:${message.focused ? `field${message.fieldId}` : 'blur'}` : 'rejected'), [
			'1:field1',
			'2:blur',
			'3:field1',
			'4:blur',
			'5:field1',
			'rejected',
			'6:field1',
		]);
	});
});
