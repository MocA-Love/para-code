/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { nativeImage, screen, type BrowserWindow, type NativeImage, type WebContents } from 'electron';
import { VSBuffer } from '../../../base/common/buffer.js';
import { ILogService } from '../../log/common/log.js';
import { browserViewEffectiveCaptureBeyondDevicePixelRatio, browserViewThrowIfScreenshotAborted, browserViewValidateAndEncodeScreenshot, captureBrowserViewWithRestore, captureBrowserViewWithRetry, type BrowserViewScreenshotRoute, type IBrowserViewScreenshotValidation } from '../common/paraBrowserViewScreenshot.js';
import { paraBrowserViewZoomShrink } from './paraBrowserViewZoom.js';

/** The parts of a BrowserView the screenshot helpers read, each read again on every use. */
export interface IParaBrowserViewScreenshotHost {
	webContents(): WebContents;
	/** The window the view is shown in, or undefined when none can be resolved (e.g. during teardown). */
	hostWindow(): BrowserWindow | undefined;
	/** The deviceScaleFactor of the emulated device, if any. */
	emulatedDeviceScaleFactor(): number | undefined;
	sendCommand(method: string, params?: unknown): Promise<unknown>;
	waitForNextPaint(): Promise<void>;
}

/**
 * The capture helpers of the hardened BrowserView screenshot pipeline (Para Browser MCP screenshot
 * hardening): CDP capture beyond the viewport with validated retry, validation before encoding, and
 * the device pixel ratios used by the pixel-budget guards. BrowserView owns one of these and calls it
 * from its capture paths (browserView.ts, PARA-PATCH).
 */
export class ParaBrowserViewScreenshotCapture {
	constructor(
		private readonly host: IParaBrowserViewScreenshotHost,
		private readonly logService: ILogService,
	) { }

	// Capture a document-coordinate pageRect beyond the viewport via CDP with validated retry (Para Browser MCP screenshot hardening)
	async captureDocumentRectScreenshot(
		pageRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
		format: 'jpeg' | 'png',
		quality: number,
		signal: AbortSignal,
		route: BrowserViewScreenshotRoute,
	): Promise<VSBuffer> {
		const candidate = await captureBrowserViewWithRetry(
			async (captureSignal, attempt) => {
				const image = await this.captureBeyondViewportImage({
					format,
					...(format === 'jpeg' ? { quality } : {}),
					captureBeyondViewport: true,
					clip: { ...pageRect, scale: 1 },
				}, captureSignal);
				browserViewThrowIfScreenshotAborted(captureSignal);
				return this.validateAndEncodeScreenshot(image, format, quality, route, attempt);
			},
			current => current.valid,
			() => this.host.waitForNextPaint(),
			5,
			{ signal, onRetry: event => this.logService.trace(`[BrowserView] screenshot retry route=${route} attempt=${event.attempt} reason=${event.reason}`) },
		);
		if (!candidate.valid) {
			throw new Error('BrowserView screenshot validation exhausted without a valid image.');
		}
		return VSBuffer.wrap(candidate.encoded);
	}

	// Run Page.captureScreenshot and always restore pinch-to-zoom limits afterwards, returning a NativeImage for validation (Para Browser MCP screenshot hardening)
	async captureBeyondViewportImage(params: Record<string, unknown>, signal: AbortSignal): Promise<NativeImage> {
		return captureBrowserViewWithRestore(async () => {
			const result = await this.host.sendCommand('Page.captureScreenshot', params) as { data?: unknown };
			browserViewThrowIfScreenshotAborted(signal);
			const encoded = typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : Buffer.alloc(0);
			return nativeImage.createFromBuffer(encoded);
		}, () => this.host.webContents().setVisualZoomLevelLimits(1, 3), () => {
			this.logService.warn('[BrowserView] screenshot zoom restore failed route=capture-beyond-viewport');
		});
	}

	// Reject empty/oversized images with lazy bitmap extraction before encoding, tracing the validation outcome (Para Browser MCP screenshot hardening)
	validateAndEncodeScreenshot(image: NativeImage, format: 'jpeg' | 'png', quality: number, route: BrowserViewScreenshotRoute, attempt: number): IBrowserViewScreenshotValidation<Buffer> {
		const size = image.getSize();
		const result = browserViewValidateAndEncodeScreenshot({
			empty: image.isEmpty(),
			width: size.width,
			height: size.height,
			// Keep bitmap extraction lazy so an unexpectedly oversized decoded image is rejected
			// before Electron copies its full pixel buffer into JavaScript memory.
			bitmap: () => image.toBitmap(),
			encode: () => format === 'png' ? image.toPNG() : image.toJPEG(quality),
		});
		const status = result.valid ? 'valid' : result.reason;
		this.logService.trace(`[BrowserView] screenshot validation route=${route} attempt=${attempt} width=${size.width} height=${size.height} status=${status}`);
		return result;
	}

	// Host-display and emulation-adjusted device pixel ratios used by the screenshot pixel-budget guards (Para Browser MCP screenshot hardening)
	devicePixelRatio(): number {
		const hostWindow = this.host.hostWindow();
		return (hostWindow ? screen.getDisplayMatching(hostWindow.getBounds()) : screen.getPrimaryDisplay()).scaleFactor;
	}

	captureBeyondViewportDevicePixelRatio(): number {
		// A page shrunk by zoom keeps its full devicePixelRatio, so it captures at 1 / shrink more pixels than the zoom suggests (paraBrowserViewZoom.ts)
		return browserViewEffectiveCaptureBeyondDevicePixelRatio(this.devicePixelRatio(), this.host.emulatedDeviceScaleFactor()) / paraBrowserViewZoomShrink(this.host.webContents());
	}
}
