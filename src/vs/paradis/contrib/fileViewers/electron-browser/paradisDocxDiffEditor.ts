/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)差分ビューアの EditorPane。
//
// 構成:
//   ツールバー（件数・凡例・書式トグル・ズーム・Prev/Next）は renderer 側の DOM で描き、
//   本文（左右2ペインの Word 描画）は1枚の OverlayWebview の中で docx-preview が描く。
//   差分の計算は renderer 側（common/paradisDocxDiff.ts）で行い、注釈だけを webview へ渡す。
//
// なぜ .docx を webview に fetch させず renderer で読むのか:
// SCM の「変更前バージョン」は `git:` スキーム（git 拡張の readonly FS プロバイダ）で渡ってくる。
// asWebviewUri 経由の fetch は service worker のリソース解決に依存し、git: の query(JSON) を
// 通す経路が不確実。IFileService はどのスキームでも読めるので、renderer で読んで postMessage で
// 渡す方が確実で、サイズ上限も掛けやすい。
//
// webview のライフサイクル（OverlayWebview + claim/release）は paradisDocxFileEditor.ts と同方式。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ParadisWebviewOriginPool } from '../browser/paradisWebviewOriginPool.js';
import { resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_DOCX_DIFF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import {
	IParadisDocxChange,
	IParadisDocxDiffResult,
	IParadisDocxOutline,
	PARADIS_DOCX_ERROR_LIBRARY_MISSING,
	PARADIS_DOCX_MAX_BYTES,
	ParadisDocxChangeStatus,
	ParadisDocxSide,
	ParadisDocxWebviewMessage,
} from '../common/paradisDocx.js';
import { buildDocxDiff } from '../common/paradisDocxDiff.js';
import { describeDocxChangeStatus, localizeDocxAnnotations } from '../common/paradisDocxDiffPresentation.js';
import { ParadisDocxDiffInput } from './paradisDocxInput.js';
import { buildParadisDocxDiffHtml, sanitizeParadisDocxBytesForRenderer } from './paradisDocxDiffWebview.js';
import './media/paradisDocxDiff.css';

const $ = dom.$;

/** vendored docx-preview / jszip の配置ディレクトリ（webview に許可するリソースの根）。 */
const DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;

/**
 * 凡例に出す色。値は webview 側の CSS（paradisDocxDiffWebview.ts）と揃えること。
 * 文言は presentation 層と共有し、同じ意味を2か所で訳さないようにする。
 */
const LEGEND: readonly { readonly color: string; readonly status: ParadisDocxChangeStatus }[] = [
	{ color: '#22c55e', status: 'added' },
	{ color: '#ef4444', status: 'removed' },
	{ color: '#3b82f6', status: 'modified' },
	{ color: '#a855f7', status: 'moved' },
];

export class ParadisDocxDiffEditor extends EditorPane {

	static readonly ID = PARADIS_DOCX_DIFF_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _noticeEl: HTMLElement | undefined;
	private _navPositionEl: HTMLElement | undefined;
	private _percentEl: HTMLButtonElement | undefined;
	private _formatToggle: HTMLButtonElement | undefined;
	private _openAppEl: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	private readonly _originPool: ParadisWebviewOriginPool;
	private _webviewClaimed = false;
	private _editorVisible = false;

	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _changes: readonly IParadisDocxChange[] = [];
	private _currentIndex = -1;
	private _scale = 1;
	private _showFormatChanges = true;
	/** 応答の逆順到着で古い結果が新しい結果を上書きしないようにする世代トークン。 */
	private _loadGeneration = 0;
	/** 並行して走る setInput の取り違えを防ぐための世代トークン。 */
	private _inputEpoch = 0;
	private _disposed = false;

	private readonly _headerDisposables = this._register(new DisposableStore());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
	) {
		super(PARADIS_DOCX_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
		// ライブラリの置き場は入力に依らないので、ここで先に決めておく。開く操作が
		// 共有プロセスの応答を待たされる最悪値が、そのぶん短くなる。
		void this._resolveLibBase();
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-docx-diff'));

		const toolbar = dom.append(this._root, $('.paradis-docx-diff-toolbar'));
		const left = dom.append(toolbar, $('.paradis-docx-diff-toolbar-left'));
		this._countEl = dom.append(left, $('span.paradis-docx-diff-count'));
		this._noticeEl = dom.append(left, $('span.paradis-docx-diff-notice'));
		this._noticeEl.style.display = 'none';
		const legend = dom.append(left, $('.paradis-docx-diff-legend'));
		for (const entry of LEGEND) {
			const item = dom.append(legend, $('span.paradis-docx-diff-legend-item'));
			const swatch = dom.append(item, $('span.paradis-docx-diff-legend-swatch'));
			swatch.style.backgroundColor = entry.color;
			dom.append(item, $('span')).textContent = describeDocxChangeStatus(entry.status);
		}

		const right = dom.append(toolbar, $('.paradis-docx-diff-toolbar-right'));

		this._formatToggle = dom.append(right, $('button.paradis-docx-diff-toggle')) as HTMLButtonElement;
		dom.append(this._formatToggle, $(`span${ThemeIcon.asCSSSelector(Codicon.symbolText)}`));
		// allow-any-unicode-next-line
		dom.append(this._formatToggle, $('span')).textContent = localize('paradis.docxDiff.formatToggle', "書式の変更");
		this._headerDisposables.add(dom.addDisposableListener(this._formatToggle, dom.EventType.CLICK, () => this._setShowFormatChanges(!this._showFormatChanges)));

		const zoom = dom.append(right, $('.paradis-docx-diff-zoom'));
		this._appendIconButton(zoom, Codicon.zoomOut, localize('paradis.docxDiff.zoomOut', "Zoom Out"), this._headerDisposables, () => this._zoom(1 / ZOOM_STEP));
		this._percentEl = dom.append(zoom, $('button.paradis-docx-diff-percent')) as HTMLButtonElement;
		this._percentEl.title = localize('paradis.docxDiff.resetZoom', "Reset Zoom");
		this._headerDisposables.add(dom.addDisposableListener(this._percentEl, dom.EventType.CLICK, () => this._setScale(1)));
		this._appendIconButton(zoom, Codicon.zoomIn, localize('paradis.docxDiff.zoomIn', "Zoom In"), this._headerDisposables, () => this._zoom(ZOOM_STEP));

		const nav = dom.append(right, $('.paradis-docx-diff-nav'));
		const previous = dom.append(nav, $('button.paradis-docx-diff-navbtn')) as HTMLButtonElement;
		previous.textContent = localize('paradis.docxDiff.previous', "Prev");
		this._navPositionEl = dom.append(nav, $('span.paradis-docx-diff-navpos'));
		const next = dom.append(nav, $('button.paradis-docx-diff-navbtn')) as HTMLButtonElement;
		next.textContent = localize('paradis.docxDiff.next', "Next");
		this._headerDisposables.add(dom.addDisposableListener(previous, dom.EventType.CLICK, () => this._navigate(-1)));
		this._headerDisposables.add(dom.addDisposableListener(next, dom.EventType.CLICK, () => this._navigate(1)));
		this._openAppEl = dom.append(nav, $('.paradis-docx-diff-openapp'));

		this._webviewContainer = dom.append(this._root, $('.paradis-docx-diff-body'));
		this._updateScaleLabel();
		this._updateFormatToggle();
		this._updateNav();
	}

	/**
	 * ヘッダーのアイコンボタンを作る。
	 * `disposables` には**そのボタンの寿命に合う store** を渡すこと。入力ごとに作り直すボタンを
	 * pane 寿命の store に登録すると、入力を切り替えるたびにリスナーが溜まる。
	 */
	private _appendIconButton(parent: HTMLElement, icon: ThemeIcon, title: string, disposables: DisposableStore, onClick: () => void): HTMLButtonElement {
		const button = dom.append(parent, $('button.paradis-docx-diff-iconbtn')) as HTMLButtonElement;
		button.title = title;
		dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		disposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, onClick));
		return button;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const invocationEpoch = ++this._inputEpoch;
		const previousInput = this._input;
		const previousOptions = this._options;
		await super.setInput(input, options, context, token);
		if (this._disposed || invocationEpoch !== this._inputEpoch) {
			return;
		}
		if (token.isCancellationRequested) {
			// 入力を戻さないと、_input だけ新しくリソースは旧いままの食い違いが残る。
			this._input = previousInput;
			this._options = previousOptions;
			return;
		}

		const diffInput = input as ParadisDocxDiffInput;
		this._originalResource = diffInput.originalResource;
		this._modifiedResource = diffInput.modifiedResource;
		this._changes = [];
		this._currentIndex = -1;
		this._scale = 1;
		this._showFormatChanges = true;
		this._updateScaleLabel();
		this._updateFormatToggle();
		this._updateNav();
		this._setNotice(undefined);
		this._setCount(undefined);

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			if (this._modifiedResource.scheme === Schemas.file) {
				const resource = this._modifiedResource;
				// リスナーは入力ごとの store に載せる（pane 寿命に載せると切り替えるたびに溜まる）。
				// allow-any-unicode-next-line
				this._appendIconButton(this._openAppEl, Codicon.linkExternal, localize('paradis.docxDiff.openInApp', "既定のアプリで開く"), store, () => {
					void this._nativeHostService.openExternal(resource.toString(true));
				});
			}
		}

		// 新版がワーキングコピーならディスク更新で自動的に取り直す。
		if (this._modifiedResource.scheme === Schemas.file || this._modifiedResource.scheme === Schemas.vscodeRemote) {
			try {
				const watched = this._modifiedResource;
				const watcher = this._fileService.createWatcher(watched, { recursive: false, excludes: [] });
				store.add(watcher);
				store.add(watcher.onDidChange(event => {
					if (event.contains(watched) && isEqual(this._modifiedResource, watched)) {
						this._reload();
					}
				}));
			} catch {
				// watcher が作れなくても表示は続けられる。
			}
		}

		// 既に claim 済みならここで読み直す。未 claim なら _updateWebviewPlacement が claim して
		// そこから1回だけ読み込む。**逆順にすると新規オープンで必ず2回読み込む**（claim 時に1回、
		// その直後にもう1回）ので、この並びを崩さないこと。
		if (this._webviewClaimed) {
			this._reload();
		}
		this._updateWebviewPlacement();
	}

	// ── webview ───────────────────────────────────────────────────────────

	/**
	 * 同梱ライブラリをローカルサーバに載せた結果。**ペインにつき一度だけ**決める
	 * （`disableServiceWorker` は webview の生成時にしか渡せない。paradisViewerAssets.ts 参照）。
	 * 文書そのものは postMessage で渡すので、ここで載せるのはライブラリだけ。
	 */
	private _libBase: Promise<string | undefined> | undefined;
	private _libBaseResolved = false;
	private _resolvedLibBase: string | undefined;

	private async _resolveLibBase(): Promise<string | undefined> {
		this._libBase ??= resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(DOCX_MEDIA_ROOT));
		const libBase = await this._libBase;
		this._resolvedLibBase = libBase;
		this._libBaseResolved = true;
		return libBase;
	}

	private _ensureWebview(): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		// origin を渡さないと webview ごとに service worker 登録が増え、二度と消えない。
		const lease = this._register(this._originPool.acquire(PARADIS_DOCX_DIFF_EDITOR_ID));
		const webview = this._webviewService.createWebviewOverlay({
			origin: lease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true,
				// 隠すたびに service worker 登録からやり直すと白紙で止まる窓ができる。
				retainContextWhenHidden: true,
				// ローカルサーバから配れるなら service worker は要らない。
				disableServiceWorker: !!this._resolvedLibBase
			},
			contentOptions: {
				allowScripts: true,
				// .docx 本体は postMessage で渡すので、許可するのは vendored ライブラリだけでよい。
				localResourceRoots: [FileAccess.asFileUri(DOCX_MEDIA_ROOT)]
			},
			extension: undefined
		});
		this._webview = webview;
		this._register(webview);
		this._register(webview.onMessage(event => this._onWebviewMessage(event.message as ParadisDocxWebviewMessage)));
		return webview;
	}

	/** webview を作り直して読み込みからやり直す。 */
	private _reload(): void {
		void this._reloadAfterAssets();
	}

	private async _reloadAfterAssets(): Promise<void> {
		const libBase = await this._resolveLibBase();
		const original = this._originalResource;
		const modified = this._modifiedResource;
		if (!original || !modified || !this._webviewClaimed) {
			return;
		}
		this._loadGeneration++;
		const webview = this._ensureWebview();
		webview.setHtml(buildParadisDocxDiffHtml({
			// allow-any-unicode-next-line
			original: localize('paradis.docxDiff.paneOriginal', "旧版 — {0}", basename(original)),
			// allow-any-unicode-next-line
			modified: localize('paradis.docxDiff.paneModified', "新版 — {0}", basename(modified)),
			// allow-any-unicode-next-line
			loading: localize('paradis.docxDiff.loading', "読み込み中…"),
		}, libBase));
	}

	/** webview の受信準備ができてから .docx の中身を送る（先に送ると取りこぼす）。 */
	private async _sendDocuments(): Promise<void> {
		const original = this._originalResource;
		const modified = this._modifiedResource;
		const webview = this._webview;
		if (!original || !modified || !webview) {
			return;
		}
		const generation = this._loadGeneration;
		// 読み直しの前にツールバーの状態を送り直す。webview は作り直されるたびに
		// 倍率 1・書式表示 ON に戻るので、送らないとツールバーの表示と本文が食い違う。
		void webview.postMessage({ type: 'zoom', scale: this._scale });
		void webview.postMessage({ type: 'showFormatChanges', enabled: this._showFormatChanges });
		try {
			const [originalBuffer, modifiedBuffer] = await Promise.all([
				this._readDocument(original),
				this._readDocument(modified),
			]);
			if (generation !== this._loadGeneration || this._disposed) {
				return;
			}
			// transfer リストを渡しても renderer → webview の最初のホップは構造化クローン
			// （webviewElement.postMessage は transfer をメッセージ本体に詰めるだけ）。
			// 実際に所有権が移るのは webview 内部から iframe へ渡す最後のホップだけで、
			// ここでのコピーは避けられない。
			void webview.postMessage(
				{ type: 'load', generation, original: originalBuffer, modified: modifiedBuffer },
				[originalBuffer, modifiedBuffer]
			);
		} catch (error) {
			if (generation === this._loadGeneration) {
				this._setNotice(this._describeError(error));
			}
		}
	}

	private async _readDocument(resource: URI): Promise<ArrayBuffer> {
		// 上限は readFile に渡す。読み切ってから判定すると、巨大なファイルを一度メモリに載せてしまう。
		const content = await this._fileService.readFile(resource, { limits: { size: PARADIS_DOCX_MAX_BYTES } });
		const sanitized = await sanitizeParadisDocxBytesForRenderer(content.value.buffer, `diff_${this._loadGeneration}`);
		const bytes = sanitized.bytes;
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	/** 例外を利用者に見せる文言にする。ファイルが大きすぎる場合だけ専用の案内を出す。 */
	private _describeError(error: unknown): string {
		if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.tooLarge', "ファイルが大きすぎるため比較できません");
		}
		return error instanceof Error ? error.message : String(error);
	}

	private _onWebviewMessage(message: ParadisDocxWebviewMessage): void {
		if (this._disposed || !message) {
			return;
		}
		switch (message.type) {
			case 'ready':
				void this._sendDocuments();
				return;
			case 'outline':
				// 読み直しをまたいで届いた古い概要は捨てる（旧文書の差分を新文書へ当ててしまうため）。
				if (message.generation !== this._loadGeneration) {
					return;
				}
				this._onOutline(message.original, message.modified);
				return;
			case 'rendered':
				this._updateNav();
				return;
			case 'activeChange': {
				const index = this._changes.findIndex(change => change.id === message.changeId);
				if (index >= 0 && index !== this._currentIndex) {
					this._currentIndex = index;
					this._updateNav();
				}
				return;
			}
			case 'error':
				this._setNotice(this._describeWebviewError(message));
				return;
			default:
				return;
		}
	}

	/** webview からのエラーを利用者向けの文言にする。既知のものは翻訳し、それ以外は生のまま出す。 */
	private _describeWebviewError(message: { readonly side?: ParadisDocxSide; readonly message: string }): string {
		if (message.message === PARADIS_DOCX_ERROR_LIBRARY_MISSING) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.library', "表示用のライブラリを読み込めませんでした");
		}
		if (message.side === 'original') {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.original', "旧版を読み込めませんでした: {0}", message.message);
		}
		if (message.side === 'modified') {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.modified', "新版を読み込めませんでした: {0}", message.message);
		}
		// allow-any-unicode-next-line
		return localize('paradis.docxDiff.error.generic', "Word 文書を比較できませんでした: {0}", message.message);
	}

	private _onOutline(original: IParadisDocxOutline, modified: IParadisDocxOutline): void {
		let result: IParadisDocxDiffResult;
		try {
			result = buildDocxDiff(original, modified);
		} catch (error) {
			this._setNotice(error instanceof Error ? error.message : String(error));
			return;
		}
		this._changes = result.changes;
		this._currentIndex = -1;
		this._setCount(result.changes.length);
		this._setNotice(this._degradedNotice(result));
		this._updateNav();
		// 文言（書式変更のツールチップ）は webview では作れないので、送る直前にここで埋める。
		void this._webview?.postMessage({
			type: 'annotate',
			annotations: localizeDocxAnnotations(result.annotations),
			fillers: result.fillers,
		});
	}

	private _degradedNotice(result: IParadisDocxDiffResult): string | undefined {
		if (!result.degraded?.length) {
			return undefined;
		}
		if (result.degraded.includes('blocks')) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.degraded.blocks', "文書が大きいため、途中までを比較しています");
		}
		// allow-any-unicode-next-line
		return localize('paradis.docxDiff.degraded.simple', "変更が多いため、一部を簡易表示しています");
	}

	// ── ツールバーの状態 ──────────────────────────────────────────────────

	private _setCount(count: number | undefined): void {
		if (!this._countEl) {
			return;
		}
		if (count === undefined) {
			this._countEl.textContent = '';
		} else if (count === 0) {
			// allow-any-unicode-next-line
			this._countEl.textContent = localize('paradis.docxDiff.noChanges', "変更はありません");
		} else {
			// allow-any-unicode-next-line
			this._countEl.textContent = localize('paradis.docxDiff.changeCount', "{0} 件の変更", count);
		}
	}

	private _setNotice(text: string | undefined): void {
		if (!this._noticeEl) {
			return;
		}
		this._noticeEl.textContent = text ?? '';
		// 横幅が足りないと省略記号で切れるので、全文はツールチップで読めるようにする。
		this._noticeEl.title = text ?? '';
		this._noticeEl.style.display = text ? '' : 'none';
	}

	private _updateNav(): void {
		if (this._navPositionEl) {
			this._navPositionEl.textContent = this._changes.length === 0
				? '-'
				: `${this._currentIndex + 1} / ${this._changes.length}`;
		}
	}

	private _navigate(delta: number): void {
		if (this._changes.length === 0) {
			return;
		}
		const next = this._currentIndex < 0
			? (delta > 0 ? 0 : this._changes.length - 1)
			: (this._currentIndex + delta + this._changes.length) % this._changes.length;
		this._currentIndex = next;
		this._updateNav();
		void this._webview?.postMessage({ type: 'reveal', changeId: this._changes[next].id });
	}

	private _zoom(factor: number): void {
		this._setScale(this._scale * factor);
	}

	private _setScale(scale: number): void {
		const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
		if (clamped === this._scale) {
			return;
		}
		this._scale = clamped;
		this._updateScaleLabel();
		void this._webview?.postMessage({ type: 'zoom', scale: clamped });
	}

	private _updateScaleLabel(): void {
		if (this._percentEl) {
			this._percentEl.textContent = `${Math.round(this._scale * 100)}%`;
		}
	}

	private _setShowFormatChanges(enabled: boolean): void {
		this._showFormatChanges = enabled;
		this._updateFormatToggle();
		void this._webview?.postMessage({ type: 'showFormatChanges', enabled });
	}

	private _updateFormatToggle(): void {
		if (!this._formatToggle) {
			return;
		}
		this._formatToggle.classList.toggle('active', this._showFormatChanges);
		this._formatToggle.setAttribute('aria-pressed', String(this._showFormatChanges));
	}

	// ── ライフサイクル ────────────────────────────────────────────────────

	private _updateWebviewPlacement(): void {
		const shouldShow = this._editorVisible && !!this._originalResource && !!this._modifiedResource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			return;
		}
		if (!this._webview && !this._libBaseResolved) {
			// 配信先が決まる前に作ると service worker の要否を間違える。ここで自分で解決を蹴る。
			void this._resolveLibBase().then(() => this._updateWebviewPlacement());
			return;
		}
		const webview = this._ensureWebview();
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		if (justClaimed) {
			this._reload();
		}
	}

	override clearInput(): void {
		this._inputEpoch++;
		this._loadGeneration++;
		this._inputDisposables.clear();
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._changes = [];
		this._currentIndex = -1;
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		// retainContextWhenHidden なので release だけでは webview は生きたまま残る。
		// 左右2文書ぶんのパース済み AST と描画済み DOM を抱えたままになるので、中身を捨てる。
		this._webview?.setHtml('');
		super.clearInput();
	}

	override dispose(): void {
		this._disposed = true;
		this._loadGeneration++;
		super.dispose();
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
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}
