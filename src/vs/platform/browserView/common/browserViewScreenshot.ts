/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Electron's NativeImage bitmap uses four bytes per pixel and stores alpha at byte offset 3.
 */
export function browserViewBitmapHasVisibleAlpha(bitmap: Uint8Array): boolean {
	for (let offset = 3; offset < bitmap.byteLength; offset += 4) {
		if (bitmap[offset] !== 0) {
			return true;
		}
	}
	return false;
}

export const BROWSER_VIEW_SCREENSHOT_TIMEOUT_MS = 30_000;
export const BROWSER_VIEW_SCREENSHOT_MAX_EDGE = 8_192;
export const BROWSER_VIEW_SCREENSHOT_MAX_PIXELS = 16 * 1024 * 1024;
// A 23 MiB image expands to about 30.7 MiB as base64, leaving over 1 MiB for the CDP JSON
// envelope beneath the gateway's 32 MiB screenshot-frame limit.
export const BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES = 23 * 1024 * 1024;
export const BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX = 'BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE:';

const neverAbortedSignal = new AbortController().signal;

function screenshotAbortReason(signal: AbortSignal | undefined): Error | undefined {
	if (!signal?.aborted) {
		return undefined;
	}
	return signal.reason instanceof Error ? signal.reason : new Error('BrowserView screenshot capture was aborted.');
}

export function browserViewThrowIfScreenshotAborted(signal: AbortSignal | undefined): void {
	const reason = screenshotAbortReason(signal);
	if (reason) {
		throw reason;
	}
}

export class BrowserViewScreenshotCoordinator {
	private _activeCapture: object | undefined;

	constructor(private readonly timeoutMs = BROWSER_VIEW_SCREENSHOT_TIMEOUT_MS) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error('BrowserView screenshot timeout must be a positive finite number.');
		}
	}

	run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this._activeCapture) {
			return Promise.reject(new Error('PARA_BROWSER_RETRYABLE: a previous BrowserView screenshot capture is still in progress; retry after it settles.'));
		}
		const capture = {};
		this._activeCapture = capture;
		const controller = new AbortController();
		const underlying = Promise.resolve()
			.then(() => operation(controller.signal))
			.finally(() => {
				if (this._activeCapture === capture) {
					this._activeCapture = undefined;
				}
			});
		// Keep an explicit rejection observer after a timeout wins the public race.
		void underlying.catch(() => undefined);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error(`PARA_BROWSER_RETRYABLE: BrowserView screenshot capture timed out after ${this.timeoutMs}ms.`);
				controller.abort(error);
				reject(error);
			}, this.timeoutMs);
		});
		return Promise.race([underlying, timeout]).finally(() => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		});
	}
}

export interface IBrowserViewScreenshotRetryEvent {
	readonly attempt: number;
	readonly reason: 'invalid-image' | 'unknown-viz';
}

export interface IBrowserViewScreenshotRetryOptions {
	readonly signal?: AbortSignal;
	readonly onRetry?: (event: IBrowserViewScreenshotRetryEvent) => void;
}

function isUnknownVizError(error: unknown): boolean {
	return error instanceof Error && error.message === 'UnknownVizError';
}

/**
 * Captures up to `maxAttempts` times. Invalid images and Electron's transient
 * UnknownVizError wait for a new compositor paint before the next attempt.
 */
export async function captureBrowserViewWithRetry<T>(
	capture: (signal: AbortSignal, attempt: number) => Promise<T>,
	isValid: (value: T, attempt: number) => boolean,
	waitForNextPaint: (signal: AbortSignal, attempt: number) => Promise<void>,
	maxAttempts = 5,
	options?: IBrowserViewScreenshotRetryOptions,
): Promise<T> {
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error('maxAttempts must be a positive integer');
	}
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const signal = options?.signal ?? neverAbortedSignal;
		browserViewThrowIfScreenshotAborted(options?.signal);
		try {
			const value = await capture(signal, attempt);
			browserViewThrowIfScreenshotAborted(options?.signal);
			if (isValid(value, attempt)) {
				return value;
			}
			lastError = new Error('Screenshot was empty or fully transparent');
			options?.onRetry?.({ attempt, reason: 'invalid-image' });
		} catch (error) {
			const aborted = screenshotAbortReason(options?.signal);
			if (aborted) {
				throw aborted;
			}
			if (!isUnknownVizError(error)) {
				throw error;
			}
			lastError = error;
			options?.onRetry?.({ attempt, reason: 'unknown-viz' });
		}
		if (attempt < maxAttempts) {
			await waitForNextPaint(signal, attempt);
			browserViewThrowIfScreenshotAborted(options?.signal);
		}
	}
	throw new Error(`Failed to capture a non-empty, visible screenshot after ${maxAttempts} attempts`, { cause: lastError });
}

export async function prepareBrowserViewScreenshotCapture(
	isVisible: boolean,
	setPrivateVisible: (visible: boolean) => void,
	waitForNextPaint: () => Promise<void>,
	awaitNextPaint: boolean,
	signal?: AbortSignal,
): Promise<void> {
	browserViewThrowIfScreenshotAborted(signal);
	if (!isVisible) {
		try {
			setPrivateVisible(true);
		} finally {
			setPrivateVisible(false);
		}
	}
	if (!isVisible || awaitNextPaint) {
		await waitForNextPaint();
		browserViewThrowIfScreenshotAborted(signal);
	}
}

export async function captureBrowserViewWithRestore<T>(
	capture: () => Promise<T>,
	restore: () => Promise<void>,
	onRestoreError: (error: unknown) => void = () => undefined,
): Promise<T> {
	try {
		return await capture();
	} finally {
		try {
			await restore();
		} catch (error) {
			onRestoreError(error);
		}
	}
}

export interface IBrowserViewScreenshotRouteOptions {
	readonly screenRect?: unknown;
	readonly pageRect?: unknown;
	readonly fullPage?: boolean;
	readonly captureBeyondViewport?: boolean;
}

export type BrowserViewScreenshotRoute = 'viewport' | 'viewport-rect' | 'full-page' | 'document-rect';

export function browserViewScreenshotRoute(options: IBrowserViewScreenshotRouteOptions | undefined): BrowserViewScreenshotRoute {
	if (options?.fullPage && !options.screenRect && !options.pageRect) {
		return 'full-page';
	}
	if (options?.pageRect && options.captureBeyondViewport) {
		return 'document-rect';
	}
	if (options?.pageRect || options?.screenRect) {
		return 'viewport-rect';
	}
	return 'viewport';
}

export interface IBrowserViewScreenshotPolicyOptions extends IBrowserViewScreenshotRouteOptions {
	readonly awaitNextPaint?: boolean;
}

export interface IBrowserViewScreenshotPolicyDependencies<T> {
	readonly isVisible: () => boolean;
	readonly setPrivateVisible: (visible: boolean) => void;
	readonly waitForNextPaint: () => Promise<void>;
	readonly capture: (route: BrowserViewScreenshotRoute, signal: AbortSignal) => Promise<T>;
}

/** Production orchestration boundary shared by BrowserView and unit tests. */
export function captureBrowserViewScreenshotWithPolicy<T>(
	coordinator: BrowserViewScreenshotCoordinator,
	options: IBrowserViewScreenshotPolicyOptions | undefined,
	dependencies: IBrowserViewScreenshotPolicyDependencies<T>,
): Promise<T> {
	const route = browserViewScreenshotRoute(options);
	return coordinator.run(async signal => {
		await prepareBrowserViewScreenshotCapture(
			dependencies.isVisible(),
			dependencies.setPrivateVisible,
			dependencies.waitForNextPaint,
			options?.awaitNextPaint === true,
			signal,
		);
		return dependencies.capture(route, signal);
	});
}

export interface IBrowserViewScreenshotPixelEstimateInput {
	readonly width: number;
	readonly height: number;
	readonly devicePixelRatio?: number;
	readonly zoomFactor?: number;
	readonly visualViewportScale?: number;
	readonly emulationScale?: number;
	readonly captureScale?: number;
}

export interface IBrowserViewScreenshotPixelEstimate {
	readonly width: number;
	readonly height: number;
	readonly pixels: number;
}

function screenshotScale(input: IBrowserViewScreenshotPixelEstimateInput): number {
	const factors = [input.devicePixelRatio ?? 1, input.zoomFactor ?? 1, input.visualViewportScale ?? 1, input.emulationScale ?? 1, input.captureScale ?? 1];
	if (![input.width, input.height, ...factors].every(value => Number.isFinite(value) && value > 0)) {
		throw new Error('BrowserView screenshot dimensions and scale factors must be positive finite numbers.');
	}
	return factors.reduce((product, factor) => product * factor, 1);
}

export function browserViewAssertScreenshotPixelBudget(
	input: IBrowserViewScreenshotPixelEstimateInput,
	maxEdge = BROWSER_VIEW_SCREENSHOT_MAX_EDGE,
	maxPixels = BROWSER_VIEW_SCREENSHOT_MAX_PIXELS,
): IBrowserViewScreenshotPixelEstimate {
	const scale = screenshotScale(input);
	const width = Math.ceil(input.width * scale);
	const height = Math.ceil(input.height * scale);
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels) || width > maxEdge || height > maxEdge || pixels > maxPixels) {
		throw new Error(`BrowserView screenshot output exceeds the pixel budget (${width}x${height}, limit edge=${maxEdge}, pixels=${maxPixels}).`);
	}
	return { width, height, pixels };
}

export function browserViewCalculateBoundedCaptureScale(
	input: Omit<IBrowserViewScreenshotPixelEstimateInput, 'captureScale'>,
	maxEdge: number,
): number {
	if (!Number.isFinite(maxEdge) || maxEdge <= 0) {
		throw new Error('BrowserView screenshot maximum edge must be a positive finite number.');
	}
	const scale = screenshotScale(input);
	let captureScale = Math.min(1, maxEdge / Math.max(input.width * scale, input.height * scale));
	// Division and the later multiplication can round in opposite directions at the exact
	// boundary (for example 2178 * 2 * scale becomes 2576.0000000000005). Nudge only when
	// the same multiplication order used by the budget check would exceed the hard limit.
	const exceedsEdge = () => Math.max(input.width * (scale * captureScale), input.height * (scale * captureScale)) > maxEdge;
	for (let adjustment = 0; adjustment < 4 && exceedsEdge(); adjustment++) {
		captureScale *= 1 - Number.EPSILON;
	}
	if (exceedsEdge()) {
		throw new Error('BrowserView screenshot scale could not be represented within the maximum edge.');
	}
	return captureScale;
}

/** CDP beyond-viewport capture may render at either the host or emulated device scale. */
export function browserViewEffectiveCaptureBeyondDevicePixelRatio(hostDevicePixelRatio: number, emulatedDeviceScaleFactor: number | undefined): number {
	if (!Number.isFinite(hostDevicePixelRatio) || hostDevicePixelRatio <= 0) {
		throw new Error('BrowserView host device pixel ratio must be a positive finite number.');
	}
	const emulated = typeof emulatedDeviceScaleFactor === 'number' && Number.isFinite(emulatedDeviceScaleFactor) && emulatedDeviceScaleFactor > 0
		? emulatedDeviceScaleFactor
		: 0;
	return Math.max(hostDevicePixelRatio, emulated);
}

export interface IBrowserViewScreenshotImageInput<TEncoded extends Uint8Array> {
	readonly empty: boolean;
	readonly width: number;
	readonly height: number;
	readonly bitmap: Uint8Array | (() => Uint8Array);
	readonly encode: () => TEncoded;
}

export type IBrowserViewScreenshotValidation<TEncoded extends Uint8Array> =
	| { readonly valid: true; readonly encoded: TEncoded; readonly width: number; readonly height: number }
	| { readonly valid: false; readonly reason: 'empty' | 'dimensions' | 'transparent' | 'encode-empty' | 'encode-error'; readonly width: number; readonly height: number };

export function browserViewValidateAndEncodeScreenshot<TEncoded extends Uint8Array>(
	input: IBrowserViewScreenshotImageInput<TEncoded>,
): IBrowserViewScreenshotValidation<TEncoded> {
	if (Number.isFinite(input.width) && Number.isFinite(input.height) && input.width > 0 && input.height > 0) {
		browserViewAssertScreenshotPixelBudget({ width: input.width, height: input.height });
	}
	if (input.empty) {
		return { valid: false, reason: 'empty', width: input.width, height: input.height };
	}
	if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) {
		return { valid: false, reason: 'dimensions', width: input.width, height: input.height };
	}
	const bitmap = typeof input.bitmap === 'function' ? input.bitmap() : input.bitmap;
	if (bitmap.byteLength < 4) {
		return { valid: false, reason: 'dimensions', width: input.width, height: input.height };
	}
	if (!browserViewBitmapHasVisibleAlpha(bitmap)) {
		return { valid: false, reason: 'transparent', width: input.width, height: input.height };
	}
	let encoded: TEncoded;
	try {
		encoded = input.encode();
	} catch {
		return { valid: false, reason: 'encode-error', width: input.width, height: input.height };
	}
	if (encoded.byteLength === 0) {
		return { valid: false, reason: 'encode-empty', width: input.width, height: input.height };
	}
	if (encoded.byteLength > BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES) {
		throw new Error(`${BROWSER_VIEW_SCREENSHOT_ENCODED_SIZE_ERROR_PREFIX} encoded image exceeds the ${BROWSER_VIEW_SCREENSHOT_MAX_ENCODED_BYTES}-byte transport budget.`);
	}
	return { valid: true, encoded, width: input.width, height: input.height };
}
