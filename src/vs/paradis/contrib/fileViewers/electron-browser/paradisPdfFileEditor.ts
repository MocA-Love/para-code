/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// PDF ビューア。vendored pdf.js（media/pdfjs/、pdfjs-dist の build 成果物）を webview 内で実行し、
// PDF 本体は base64 化せず asWebviewUri のリソース URL を pdf.js に直接 fetch させる（大きい PDF でも
// レンダラのメモリを二重に食わない）。webview に書く HTML とページの描き方は
// common/paradisPdfViewerHtml.ts にある（大きい文書の区間読み、遠いページの canvas の解放）。
// 日本語 PDF の非埋め込み CID フォントのために cmaps/、非埋め込み標準フォントのために
// standard_fonts/ を同梱している。
//
// webview のライフサイクル（OverlayWebview + claim/release）は paradisRenderedFileEditor.ts と
// 同じ方式（upstream webviewPanel 準拠）。PDF に Raw モードは無いためトグルは持たない。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { readParadisFileHead } from '../../../../platform/files/common/paradisReadFileHead.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ParadisOverlayWebviewPane, watchParadisViewerResource } from '../browser/paradisOverlayWebviewPane.js';
import { paradisPreviewOrigins, resolveParadisViewerDocumentUrl, resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ParadisPdfInput } from './paradisPdfInput.js';
import { PARADIS_PDF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { buildParadisPdfViewerHtml, PARADIS_PDF_FIRST_PAINT_MESSAGE, PARADIS_PDF_VIEW_STATE_MESSAGE, PARADIS_PDF_ZOOM_MESSAGE, ParadisPdfZoomCommand, shouldParadisPdfUseRangeRequests } from '../common/paradisPdfViewerHtml.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarIconButton, appendParadisViewerToolbarPercent, createParadisViewerToolbar } from '../browser/paradisViewerToolbar.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { IParadisViewerOpenTiming, startParadisViewerOpenTiming } from '../common/paradisViewerOpenTiming.js';
import { paradisViewerWebviewFailureHtml } from '../common/paradisViewerWebviewState.js';

/** vendored pdf.js 成果物の配置ディレクトリ（AppResourcePath）。 */
const PDFJS_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs' as const;
const PDF_HEADER_BYTES = 5;

/** PDFの先頭シグネチャを検証する。 */
export function isParadisPdfHeader(bytes: Uint8Array): boolean {
	return bytes.length === PDF_HEADER_BYTES && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export async function readParadisPdfHeader(fileService: IFileService, resource: URI): Promise<boolean | undefined> {
	try {
		return isParadisPdfHeader((await readParadisFileHead(fileService, resource, { length: PDF_HEADER_BYTES })).value.buffer);
	} catch {
		return undefined;
	}
}

/** 文書の大きさ（バイト）と etag。分からなければ `undefined`（区間読みにせず、描いた記録も残さない）。 */
async function readParadisPdfStat(fileService: IFileService, resource: URI): Promise<{ readonly size: number; readonly mtime: number; readonly etag: string } | undefined> {
	try {
		const stat = await fileService.stat(resource);
		return { size: stat.size, mtime: stat.mtime, etag: stat.etag };
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
	/** overlay webview（作り方・配置・同梱ライブラリの置き場は部品が持つ）。 */
	private readonly _pane: ParadisOverlayWebviewPane;
	private _pageLabel: HTMLElement | undefined;
	private _percentButton: HTMLButtonElement | undefined;
	/** webview の origin の貸し出し元（service worker の登録を開き直しで増やさないため）。 */
	private _editorVisible = false;
	private _currentResource: URI | undefined;
	private _renderGeneration = 0;
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	/** 開いてから最初のページが描けるまでの計測（Sentry へ数値だけ送る）。 */
	private readonly _openTiming = this._register(new MutableDisposable<IParadisViewerOpenTiming>());
	/** いま描いている文書の、計測に添える値（大きさと区間読みか）。 */
	private _renderedDocument: { readonly sizeKb: number | undefined; readonly rangeRequests: boolean; readonly served: boolean; readonly render: string } | undefined;
	/**
	 * 開いた時刻（`setInput`、`performance.now()`）と、そこから配信サーバへの登録が返るまで・webview を確保するまでの ms。
	 * 開いてから描けるまでのどこで待ったかを、計測に添えて送るため（表示には使わない）。
	 */
	private _openMarks: { readonly startedAt: number; mount?: number; webview?: number } | undefined;
	/**
	 * webview に残っている文書。タブを離れると clearInput を通るので、入力ではなくペインに持つ。
	 * 同じ文書・同じ etag へ戻ったときは描き直さない（retainContextWhenHidden で中身もスクロール位置も残っている）。
	 */

	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super(PARADIS_PDF_EDITOR_ID, group, telemetryService, themeService, storageService);
		this._pane = this._register(new ParadisOverlayWebviewPane(this, {
			originKey: PARADIS_PDF_EDITOR_ID,
			enableFindWidget: false,
			allowScripts: true,
			resolveLibBase: () => resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(PDFJS_MEDIA_ROOT)),
			onDidCreate: (webview, store) => this._onWebviewCreated(webview, store),
			// PDF には Raw が無いので白紙の検知（作り直して最後は Raw へ倒す）は入れず、基盤の致命エラーを送るだけにする。
			reportFatalErrorAs: PARADIS_PDF_EDITOR_ID,
		}, webviewService, layoutService, storageService));
		// ライブラリの置き場は入力に依らないので、ここで先に決めておく。開く操作が
		// 共有プロセスの応答を待たされる最悪値が、そのぶん短くなる。
		void this._pane.resolveLibBase();
	}

	protected override createEditor(parent: HTMLElement): void {
		// タブを閉じたら、戻るための記録と描画を捨てる。
		this._register(this.group.onDidCloseEditor(e => {
			if (e.editor instanceof ParadisPdfInput) {
				// 戻るために残していた描画（pdf.js の canvas）も捨てる。閉じた後まで抱えない。
				this._pane.clearContentFor(e.editor.resource);
			}
		}));
		this._rootElement = dom.append(parent, dom.$('.paradis-pdf-viewer'));
		this._rootElement.style.position = 'relative';
		this._rootElement.style.overflow = 'hidden';
		// 全ビューア共通のバー。左にページ番号、右に拡大縮小と「幅に合わせる」。ページの中には置かない。
		const toolbar = createParadisViewerToolbar(this._rootElement, 'paradis-pdf-toolbar', localize('paradis.pdf.toolbar', "PDF のツールバー"));
		this._pageLabel = dom.append(toolbar.start, dom.$('span.paradis-viewer-toolbar-position'));
		const zoom = appendParadisViewerToolbarGroup(toolbar.end);
		this._appendZoomButton(zoom, Codicon.zoomOut, localize('paradis.pdf.zoomOut', "ズームアウト"), 'out');
		this._percentButton = appendParadisViewerToolbarPercent(zoom, localize('paradis.pdf.resetZoom', "ズームをリセット"));
		this._register(dom.addDisposableListener(this._percentButton, dom.EventType.CLICK, () => this._postZoom('reset')));
		this._appendZoomButton(zoom, Codicon.zoomIn, localize('paradis.pdf.zoomIn', "ズームイン"), 'in');
		this._appendZoomButton(appendParadisViewerToolbarGroup(toolbar.end), Codicon.screenFull, localize('paradis.pdf.fitWidth', "幅に合わせる"), 'fit');
		// overlay webview を重ねる位置合わせ用アンカー（paradisRenderedFileEditor と同方式）。バーの下から。
		this._webviewContainer = dom.append(this._rootElement, dom.$('.paradis-pdf-viewer-webview'));
		this._webviewContainer.style.position = 'absolute';
		this._webviewContainer.style.inset = '28px 0 0 0';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const resource = (input as ParadisPdfInput).resource;
		this._currentResource = resource;
		this._openTiming.value = startParadisViewerOpenTiming('pdf');
		this._openMarks = { startedAt: performance.now() };

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		// ディスク上の PDF が差し替わったら表示中なら再レンダリングする（通知が続いても 50ms に 1 回）。
		store.add(watchParadisViewerResource(this._fileService, resource, () => {
			if (isEqual(this._currentResource, resource) && this._pane.claimed) {
				this._renderResource(resource);
			}
		}));

		if (this._pane.claimed) {
			this._renderResource(resource);
		}
		this._updateWebviewPlacement();
	}

	/** このリソースを配信サーバから出せるか（ライブラリを載せられて、文書が手元にある）。 */
	private _canServe(resource: URI): boolean {
		return !!this._pane.libBase && !this._pane.documentServeFailed && resource.scheme === Schemas.file;
	}

	/** webview を返す（ローカルサーバから配れるなら service worker を切った webview。要否が変わったら作り直す）。 */
	private _ensureWebview(resource: URI): IOverlayWebview {
		return this._pane.ensure(this._canServe(resource), this._localResourceRoots(resource));
	}

	private _onWebviewCreated(webview: IOverlayWebview, store: DisposableStore): void {
		store.add(webview.onMessage(({ message }) => {
			if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === PARADIS_PDF_VIEW_STATE_MESSAGE
				&& this._renderedDocument !== undefined && (message as { render?: unknown }).render === this._renderedDocument.render) {
				const state = message as { zoom?: unknown; page?: unknown; pages?: unknown };
				this._showViewState(state.zoom, state.page, state.pages);
				return;
			}
			// 使い回した webview では、前の文書の知らせが遅れて届くことがある。いま描いている HTML の知らせだけを使う。
			if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === PARADIS_PDF_FIRST_PAINT_MESSAGE
				&& this._renderedDocument !== undefined && (message as { render?: unknown }).render === this._renderedDocument.render) {
				this._pane.confirmShown(webview);
				const pages = (message as { pages?: unknown }).pages;
				const marks = this._openMarks;
				this._openTiming.value?.painted({
					...(typeof pages === 'number' ? { safe_pages: pages } : {}),
					...(this._renderedDocument?.sizeKb !== undefined ? { safe_size_kb: this._renderedDocument.sizeKb } : {}),
					safe_range: this._renderedDocument?.rangeRequests ?? false,
					safe_served: this._renderedDocument?.served ?? false,
					...(marks?.mount !== undefined ? { safe_mount_ms: marks.mount } : {}),
					...(marks?.webview !== undefined ? { safe_webview_ms: marks.webview } : {}),
				});
				this._openTiming.clear();
			}
		}));
	}

	private _appendZoomButton(parent: HTMLElement, icon: ThemeIcon, title: string, command: ParadisPdfZoomCommand): void {
		const button = appendParadisViewerToolbarIconButton(parent, icon, title);
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => this._postZoom(command)));
	}

	private _postZoom(command: ParadisPdfZoomCommand): void {
		void this._pane.webview?.postMessage({ type: PARADIS_PDF_ZOOM_MESSAGE, command });
	}

	/** ページの中から届いた拡大率とページ番号をバーに出す。値が無いとき（描く前）は空にする。 */
	private _showViewState(zoom: unknown, page: unknown, pages: unknown): void {
		if (this._percentButton) {
			this._percentButton.textContent = typeof zoom === 'number' ? `${zoom}%` : '';
		}
		if (this._pageLabel) {
			this._pageLabel.textContent = typeof page === 'number' && typeof pages === 'number' ? localize('paradis.pdf.pageOf', "{0} / {1} ページ", page, pages) : '';
		}
	}

	private _localResourceRoots(resource: URI): URI[] {
		return [dirname(resource), FileAccess.asFileUri(PDFJS_MEDIA_ROOT)];
	}

	/**
	 * @param reuseShown タブへ戻ったときの描画。同じ文書がまだ webview に残っていれば送り直さない。
	 * ファイルの変更や新しい入力では `false`（必ず描き直す）。
	 */
	/** 残っている表示を使い回せるかを決める値。中身は etag・大きさ・更新時刻で見る（中身のハッシュは取らない）。 */
	private _shownKeys(stat: { readonly size: number; readonly mtime: number; readonly etag: string }, documentUrl: string | undefined): readonly unknown[] {
		return [stat.etag, stat.size, stat.mtime, documentUrl ?? ''];
	}

	protected _renderResource(resource: URI, reuseShown = false): void {
		const generation = ++this._renderGeneration;
		void this._renderResourceAfterPreflight(resource, generation, reuseShown);
	}

	private async _renderResourceAfterPreflight(resource: URI, generation: number, reuseShown: boolean): Promise<void> {
		await this._pane.resolveLibBase();
		if (reuseShown && this._pane.shown && this._pane.webview && this._pane.serviceWorkerDisabled === this._canServe(resource)) {
			// 配信サーバから読んでいる文書は、登録を取り直してから使い回す。取り直さないと、裏にいる間に
			// 古い順に外され（上限 64 件）、区間読みの大きな PDF で、まだ読んでいないページが読めなくなる。
			// 外れていたら新しい URL になるので、鍵が合わずに描き直す。
			const [stat, documentUrl] = await Promise.all([
				readParadisPdfStat(this._fileService, resource),
				this._canServe(resource) ? resolveParadisViewerDocumentUrl(this._sharedProcessService, resource) : Promise.resolve(undefined),
			]);
			if (generation !== this._renderGeneration || !isEqual(this._currentResource, resource)) {
				return;
			}
			if (stat?.etag && this._pane.canReuseShown(resource, this._shownKeys(stat, documentUrl))) {
				// 前の表示がそのまま見えている。描くのにかかった時間ではないので、開くまでの計測も使わない。
				this._openTiming.clear();
				return;
			}
		}
		const documentUrl = this._canServe(resource) ? await resolveParadisViewerDocumentUrl(this._sharedProcessService, resource) : undefined;
		this._noteOpenMark('mount');
		if (this._canServe(resource) && documentUrl === undefined) {
			// 文書だけ載らなかった。この webview の作り方では読めないので、以後サーバを使わない。
			this._pane.markDocumentServeFailed();
		}
		// `_ensureWebview` は要否が変わると webview を捨てる破壊的な操作になったので、
		// 追い越された描画がここへ来て新しい webview を捨てないよう先に落とす。
		if (generation !== this._renderGeneration || !isEqual(this._currentResource, resource)) {
			return;
		}
		const webview = this._ensureWebview(resource);
		this._noteOpenMark('webview');
		// 配信先が決まる前に見送った claim をここで拾う。
		this._updateWebviewPlacement();
		webview.contentOptions = {
			allowScripts: true,
			localResourceRoots: this._localResourceRoots(resource)
		};
		const [isValid, stat] = await Promise.all([readParadisPdfHeader(this._fileService, resource), readParadisPdfStat(this._fileService, resource)]);
		switch (getParadisPdfRenderDecision(isValid, resource, this._currentResource, generation, this._renderGeneration)) {
			case 'rejected':
				this._pane.shown = undefined;
				this._pane.setDocumentHtml(webview, resource, this._buildRejectedFileHtml());
				return;
			case 'viewer':
				// 描き終わりの知らせ（first paint）が届くまでは使い回さない。
				this._pane.shown = stat?.etag ? { resource, webview, keys: this._shownKeys(stat, documentUrl), confirmed: false } : undefined;
				this._pane.setDocumentHtml(webview, resource, this._buildHtml(resource, documentUrl, stat?.size));
				return;
			case 'stale':
				return;
		}
	}

	private _buildRejectedFileHtml(): string {
		return paradisViewerWebviewFailureHtml(localize('paradis.pdf.failed', "PDF を表示できませんでした: {0}", localize('paradis.viewer.emptyOrBroken', "ファイルが空または破損しています")));
	}

	private _buildHtml(resource: URI, documentUrl: string | undefined, size: number | undefined): string {
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		// 配信サーバを使うかどうかは webview の作り方と揃える。片方だけサーバにすると、
		// service worker を切った webview に解決できない URL を渡すことになる。
		const served = this._pane.serviceWorkerDisabled && documentUrl !== undefined;
		const pdfUrl = served ? documentUrl : asWebviewUri(resource, remoteInfo).toString(true);
		const libBase = served && this._pane.libBase ? this._pane.libBase : asWebviewUri(FileAccess.asFileUri(PDFJS_MEDIA_ROOT)).toString(true);
		const useRangeRequests = shouldParadisPdfUseRangeRequests(size, served);
		const nonce = generateUuid();
		this._showViewState(undefined, undefined, undefined);
		this._renderedDocument = { sizeKb: size === undefined ? undefined : Math.round(size / 1024), rangeRequests: useRangeRequests, served, render: nonce };
		return buildParadisPdfViewerHtml({
			nonce,
			pdfUrl,
			libBase,
			// CSP は実際に使うポートまで絞る。`http://127.0.0.1:*` にすると、他のプロセスが立てた
			// ローカルサーバまで script-src に含めてしまう。
			serverOrigin: served ? paradisPreviewOrigins(libBase, pdfUrl) : '',
			// 区間読みは配信サーバ（Range に対応済み）から読むときだけ。service worker 経由は今までどおり。
			useRangeRequests,
		});
	}

	/** 開いてから（`setInput` から）いままでの ms を、計測に添える値として覚える。 */
	private _noteOpenMark(name: 'mount' | 'webview'): void {
		if (this._openMarks) {
			this._openMarks[name] = Math.round(performance.now() - this._openMarks.startedAt);
		}
	}

	private _updateWebviewPlacement(): void {
		const resource = this._currentResource;
		const justClaimed = this._pane.place(this._editorVisible && !!resource, this.window, this._webviewContainer!,
			() => ({ disableServiceWorker: this._canServe(resource!), localResourceRoots: this._localResourceRoots(resource!) }),
			() => this._updateWebviewPlacement());
		if (justClaimed && resource) {
			this._renderResource(resource, true);
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		// 描く前に閉じた・別のファイルへ移ったものは送らない。
		this._openTiming.clear();
		this._currentResource = undefined;
		// 描き終わったか分からない表示は、戻ったときに描き直す（白紙のまま残さない）。
		this._pane.forgetUnconfirmedShown();
		this._pane.release();
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
		this._pane.webview?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}
