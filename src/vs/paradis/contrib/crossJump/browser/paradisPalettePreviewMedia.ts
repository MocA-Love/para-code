/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの右のプレビューで、テキストでないタブ（画像・PDF）と HTML の描画を出す部分（mock/ui/palette-ideas.html の案 12）。
//
// - 画像: ファイルのバイト列（IFileService 経由なので SSH 先も読める）を Blob にして <img> で出す。SVG も <img> で出すので
//   スクリプトは動かない。Blob の URL は行が替わったら（取り消しで）手放す。20 MB を超えるものは読まない
// - HTML: スクリプトを止めた sandbox の iframe（sandbox 属性は空）に srcdoc で渡す。文書の CSP と iframe の csp 属性で
//   外への通信（相対パスの CSS・画像・スクリプト、https の画像など）を止める。iframe は押せない（パレットのフォーカスを奪わない）
// - PDF は paradisPalettePdfPreview.ts

import * as dom from '../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../base/common/network.js';
import { extname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { judgeParadisImageDecode } from '../../fileViewers/browser/image/paradisImageDimensions.js';
import { getParadisImageMimeType, isParadisSvgResource, PARADIS_IMAGE_MAX_PIXELS } from '../../fileViewers/browser/image/paradisImagePreview.js';

/** 面に描くテキストでない中身の種類。`html` はテキストとしても読めるが、描画とソースを切り替える。 */
export type ParadisPalettePreviewMedia = 'image' | 'pdf' | 'html';

/** これを超える画像は読まずに名前と大きさだけを出す。 */
export const PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** これを超える PDF は読まずに大きさだけを出す（ページ数は文書を読まないと分からない）。 */
export const PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES = 30 * 1024 * 1024;
/** HTML を描くときに読む量の上限（これを超える分は描かない）。 */
export const PARADIS_PALETTE_PREVIEW_HTML_MAX_BYTES = 2 * 1024 * 1024;

/** 同梱の pdf.js（PDF ビューアと同じもの）の置き場。 */
export const PARADIS_PALETTE_PDFJS_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs';

/** 本家の画像プレビュー（media-preview 拡張）など、カスタムエディタのタブの種類。 */
const CUSTOM_EDITOR_TYPE_ID = 'workbench.editors.webviewEditor';

/**
 * タブの中身をどう描くか。
 * - fork の画像ビューアのタブ、拡張子が画像（SVG 以外）のタブは画像。SVG はテキストとしても開けるので、画像ビューアか
 *   カスタムエディタ（本家の画像プレビュー）のタブだけ画像にし、テキストのエディタで開いた SVG はテキストのまま
 * - fork の PDF ビューアのタブ、拡張子が .pdf のタブは PDF
 * - 拡張子が .html・.htm のタブ（HTML ビューアでもテキストのエディタでも）は HTML（描画とソースを切り替える）
 * - ほかは undefined（今までどおりテキストの先頭）
 */
export function paradisPalettePreviewMedia(typeId: string, resource: URI, ids: { readonly image: string; readonly pdf: string }): ParadisPalettePreviewMedia | undefined {
	if (typeId === ids.image) {
		return 'image';
	}
	if (typeId === ids.pdf) {
		return 'pdf';
	}
	const extension = extname(resource).toLowerCase();
	if (extension === '.pdf') {
		return 'pdf';
	}
	if (getParadisImageMimeType(resource)) {
		return !isParadisSvgResource(resource) || typeId === CUSTOM_EDITOR_TYPE_ID ? 'image' : undefined;
	}
	if (extension === '.html' || extension === '.htm') {
		return 'html';
	}
	return undefined;
}

/** 面に出す大きさ（「182 KB」「24.6 MB」）。 */
export function paradisFormatPreviewSize(bytes: number): string {
	if (bytes < 1024) {
		return localize('paradis.palette.preview.sizeBytes', "{0} B", bytes);
	}
	if (bytes < 1024 * 1024) {
		return localize('paradis.palette.preview.sizeKb', "{0} KB", Math.round(bytes / 1024));
	}
	return localize('paradis.palette.preview.sizeMb', "{0} MB", (bytes / (1024 * 1024)).toFixed(1));
}

/** 上限の表示（「20 MB」）。 */
export function paradisFormatPreviewLimit(bytes: number): string {
	return localize('paradis.palette.preview.limitMb', "{0} MB", Math.round(bytes / (1024 * 1024)));
}

/** 上限を超えたか。大きさが分からないとき（stat できない）は読んでみる（読むときにも上限を付ける）。 */
export function paradisPreviewTooLarge(size: number | undefined, limit: number): boolean {
	return size !== undefined && size > limit;
}

/** HTML の描画の iframe の CSP。スクリプトと外への通信を止め、文書の中の style と data: の画像・フォントだけを許す。 */
export const PARADIS_PALETTE_PREVIEW_HTML_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`;

/**
 * iframe に渡す HTML。先頭（DOCTYPE があればその直後）に CSP と既定の紙の色（面では動かせないのでスクロールバーも出さない）を差し込み、meta refresh（ほかへの移動）を外す。
 * DOCTYPE の前に差し込むと互換モードで描かれるので、DOCTYPE は先頭に残す。紙の色は `:where` で詳細度を 0 にし、文書の CSS が勝つ。
 */
export function paradisPalettePreviewHtmlDocument(html: string): string {
	const head = `<meta http-equiv="Content-Security-Policy" content="${PARADIS_PALETTE_PREVIEW_HTML_CSP}"><style>:where(html){color-scheme:light;background:Canvas;color:CanvasText;overflow:hidden}</style>`;
	const body = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
	const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(body);
	return doctype ? doctype[0] + head + body.slice(doctype[0].length) : head + body;
}

/** 面が使う Trusted Types のポリシー（名前は workbench.html の trusted-types に載せてある）。作れるのは窓に 1 回だけ。 */
const trustedTypes = createTrustedTypesPolicy('paradisPalettePreview', {
	// iframe の srcdoc へ渡すのは paradisPalettePreviewHtmlDocument で CSP を差し込んだ文書だけ（sandbox でスクリプトも止める）
	createHTML: value => value,
	// Worker に渡せるのは同梱の pdf.js の worker だけ
	createScriptURL: value => {
		if (value !== paradisPalettePdfWorkerUrl()) {
			throw new Error('paradisPalettePreview: unexpected script URL');
		}
		return value;
	},
});

/** 同梱の pdf.js の worker の URL。 */
export function paradisPalettePdfWorkerUrl(): string {
	return FileAccess.asBrowserUri(`${PARADIS_PALETTE_PDFJS_ROOT}/pdf.worker.min.mjs`).toString(true);
}

/** 同梱の pdf.js の worker を起動する（窓に 1 本だけ。呼び出し側が使い回す）。 */
export function paradisCreatePalettePdfWorker(): Worker {
	const url = paradisPalettePdfWorkerUrl();
	return new Worker((trustedTypes?.createScriptURL(url) ?? url) as unknown as string, { type: 'module', name: 'paradisPalettePdfPreview' });
}

/** 取り消されたら手放す。すでに取り消されていればすぐ手放す。 */
export function paradisReleaseOnCancel(token: CancellationToken, release: () => void): void {
	if (token.isCancellationRequested) {
		release();
		return;
	}
	const listener = token.onCancellationRequested(() => {
		listener.dispose();
		release();
	});
}

/** 上限（画像 20 MB・PDF 30 MB）を超えて描かないときの、名前と大きさの箱。 */
export function renderParadisPreviewTooLarge(body: HTMLElement, icon: string, name: string, detail: string, limit: string): void {
	const box = dom.append(body, dom.$('.paradis-palette-preview-media-big'));
	dom.append(box, dom.$(`span.codicon.codicon-${icon}`));
	dom.append(box, dom.$('span.paradis-palette-preview-media-big-name')).textContent = name;
	dom.append(box, dom.$('span.paradis-palette-preview-media-big-size')).textContent = detail;
	dom.append(box, dom.$('span.paradis-palette-preview-empty')).textContent = localize('paradis.palette.preview.tooLarge', "{0} を超えるので描きません", limit);
}

/** 描いた中身の下の 1 行（「幅 × 高さ · 大きさ」「1 / N ページ · 大きさ」）。 */
export function appendParadisPreviewMediaMeta(body: HTMLElement, text: string): HTMLElement {
	const meta = dom.append(body, dom.$('.paradis-palette-preview-more.paradis-palette-preview-media-meta'));
	meta.textContent = text;
	return meta;
}

async function statSize(fileService: IFileService, resource: URI): Promise<number | undefined> {
	try {
		return (await fileService.stat(resource)).size;
	} catch {
		return undefined;
	}
}

/**
 * 画像を面の幅に縮めて出す。読めない・描けない（壊れた画像・画素数が多すぎる）ときは投げる（呼び出し側が「プレビューできません」にする）。
 */
export async function renderParadisPreviewImage(fileService: IFileService, resource: URI, name: string, body: HTMLElement, token: CancellationToken): Promise<void> {
	const size = await statSize(fileService, resource);
	if (token.isCancellationRequested) {
		return;
	}
	const limit = paradisFormatPreviewLimit(PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES);
	if (paradisPreviewTooLarge(size, PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES)) {
		renderParadisPreviewTooLarge(body, 'file-media', name, paradisFormatPreviewSize(size!), limit);
		return;
	}
	const content = await fileService.readFile(resource, { limits: { size: PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES } }, token);
	if (token.isCancellationRequested) {
		return;
	}
	const mimeType = getParadisImageMimeType(resource) ?? 'image/png';
	if (judgeParadisImageDecode(content.value.buffer, mimeType, PARADIS_IMAGE_MAX_PIXELS) !== 'ok') {
		throw new Error('paradisPalettePreview: the image cannot be decoded');
	}
	// MIME は拡張子で決める（中身が HTML でも画像としてしか解釈されない）。<img> の SVG はスクリプトを動かさない
	const url = URL.createObjectURL(new Blob([content.value.buffer as Uint8Array<ArrayBuffer>], { type: mimeType }));
	paradisReleaseOnCancel(token, () => URL.revokeObjectURL(url));
	if (token.isCancellationRequested) {
		return;
	}
	const frame = dom.append(body, dom.$('.paradis-palette-preview-media'));
	const image = dom.append(frame, dom.$<HTMLImageElement>('img.paradis-palette-preview-media-image'));
	image.decoding = 'async';
	image.alt = name;
	image.src = url;
	await image.decode();
	if (token.isCancellationRequested) {
		return;
	}
	// SVG は幅と高さを持たないことがある（viewBox だけ）ので、そのときは大きさだけ
	const bytes = paradisFormatPreviewSize(content.size);
	appendParadisPreviewMediaMeta(body, image.naturalWidth && image.naturalHeight
		// allow-any-unicode-next-line
		? localize('paradis.palette.preview.imageMeta', "{0} × {1} · {2}", image.naturalWidth, image.naturalHeight, bytes)
		: bytes);
}

/** HTML を、スクリプトを止めた sandbox の iframe で描く。 */
export function renderParadisPreviewHtml(html: string, name: string, body: HTMLElement): void {
	const frame = dom.append(body, dom.$('.paradis-palette-preview-html'));
	const iframe = dom.append(frame, dom.$<HTMLIFrameElement>('iframe'));
	// 空の sandbox: スクリプト・フォーム・ほかへの移動・同じ origin の扱いをすべて止める
	iframe.setAttribute('sandbox', '');
	// 文書の meta の CSP が効かない形（差し込みの失敗）でも、外への通信は iframe の側の CSP で止める
	iframe.setAttribute('csp', PARADIS_PALETTE_PREVIEW_HTML_CSP);
	iframe.setAttribute('referrerpolicy', 'no-referrer');
	iframe.tabIndex = -1;
	iframe.title = localize('paradis.palette.preview.htmlFrame', "{0} の描画", name);
	const document = paradisPalettePreviewHtmlDocument(html);
	iframe.srcdoc = (trustedTypes?.createHTML(document) ?? document) as unknown as string;
	dom.append(body, dom.$('.paradis-palette-preview-more')).textContent = localize('paradis.palette.preview.htmlNote', "相対パスの CSS・画像・スクリプトは読み込みません");
}
