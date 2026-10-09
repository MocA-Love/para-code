/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, ok } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildParadisPdfViewerHtml, createParadisPdfPageScheduler, fitsParadisPdfCanvasBudget, IParadisPdfCanvasInfo, IParadisPdfPagePlan, IParadisPdfRenderJob, PARADIS_PDF_CANVAS_PIXEL_BUDGET, PARADIS_PDF_FIRST_PAINT_MESSAGE, PARADIS_PDF_KEEP_PAGES, PARADIS_PDF_PRERENDER_PAGES, PARADIS_PDF_RANGE_THRESHOLD_BYTES, planParadisPdfPages, selectParadisPdfCanvasesToRelease, shouldParadisPdfUseRangeRequests } from '../../common/paradisPdfViewerHtml.js';

suite('ParadisPdfViewerHtml', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** webview の中の実物の代わり。描画は `finishAll` まで、または取りやめまで決着しない。 */
	class FakeHost {
		readonly canvasesByIndex = new Map<number, number>();
		readonly cancelled: number[] = [];
		readonly pending = new Map<number, () => void>();
		maxPixels = 0;
		autoFinish = true;

		constructor(readonly pageCount: number, readonly pixelsPerPage: number) { }

		readonly host = {
			pageCount: this.pageCount,
			prerender: PARADIS_PDF_PRERENDER_PAGES,
			keep: PARADIS_PDF_KEEP_PAGES,
			pixelBudget: PARADIS_PDF_CANVAS_PIXEL_BUDGET,
			plan: planParadisPdfPages,
			selectRelease: selectParadisPdfCanvasesToRelease,
			fitsBudget: fitsParadisPdfCanvasBudget,
			canvases: () => [...this.canvasesByIndex].map(([index, pixels]) => ({ index, pixels, current: true })),
			estimatePixels: () => this.pixelsPerPage,
			render: (index: number): IParadisPdfRenderJob => {
				let settle!: () => void;
				let cancelled = false;
				const done = new Promise<void>(resolve => { settle = resolve; });
				const finish = () => {
					if (!cancelled) {
						this.canvasesByIndex.set(index, this.pixelsPerPage);
						this.maxPixels = Math.max(this.maxPixels, [...this.canvasesByIndex.values()].reduce((a, b) => a + b, 0));
					}
					this.pending.delete(index);
					settle();
				};
				if (this.autoFinish) {
					queueMicrotask(finish);
				} else {
					this.pending.set(index, finish);
				}
				return { done, cancel: () => { cancelled = true; this.cancelled.push(index); finish(); } };
			},
			release: (index: number) => { this.canvasesByIndex.delete(index); },
		};
	}

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
			{ first: 250, last: 251, order: [250, 251, 252, 249, 253, 248], keepFrom: 240, keepTo: 261 },
			{ first: 0, last: 0, order: [0, 1, 2], keepFrom: 0, keepTo: 10 },
			{ first: 498, last: 499, order: [498, 499, 497, 496], keepFrom: 488, keepTo: 499 },
			{ first: 0, last: 0, order: [0], keepFrom: 0, keepTo: 0 },
		]);
	});

	test('embeds the planner and the scheduler so that they work without anything outside their own bodies', async () => {
		// webview へは関数の本体を文字列のまま埋め込む。外の名前を参照すると webview の中でだけ壊れる。
		const html = buildParadisPdfViewerHtml({ nonce: 'n', pdfUrl: 'http://127.0.0.1:1/t/a.pdf', libBase: 'http://127.0.0.1:1/l', serverOrigin: 'http://127.0.0.1:1', useRangeRequests: true });
		const block = /\n\t\t(?<block>const planPages = [\s\S]*?)\n\t\tconst statusEl/.exec(html)?.groups?.block;
		ok(block);
		const embedded = new Function(`${block}\nreturn { planPages, selectRelease, fitsBudget, createScheduler };`)() as {
			planPages: typeof planParadisPdfPages;
			selectRelease: typeof selectParadisPdfCanvasesToRelease;
			fitsBudget: typeof fitsParadisPdfCanvasBudget;
			createScheduler: typeof createParadisPdfPageScheduler;
		};
		const plans: IParadisPdfPagePlan[] = [embedded.planPages(250, 251, 500, 2, 10), embedded.planPages(0, 0, 1, 2, 10)];
		deepStrictEqual(plans, [planParadisPdfPages(250, 251, 500, 2, 10), planParadisPdfPages(0, 0, 1, 2, 10)]);

		const fake = new FakeHost(500, 2 ** 25);
		const scheduler = embedded.createScheduler({ ...fake.host, plan: embedded.planPages, selectRelease: embedded.selectRelease, fitsBudget: embedded.fitsBudget });
		scheduler.setVisible(5, true);
		scheduler.schedule();
		await scheduler.idle();
		deepStrictEqual([...fake.canvasesByIndex.keys()], [5, 6]);
		ok(html.includes('const USE_RANGE = true;'));
		// 最初のページが描けたことをエディタへ知らせる（開いてから描けるまでの計測）。
		ok(html.includes(`type: '${PARADIS_PDF_FIRST_PAINT_MESSAGE}'`));
	});

	test('releases canvases far from the visible pages first once their pixels go over the budget', () => {
		const plan = planParadisPdfPages(100, 100, 500, 2, 10);
		const canvas = (index: number, current = true): IParadisPdfCanvasInfo => ({ index, pixels: 30, current });
		deepStrictEqual([
			// 範囲の外（89・112）は上限に関係なく外す。中は遠い順（95 → 97）に、合計が 60 以下になるまで。
			selectParadisPdfCanvasesToRelease([canvas(89), canvas(95), canvas(97), canvas(99), canvas(100), canvas(112)], plan, 60),
			// 古い倍率のもの（102）を先に、次に描く順番の後ろ（99 は 101 より後）から外す。見えているページ（100）は外さない。
			selectParadisPdfCanvasesToRelease([canvas(99), canvas(100), canvas(101), canvas(102, false)], plan, 30),
			// 先に描くか: 見えているページと、描く順番が前のページだけを数える。
			[fitsParadisPdfCanvasBudget([canvas(100), canvas(99)], plan, 101, 30, 60), fitsParadisPdfCanvasBudget([canvas(100), canvas(101)], plan, 99, 30, 60)],
		], [[89, 112, 95, 97], [102, 99, 101], [true, false]]);
	});

	test('keeps the canvases under the pixel budget while paging through a zoomed-in document', async () => {
		// 800% 相当: 1 枚が 1 枚の上限（2^25 画素）に達し、枚数だけなら前後 10 ページで 21 枚残る。
		const fake = new FakeHost(500, 2 ** 25);
		const scheduler = createParadisPdfPageScheduler(fake.host);
		for (let page = 0; page < 30; page++) {
			scheduler.setVisible(page - 1, false);
			scheduler.setVisible(page, true);
			scheduler.schedule();
			await scheduler.idle();
		}
		const total = [...fake.canvasesByIndex.values()].reduce((a, b) => a + b, 0);
		deepStrictEqual({ withinBudget: fake.maxPixels <= PARADIS_PDF_CANVAS_PIXEL_BUDGET, total, visibleDrawn: fake.canvasesByIndex.has(29) }, { withinBudget: true, total: 2 ** 26, visibleDrawn: true });
	});

	test('stops drawing a page that the reader jumped away from, and never keeps its canvas', async () => {
		const fake = new FakeHost(500, 1000);
		fake.autoFinish = false;
		const scheduler = createParadisPdfPageScheduler(fake.host);
		scheduler.setVisible(0, true);
		scheduler.schedule();
		await Promise.resolve();
		// 0 ページ目を描いている途中で、300 ページ目へ飛ぶ。
		scheduler.setVisible(0, false);
		scheduler.setVisible(300, true);
		scheduler.schedule();
		fake.autoFinish = true;
		for (const finish of [...fake.pending.values()]) {
			finish();
		}
		await scheduler.idle();
		deepStrictEqual({
			cancelled: fake.cancelled,
			drawn: [...fake.canvasesByIndex.keys()].sort((a, b) => a - b),
		}, { cancelled: [0], drawn: [298, 299, 300, 301, 302] });
	});
});
