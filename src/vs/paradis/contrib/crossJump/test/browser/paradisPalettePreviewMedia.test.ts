/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_PDF_INPUT_TYPE_ID } from '../../../fileViewers/browser/paradisFileViewers.js';
import { PARADIS_IMAGE_INPUT_TYPE_ID } from '../../../fileViewers/browser/image/paradisImagePreview.js';
import { paradisPalettePdfScale } from '../../browser/paradisPalettePdfPreview.js';
import {
	paradisFormatPreviewLimit,
	paradisFormatPreviewSize,
	PARADIS_PALETTE_PREVIEW_HTML_CSP,
	PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES,
	PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES,
	paradisPalettePreviewHtmlDocument,
	paradisPalettePreviewMedia,
	paradisPreviewTooLarge,
	paradisReleaseOnCancel,
} from '../../browser/paradisPalettePreviewMedia.js';

suite('paradisPalettePreviewMedia', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ids = { image: PARADIS_IMAGE_INPUT_TYPE_ID, pdf: PARADIS_PDF_INPUT_TYPE_ID };
	const textEditor = 'workbench.editors.files.fileEditorInput';

	test('images and PDFs are drawn; an SVG opened as text stays text; HTML switches between drawn and source', () => {
		const cases: [string, string][] = [
			[PARADIS_IMAGE_INPUT_TYPE_ID, '/r/a.png'],
			[textEditor, '/r/photo.JPG'],
			['workbench.editors.webviewEditor', '/r/b.webp'],
			[PARADIS_IMAGE_INPUT_TYPE_ID, '/r/icon.svg'],
			['workbench.editors.webviewEditor', '/r/icon.svg'],
			[textEditor, '/r/icon.svg'],
			[PARADIS_PDF_INPUT_TYPE_ID, '/r/spec.pdf'],
			['workbench.editors.webviewEditor', '/r/spec.PDF'],
			[textEditor, '/r/index.html'],
			['paradis.input.htmlPreview', '/r/page.htm'],
			[textEditor, '/r/a.ts'],
			[textEditor, '/r/README.md'],
		];
		assert.deepStrictEqual(cases.map(([typeId, path]) => paradisPalettePreviewMedia(typeId, URI.file(path), ids)),
			['image', 'image', 'image', 'image', 'image', undefined, 'pdf', 'pdf', 'html', 'html', undefined, undefined]);
	});

	test('images over 20 MB and PDFs over 30 MB are not read; an unknown size is read with a limit', () => {
		assert.deepStrictEqual({
			image: [PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES, PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES + 1, undefined].map(size => paradisPreviewTooLarge(size, PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES)),
			pdf: [PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES, PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES + 1].map(size => paradisPreviewTooLarge(size, PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES)),
			limits: [paradisFormatPreviewLimit(PARADIS_PALETTE_PREVIEW_IMAGE_MAX_BYTES), paradisFormatPreviewLimit(PARADIS_PALETTE_PREVIEW_PDF_MAX_BYTES)],
			sizes: [512, 182 * 1024, 24.6 * 1024 * 1024].map(paradisFormatPreviewSize),
		}, {
			image: [false, true, false],
			pdf: [false, true],
			limits: ['20 MB', '30 MB'],
			sizes: ['512 B', '182 KB', '24.6 MB'],
		});
	});

	test('the drawn HTML gets the CSP right after the DOCTYPE, and loses meta refresh', () => {
		const head = `<meta http-equiv="Content-Security-Policy" content="${PARADIS_PALETTE_PREVIEW_HTML_CSP}">`;
		const withDoctype = paradisPalettePreviewHtmlDocument('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://example.com"></head><body>x</body></html>');
		const without = paradisPalettePreviewHtmlDocument('<p>x</p>');
		assert.deepStrictEqual({
			doctypeFirst: withDoctype.startsWith(`<!DOCTYPE html>${head}`),
			refresh: /refresh/i.test(withDoctype),
			plain: without.startsWith(head) && without.endsWith('<p>x</p>'),
			noScripts: PARADIS_PALETTE_PREVIEW_HTML_CSP.includes(`default-src 'none'`) && !PARADIS_PALETTE_PREVIEW_HTML_CSP.includes('script-src'),
		}, { doctypeFirst: true, refresh: false, plain: true, noScripts: true });
	});

	test('what was made for a row is released when the row changes, or at once if it already changed', () => {
		const released: string[] = [];
		const live = new CancellationTokenSource();
		paradisReleaseOnCancel(live.token, () => released.push('url'));
		paradisReleaseOnCancel(live.token, () => released.push('pdf'));
		const before = [...released];
		live.cancel();
		live.cancel();
		const gone = new CancellationTokenSource();
		gone.cancel();
		paradisReleaseOnCancel(gone.token, () => released.push('late'));
		live.dispose();
		gone.dispose();
		assert.deepStrictEqual({ before, after: released }, { before: [], after: ['url', 'pdf', 'late'] });
	});

	test('the first PDF page fits the pane and the canvas stays under its pixel limit', () => {
		const a4 = { width: 595, height: 842 };
		const fit = paradisPalettePdfScale(a4, 300, 300, 2);
		const huge = paradisPalettePdfScale({ width: 14400, height: 14400 }, 4000, 4000, 4);
		assert.deepStrictEqual({
			fit: Math.round(fit * 1000) / 1000,
			hugePixels: Math.round(14400 * 14400 * huge * huge) <= 4 * 1024 * 1024,
			empty: paradisPalettePdfScale({ width: 0, height: 0 }, 300, 300, 2),
		}, { fit: Math.round(300 / 842 * 2 * 1000) / 1000, hugePixels: true, empty: 1 });
	});
});
