/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildParadisPdfViewerHtml, IParadisPdfPagePlan, PARADIS_PDF_FIRST_PAINT_MESSAGE, PARADIS_PDF_RANGE_THRESHOLD_BYTES, planParadisPdfPages, shouldParadisPdfUseRangeRequests } from '../../common/paradisPdfViewerHtml.js';

suite('ParadisPdfViewerHtml', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only large documents in pieces, and only from the preview server', () => {
		deepStrictEqual([
			shouldParadisPdfUseRangeRequests(PARADIS_PDF_RANGE_THRESHOLD_BYTES, true),
			shouldParadisPdfUseRangeRequests(PARADIS_PDF_RANGE_THRESHOLD_BYTES - 1, true),
			shouldParadisPdfUseRangeRequests(PARADIS_PDF_RANGE_THRESHOLD_BYTES, false),
			shouldParadisPdfUseRangeRequests(undefined, true),
		], [true, false, false, false]);
	});

	test('draws the visible pages first, then their neighbours, and keeps canvases only near them', () => {
		deepStrictEqual([
			planParadisPdfPages(250, 251, 500, 2, 10),
			planParadisPdfPages(0, 0, 500, 2, 10),
			planParadisPdfPages(498, 499, 500, 2, 10),
			planParadisPdfPages(0, 0, 1, 2, 10),
		], [
			{ order: [250, 251, 252, 249, 253, 248], keepFrom: 240, keepTo: 261 },
			{ order: [0, 1, 2], keepFrom: 0, keepTo: 10 },
			{ order: [498, 499, 497, 496], keepFrom: 488, keepTo: 499 },
			{ order: [0], keepFrom: 0, keepTo: 0 },
		]);
	});

	test('embeds a planner that works without anything outside its own body', () => {
		// webview へは関数の本体を文字列のまま埋め込む。外の名前を参照すると webview の中でだけ壊れる。
		const html = buildParadisPdfViewerHtml({ nonce: 'n', pdfUrl: 'http://127.0.0.1:1/t/a.pdf', libBase: 'http://127.0.0.1:1/l', serverOrigin: 'http://127.0.0.1:1', useRangeRequests: true });
		const source = /const planPages = (?<body>[\s\S]*?);\n\t\tconst statusEl/.exec(html)?.groups?.body;
		ok(source);
		const embedded = new Function(`return (${source});`)() as typeof planParadisPdfPages;
		const plans: IParadisPdfPagePlan[] = [embedded(250, 251, 500, 2, 10), embedded(0, 0, 1, 2, 10)];
		deepStrictEqual(plans, [planParadisPdfPages(250, 251, 500, 2, 10), planParadisPdfPages(0, 0, 1, 2, 10)]);
		ok(html.includes('const USE_RANGE = true;'));
		// 最初のページが描けたことをエディタへ知らせる（開いてから描けるまでの計測）。
		ok(html.includes(`type: '${PARADIS_PDF_FIRST_PAINT_MESSAGE}'`));
	});
});
