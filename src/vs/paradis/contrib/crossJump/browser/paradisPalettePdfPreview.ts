/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの右のプレビューで、PDF の 1 ページ目を小さく描く（mock/ui/palette-ideas.html の案 12）。
//
// PDF ビューアは webview の中で pdf.js を動かすが、プレビューは webview を作らず、同梱の同じ pdf.js（media/pdfjs/）を
// パレットの画面で読み込んで canvas に描く。pdf.js のモジュールと worker は窓に 1 つだけ作って使い回し（2 回目からは
// 読み込みも worker の起動も無い）、文書は描き終えたら・行が替わったら手放す。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { renderParadisProgress } from '../../../browser/paradisProgress.js';
import { appendParadisPreviewMediaMeta, paradisCreatePalettePdfWorker, paradisFormatPreviewLimit, paradisFormatPreviewSize, paradisPreviewTooLarge, paradisReleaseOnCancel, PARADIS_PALETTE_PDFJS_ROOT, PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES, renderParadisPreviewTooLarge } from './paradisPalettePreviewMedia.js';

/** 1 ページ目の canvas の画素数の上限（面は 420px 幅まで。高解像度の画面でも 4 倍程度で足りる）。 */
const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;

/** pdf.js の使う分だけの形（同梱の pdf.min.mjs には型が無い）。 */
interface IPdfViewport {
	readonly width: number;
	readonly height: number;
}
interface IPdfRenderTask {
	readonly promise: Promise<void>;
	cancel(): void;
}
interface IPdfPage {
	getViewport(options: { scale: number }): IPdfViewport;
	render(options: { canvasContext: CanvasRenderingContext2D; canvas: HTMLCanvasElement; viewport: IPdfViewport }): IPdfRenderTask;
}
interface IPdfDocument {
	readonly numPages: number;
	getPage(pageNumber: number): Promise<IPdfPage>;
}
interface IPdfLoadingTask {
	readonly promise: Promise<IPdfDocument>;
	destroy(): Promise<void>;
}
interface IPdfWorker {
	destroy(): void;
}
interface IPdfjs {
	PDFWorker: new (options: { port: Worker }) => IPdfWorker;
	getDocument(source: Record<string, unknown>): IPdfLoadingTask;
}

/** 窓に 1 つだけの pdf.js と worker。 */
let shared: Promise<{ readonly pdfjs: IPdfjs; readonly worker: IPdfWorker }> | undefined;

function pdfjsUrl(file: string): string {
	return FileAccess.asBrowserUri(`${PARADIS_PALETTE_PDFJS_ROOT}/${file}`).toString(true);
}

async function loadPdfjs(): Promise<{ readonly pdfjs: IPdfjs; readonly worker: IPdfWorker }> {
	if (!shared) {
		shared = (async () => {
			const pdfjs: IPdfjs = await import(/* webpackIgnore: true */ /* @vite-ignore */ pdfjsUrl('pdf.min.mjs'));
			// worker を自分で起動して渡す（pdf.js に作らせると Trusted Types で弾かれて、画面の側で解析する遅い形に落ちる）。
			// 文書ごとに渡すので、文書を手放しても worker は残る
			const worker = new pdfjs.PDFWorker({ port: paradisCreatePalettePdfWorker() });
			return { pdfjs, worker };
		})();
		// 読み込みに失敗したら次の PDF でやり直す
		shared.catch(() => shared = undefined);
	}
	return shared;
}

/** 1 ページ目を面に収める倍率（canvas の画素で面を埋め、画素数の上限で抑える）。 */
export function paradisPalettePdfScale(page: IPdfViewport, width: number, height: number, devicePixelRatio: number): number {
	if (page.width <= 0 || page.height <= 0) {
		return 1;
	}
	const fit = Math.max(0.05, Math.min(width / page.width, height / page.height)) * devicePixelRatio;
	const pixels = page.width * page.height * fit * fit;
	return pixels > MAX_CANVAS_PIXELS ? fit * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : fit;
}

/**
 * PDF の 1 ページ目を描く。描いている間は進み具合の帯を出す。読めない・壊れた PDF は投げる（呼び出し側が「プレビューできません」にする）。
 */
export async function renderParadisPreviewPdf(fileService: IFileService, resource: URI, name: string, body: HTMLElement, token: CancellationToken): Promise<void> {
	let size: number | undefined;
	try {
		size = (await fileService.stat(resource)).size;
	} catch {
		size = undefined;
	}
	if (token.isCancellationRequested) {
		return;
	}
	if (paradisPreviewTooLarge(size, PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES)) {
		renderParadisPreviewTooLarge(body, 'file-pdf', name, paradisFormatPreviewSize(size!), paradisFormatPreviewLimit(PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES));
		return;
	}

	const drawing = localize('paradis.palette.preview.pdfDrawing', "1 ページ目を描いています...");
	const loading = dom.append(body, dom.$('.paradis-palette-preview-pdf-loading'));
	dom.append(loading, dom.$('span.paradis-palette-preview-empty')).textContent = drawing;
	const progress = renderParadisProgress(loading, { ariaLabel: drawing, value: 0 });
	const meta = size === undefined ? undefined : appendParadisPreviewMediaMeta(body, paradisFormatPreviewSize(size));

	const [content, { pdfjs, worker }] = await Promise.all([
		fileService.readFile(resource, { limits: { size: PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES } }, token),
		loadPdfjs(),
	]);
	if (token.isCancellationRequested) {
		return;
	}
	progress.update(0.3);
	const loadingTask = pdfjs.getDocument({
		data: content.value.buffer,
		worker,
		cMapUrl: pdfjsUrl('cmaps/'),
		cMapPacked: true,
		standardFontDataUrl: pdfjsUrl('standard_fonts/'),
		isEvalSupported: false,
		ownerDocument: dom.getWindow(body).document,
	});
	// 文書は描き終えたら・行が替わったら手放す（canvas の絵は残る）。worker は手放さない
	let destroyed = false;
	const destroy = () => {
		if (!destroyed) {
			destroyed = true;
			void loadingTask.destroy().catch(() => { /* 手放すときの失敗は出さない */ });
		}
	};
	paradisReleaseOnCancel(token, destroy);
	try {
		const pdf = await loadingTask.promise;
		if (token.isCancellationRequested) {
			return;
		}
		const bytes = paradisFormatPreviewSize(content.size);
		const pageMeta = localize('paradis.palette.preview.pdfMeta', "1 / {0} ページ · {1}", pdf.numPages, bytes);
		(meta ?? appendParadisPreviewMediaMeta(body, pageMeta)).textContent = pageMeta;
		progress.update(0.6);
		const page = await pdf.getPage(1);
		if (token.isCancellationRequested) {
			return;
		}
		progress.update(0.8);
		const targetWindow = dom.getWindow(body);
		const scale = paradisPalettePdfScale(page.getViewport({ scale: 1 }), Math.max(1, body.clientWidth - 20), Math.max(1, body.clientHeight - 40), targetWindow.devicePixelRatio || 1);
		const viewport = page.getViewport({ scale });
		const canvas = targetWindow.document.createElement('canvas');
		canvas.className = 'paradis-palette-preview-media-image paradis-palette-preview-pdf-page';
		canvas.width = Math.max(1, Math.floor(viewport.width));
		canvas.height = Math.max(1, Math.floor(viewport.height));
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('paradisPalettePreview: no canvas context');
		}
		const renderTask = page.render({ canvasContext: context, canvas, viewport });
		paradisReleaseOnCancel(token, () => renderTask.cancel());
		await renderTask.promise;
		if (token.isCancellationRequested) {
			return;
		}
		progress.update(1);
		const frame = dom.$('.paradis-palette-preview-media.paradis-palette-preview-pdf');
		frame.append(canvas);
		loading.replaceWith(frame);
	} finally {
		destroy();
	}
}
