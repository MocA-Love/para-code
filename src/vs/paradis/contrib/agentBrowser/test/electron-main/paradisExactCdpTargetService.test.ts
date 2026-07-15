/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { BrowserView } from '../../../../../platform/browserView/electron-main/browserView.js';
import type { IBrowserViewMainService } from '../../../../../platform/browserView/electron-main/browserViewMainService.js';
import {
	IParadisExactBrowserViewDescriptor,
	PARADIS_EXACT_VIEW_ID_MAX_LENGTH,
	PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH,
	PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH,
	paradisParseExactBrowserViewDescriptor,
	paradisParseExactCdpScreenshotOptions,
} from '../../common/paradisAgentBrowser.js';
import { ParadisCdpTargetService } from '../../electron-main/paradisCdpTargetService.js';

interface ITestViewState {
	ownerWindowId: number;
	targetId: string;
	destroyed: boolean;
	visible: boolean;
	captureResult: Promise<VSBuffer>;
	onTargetRead?: () => void;
	onVisibleRead?: () => void;
	onCapture?: () => void;
	throwOwner?: boolean;
	throwTarget?: boolean;
	throwDestroyed?: boolean;
	throwVisible?: boolean;
	throwThrottling?: boolean;
	focused: boolean;
	focusAuthority: object;
	automationReady: boolean;
	automationActivateReady: boolean;
	automationCommitReady: boolean;
	inputResult: Promise<unknown>;
	onPrepareAutomation?: () => void;
	onActivateAutomation?: () => void;
	onInput?: () => void;
}

interface ITestViewCounters {
	owner: number;
	target: number;
	webContents: number;
	destroyed: number;
	state: number;
	capture: number;
	throttling: number;
	focus: number;
	prepareAutomation: number;
	activateAutomation: number;
	commitAutomation: number;
	completeAutomation: number;
	cancelAutomation: number;
	input: number;
}

function createTestView(overrides: Partial<ITestViewState> = {}): {
	readonly view: BrowserView;
	readonly state: ITestViewState;
	readonly counters: ITestViewCounters;
	readonly throttlingValues: boolean[];
	readonly captureOptions: unknown[];
	readonly inputCalls: Array<{ method: string; params: unknown; sessionId: string | undefined }>;
} {
	const state: ITestViewState = {
		ownerWindowId: 1,
		targetId: 'target-1',
		destroyed: false,
		visible: true,
		focused: false,
		focusAuthority: Object.freeze({}),
		automationReady: true,
		automationActivateReady: true,
		automationCommitReady: true,
		captureResult: Promise.resolve(VSBuffer.fromString('image')),
		inputResult: Promise.resolve({}),
		...overrides,
	};
	const counters: ITestViewCounters = {
		owner: 0,
		target: 0,
		webContents: 0,
		destroyed: 0,
		state: 0,
		capture: 0,
		throttling: 0,
		focus: 0,
		prepareAutomation: 0,
		activateAutomation: 0,
		commitAutomation: 0,
		completeAutomation: 0,
		cancelAutomation: 0,
		input: 0,
	};
	const throttlingValues: boolean[] = [];
	const captureOptions: unknown[] = [];
	const inputCalls: Array<{ method: string; params: unknown; sessionId: string | undefined }> = [];
	const webContents = {
		isDestroyed: () => {
			counters.destroyed++;
			if (state.throwDestroyed) {
				throw new Error('destroyed getter failed');
			}
			return state.destroyed;
		},
		setBackgroundThrottling: (enabled: boolean) => {
			counters.throttling++;
			if (state.throwThrottling) {
				throw new Error('throttling failed');
			}
			throttlingValues.push(enabled);
		},
		focus: () => counters.focus++,
		isFocused: () => state.focused,
	};
	const view = {
		get owner() {
			counters.owner++;
			if (state.throwOwner) {
				throw new Error('owner getter failed');
			}
			return { mainWindowId: state.ownerWindowId };
		},
		get debugger() {
			return {
				get targetId() {
					counters.target++;
					if (state.throwTarget) {
						throw new Error('target getter failed');
					}
					const targetId = state.targetId;
					state.onTargetRead?.();
					return targetId;
				},
				sendCommandRaw: (method: string, params: unknown, sessionId?: string) => {
					counters.input++;
					inputCalls.push({ method, params, sessionId });
					state.onInput?.();
					return state.inputResult;
				},
			};
		},
		get webContents() {
			counters.webContents++;
			return webContents;
		},
		getState: () => {
			counters.state++;
			if (state.throwVisible) {
				throw new Error('visibility failed');
			}
			const visible = state.visible;
			state.onVisibleRead?.();
			return { visible };
		},
		captureScreenshot: (options: unknown) => {
			counters.capture++;
			captureOptions.push(options);
			state.onCapture?.();
			return state.captureResult;
		},
		prepareAutomationKeyInput: async () => {
			counters.prepareAutomation++;
			state.onPrepareAutomation?.();
			return state.automationReady
				? {
					sequence: 1,
					activate: async () => {
						counters.activateAutomation++;
						state.onActivateAutomation?.();
						return state.automationActivateReady;
					},
					commit: () => { counters.commitAutomation++; return state.automationCommitReady; },
					complete: () => { counters.completeAutomation++; },
					cancel: () => { counters.cancelAutomation++; },
				}
				: undefined;
		},
		captureAutomationInputFocusAuthority: () => state.focusAuthority,
	};
	return { view: view as unknown as BrowserView, state, counters, throttlingValues, captureOptions, inputCalls };
}

function createRegistry(initialViews: Readonly<Record<string, BrowserView | undefined>>): {
	readonly service: IBrowserViewMainService;
	readonly views: Map<string, BrowserView | undefined>;
	readonly calls: { count: number };
} {
	const views = new Map(Object.entries(initialViews));
	const calls = { count: 0 };
	return {
		views,
		calls,
		service: {
			tryGetBrowserView: (viewId: string) => {
				calls.count++;
				return views.get(viewId);
			},
		} as unknown as IBrowserViewMainService,
	};
}

function descriptor(overrides: Partial<IParadisExactBrowserViewDescriptor> = {}): IParadisExactBrowserViewDescriptor {
	return {
		windowId: 1,
		viewId: 'view-1',
		targetId: 'target-1',
		viewLease: 'lease-1',
		...overrides,
	};
}

suite('ParadisCdpTargetService exact BrowserView authority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('strict descriptor parser returns a frozen copy and rejects malformed or extra fields', () => {
		const source = descriptor();
		const parsed = paradisParseExactBrowserViewDescriptor(source);
		assert.deepStrictEqual(parsed, source);
		assert.strictEqual(Object.isFrozen(parsed), true);

		const invalid: readonly unknown[] = [
			null,
			[],
			{ ...source, windowId: 0 },
			{ ...source, windowId: 1.5 },
			{ ...source, windowId: Number.MAX_SAFE_INTEGER + 1 },
			{ ...source, windowId: '1' },
			{ ...source, viewId: '' },
			{ ...source, viewId: 'x'.repeat(PARADIS_EXACT_VIEW_ID_MAX_LENGTH + 1) },
			{ ...source, targetId: '' },
			{ ...source, targetId: 'x'.repeat(PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH + 1) },
			{ ...source, viewLease: '' },
			{ ...source, viewLease: 'x'.repeat(PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH + 1) },
			{ ...source, extra: true },
			{ windowId: 1, viewId: 'view-1', targetId: 'target-1' },
		];
		for (const value of invalid) {
			assert.strictEqual(paradisParseExactBrowserViewDescriptor(value), undefined);
		}
		const throwingKeys = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys failed'); } });
		const throwingGetter = descriptor();
		Object.defineProperty(throwingGetter, 'viewLease', { enumerable: true, get: () => { throw new Error('getter failed'); } });
		assert.doesNotThrow(() => assert.strictEqual(paradisParseExactBrowserViewDescriptor(throwingKeys), undefined));
		assert.doesNotThrow(() => assert.strictEqual(paradisParseExactBrowserViewDescriptor(throwingGetter), undefined));
		for (const extraKey of ['hidden', Symbol('hidden')]) {
			const value = descriptor();
			Object.defineProperty(value, extraKey, { enumerable: false, value: true });
			assert.strictEqual(paradisParseExactBrowserViewDescriptor(value), undefined);
		}
		let targetReads = 0;
		const changingGetter = descriptor();
		Object.defineProperty(changingGetter, 'targetId', {
			enumerable: true,
			get: () => ++targetReads === 1 ? 'first-target' : 'x'.repeat(PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH + 1),
		});
		assert.deepStrictEqual(paradisParseExactBrowserViewDescriptor(changingGetter), { ...descriptor(), targetId: 'first-target' });
		assert.strictEqual(targetReads, 1);
	});

	test('resolves a copy-owned immutable descriptor and preserves one lease per concrete object', async () => {
		const first = createTestView();
		const second = createTestView({ ownerWindowId: 2, targetId: 'target-2' });
		const registry = createRegistry({ 'view-1': first.view, 'view-2': second.view });
		const leases = ['lease-first', 'lease-second'];
		const service = new ParadisCdpTargetService(registry.service, () => leases.shift()!);

		const firstDescriptor = await service.resolveExactViewDescriptor(1, 'view-1');
		const repeatedDescriptor = await service.resolveExactViewDescriptor(1, 'view-1');
		const secondDescriptor = await service.resolveExactViewDescriptor(2, 'view-2');

		assert.deepStrictEqual(firstDescriptor, { windowId: 1, viewId: 'view-1', targetId: 'target-1', viewLease: 'lease-first' });
		assert.notStrictEqual(firstDescriptor, repeatedDescriptor);
		assert.deepStrictEqual(repeatedDescriptor, firstDescriptor);
		assert.strictEqual(Object.isFrozen(firstDescriptor), true);
		assert.strictEqual(secondDescriptor?.viewLease, 'lease-second');
		assert.notStrictEqual(secondDescriptor?.viewLease, firstDescriptor?.viewLease);
	});

	test('strict screenshot parser returns a deeply frozen copy and preserves the supported option contract', () => {
		const source = {
			format: 'png' as const,
			quality: 80,
			pageRect: { x: 1, y: 2, width: 3, height: 4 },
			captureBeyondViewport: true,
		};
		const parsed = paradisParseExactCdpScreenshotOptions(source);
		assert.deepStrictEqual(parsed, source);
		assert.strictEqual(Object.isFrozen(parsed), true);
		assert.strictEqual(Object.isFrozen(parsed?.pageRect), true);
		source.pageRect.x = 100;
		assert.strictEqual(parsed?.pageRect?.x, 1);
		assert.strictEqual(paradisParseExactCdpScreenshotOptions({ captureBeyondViewport: true }), undefined);
		assert.strictEqual(paradisParseExactCdpScreenshotOptions({ fullPage: true, captureBeyondViewport: true }), undefined);
		assert.deepStrictEqual(paradisParseExactCdpScreenshotOptions({ captureBeyondViewport: false }), { captureBeyondViewport: false });
		assert.deepStrictEqual(paradisParseExactCdpScreenshotOptions(Object.create({ format: 'png' })), {});
		let formatReads = 0;
		const changingFormat: Record<string, unknown> = {};
		Object.defineProperty(changingFormat, 'format', {
			enumerable: true,
			get: () => ++formatReads === 1 ? 'png' : 'webp',
		});
		assert.deepStrictEqual(paradisParseExactCdpScreenshotOptions(changingFormat), { format: 'png' });
		assert.strictEqual(formatReads, 1);
		for (const extraKey of ['hidden', Symbol('hidden')]) {
			const topLevel = {};
			Object.defineProperty(topLevel, extraKey, { enumerable: false, value: true });
			assert.strictEqual(paradisParseExactCdpScreenshotOptions(topLevel), undefined);

			const pageRect = { x: 0, y: 0, width: 1, height: 1 };
			Object.defineProperty(pageRect, extraKey, { enumerable: false, value: true });
			assert.strictEqual(paradisParseExactCdpScreenshotOptions({ pageRect }), undefined);
		}
	});

	test('resolver fails closed for malformed arguments, wrong owner, absent/destroyed views, target failure and invalid lease output', async () => {
		const valid = createTestView();
		const destroyed = createTestView({ destroyed: true });
		const targetFailure = createTestView({ throwTarget: true });
		const registry = createRegistry({ valid: valid.view, destroyed: destroyed.view, failure: targetFailure.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease');

		for (const args of [[0, 'valid'], [1.5, 'valid'], ['1', 'valid'], [1, ''], [1, 'x'.repeat(PARADIS_EXACT_VIEW_ID_MAX_LENGTH + 1)], [1, 1]] as const) {
			const before = registry.calls.count;
			assert.strictEqual(await service.resolveExactViewDescriptor(args[0], args[1]), null);
			assert.strictEqual(registry.calls.count, before);
		}
		assert.strictEqual(await service.resolveExactViewDescriptor(2, 'valid'), null);
		assert.strictEqual(await service.resolveExactViewDescriptor(1, 'absent'), null);
		assert.strictEqual(await service.resolveExactViewDescriptor(1, 'destroyed'), null);
		assert.strictEqual(await service.resolveExactViewDescriptor(1, 'failure'), null);

		for (const leaseFactory of [
			() => '',
			() => 'x'.repeat(PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH + 1),
			() => 1 as unknown as string,
			() => ({}) as unknown as string,
			() => null as unknown as string,
			() => { throw new Error('entropy failed'); },
		]) {
			const invalidLeaseService = new ParadisCdpTargetService(registry.service, leaseFactory);
			assert.strictEqual(await invalidLeaseService.resolveExactViewDescriptor(1, 'valid'), null);
		}
	});

	test('resolver rejects replacement during target lookup', async () => {
		const first = createTestView();
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': first.view });
		first.state.onTargetRead = () => registry.views.set('view-1', replacement.view);
		const service = new ParadisCdpTargetService(registry.service, () => 'lease');

		assert.strictEqual(await service.resolveExactViewDescriptor(1, 'view-1'), null);
	});

	test('resolver rejects replacement during its final identity read', async () => {
		const first = createTestView();
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': first.view });
		let targetReads = 0;
		first.state.onTargetRead = () => {
			if (++targetReads === 3) {
				registry.views.set('view-1', replacement.view);
			}
		};
		const service = new ParadisCdpTargetService(registry.service, () => 'lease');

		assert.strictEqual(await service.resolveExactViewDescriptor(1, 'view-1'), null);
	});

	test('replacement after descriptor creation is rejected lease-first without touching replacement capabilities', async () => {
		const first = createTestView();
		const replacement = createTestView({ throwOwner: true, throwTarget: true, throwDestroyed: true, throwVisible: true, throwThrottling: true });
		const registry = createRegistry({ 'view-1': first.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		registry.views.set('view-1', replacement.view);

		assert.strictEqual(await service.isExactViewVisible(exact), null);
		assert.strictEqual(await service.captureExactViewScreenshot(exact, {}), null);
		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, false), false);
		assert.deepStrictEqual(replacement.counters, {
			owner: 0,
			target: 0,
			webContents: 0,
			destroyed: 0,
			state: 0,
			capture: 0,
			throttling: 0,
			focus: 0,
			prepareAutomation: 0,
			activateAutomation: 0,
			commitAutomation: 0,
			completeAutomation: 0,
			cancelAutomation: 0,
			input: 0,
		});
	});

	test('target change on the same object rejects an old descriptor', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		current.state.targetId = 'target-2';

		assert.strictEqual(await service.isExactViewVisible(exact), null);
		assert.strictEqual(await service.captureExactViewScreenshot(exact, {}), null);
		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, false), false);
	});

	test('malformed descriptors, screenshot options and throttling fail before registry access', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const invalidDescriptors: readonly unknown[] = [null, [], { ...exact, extra: true }, { ...exact, windowId: '1' }];
		for (const invalid of invalidDescriptors) {
			const before = registry.calls.count;
			assert.strictEqual(await service.isExactViewVisible(invalid), null);
			assert.strictEqual(await service.captureExactViewScreenshot(invalid, {}), null);
			assert.strictEqual(await service.setExactViewBackgroundThrottling(invalid, false), false);
			assert.strictEqual(registry.calls.count, before);
		}

		const invalidOptions: readonly unknown[] = [
			null,
			[],
			{ format: 'webp' },
			{ quality: -1 },
			{ quality: 1.5 },
			{ fullPage: 'true' },
			{ captureBeyondViewport: 1 },
			{ captureBeyondViewport: true },
			{ pageRect: null },
			{ pageRect: { x: 0, y: 0, width: 1, height: 1, extra: true } },
			{ pageRect: { x: 0, y: 0, width: 0, height: 1 } },
			{ pageRect: { x: 0, y: 0, width: 8193, height: 1 } },
			{ pageRect: { x: 0, y: 0, width: 8192, height: 8192 } },
			{ pageRect: { x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1 } },
			{ pageRect: { x: 0, y: 0, width: 1, height: 1 }, fullPage: true },
			{ unexpected: true },
			new Proxy({}, { ownKeys: () => { throw new Error('ownKeys failed'); } }),
		];
		for (const invalid of invalidOptions) {
			const before = registry.calls.count;
			assert.strictEqual(await service.captureExactViewScreenshot(exact, invalid), null);
			assert.strictEqual(registry.calls.count, before);
		}
		for (const invalid of [null, 0, 1, 'false', {}, []]) {
			const before = registry.calls.count;
			assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, invalid), false);
			assert.strictEqual(registry.calls.count, before);
		}
		assert.strictEqual(current.counters.capture, 0);
		assert.strictEqual(current.counters.throttling, 0);
	});

	test('final validation detects reentrant replacement before any exact side effect', async () => {
		const current = createTestView();
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		let targetReads = 0;
		current.state.onTargetRead = () => {
			if (++targetReads === 2) {
				registry.views.set('view-1', replacement.view);
			}
		};

		assert.strictEqual(await service.captureExactViewScreenshot(exact, {}), null);
		assert.strictEqual(current.counters.capture, 0);
		assert.strictEqual(replacement.counters.capture, 0);
	});

	test('visibility validates before and after the read and turns read exceptions into null', async () => {
		const current = createTestView({ visible: false });
		const replacement = createTestView({ visible: true });
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		assert.strictEqual(await service.isExactViewVisible(exact), false);

		current.state.onVisibleRead = () => registry.views.set('view-1', replacement.view);
		assert.strictEqual(await service.isExactViewVisible(exact), null);
		registry.views.set('view-1', current.view);
		current.state.onVisibleRead = undefined;
		current.state.throwVisible = true;
		assert.strictEqual(await service.isExactViewVisible(exact), null);
	});

	test('screenshot validates after await and gives stale authority precedence over capture rejection', async () => {
		let resolveCapture!: (value: VSBuffer) => void;
		const successCapture = new Promise<VSBuffer>(resolve => resolveCapture = resolve);
		const current = createTestView({ captureResult: successCapture });
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;

		const pendingSuccess = service.captureExactViewScreenshot(exact, { format: 'png', pageRect: { x: 1, y: 2, width: 3, height: 4 }, captureBeyondViewport: true });
		registry.views.set('view-1', replacement.view);
		resolveCapture(VSBuffer.fromString('image'));
		assert.strictEqual(await pendingSuccess, null);

		let rejectCapture!: (error: unknown) => void;
		current.state.captureResult = new Promise<VSBuffer>((_resolve, reject) => rejectCapture = reject);
		registry.views.set('view-1', current.view);
		const pendingReject = service.captureExactViewScreenshot(exact, {});
		registry.views.set('view-1', replacement.view);
		const staleError = new Error('capture failed stale');
		rejectCapture(staleError);
		assert.strictEqual(await pendingReject, null);

		const currentError = new Error('capture failed current');
		current.state.captureResult = Promise.reject(currentError);
		registry.views.set('view-1', current.view);
		await assert.rejects(service.captureExactViewScreenshot(exact, {}), error => error === currentError);
	});

	test('screenshot passes a deeply frozen owned copy of every supported option field', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const source = {
			format: 'jpeg' as const,
			quality: 42,
			pageRect: { x: 1, y: 2, width: 3, height: 4 },
			captureBeyondViewport: true,
		};

		const firstCapture = service.captureExactViewScreenshot(exact, source);
		source.quality = 99;
		source.pageRect.x = 100;
		assert.strictEqual(await firstCapture, Buffer.from('image').toString('base64'));
		assert.strictEqual(await service.captureExactViewScreenshot(exact, { format: 'png', fullPage: true }), Buffer.from('image').toString('base64'));

		assert.deepStrictEqual(current.captureOptions, [
			{ format: 'jpeg', quality: 42, pageRect: { x: 1, y: 2, width: 3, height: 4 }, captureBeyondViewport: true },
			{ format: 'png', fullPage: true },
		]);
		assert.strictEqual(Object.isFrozen(current.captureOptions[0]), true);
		assert.strictEqual(Object.isFrozen((current.captureOptions[0] as { pageRect: object }).pageRect), true);
		assert.strictEqual(Object.isFrozen(current.captureOptions[1]), true);
	});

	test('exact throttling touches only a live exact object and reports synchronous failures', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;

		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, false), true);
		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, true), true);
		assert.deepStrictEqual(current.throttlingValues, [false, true]);
		current.state.throwThrottling = true;
		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, false), false);
	});

	test('dispatches every allowed input through the exact BrowserView debugger root without focusing', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const commands: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'A', code: 'KeyA' }],
			['Input.insertText', { text: 'hello' }],
			['Input.imeSetComposition', { text: '変換', selectionStart: 0, selectionEnd: 2 }],
			['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 }],
			['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 2 }] }],
			['Input.dispatchDragEvent', { type: 'dragEnter', x: 1, y: 2, data: { items: [], files: [], dragOperationsMask: 1 } }],
		];

		for (const [method, params] of commands) {
			assert.deepStrictEqual(await service.dispatchExactViewInput(exact, method, JSON.stringify(params)), {
				status: 'success', result: {},
			});
		}

		assert.deepStrictEqual(current.inputCalls, commands.map(([method, params]) => ({ method, params, sessionId: undefined })));
		assert.strictEqual(current.counters.prepareAutomation, 1);
		assert.strictEqual(current.counters.activateAutomation, 1);
		assert.strictEqual(current.counters.commitAutomation, 1);
		assert.strictEqual(current.counters.completeAutomation, 1);
		assert.strictEqual(current.counters.cancelAutomation, 0);
		assert.strictEqual(current.counters.focus, 0);
	});

	test('rejects every automation input while the exact BrowserView is user-focused', async () => {
		const current = createTestView({ focused: true });
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;

		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchMouseEvent', JSON.stringify({ type: 'mouseMoved', x: 1, y: 2 })), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.prepareAutomation, 0);
		assert.strictEqual(current.counters.focus, 0);
	});

	test('requires preload registration ack and revalidates focus and identity before debugger send', async () => {
		const current = createTestView({ automationReady: false });
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const params = JSON.stringify({ type: 'keyDown', key: 'Escape', code: 'Escape' });

		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be registered',
		});
		assert.strictEqual(current.counters.input, 0);

		current.state.automationReady = true;
		current.state.onPrepareAutomation = () => { current.state.focused = true; };
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView became focused before input dispatch',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 0);
		assert.strictEqual(current.counters.completeAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 1);

		current.state.focused = false;
		current.state.onPrepareAutomation = () => registry.views.set('view-1', replacement.view);
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView authority changed before input dispatch',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 0);
		assert.strictEqual(current.counters.completeAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 2);

		registry.views.set('view-1', current.view);
		current.state.onPrepareAutomation = undefined;
		current.state.automationCommitReady = false;
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression was cancelled before input dispatch',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 1);
		assert.strictEqual(current.counters.completeAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 3);
	});

	test('activates preload suppression in a second phase and revalidates focus and identity afterwards', async () => {
		const current = createTestView({ automationActivateReady: false });
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const params = JSON.stringify({ type: 'keyDown', key: 'Escape', code: 'Escape' });

		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be activated',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 1);

		current.state.automationActivateReady = true;
		current.state.onActivateAutomation = () => { current.state.focused = true; };
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView became focused before input dispatch',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 2);

		current.state.focused = false;
		current.state.onActivateAutomation = () => registry.views.set('view-1', replacement.view);
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchKeyEvent', params), {
			status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView authority changed before input dispatch',
		});
		assert.strictEqual(current.counters.input, 0);
		assert.strictEqual(current.counters.commitAutomation, 0);
		assert.strictEqual(current.counters.cancelAutomation, 3);
	});

	test('reports target replacement and debugger failure after send as outcome unknown', async () => {
		const current = createTestView();
		const replacement = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const params = JSON.stringify({ type: 'mouseMoved', x: 1, y: 2 });

		current.state.onInput = () => registry.views.set('view-1', replacement.view);
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchMouseEvent', params), {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: exact BrowserView authority changed after input dispatch',
		});

		registry.views.set('view-1', current.view);
		current.state.onInput = undefined;
		current.state.inputResult = Promise.reject(new Error('debugger detached'));
		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchMouseEvent', params), {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView debugger input dispatch did not complete',
		});
		assert.strictEqual(current.counters.focus, 0);
	});

	test('reports even a focus then blur transition during debugger send as outcome unknown', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		current.state.onInput = () => {
			current.state.focused = true;
			current.state.focusAuthority = Object.freeze({});
			current.state.focused = false;
			current.state.focusAuthority = Object.freeze({});
		};

		assert.deepStrictEqual(await service.dispatchExactViewInput(exact, 'Input.dispatchMouseEvent', JSON.stringify({ type: 'mouseMoved', x: 1, y: 2 })), {
			status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView focus authority changed after input dispatch',
		});
		assert.strictEqual(current.counters.input, 1);
		assert.strictEqual(current.counters.focus, 0);
	});

	test('rejects unsupported or malformed input before touching an exact BrowserView', async () => {
		const current = createTestView();
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		const callsBefore = registry.calls.count;

		for (const [method, params] of [
			['Input.setIgnoreInputEvents', '{}'],
			['Input.dispatchKeyEvent', JSON.stringify({ type: 'keyDown', key: 'A' })],
			['Runtime.evaluate', '{}'],
			['Input.insertText', '{'],
		] as const) {
			const result = await service.dispatchExactViewInput(exact, method, params);
			assert.strictEqual(result.status, 'retryable');
			assert.match(result.status === 'retryable' ? result.message : '', new RegExp(method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		}
		assert.strictEqual(registry.calls.count, callsBefore);
		assert.strictEqual(current.counters.input, 0);
	});

	test('exact paths are independent from all viewId-only legacy and focus methods', async () => {
		const current = createTestView({ visible: true });
		const registry = createRegistry({ 'view-1': current.view });
		const service = new ParadisCdpTargetService(registry.service, () => 'lease-1');
		const exact = (await service.resolveExactViewDescriptor(1, 'view-1'))!;
		for (const method of ['resolveTargetId', 'isViewVisible', 'captureScreenshot', 'setBackgroundThrottling'] as const) {
			Reflect.set(service, method, () => { throw new Error(`legacy ${method} called`); });
		}

		assert.strictEqual(await service.isExactViewVisible(exact), true);
		assert.strictEqual(await service.captureExactViewScreenshot(exact, {}), Buffer.from('image').toString('base64'));
		assert.strictEqual(await service.setExactViewBackgroundThrottling(exact, false), true);
		assert.strictEqual(current.counters.focus, 0);
	});
});
