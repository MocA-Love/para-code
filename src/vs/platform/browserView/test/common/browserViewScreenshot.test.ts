/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES, BROWSER_VIEW_SCREENSHOT_MAX_QUEUE_DEPTH, BrowserViewScreenshotCoordinator, browserViewAssertScreenshotPixelBudget, browserViewBitmapHasVisibleAlpha, browserViewCalculateBoundedCaptureScale, browserViewEffectiveCaptureBeyondDevicePixelRatio, browserViewScreenshotCoalesceKey, browserViewScreenshotRoute, browserViewThrowIfScreenshotAborted, browserViewValidateAndEncodeScreenshot, captureBrowserViewScreenshotWithPolicy, captureBrowserViewWithRestore, captureBrowserViewWithRetry, prepareBrowserViewScreenshotCapture } from '../../common/browserViewScreenshot.js';

suite('BrowserView screenshot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects empty and fully transparent RGBA bitmaps', () => {
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array()), false);
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 0])), false);
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 0, 40, 50, 60, 0])), false);
	});

	test('accepts a bitmap when any pixel has visible alpha', () => {
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 0, 40, 50, 60, 1])), true);
		assert.strictEqual(browserViewBitmapHasVisibleAlpha(new Uint8Array([10, 20, 30, 255])), true);
	});

	test('waits for a paint before each retry and returns the first valid capture', async () => {
		const order: string[] = [];
		let attempt = 0;
		const result = await captureBrowserViewWithRetry(
			async () => {
				order.push(`capture-${++attempt}`);
				return attempt;
			},
			value => value === 3,
			async () => { order.push('paint'); },
		);

		assert.strictEqual(result, 3);
		assert.deepStrictEqual(order, ['capture-1', 'paint', 'capture-2', 'paint', 'capture-3']);
	});

	test('retries UnknownVizError after waiting for a paint', async () => {
		const order: string[] = [];
		let attempt = 0;
		const result = await captureBrowserViewWithRetry(
			async () => {
				order.push(`capture-${++attempt}`);
				if (attempt === 1) {
					throw new Error('UnknownVizError');
				}
				return 'opaque';
			},
			value => value === 'opaque',
			async () => { order.push('paint'); },
		);

		assert.strictEqual(result, 'opaque');
		assert.deepStrictEqual(order, ['capture-1', 'paint', 'capture-2']);
	});

	test('stops after five invalid captures and waits only between attempts', async () => {
		let captures = 0;
		let paints = 0;
		await assert.rejects(
			captureBrowserViewWithRetry(
				async () => ++captures,
				() => false,
				async () => { paints++; },
			),
			/5 attempts/,
		);
		assert.strictEqual(captures, 5);
		assert.strictEqual(paints, 4);
	});

	test('does not retry non-transient capture errors', async () => {
		let captures = 0;
		let paints = 0;
		const failure = new Error('renderer destroyed');
		await assert.rejects(
			captureBrowserViewWithRetry(
				async () => {
					captures++;
					throw failure;
				},
				() => true,
				async () => { paints++; },
			),
			error => error === failure,
		);
		assert.strictEqual(captures, 1);
		assert.strictEqual(paints, 0);
	});

	test('times out, aborts, and holds the slot for a queued distinct capture until the underlying attempt settles', async () => {
		let release!: () => void;
		let signal!: AbortSignal;
		let secondStarted = false;
		const gate = new Promise<void>(resolve => release = resolve);
		const coordinator = new BrowserViewScreenshotCoordinator(10);
		const first = coordinator.run(async currentSignal => {
			signal = currentSignal;
			await gate;
			return 'late';
		}, { key: 'a' });

		await assert.rejects(first, /timed out after 10ms/);
		assert.strictEqual(signal.aborted, true);

		// A distinct-key request queues behind the still-running underlying capture instead of rejecting.
		const second = coordinator.run(async () => {
			secondStarted = true;
			return 'recovered';
		}, { key: 'b' });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(secondStarted, false, 'queued capture must wait for the underlying capture to settle');

		release();
		assert.strictEqual(await second, 'recovered');
	});

	test('coalesces concurrent identical-key captures into a single in-flight capture', async () => {
		let release!: () => void;
		let captures = 0;
		const gate = new Promise<void>(resolve => release = resolve);
		const coordinator = new BrowserViewScreenshotCoordinator(1000);
		const operation = async () => {
			captures++;
			await gate;
			return `image-${captures}`;
		};
		const first = coordinator.run(operation, { key: 'same' });
		const second = coordinator.run(operation, { key: 'same' });

		release();
		const [a, b] = await Promise.all([first, second]);
		assert.strictEqual(captures, 1);
		assert.strictEqual(a, 'image-1');
		assert.strictEqual(b, 'image-1');
	});

	test('runs distinct-key captures serially through the FIFO and rejects on overflow', async () => {
		const order: string[] = [];
		const gates: Array<() => void> = [];
		const coordinator = new BrowserViewScreenshotCoordinator(1000, 2);
		const make = (name: string) => coordinator.run(async () => {
			order.push(`start-${name}`);
			await new Promise<void>(resolve => gates.push(() => { order.push(`end-${name}`); resolve(); }));
			return name;
		}, { key: name });

		const active = make('a'); // becomes active immediately
		const queued1 = make('b'); // queue depth 1
		const queued2 = make('c'); // queue depth 2 (full)
		// Queue is full (depth 2); a further distinct request rejects retryable.
		await assert.rejects(make('d'), /still in progress/);

		// Drain in order: each capture only starts after the previous one settles.
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(order, ['start-a']);
		gates.shift()!();
		assert.strictEqual(await active, 'a');
		await new Promise(resolve => setTimeout(resolve, 0));
		gates.shift()!();
		assert.strictEqual(await queued1, 'b');
		await new Promise(resolve => setTimeout(resolve, 0));
		gates.shift()!();
		assert.strictEqual(await queued2, 'c');
		assert.deepStrictEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
	});

	test('derives a coalescing key that is stable for equal parameters and distinct otherwise', () => {
		assert.strictEqual(
			browserViewScreenshotCoalesceKey({ fullPage: true, format: 'png', quality: 90 }),
			browserViewScreenshotCoalesceKey({ fullPage: true, format: 'png', quality: 90 }),
		);
		assert.notStrictEqual(
			browserViewScreenshotCoalesceKey({ fullPage: true, format: 'png' }),
			browserViewScreenshotCoalesceKey({ fullPage: true, format: 'jpeg' }),
		);
		assert.notStrictEqual(
			browserViewScreenshotCoalesceKey({ pageRect: { x: 0, y: 0, width: 10, height: 10 } }),
			browserViewScreenshotCoalesceKey({ pageRect: { x: 0, y: 0, width: 20, height: 10 } }),
		);
		assert.strictEqual(BROWSER_VIEW_SCREENSHOT_MAX_QUEUE_DEPTH, 4);
	});

	test('does not retry a timed-out attempt after its underlying capture returns late', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => release = resolve);
		let captures = 0;
		let paints = 0;
		let postCaptureWork = 0;
		const coordinator = new BrowserViewScreenshotCoordinator(10);
		const request = coordinator.run(signal => captureBrowserViewWithRetry(
			async signal => {
				captures++;
				await gate;
				browserViewThrowIfScreenshotAborted(signal);
				postCaptureWork++;
				return 'transparent';
			},
			() => false,
			async () => { paints++; },
			5,
			{ signal },
		));

		await assert.rejects(request, /timed out after 10ms/);
		release();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(captures, 1);
		assert.strictEqual(paints, 0);
		assert.strictEqual(postCaptureWork, 0);
	});

	test('clears the timeout after a successful capture', async () => {
		let signal!: AbortSignal;
		const coordinator = new BrowserViewScreenshotCoordinator(10);
		assert.strictEqual(await coordinator.run(async currentSignal => {
			signal = currentSignal;
			return 'done';
		}), 'done');
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.strictEqual(signal.aborted, false);
	});

	test('prepares hidden capture by restoring hidden state before the initial paint', async () => {
		const order: string[] = [];
		await prepareBrowserViewScreenshotCapture(
			false,
			visible => order.push(`visible-${visible}`),
			async () => { order.push('paint'); },
			false,
		);
		assert.deepStrictEqual(order, ['visible-true', 'visible-false', 'paint']);

		order.length = 0;
		await prepareBrowserViewScreenshotCapture(true, () => order.push('visible'), async () => { order.push('paint'); }, false);
		assert.deepStrictEqual(order, []);
	});

	test('routes viewport, full-page, and document-clip captures deterministically', () => {
		assert.strictEqual(browserViewScreenshotRoute(undefined), 'viewport');
		assert.strictEqual(browserViewScreenshotRoute({ screenRect: { x: 0, y: 0, width: 10, height: 10 } }), 'viewport-rect');
		assert.strictEqual(browserViewScreenshotRoute({ fullPage: true }), 'full-page');
		assert.strictEqual(browserViewScreenshotRoute({ pageRect: { x: 0, y: 0, width: 10, height: 10 }, captureBeyondViewport: true }), 'document-rect');
	});

	test('wires coordination, hidden preparation, route selection, and capture in production order', async () => {
		const order: string[] = [];
		const result = await captureBrowserViewScreenshotWithPolicy(
			new BrowserViewScreenshotCoordinator(100),
			{ fullPage: true },
			{
				isVisible: () => false,
				setPrivateVisible: visible => order.push(`visible-${visible}`),
				waitForNextPaint: async () => { order.push('paint'); },
				capture: async (route, signal) => {
					assert.strictEqual(signal.aborted, false);
					order.push(`capture-${route}`);
					return 'image';
				},
			},
		);

		assert.strictEqual(result, 'image');
		assert.deepStrictEqual(order, ['visible-true', 'visible-false', 'paint', 'capture-full-page']);
	});

	test('awaits zoom restoration for every beyond-viewport capture without masking its result', async () => {
		const order: string[] = [];
		const result = await captureBrowserViewWithRestore(
			async () => { order.push('capture'); return 'image'; },
			async () => { order.push('restore'); },
		);
		assert.strictEqual(result, 'image');
		assert.deepStrictEqual(order, ['capture', 'restore']);

		assert.strictEqual(await captureBrowserViewWithRestore(
			async () => 'image',
			async () => { throw new Error('zoom failed'); },
			() => order.push('restore-error'),
		), 'image');
		assert.strictEqual(order.at(-1), 'restore-error');
	});

	test('enforces output-pixel limits after Retina, zoom, viewport, and emulation scales', () => {
		assert.deepStrictEqual(browserViewAssertScreenshotPixelBudget({
			width: 1_800,
			height: 900,
			devicePixelRatio: 2,
			zoomFactor: 1.5,
		}), { width: 5_400, height: 2_700, pixels: 14_580_000 });
		assert.throws(() => browserViewAssertScreenshotPixelBudget({
			width: 3_000,
			height: 2_000,
			devicePixelRatio: 2,
			zoomFactor: 1.5,
			visualViewportScale: 1.25,
			emulationScale: 1.5,
		}), /pixel budget/);
	});

	test('calculates a capture scale that retains the full-page 2576px physical edge limit', () => {
		const scale = browserViewCalculateBoundedCaptureScale({ width: 4_000, height: 2_000, devicePixelRatio: 2 }, 2_576);
		assert.strictEqual(scale, 0.322);
		const estimate = browserViewAssertScreenshotPixelBudget({ width: 4_000, height: 2_000, devicePixelRatio: 2, captureScale: scale }, 2_576, 2_576 * 2_576);
		assert.deepStrictEqual(estimate, { width: 2_576, height: 1_288, pixels: 3_317_888 });
	});

	test('keeps a mathematically exact edge limit inside the budget despite floating point rounding', () => {
		const scale = browserViewCalculateBoundedCaptureScale({ width: 2_178, height: 1_000, devicePixelRatio: 2 }, 2_576);
		const estimate = browserViewAssertScreenshotPixelBudget({ width: 2_178, height: 1_000, devicePixelRatio: 2, captureScale: scale }, 2_576, 2_576 * 2_576);
		assert.strictEqual(estimate.width, 2_576);
		assert.ok(2_178 * 2 * scale <= 2_576);
	});

	test('uses the safer device scale for CDP captures beyond the compositor viewport', () => {
		assert.strictEqual(browserViewEffectiveCaptureBeyondDevicePixelRatio(2, 3), 3);
		assert.strictEqual(browserViewEffectiveCaptureBeyondDevicePixelRatio(2, 1), 2);
		assert.strictEqual(browserViewEffectiveCaptureBeyondDevicePixelRatio(2, 0), 2);
	});

	test('validates and encodes an image once, after empty/dimension/alpha checks', () => {
		let encodes = 0;
		const transparent = browserViewValidateAndEncodeScreenshot({
			empty: false,
			width: 1,
			height: 1,
			bitmap: new Uint8Array([0, 0, 0, 0]),
			encode: () => { encodes++; return new Uint8Array([1]); },
		});
		assert.strictEqual(transparent.valid, false);
		assert.strictEqual(encodes, 0);

		const opaque = browserViewValidateAndEncodeScreenshot({
			empty: false,
			width: 1,
			height: 1,
			bitmap: new Uint8Array([0, 0, 0, 255]),
			encode: () => { encodes++; return new Uint8Array([1, 2, 3]); },
		});
		assert.strictEqual(opaque.valid, true);
		assert.deepStrictEqual(opaque.encoded, new Uint8Array([1, 2, 3]));
		assert.strictEqual(encodes, 1);

		const encodeError = browserViewValidateAndEncodeScreenshot({
			empty: false,
			width: 1,
			height: 1,
			bitmap: new Uint8Array([0, 0, 0, 255]),
			encode: () => { throw new Error('encoder unavailable'); },
		});
		assert.deepStrictEqual(encodeError, { valid: false, reason: 'encode-error', width: 1, height: 1 });
	});

	test('accepts the encoded byte boundary and rejects one byte beyond it', () => {
		const input = {
			empty: false,
			width: 1,
			height: 1,
			bitmap: new Uint8Array([0, 0, 0, 255]),
		};
		const boundary = browserViewValidateAndEncodeScreenshot({
			...input,
			encode: () => new Uint8Array(BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES),
		});
		assert.strictEqual(boundary.valid, true);

		assert.throws(() => browserViewValidateAndEncodeScreenshot({
			...input,
			encode: () => new Uint8Array(BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES + 1),
		}), /encoded image exceeds.*transport budget/i);
	});

	test('keeps a maximum encoded screenshot below the 32 MiB base64 JSON transport envelope', () => {
		const data = Buffer.alloc(BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES).toString('base64');
		const response = JSON.stringify({
			id: Number.MAX_SAFE_INTEGER,
			sessionId: 'x'.repeat(512),
			result: { data },
		});
		assert.ok(Buffer.byteLength(response, 'utf8') < 32 * 1024 * 1024);
	});

	test('rejects an oversized decoded image before copying its bitmap or retrying validation', () => {
		let bitmapReads = 0;
		assert.throws(() => browserViewValidateAndEncodeScreenshot({
			empty: false,
			width: 8_193,
			height: 1,
			bitmap: () => { bitmapReads++; return new Uint8Array([0, 0, 0, 255]); },
			encode: () => new Uint8Array([1]),
		}), /pixel budget/);
		assert.strictEqual(bitmapReads, 0);
	});
});
