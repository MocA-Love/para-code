/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createParadisOfficeError, type ParadisOfficeError } from '../common/paradisOfficeErrors.js';
import {
	PARADIS_OFFICE_PRINT_LIMITS,
	ParadisOfficePrintError,
	renderParadisOfficePrintHtml,
	selectParadisOfficePrintPages,
} from '../common/paradisOfficePrint.js';
import type { ParadisOfficePrintModel } from '../common/paradisOfficeProtocol.js';

export type ParadisOfficePrintPlatform = 'desktop' | 'web' | 'mobileConnected' | 'mobileStandalone';

export interface ParadisOfficePrintBackend {
	readonly platform: ParadisOfficePrintPlatform;
	readonly printHtml?: (html: string, token: CancellationToken) => Promise<void>;
	readonly exportPdf?: (
		model: ParadisOfficePrintModel,
		pageRange: readonly [number, number] | undefined,
		token: CancellationToken,
	) => Promise<Uint8Array>;
	readonly sharePdf?: (bytes: Uint8Array, title: string, token: CancellationToken) => Promise<void>;
}

export interface ParadisOfficePrintOptions {
	readonly pageRange?: readonly [number, number];
}

export type ParadisOfficePrintResult =
	| { readonly ok: true; readonly kind: 'printed'; readonly pageCount: number }
	| { readonly ok: true; readonly kind: 'exported'; readonly pageCount: number; readonly byteLength: number; readonly bytes: Uint8Array }
	| { readonly ok: true; readonly kind: 'shared'; readonly pageCount: number; readonly byteLength: number }
	| { readonly ok: false; readonly error: ParadisOfficeError };

/** Carries a backend failure into the existing inspector warning surface without exposing a raw cause. */
export function withParadisOfficePrintResult(model: ParadisOfficePrintModel, result: ParadisOfficePrintResult): ParadisOfficePrintModel {
	if (result.ok) {
		return model;
	}
	return {
		...model,
		approximationWarnings: [...model.approximationWarnings, {
			code: `print.${result.error.stage}.${result.error.code}`,
			message: result.error.safeMessage,
		}],
	};
}

function safeError(code: 'unsupported' | 'printFailed'): ParadisOfficeError {
	return createParadisOfficeError('export', code, {
		severity: 'error',
		retryable: code === 'printFailed',
		recoverable: true,
		userAction: code === 'printFailed' ? 'retry' : 'openExternally',
	});
}

function cancelledError(): ParadisOfficeError {
	return createParadisOfficeError('transport', 'cancelled', {
		severity: 'warning',
		retryable: true,
		recoverable: true,
		userAction: 'retry',
	});
}

function failure(error: unknown, token: CancellationToken): { readonly ok: false; readonly error: ParadisOfficeError } {
	if (token.isCancellationRequested || error instanceof ParadisOfficePrintError && error.code === 'cancelled') {
		return { ok: false, error: cancelledError() };
	}
	if (error instanceof ParadisOfficePrintError && error.code === 'unsupported') {
		return { ok: false, error: safeError('unsupported') };
	}
	return { ok: false, error: safeError('printFailed') };
}

function ownedPdfBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.byteLength < 5 || bytes.byteLength > PARADIS_OFFICE_PRINT_LIMITS.maximumPdfBytes
		|| bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
		throw new ParadisOfficePrintError('printFailed');
	}
	return bytes.slice();
}

/** Routes an already typed print model without creating a new wire transport or reading live viewer DOM. */
export class ParadisOfficePrintService {
	constructor(private readonly backend: ParadisOfficePrintBackend) { }

	async print(
		model: ParadisOfficePrintModel,
		options: ParadisOfficePrintOptions = {},
		token: CancellationToken = CancellationToken.None,
	): Promise<ParadisOfficePrintResult> {
		try {
			const selected = selectParadisOfficePrintPages(model, options.pageRange, token);
			if (this.backend.platform === 'mobileConnected') {
				if (!this.backend.exportPdf || !this.backend.sharePdf) {
					throw new ParadisOfficePrintError('unsupported');
				}
				const bytes = await this.exportOwnedPdf(model, options.pageRange, token);
				if (token.isCancellationRequested) {
					throw new ParadisOfficePrintError('cancelled');
				}
				await this.backend.sharePdf(bytes, model.title, token);
				if (token.isCancellationRequested) {
					throw new ParadisOfficePrintError('cancelled');
				}
				return { ok: true, kind: 'shared', pageCount: selected.pages.length, byteLength: bytes.byteLength };
			}
			if (!this.backend.printHtml) {
				throw new ParadisOfficePrintError('unsupported');
			}
			const artifact = renderParadisOfficePrintHtml(model, options, token);
			await this.backend.printHtml(artifact.html, token);
			if (token.isCancellationRequested) {
				throw new ParadisOfficePrintError('cancelled');
			}
			return { ok: true, kind: 'printed', pageCount: artifact.model.pages.length };
		} catch (error) {
			return failure(error, token);
		}
	}

	async exportPdf(
		model: ParadisOfficePrintModel,
		options: ParadisOfficePrintOptions = {},
		token: CancellationToken = CancellationToken.None,
	): Promise<ParadisOfficePrintResult> {
		try {
			const selected = selectParadisOfficePrintPages(model, options.pageRange, token);
			const bytes = await this.exportOwnedPdf(model, options.pageRange, token);
			return { ok: true, kind: 'exported', pageCount: selected.pages.length, byteLength: bytes.byteLength, bytes };
		} catch (error) {
			return failure(error, token);
		}
	}

	private async exportOwnedPdf(
		model: ParadisOfficePrintModel,
		pageRange: readonly [number, number] | undefined,
		token: CancellationToken,
	): Promise<Uint8Array> {
		if (!this.backend.exportPdf) {
			throw new ParadisOfficePrintError('unsupported');
		}
		selectParadisOfficePrintPages(model, pageRange, token);
		const bytes = await this.backend.exportPdf(model, pageRange, token);
		if (token.isCancellationRequested) {
			throw new ParadisOfficePrintError('cancelled');
		}
		return ownedPdfBytes(bytes);
	}
}

/** Creates the concrete Web/Electron browser-print callback used by the Office editors. */
export function createParadisOfficeBrowserPrintCallback(targetWindow: Window): ParadisOfficePrintBackend['printHtml'] {
	return (html, token) => new Promise<void>((resolve, reject) => {
		if (token.isCancellationRequested) {
			reject(new ParadisOfficePrintError('cancelled'));
			return;
		}
		const frame = targetWindow.document.createElement('iframe');
		frame.setAttribute('aria-hidden', 'true');
		frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
		frame.style.position = 'fixed';
		frame.style.inset = '0 auto auto 0';
		frame.style.width = '1px';
		frame.style.height = '1px';
		frame.style.border = '0';
		frame.style.opacity = '0';
		let settled = false;
		const finish = (error?: ParadisOfficePrintError): void => {
			if (settled) {
				return;
			}
			settled = true;
			targetWindow.clearTimeout(timeout);
			frame.onload = null;
			frame.onerror = null;
			frame.remove();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const timeout = targetWindow.setTimeout(() => finish(new ParadisOfficePrintError('printFailed')), 10_000);
		frame.onload = () => {
			try {
				if (token.isCancellationRequested) {
					finish(new ParadisOfficePrintError('cancelled'));
					return;
				}
				const printWindow = frame.contentWindow;
				if (!printWindow) {
					finish(new ParadisOfficePrintError('printFailed'));
					return;
				}
				printWindow.focus();
				printWindow.print();
				finish();
			} catch {
				finish(new ParadisOfficePrintError('printFailed'));
			}
		};
		frame.onerror = () => finish(new ParadisOfficePrintError('printFailed'));
		frame.srcdoc = html;
		targetWindow.document.body.appendChild(frame);
	});
}

/** Prints one model in a fresh script-free frame owned by the current browser window. */
export function printParadisOfficeModelInBrowser(
	model: ParadisOfficePrintModel,
	targetWindow: Window,
	options: ParadisOfficePrintOptions = {},
	token: CancellationToken = CancellationToken.None,
): Promise<ParadisOfficePrintResult> {
	return new ParadisOfficePrintService({
		platform: 'desktop',
		printHtml: createParadisOfficeBrowserPrintCallback(targetWindow),
	}).print(model, options, token);
}
