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
import { ParadisWebviewOriginPool } from '../browser/paradisWebviewOriginPool.js';
import { paradisPreviewOrigins, resolveParadisViewerDocumentUrl, resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
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
const PDF_HEADER_BYTES = 5;

/** PDFの先頭シグネチャを検証する。 */
export function isParadisPdfHeader(bytes: Uint8Array): boolean {
	return bytes.length === PDF_HEADER_BYTES && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export async function readParadisPdfHeader(fileService: IFileService, resource: URI): Promise<boolean | undefined> {
	try {
		return isParadisPdfHeader((await fileService.readFile(resource, { length: PDF_HEADER_BYTES })).value.buffer);
	} catch {
		return undefined;
	}
}

export type ParadisPdfRenderDecision = 'rejected' | 'viewer' | 'stale';

export function getParadisPdfRenderDecision(isValid: boolean | undefined, resource: URI, currentResource: URI | undefined, generation: number, currentGeneration: number): ParadisPdfRenderDecision {
	if (generation !== currentGeneration || !isEqual(currentResource, resource)) {
		return 'stale';
	}
	return isValid === false ? 'rejected' : 'viewer';
}

export class ParadisPdfFileEditor extends EditorPane {

	static readonly ID = PARADIS_PDF_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	/** webview の origin の貸し出し元（service worker の登録を開き直しで増やさないため）。 */
	private readonly _originPool: ParadisWebviewOriginPool;
	private _webviewClaimed = false;
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private _renderGeneration = 0;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super(PARADIS_PDF_EDITOR_ID, group, telemetryService, themeService, storageService);
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);
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

		if (this._webviewClaimed) {
			this._renderResource(resource);
		}
		this._updateWebviewPlacement();
	}

	/**
	 * 同梱ライブラリの置き場。**ペインにつき一度だけ**決める（アプリの中にあるので入力に依らない）。
	 * 文書の URL はこれとは別に、入力ごとに解決する（使い回されるペインで焼き付けないため）。
	 */
	private _libBase: Promise<string | undefined> | undefined;
	/** 上の答えが出たか。webview の生成は答えが出るまで待つ（生成時にしか渡せないため）。 */
	private _libBaseResolved = false;
	private _resolvedLibBase: string | undefined;
	/** いまの webview を作ったときに service worker を切ったか。要否が変わったら作り直す。 */
	private _webviewServiceWorkerDisabled = false;
	/** webview とその貸し出し origin。作り直せるようにまとめて捨てられる形で持つ。 */
	private readonly _webviewStore = this._register(new MutableDisposable<DisposableStore>());

	private async _resolveLibBase(): Promise<string | undefined> {
		this._libBase ??= resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(PDFJS_MEDIA_ROOT));
		const libBase = await this._libBase;
		this._resolvedLibBase = libBase;
		this._libBaseResolved = true;
		return libBase;
	}

	/**
	 * 文書だけ載せられなかったことがあるか。
	 *
	 * ライブラリは載ったが文書の mount だけ失敗すると、「service worker を切った webview に、
	 * service worker でしか解決できない URL を渡す」状態になり、ライブラリすら読めなくなる。
	 * **真偽値を毎回計算し直すと placement 側（文書 URL を知らない）と食い違って作り直しが
	 * 往復する**ので、一度失敗したらラッチして以後はサーバを使わない。
	 */
	private _documentServeFailed = false;

	/** このリソースを配信サーバから出せるか（ライブラリを載せられて、文書が手元にある）。 */
	private _canServe(resource: URI): boolean {
		return !!this._resolvedLibBase && !this._documentServeFailed && resource.scheme === Schemas.file;
	}

	private _disposeWebview(): void {
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
		}
		this._webviewClaimed = false;
		this._webview = undefined;
		this._webviewStore.clear();
	}

	private _ensureWebview(resource: URI): IOverlayWebview {
		const wantsServiceWorkerDisabled = this._canServe(resource);
		if (this._webview && this._webviewServiceWorkerDisabled !== wantsServiceWorkerDisabled) {
			// 生成時オプションなので、要否が変わったら作り直すしかない（別のファイルを開いたとき等）。
			this._disposeWebview();
		}
		if (this._webview) {
			return this._webview;
		}
		const store = new DisposableStore();
		this._webviewStore.value = store;
		this._webviewServiceWorkerDisabled = wantsServiceWorkerDisabled;
		// origin を渡さないと webview ごとに新しい service worker 登録が増え、二度と消えない。
		const originLease = store.add(this._originPool.acquire(PARADIS_PDF_EDITOR_ID));
		const webview = this._webviewService.createWebviewOverlay({
			origin: originLease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true,
				// 非表示になるたびに service worker 登録からやり直すと、白紙で止まる窓が毎回でき直す
				// （paradisRenderedFileEditor.ts と同じ「間欠的に白紙になる」フィールド報告の主因）。
				// 生かしたまま隠すことでその窓を無くす。
				retainContextWhenHidden: true,
				// ローカルサーバから配れるなら service worker は要らない（60秒待ちの経路に入らない）。
				disableServiceWorker: wantsServiceWorkerDisabled
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: this._localResourceRoots(resource)
			},
			extension: undefined
		});
		this._webview = webview;
		store.add(webview);
		return webview;
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(PDFJS_MEDIA_ROOT)];
	}

	protected _renderResource(resource: URI): void {
		const generation = ++this._renderGeneration;
		void this._renderResourceAfterPreflight(resource, generation);
	}

	private async _renderResourceAfterPreflight(resource: URI, generation: number): Promise<void> {
		await this._resolveLibBase();
		const documentUrl = this._canServe(resource) ? await resolveParadisViewerDocumentUrl(this._sharedProcessService, resource) : undefined;
		if (this._canServe(resource) && documentUrl === undefined) {
			// 文書だけ載らなかった。この webview の作り方では読めないので、以後サーバを使わない。
			this._documentServeFailed = true;
		}
		// `_ensureWebview` は要否が変わると webview を捨てる破壊的な操作になったので、
		// 追い越された描画がここへ来て新しい webview を捨てないよう先に落とす。
		if (generation !== this._renderGeneration || !isEqual(this._currentResource, resource)) {
			return;
		}
		const webview = this._ensureWebview(resource);
		// 配信先が決まる前に見送った claim をここで拾う。
		this._updateWebviewPlacement();
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		const isValid = await readParadisPdfHeader(this._fileService, resource);
		switch (getParadisPdfRenderDecision(isValid, resource, this._currentResource, generation, this._renderGeneration)) {
			case 'rejected':
				webview.setHtml(this._buildRejectedFileHtml());
				return;
			case 'viewer':
				webview.setHtml(this._buildHtml(resource, documentUrl));
				return;
			case 'stale':
				return;
		}
	}

	private _buildRejectedFileHtml(): string {
		return '<!DOCTYPE html><html><body>PDF を表示できませんでした: ファイルが空または破損しています</body></html>';
	}

	private _buildHtml(resource: URI, documentUrl: string | undefined): string {
		const nonce = generateUuid();
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		// 配信サーバを使うかどうかは webview の作り方と揃える。片方だけサーバにすると、
		// service worker を切った webview に解決できない URL を渡すことになる。
		const served = this._webviewServiceWorkerDisabled && documentUrl !== undefined;
		const pdfUrl = served ? documentUrl : asWebviewUri(resource, remoteInfo).toString(true);
		const libBase = served && this._resolvedLibBase ? this._resolvedLibBase : asWebviewUri(FileAccess.asFileUri(PDFJS_MEDIA_ROOT)).toString(true);
		// CSP は実際に使うポートまで絞る。`http://127.0.0.1:*` にすると、他のプロセスが立てた
		// ローカルサーバまで script-src に含めてしまう。
		const serverOrigin = served ? paradisPreviewOrigins(libBase, pdfUrl) : '';
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
		if (!this._webview && !this._libBaseResolved) {
			// 配信先が決まる前に作ると service worker の要否を間違える。**ここで自分で解決を蹴ること。**
			// 描画側に任せると、描画は claim 済みでないと走らないので、初回は誰も蹴らずに白紙のまま止まる。
			void this._resolveLibBase().then(() => this._updateWebviewPlacement());
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
