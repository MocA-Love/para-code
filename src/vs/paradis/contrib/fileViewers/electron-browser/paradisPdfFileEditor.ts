/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF ビューア。vendored pdf.js（media/pdfjs/、pdfjs-dist の build 成果物）を webview 内で実行し、
// PDF 本体は base64 化せず asWebviewUri のリソース URL を pdf.js に直接 fetch させる（大きい PDF でも
// レンダラのメモリを二重に食わない）。ページはビューポート近傍のみ遅延レンダリングし、ズームは
// ツールバー（webview 内）で再レンダリングする。日本語 PDF の非埋め込み CID フォントのために
// cmaps/、非埋め込み標準フォントのために standard_fonts/ を同梱している。
//
// webview のライフサイクル（OverlayWebview + claim/release）は paradisRenderedFileEditor.ts と
// 同じ方式（upstream webviewPanel 準拠）。PDF に Raw モードは無いためトグルは持たない。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisPdfInput } from './paradisPdfInput.js';
import { PARADIS_PDF_EDITOR_ID } from '../browser/paradisFileViewers.js';

/** vendored pdf.js 成果物の配置ディレクトリ（AppResourcePath）。 */
const PDFJS_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs' as const;

export class ParadisPdfFileEditor extends EditorPane {

	static readonly ID = PARADIS_PDF_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	private _webviewClaimed = false;
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super(PARADIS_PDF_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-pdf-viewer'));
		this._rootElement.style.position = 'relative';
		this._rootElement.style.overflow = 'hidden';
		// overlay webview を重ねる位置合わせ用アンカー（paradisRenderedFileEditor と同方式）。
		this._webviewContainer = dom.append(this._rootElement, dom.$('.paradis-pdf-viewer-webview'));
		this._webviewContainer.style.position = 'absolute';
		this._webviewContainer.style.inset = '0';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisPdfInput).resource;
		this._currentResource = resource;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		// ディスク上の PDF が差し替わったら表示中なら再レンダリングする。
		try {
			const watcher = this._fileService.createWatcher(resource, { recursive: false, excludes: [] });
			store.add(watcher);
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource) && isEqual(this._currentResource, resource) && this._webviewClaimed) {
					this._renderResource(resource);
				}
			}));
		} catch {
			// watcher が作れなくても表示は継続できる。
		}

		this._updateWebviewPlacement();
	}

	private _ensureWebview(resource: URI): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		const webview = this._webviewService.createWebviewOverlay({
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: this._localResourceRoots(resource)
			},
			extension: undefined
		});
		this._webview = webview;
		this._register(webview);
		return webview;
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(PDFJS_MEDIA_ROOT)];
	}

	private _renderResource(resource: URI): void {
		const webview = this._ensureWebview(resource);
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		webview.setHtml(this._buildHtml(resource));
	}

	private _buildHtml(resource: URI): string {
		const nonce = generateUuid();
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const pdfUrl = asWebviewUri(resource, remoteInfo).toString(true);
		const libBase = asWebviewUri(FileAccess.asFileUri(PDFJS_MEDIA_ROOT)).toString(true);

		// CSP: スクリプトは nonce 付き inline module と webview リソース(https:)のみ。worker は
		// クロスオリジン制約を避けるため blob 化して起動する（worker-src blob:）。connect-src は
		// pdf.js が PDF 本体 / cmaps / standard_fonts を fetch するために webview リソースを許可する。
		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https: blob:; style-src 'nonce-${nonce}'; img-src blob: data:; font-src https: data: blob:; connect-src https: blob: data:; worker-src blob:;">
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
		const statusEl = document.getElementById('status');
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

			const doc = await pdfjsLib.getDocument({
				url: PDF_URL,
				cMapUrl: LIB + '/cmaps/',
				cMapPacked: true,
				standardFontDataUrl: LIB + '/standard_fonts/'
			}).promise;

			const scroller = document.getElementById('scroller');
			const pagesEl = document.getElementById('pages');
			const toolbar = document.getElementById('toolbar');
			const zoomLabel = document.getElementById('zoomLabel');
			const pageLabel = document.getElementById('pageLabel');

			const pages = [];
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const wrap = document.createElement('div');
				wrap.className = 'pm-page';
				pagesEl.appendChild(wrap);
				pages.push({ page, wrap, canvas: null, renderedScale: 0, renderTask: null });
			}

			// 初期スケール = 1ページ目が横幅に収まる倍率（100%を上限にしない: 小さいPDFは等倍のまま）。
			const base = pages[0].page.getViewport({ scale: 1 });
			const fitScale = () => Math.max(0.1, (scroller.clientWidth - 48) / base.width);
			let scale = Math.min(fitScale(), 2);

			const applySizes = () => {
				for (const p of pages) {
					const vp = p.page.getViewport({ scale });
					p.wrap.style.width = vp.width + 'px';
					p.wrap.style.height = vp.height + 'px';
				}
				zoomLabel.textContent = Math.round(scale * 100) + '%';
			};

			const renderPage = async (p) => {
				if (p.renderedScale === scale) { return; }
				if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; }
				const target = scale;
				const dpr = Math.min(window.devicePixelRatio || 1, 3);
				const vp = p.page.getViewport({ scale: target * dpr });
				const canvas = document.createElement('canvas');
				canvas.width = Math.floor(vp.width);
				canvas.height = Math.floor(vp.height);
				const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
				p.renderTask = task;
				try {
					await task.promise;
				} catch {
					return; // キャンセル（ズーム変更等）
				}
				if (scale !== target) { return; }
				p.wrap.replaceChildren(canvas);
				p.canvas = canvas;
				p.renderedScale = target;
				p.renderTask = null;
			};

			const visible = new Set();
			const observer = new IntersectionObserver(entries => {
				for (const e of entries) {
					const p = pages.find(x => x.wrap === e.target);
					if (!p) { continue; }
					if (e.isIntersecting) { visible.add(p); void renderPage(p); }
					else { visible.delete(p); }
				}
				updatePageLabel();
			}, { root: scroller, rootMargin: '600px 0px' });
			for (const p of pages) { observer.observe(p.wrap); }

			const rerenderVisible = () => {
				applySizes();
				for (const p of pages) { p.renderedScale = p.renderedScale === scale ? scale : 0; }
				for (const p of visible) { void renderPage(p); }
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
		} catch (err) {
			statusEl.textContent = 'PDF を表示できませんでした: ' + (err && err.message ? err.message : err);
		}
	</script>
</body>
</html>`;
	}

	private _updateWebviewPlacement(): void {
		const resource = this._currentResource;
		const shouldShow = this._editorVisible && !!resource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			return;
		}
		const webview = this._ensureWebview(resource);
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		if (justClaimed) {
			this._renderResource(resource);
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._currentResource = undefined;
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			this._updateWebviewPlacement();
		}
		super.setEditorVisible(visible);
	}

	override focus(): void {
		super.focus();
		this._webview?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}
