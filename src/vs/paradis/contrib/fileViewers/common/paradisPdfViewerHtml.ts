/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF ビューアの webview に書く HTML。エディタ（electron-browser）から切り出して、ここでは文字列を
// 組み立てるだけにしている。ページの描き方の判断（どのページを描き、どのページの canvas を捨てるか）は
// 純関数 `planParadisPdfPages` に置き、webview のスクリプトへはその関数の本体をそのまま埋め込む。
//
// 大きい PDF で遅かった理由と、ここでの直し方:
//  - 文書全体を受け取って解析し終えるまで 1 ページ目を描けなかった（配信サーバが Range に対応して
//    いなかった）。53 MB・500 ページで 1 ページ目まで 2〜6 秒。大きい文書だけ区間読み
//    （`disableAutoFetch` + `disableStream`）にし、全ページの `getPage` も先にしない
//  - 描いたページの canvas を捨てなかった。100 ページを最後まで見ると約 794 MB。見えているページの
//    前後 `keep` ページだけ残し、残りは外す。戻ったときに白く見えないよう、見えているページの前後
//    `prerender` ページは先に描いておく（白く見えるのは遠くへ飛んだときだけになる）
//  - 小さい文書は今までどおり全体を一度に読む。区間読みは 1 回ごとの往復があるぶん、小さい文書では
//    かえって遅くなる（5 MB・50 ページで 1 ページ目まで中央値 0.70 秒 → 1.26 秒）

/**
 * これ以上の大きさの文書だけ区間読みにする。実測（2026-10-09）で、5 MB では区間読みが遅く、
 * 10 MB では測るたびに勝ち負けが入れ替わり、20 MB 以上では区間読みが速かったので、その間に置いた。
 */
export const PARADIS_PDF_RANGE_THRESHOLD_BYTES = 16 * 1024 * 1024;

/** 区間読みの 1 回の大きさ。pdf.js の既定（64 KiB）だと往復が多すぎる。 */
export const PARADIS_PDF_RANGE_CHUNK_BYTES = 256 * 1024;

/** 見えているページの前後で、先に描いておくページ数。 */
export const PARADIS_PDF_PRERENDER_PAGES = 2;

/** 見えているページの前後で、canvas を残しておくページ数。これより遠いページの canvas は外す。 */
export const PARADIS_PDF_KEEP_PAGES = 10;

/** 1 枚の canvas の画素数の上限（pdf.js の viewer の既定 `maxCanvasPixels` と同じ 2^25）。 */
export const PARADIS_PDF_MAX_CANVAS_PIXELS = 33554432;

/** 描く解像度の倍率（devicePixelRatio）の上限。3 だと 1 ページが 2 の 2.25 倍のメモリになる。 */
export const PARADIS_PDF_MAX_DEVICE_PIXEL_RATIO = 2;

/** 文書の大きさから、区間読みにするかを決める。配信サーバを使えないとき（リモート等）は今までどおり。 */
export function shouldParadisPdfUseRangeRequests(size: number | undefined, served: boolean): boolean {
	return served && size !== undefined && size >= PARADIS_PDF_RANGE_THRESHOLD_BYTES;
}

/** 最初のページが描けたときに webview からエディタへ送るメッセージの `type`。 */
export const PARADIS_PDF_FIRST_PAINT_MESSAGE = 'paradis-pdf-first-paint';

/** {@link planParadisPdfPages} の結果。番号はすべて 0 始まり。 */
export interface IParadisPdfPagePlan {
	/** 描く順番（見えているページ → 近い順に前後）。 */
	readonly order: number[];
	/** canvas を残す範囲の先頭（含む）。 */
	readonly keepFrom: number;
	/** canvas を残す範囲の末尾（含む）。 */
	readonly keepTo: number;
}

/**
 * 見えているページの範囲から、描く順番と canvas を残す範囲を決める。
 *
 * **webview のスクリプトへ関数の本体を文字列のまま埋め込む**ので、外の名前を一切参照しないこと
 * （引数とローカル変数だけで閉じている必要がある）。
 */
export function planParadisPdfPages(first: number, last: number, count: number, prerender: number, keep: number): IParadisPdfPagePlan {
	const order: number[] = [];
	for (let index = Math.max(0, first); index <= Math.min(count - 1, last); index++) {
		order.push(index);
	}
	for (let distance = 1; distance <= prerender; distance++) {
		if (last + distance < count) {
			order.push(last + distance);
		}
		if (first - distance >= 0) {
			order.push(first - distance);
		}
	}
	return { order, keepFrom: Math.max(0, first - keep), keepTo: Math.min(count - 1, last + keep) };
}

export interface IParadisPdfViewerHtmlOptions {
	readonly nonce: string;
	readonly pdfUrl: string;
	readonly libBase: string;
	/** CSP に足す配信サーバの origin（空文字なら足さない）。 */
	readonly serverOrigin: string;
	/** 区間読みにするか（{@link shouldParadisPdfUseRangeRequests}）。 */
	readonly useRangeRequests: boolean;
}

/** PDF ビューアの webview に書く HTML を組み立てる。 */
export function buildParadisPdfViewerHtml(options: IParadisPdfViewerHtmlOptions): string {
	const { nonce, pdfUrl, libBase, serverOrigin, useRangeRequests } = options;
	// 空のときは CSP に余分な空白を残さない。
	const serverSrc = serverOrigin ? ` ${serverOrigin}` : '';

	// CSP: スクリプトは nonce 付き inline module と webview リソース(https:)のみ。worker は
	// クロスオリジン制約を避けるため blob 化して起動する（worker-src blob:）。connect-src は
	// pdf.js が PDF 本体 / cmaps / standard_fonts を fetch するために webview リソースを許可する。
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https:${serverSrc} blob:; style-src 'nonce-${nonce}'; img-src blob: data:; font-src https:${serverSrc} data: blob:; connect-src https:${serverSrc} blob: data:; worker-src blob:;">
	<style nonce="${nonce}">
		html, body { margin: 0; padding: 0; height: 100%; }
		body {
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-font-family);
			font-size: 13px;
		}
		#scroller { position: absolute; inset: 0; overflow: auto; }
		#pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 16px 24px; }
		.pm-page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
		.pm-page canvas { display: block; width: 100%; height: 100%; }
		#toolbar {
			position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 10;
			display: flex; align-items: center; gap: 2px;
			background: var(--vscode-editorWidget-background, #252526);
			color: var(--vscode-editorWidget-foreground, #ccc);
			border: 1px solid var(--vscode-editorWidget-border, #454545);
			border-radius: 5px; padding: 2px 6px; user-select: none;
		}
		#toolbar button {
			background: transparent; color: inherit; border: none; border-radius: 3px;
			width: 24px; height: 22px; cursor: pointer; font-size: 14px; line-height: 1;
		}
		#toolbar button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31)); }
		#zoomLabel { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; }
		#pageLabel { margin-left: 8px; opacity: .8; font-variant-numeric: tabular-nums; }
		#status { position: absolute; top: 45%; width: 100%; text-align: center; opacity: .75; }
	</style>
</head>
<body>
	<div id="scroller"><div id="pages"></div></div>
	<div id="toolbar" hidden>
		<button id="zoomOut" title="縮小">−</button>
		<span id="zoomLabel">100%</span>
		<button id="zoomIn" title="拡大">＋</button>
		<button id="zoomFit" title="幅に合わせる">⤢</button>
		<span id="pageLabel"></span>
	</div>
	<div id="status">読み込み中…</div>
	<script type="module" nonce="${nonce}">
		const PDF_URL = ${JSON.stringify(pdfUrl)};
		const LIB = ${JSON.stringify(libBase)};
		const USE_RANGE = ${JSON.stringify(useRangeRequests)};
		const RANGE_CHUNK = ${PARADIS_PDF_RANGE_CHUNK_BYTES};
		const PRERENDER = ${PARADIS_PDF_PRERENDER_PAGES};
		const KEEP = ${PARADIS_PDF_KEEP_PAGES};
		const MAX_DPR = ${PARADIS_PDF_MAX_DEVICE_PIXEL_RATIO};
		const MAX_CANVAS_PIXELS = ${PARADIS_PDF_MAX_CANVAS_PIXELS};
		const planPages = ${planParadisPdfPages.toString()};
		const statusEl = document.getElementById('status');
		// 最初のページが描けたことをエディタへ知らせる（開いてから描けるまでの計測）。
		const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
		let firstPaintReported = false;
		try {
			const pdfjsLib = await import(LIB + '/pdf.min.mjs');
			// worker はリソースオリジンが document と異なり new Worker(url) が same-origin 制約で失敗するため、
			// fetch して blob URL から起動する。失敗時は workerSrc 指定に任せる（pdf.js が fake worker へフォールバック）。
			try {
				const src = await (await fetch(LIB + '/pdf.worker.min.mjs')).text();
				const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
				pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(blobUrl, { type: 'module' });
			} catch {
				pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + '/pdf.worker.min.mjs';
			}

			// 大きい文書は必要な区間だけ読む。小さい文書は今までどおり全体を一度に読む（区間読みを
			// 切っておかないと、サーバが Range に対応したことで pdf.js が勝手に混ぜて読み始める）。
			const doc = await pdfjsLib.getDocument({
				url: PDF_URL,
				cMapUrl: LIB + '/cmaps/',
				cMapPacked: true,
				standardFontDataUrl: LIB + '/standard_fonts/',
				...(USE_RANGE
					? { disableAutoFetch: true, disableStream: true, rangeChunkSize: RANGE_CHUNK }
					: { disableRange: true })
			}).promise;

			const scroller = document.getElementById('scroller');
			const pagesEl = document.getElementById('pages');
			const toolbar = document.getElementById('toolbar');
			const zoomLabel = document.getElementById('zoomLabel');
			const pageLabel = document.getElementById('pageLabel');

			// 1 ページ目だけ先に取る。残りのページは近づいたときに取る（区間読みでは、全ページを先に
			// 取ると結局ほぼ全体を読むことになる）。大きさが分かるまでは 1 ページ目と同じ大きさで置く。
			const firstPage = await doc.getPage(1);
			const base = firstPage.getViewport({ scale: 1 });
			const pages = [];
			for (let i = 1; i <= doc.numPages; i++) {
				const wrap = document.createElement('div');
				wrap.className = 'pm-page';
				wrap.dataset.index = String(i - 1);
				pagesEl.appendChild(wrap);
				pages.push({ index: i - 1, page: i === 1 ? firstPage : null, loading: null, width: base.width, height: base.height, wrap, canvas: null, renderedScale: 0, renderTask: null });
			}

			// 初期スケール = 1ページ目が横幅に収まる倍率（100%を上限にしない: 小さいPDFは等倍のまま）。
			const fitScale = () => Math.max(0.1, (scroller.clientWidth - 48) / base.width);
			let scale = Math.min(fitScale(), 2);

			const sizePage = (p) => {
				p.wrap.style.width = (p.width * scale) + 'px';
				p.wrap.style.height = (p.height * scale) + 'px';
			};
			const applySizes = () => {
				for (const p of pages) { sizePage(p); }
				zoomLabel.textContent = Math.round(scale * 100) + '%';
			};

			const loadPage = (p) => {
				if (p.page) { return Promise.resolve(p.page); }
				p.loading ??= doc.getPage(p.index + 1).then(page => {
					p.page = page;
					const vp = page.getViewport({ scale: 1 });
					if (vp.width !== p.width || vp.height !== p.height) {
						p.width = vp.width;
						p.height = vp.height;
						sizePage(p);
					}
					return page;
				}, err => {
					// 失敗を覚えたままにすると、そのページは二度と描けなくなる。次に近づいたときに取り直す。
					p.loading = null;
					throw err;
				});
				return p.loading;
			};

			// canvas を外す。width/height を 0 にして、DOM から外れる前に裏のメモリを手放させる。
			const releaseCanvas = (p) => {
				if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; }
				if (p.canvas) {
					p.canvas.width = 0;
					p.canvas.height = 0;
					p.canvas.remove();
					p.canvas = null;
				}
				p.renderedScale = 0;
			};

			const renderPage = async (p) => {
				if (p.renderedScale === scale) { return; }
				if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; }
				const target = scale;
				const page = await loadPage(p);
				if (scale !== target) { return; }
				const cssViewport = page.getViewport({ scale: target });
				let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
				const area = cssViewport.width * cssViewport.height;
				if (area * dpr * dpr > MAX_CANVAS_PIXELS) { dpr = Math.sqrt(MAX_CANVAS_PIXELS / area); }
				const vp = page.getViewport({ scale: target * dpr });
				const canvas = document.createElement('canvas');
				canvas.width = Math.floor(vp.width);
				canvas.height = Math.floor(vp.height);
				const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
				p.renderTask = task;
				try {
					await task.promise;
				} catch {
					canvas.width = 0;
					canvas.height = 0;
					return; // キャンセル（ズーム変更・遠くへ移った等）
				}
				p.renderTask = null;
				if (scale !== target) { canvas.width = 0; canvas.height = 0; return; }
				if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; }
				p.wrap.replaceChildren(canvas);
				p.canvas = canvas;
				p.renderedScale = target;
				if (!firstPaintReported) {
					firstPaintReported = true;
					requestAnimationFrame(() => vscodeApi?.postMessage({ type: '${PARADIS_PDF_FIRST_PAINT_MESSAGE}', pages: pages.length }));
				}
			};

			// 見えているページ（0 始まりの番号）。描く順番と残す範囲はここから決める。
			const visible = new Set();
			let rendering = null;
			let pumping = false;
			let dirty = false;

			const visibleRange = () => {
				let first = Infinity;
				let last = -Infinity;
				for (const index of visible) { first = Math.min(first, index); last = Math.max(last, index); }
				return visible.size ? { first, last } : undefined;
			};

			// 1 ページずつ順に描く（pdf.js の worker は 1 本なので、並べても速くならない）。
			const pump = async () => {
				if (pumping) { dirty = true; return; }
				pumping = true;
				try {
					do {
						dirty = false;
						const range = visibleRange();
						if (!range) { break; }
						const plan = planPages(range.first, range.last, pages.length, PRERENDER, KEEP);
						for (const p of pages) {
							if ((p.canvas || p.renderTask) && (p.index < plan.keepFrom || p.index > plan.keepTo)) { releaseCanvas(p); }
						}
						for (const index of plan.order) {
							if (dirty) { break; }
							const p = pages[index];
							if (p.renderedScale === scale) { continue; }
							rendering = p;
							try {
								await renderPage(p);
							} catch {
								// 1 ページ読めなくても、ほかのページは描き続ける。
							}
							rendering = null;
						}
					} while (dirty);
				} finally {
					pumping = false;
					rendering = null;
				}
			};

			const schedule = () => {
				// 遠くへ飛んだら、描いている途中の離れたページは待たずに止める。
				const range = visibleRange();
				if (rendering && rendering.renderTask && range && (rendering.index < range.first - PRERENDER || rendering.index > range.last + PRERENDER)) {
					rendering.renderTask.cancel();
				}
				void pump();
			};

			const observer = new IntersectionObserver(entries => {
				for (const e of entries) {
					const index = Number(e.target.dataset.index);
					if (e.isIntersecting) { visible.add(index); } else { visible.delete(index); }
				}
				updatePageLabel();
				schedule();
			}, { root: scroller });
			for (const p of pages) { observer.observe(p.wrap); }

			const rerenderVisible = () => {
				applySizes();
				schedule();
			};

			let zoomTimer;
			const setZoom = (next) => {
				scale = Math.min(8, Math.max(0.1, next));
				applySizes();
				clearTimeout(zoomTimer);
				zoomTimer = setTimeout(rerenderVisible, 120);
			};

			const updatePageLabel = () => {
				const mid = scroller.scrollTop + scroller.clientHeight / 2;
				let current = 1;
				for (let i = 0; i < pages.length; i++) {
					const el = pages[i].wrap;
					if (el.offsetTop <= mid) { current = i + 1; }
				}
				pageLabel.textContent = current + ' / ' + pages.length;
			};

			document.getElementById('zoomIn').addEventListener('click', () => setZoom(scale * 1.2));
			document.getElementById('zoomOut').addEventListener('click', () => setZoom(scale / 1.2));
			document.getElementById('zoomFit').addEventListener('click', () => setZoom(fitScale()));
			scroller.addEventListener('scroll', updatePageLabel, { passive: true });
			window.addEventListener('resize', () => { clearTimeout(zoomTimer); zoomTimer = setTimeout(rerenderVisible, 200); });
			// Ctrl/Cmd + ホイールでズーム（一般的なPDFビューアと同じ操作感）。
			scroller.addEventListener('wheel', e => {
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					setZoom(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
				}
			}, { passive: false });

			applySizes();
			updatePageLabel();
			toolbar.hidden = false;
			statusEl.remove();

			// 全体を読んである文書は、残りのページの大きさを裏で揃えておく（大きさの違うページが
			// 混ざっていても、スクロールしてから位置がずれない）。区間読みでは読み込みが増えるのでしない。
			if (!USE_RANGE) {
				void (async () => {
					for (const p of pages) { await loadPage(p); }
				})().catch(() => { /* 大きさを揃えられなくても、近づいたときに取り直す */ });
			}
		} catch (err) {
			statusEl.textContent = 'PDF を表示できませんでした: ' + (err && err.message ? err.message : err);
		}
	</script>
</body>
</html>`;
}
