/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像ビューアのペイン。upstream の画像プレビュー（extensions/media-preview の imagePreview）と同じ見た目と
// 操作（クリックで拡大、Option/Ctrl+クリックで縮小、Option/Ctrl+ホイールとピンチで拡大縮小、コピー、
// ステータスバーの倍率・寸法・大きさ）を、webview を使わずワークベンチの DOM の <img> で描く。
//
// webview を使わないので、service worker の起動・停止にも、webview の土台の読み込みにも待たされない。
// 画像は IFileService で読み（paradisImagePreview.ts）、Blob URL を <img> に渡す。デコードは `decode()` で
// Chromium に任せ、終わってから DOM に入れるので、大きな画像でも UI スレッドは止まらない。
//
// SVG も <img> で描く。<img> の SVG はスクリプトも外部の読み込みも動かない。Blob の MIME は拡張子で
// 固定しているので、中身が HTML でも画像としてしか解釈されない。

import * as dom from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../../base/common/actions.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ByteSize, FileChangeType, IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { SideBySideEditor } from '../../../../../workbench/browser/parts/editor/sideBySideEditor.js';
import { DEFAULT_EDITOR_ASSOCIATION, IEditorOpenContext } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../../workbench/common/editor/sideBySideEditorInput.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import { IParadisViewerOpenTiming, startParadisViewerOpenTiming } from '../../common/paradisViewerOpenTiming.js';
import { ParadisImageInput } from './paradisImageInput.js';
import {
	clampParadisImageScale,
	getParadisImageWheelScale,
	getParadisImageZoomInScale,
	getParadisImageZoomOutScale,
	loadParadisImage,
	PARADIS_IMAGE_EDITOR_ID,
	PARADIS_IMAGE_PIXELATION_THRESHOLD,
	ParadisImageCache,
	ParadisImageData,
	ParadisImageScale,
} from './paradisImagePreview.js';
import './media/paradisImageViewer.css';

/** ステータスバーの倍率を押したときに走るコマンド（contribution で登録する）。 */
export const PARADIS_IMAGE_SELECT_ZOOM_COMMAND_ID = 'paradis.imagePreview.selectZoomLevel';

/** ウィンドウ（レンダラ）につき 1 つの、読んだ画像の覚え。 */
const IMAGE_CACHE = new ParadisImageCache();

export function formatParadisImageScale(scale: ParadisImageScale): string {
	// allow-any-unicode-next-line
	return scale === 'fit' ? localize('paradis.imagePreview.wholeImage', "画像全体") : `${Math.round(scale * 100)}%`;
}

interface DisplayedImage {
	readonly resource: URI;
	readonly data: ParadisImageData;
	readonly element: HTMLImageElement;
}

type ViewerState = 'empty' | 'loading' | 'ready' | 'error' | 'gitLfs' | 'tooLarge';

export class ParadisImageFileEditor extends EditorPane {

	static readonly ID = PARADIS_IMAGE_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _messageElement: HTMLElement | undefined;
	private _messageText: HTMLElement | undefined;
	private _displayed: DisplayedImage | undefined;
	private _scale: ParadisImageScale = 'fit';
	private _state: ViewerState = 'empty';
	private _generation = 0;
	/** mousedown の時点でこのペインが前面でなければ、そのクリックは前面にするだけで拡大しない（upstream と同じ）。 */
	private _consumeClick = true;
	private _zoomOutOnClick = false;

	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _load = this._register(new MutableDisposable());
	/** 画像を表示しているあいだ、覚えている Blob を手放させない。 */
	private readonly _cacheLease = this._register(new MutableDisposable());
	/** setInput から最初に描けるまでの計測（同じファイルを開き直したときも測る）。 */
	private readonly _openTiming = this._register(new MutableDisposable<IParadisViewerOpenTiming>());
	private readonly _zoomEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _sizeEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _binarySizeEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(PARADIS_IMAGE_EDITOR_ID, group, telemetryService, themeService, storageService);

		this._register(this._editorService.onDidActiveEditorChange(() => this._updateStatus()));
		// タブを閉じたら、そのファイルのために残していた <img> を捨てる（Blob は覚えに残るので、開き直しても読み直さない）。
		this._register(this.group.onDidCloseEditor(e => {
			const closed = e.editor instanceof SideBySideEditorInput ? [e.editor.primary, e.editor.secondary] : [e.editor];
			if (closed.some(editor => editor instanceof ParadisImageInput && isEqual(editor.resource, this._displayed?.resource))) {
				this._clearDisplayed();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		const root = this._root = dom.append(parent, dom.$('.paradis-image-viewer.container.image.scale-to-fit'));
		root.tabIndex = 0;
		root.setAttribute('role', 'document');

		dom.append(root, dom.$('.paradis-image-viewer-loading')).appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		this._messageElement = dom.append(root, dom.$('.paradis-image-viewer-message'));
		this._messageText = dom.append(this._messageElement, dom.$('p'));
		const openAsText = dom.append(this._messageElement, dom.$('a.open-file-link', { href: '#' }));
		// allow-any-unicode-next-line
		openAsText.textContent = localize('paradis.imagePreview.openAsText', "VS Code の標準テキストまたはバイナリ エディターを使用してファイルを開きますか?");
		this._register(dom.addDisposableListener(openAsText, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			void this._reopenWithDefaultEditor();
		}));

		this._register(dom.addDisposableListener(root, dom.EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button !== 0 || !this._displayed) {
				return;
			}
			this._zoomOutOnClick = isMacintosh ? e.altKey : e.ctrlKey;
			this._consumeClick = !this.isActiveImage();
		}));
		this._register(dom.addDisposableListener(root, dom.EventType.CLICK, (e: MouseEvent) => {
			if (e.button !== 0 || !this._displayed || this._state !== 'ready') {
				return;
			}
			if (this._consumeClick) {
				this._consumeClick = false;
				return;
			}
			if (this._zoomOutOnClick) {
				this.zoomOut();
			} else {
				this.zoomIn();
			}
		}));
		this._register(dom.addDisposableListener(root, dom.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			// ピンチは ctrl 付きのホイールとして届く。
			if (e.ctrlKey) {
				e.preventDefault();
			}
			if (!this._displayed || this._state !== 'ready') {
				return;
			}
			if (!(isMacintosh ? e.altKey : e.ctrlKey) && !e.ctrlKey) {
				return;
			}
			e.preventDefault();
			this.setScale(getParadisImageWheelScale(this._numericScale(), e.deltaY));
		}, { passive: false }));
		const updateCursor = (e: KeyboardEvent) => {
			const zoomOut = isMacintosh ? e.altKey : e.ctrlKey;
			root.classList.toggle('zoom-out', zoomOut);
			root.classList.toggle('zoom-in', !zoomOut);
		};
		this._register(dom.addDisposableListener(root, dom.EventType.KEY_DOWN, updateCursor));
		this._register(dom.addDisposableListener(root, dom.EventType.KEY_UP, updateCursor));
		this._register(dom.addDisposableListener(root, dom.EventType.BLUR, () => {
			root.classList.remove('zoom-out');
			root.classList.add('zoom-in');
		}));
		this._register(dom.addDisposableListener(root, 'scroll', () => this._saveViewState(), { passive: true }));
		this._register(dom.addDisposableListener(root, 'copy', (e: ClipboardEvent) => {
			if (this._displayed) {
				e.preventDefault();
				void this.copyImage();
			}
		}));
		this._register(dom.addDisposableListener(root, dom.EventType.CONTEXT_MENU, (e: MouseEvent) => {
			dom.EventHelper.stop(e, true);
			if (!this._displayed || this._state !== 'ready') {
				return;
			}
			this._contextMenuService.showContextMenu({
				getAnchor: () => new StandardMouseEvent(dom.getWindow(root), e),
				getActions: () => [toAction({
					id: 'paradis.imagePreview.copy',
					// allow-any-unicode-next-line
					label: localize('paradis.imagePreview.copy', "コピー"),
					run: () => this.copyImage(),
				})],
			});
		}));
		const focusTracker = this._register(dom.trackFocus(root));
		this._register(focusTracker.onDidFocus(() => this._updateStatus()));
		this._register(focusTracker.onDidBlur(() => this._updateStatus()));

		this.updateStyles();
		this._setState('empty');
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._openTiming.value = this._startOpenTiming();
		await super.setInput(input, options, context, token);
		if (!(input instanceof ParadisImageInput)) {
			return;
		}
		const resource = input.resource;
		if (!isEqual(this._displayed?.resource, resource)) {
			this._clearDisplayed();
		}

		const store = new DisposableStore();
		this._inputDisposables.value = store;
		this._watch(resource, input, store);

		// 読み込みとデコードは待たない（タブの切り替えを止めない）。失敗は _render の中で表示する。
		void this._render(resource, input.viewState?.scale ?? 'fit', input, true);
	}

	override clearInput(): void {
		this._saveViewState();
		this._load.clear();
		this._openTiming.clear();
		this._inputDisposables.clear();
		this._generation++;
		this._hideStatus();
		// <img> は残す。同じファイルへ戻ってきたらそのまま見せる。別のファイルが来たら setInput が、
		// タブを閉じたら onDidCloseEditor が捨てる。
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this._updateStatus();
	}

	override focus(): void {
		super.focus();
		this._root?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
	}

	override updateStyles(): void {
		super.updateStyles();
		if (!this._root) {
			return;
		}
		// upstream の webview と同じ、テーマの種類のクラス（市松模様の色を切り替える）。
		const type = this.themeService.getColorTheme().type;
		this._root.classList.toggle('vscode-dark', type === ColorScheme.DARK);
		this._root.classList.toggle('vscode-high-contrast', type === ColorScheme.HIGH_CONTRAST_DARK || type === ColorScheme.HIGH_CONTRAST_LIGHT);
	}

	override dispose(): void {
		this._clearDisplayed();
		super.dispose();
	}

	// --- 操作（コマンドとステータスバーから呼ばれる） ---

	/**
	 * このペインが「操作の対象」か。前面のエディタがこのペインのとき、または差分（左右に並べた表示）で
	 * こちら側にフォーカスがある・どちらにもフォーカスが無ければ変更後の側のとき。
	 */
	isActiveImage(): boolean {
		if (!this.isVisible() || !(this.input instanceof ParadisImageInput)) {
			return false;
		}
		const active = this._editorService.activeEditorPane;
		if (active === this) {
			return true;
		}
		if (!(active instanceof SideBySideEditor)) {
			return false;
		}
		const primary = active.getPrimaryEditorPane();
		const secondary = active.getSecondaryEditorPane();
		if (primary !== this && secondary !== this) {
			return false;
		}
		if (this._rootHasFocus()) {
			return true;
		}
		const other = primary === this ? secondary : primary;
		if (other instanceof ParadisImageFileEditor && other._rootHasFocus()) {
			return false;
		}
		return primary === this;
	}

	get scale(): ParadisImageScale {
		return this._scale;
	}

	zoomIn(): void {
		if (this._displayed && this._state === 'ready') {
			this.setScale(getParadisImageZoomInScale(this._numericScale()));
		}
	}

	zoomOut(): void {
		if (this._displayed && this._state === 'ready') {
			this.setScale(getParadisImageZoomOutScale(this._numericScale()));
		}
	}

	/** 倍率を変える。拡大の中心は画面の真ん中（upstream と同じ）。 */
	setScale(scale: ParadisImageScale): void {
		const root = this._root;
		const image = this._displayed?.element;
		if (!root || !image) {
			return;
		}
		if (scale === 'fit') {
			this._scale = 'fit';
			image.classList.add('scale-to-fit');
			image.classList.remove('pixelated');
			image.style.zoom = 'normal';
			image.style.minWidth = '';
			image.style.minHeight = '';
		} else {
			this._scale = clampParadisImageScale(scale);
			image.classList.toggle('pixelated', this._scale >= PARADIS_IMAGE_PIXELATION_THRESHOLD);

			const dx = (root.scrollLeft + root.clientWidth / 2) / root.scrollWidth;
			const dy = (root.scrollTop + root.clientHeight / 2) / root.scrollHeight;

			image.classList.remove('scale-to-fit');
			// 固有の大きさが無い画像（viewBox だけの SVG など）は、zoom を掛ける大きさを px で与える。
			if (!image.naturalWidth || !image.naturalHeight) {
				image.style.minWidth = `${image.clientWidth || root.clientWidth}px`;
				image.style.minHeight = `${image.clientHeight || root.clientHeight}px`;
			}
			image.style.zoom = String(this._scale);

			root.scrollTo(root.scrollWidth * dx - root.clientWidth / 2, root.scrollHeight * dy - root.clientHeight / 2);
		}
		this._saveViewState();
		this._updateStatus();
	}

	async copyImage(): Promise<void> {
		const displayed = this._displayed;
		if (!displayed || this._state !== 'ready') {
			return;
		}
		const targetWindow = dom.getWindow(this._root);
		try {
			const png = displayed.data.blob.type === 'image/png' ? Promise.resolve(displayed.data.blob) : toPngBlob(displayed.element);
			await targetWindow.navigator.clipboard.write([new targetWindow.ClipboardItem({ 'image/png': png })]);
		} catch (error) {
			this._logService.error('[paradis image viewer] copy failed', error);
		}
	}

	// --- 読み込みと表示 ---

	private _watch(resource: URI, input: ParadisImageInput, store: DisposableStore): void {
		let watcher;
		try {
			watcher = store.add(this._fileService.createWatcher(resource, { recursive: false, excludes: [] }));
		} catch {
			// watcher が作れなくても表示は続けられる。
			return;
		}
		store.add(watcher.onDidChange(async e => {
			if (!e.contains(resource) || this.input !== input) {
				return;
			}
			// 消えた（upstream はタブを閉じる）。保存の途中で一瞬消える場合があるので、本当に無いかを確かめる。
			if (e.contains(resource, FileChangeType.DELETED) && !await this._fileService.exists(resource)) {
				if (this.input === input) {
					this.group.closeEditor(input);
				}
				return;
			}
			if (this.input === input) {
				await this._render(resource, this._scale, input, false);
			}
		}));
	}

	/**
	 * 読んで表示する。`measure` は setInput から来たときだけ true（ファイルの変更で描き直したときは測らない）。
	 */
	private async _render(resource: URI, scale: ParadisImageScale, input: ParadisImageInput, measure: boolean): Promise<void> {
		const generation = ++this._generation;
		const cts = new CancellationTokenSource();
		this._load.value = toDisposable(() => cts.dispose(true));
		const isCurrent = () => generation === this._generation && this.input === input && !cts.token.isCancellationRequested;

		if (!this._displayed) {
			this._setState('loading');
		}

		let result;
		try {
			result = await loadParadisImage(this._fileService, resource, IMAGE_CACHE, cts.token);
		} catch (error) {
			if (isCurrent() && !isCancellationError(error)) {
				this._logService.warn('[paradis image viewer] read failed', error);
				this._clearDisplayed();
				this._setState('error');
			}
			return;
		}
		if (!isCurrent()) {
			this._releaseUrl(result.kind === 'image' ? result.data.url : undefined);
			return;
		}
		if (result.kind !== 'image') {
			this._clearDisplayed();
			this._setState(result.kind === 'invalid' ? 'error' : result.kind);
			return;
		}

		const { data } = result;
		if (this._displayed && isEqual(this._displayed.resource, resource) && this._displayed.data.url === data.url) {
			// 表示中の画像のまま（タブを切り替えて戻った）。
			this._setState('ready');
			this._restoreViewState(scale, input);
			this._updateStatus();
			// タブを行き来して戻っただけ。描き直していないので測らない（「2 回目」の枠を使わない）。
			if (measure) {
				this._openTiming.clear();
			}
			return;
		}

		const image = dom.$('img') as HTMLImageElement;
		image.decoding = 'async';
		image.draggable = false;
		image.alt = basename(resource);
		image.setAttribute('elementtiming', 'paradis-image-viewer');
		image.src = data.url;
		try {
			// デコードは Chromium が別のスレッドで行う。終わってから DOM に入れる。
			await image.decode();
		} catch (error) {
			if (isCurrent()) {
				this._logService.warn('[paradis image viewer] decode failed', error);
				this._clearDisplayed();
				this._releaseUrl(data.url);
				this._setState('error');
			} else {
				this._releaseUrl(data.url);
			}
			return;
		}
		if (!isCurrent()) {
			this._releaseUrl(data.url);
			return;
		}
		const previous = this._displayed;
		this._displayed = { resource, data, element: image };
		this._cacheLease.value ??= IMAGE_CACHE.acquire();
		if (previous) {
			previous.element.remove();
			if (previous.data.url !== data.url) {
				this._releaseUrl(previous.data.url);
			}
		}
		this._root?.appendChild(image);
		this._setState('ready');
		this._restoreViewState(scale, input);
		this._updateStatus();

		if (measure) {
			this._reportPainted(data, result.fromCache);
		}
	}

	/** テストで送り先を差し替えるための口。 */
	protected _startOpenTiming(): IParadisViewerOpenTiming {
		return startParadisViewerOpenTiming('image');
	}

	/** 最初に描けたことを 1 回だけ知らせる。送るのは大きさと真偽だけ（ファイル名やパスは送らない）。 */
	private _reportPainted(data: ParadisImageData, fromCache: boolean): void {
		const image = this._displayed?.element;
		this._openTiming.value?.painted({
			safe_size_kb: Math.round(data.size / 1024),
			safe_width_px: image?.naturalWidth ?? 0,
			safe_height_px: image?.naturalHeight ?? 0,
			safe_from_cache: fromCache,
		});
		this._openTiming.clear();
	}

	private _restoreViewState(scale: ParadisImageScale, input: ParadisImageInput): void {
		this.setScale(scale);
		const viewState = input.viewState;
		if (this._root && viewState && scale !== 'fit') {
			this._root.scrollTo(viewState.scrollLeft, viewState.scrollTop);
		}
	}

	private _saveViewState(): void {
		if (this.input instanceof ParadisImageInput && this._root && this._displayed) {
			this.input.viewState = { scale: this._scale, scrollLeft: this._root.scrollLeft, scrollTop: this._root.scrollTop };
		}
	}

	private _setState(state: ViewerState): void {
		this._state = state;
		const root = this._root;
		if (!root) {
			return;
		}
		root.classList.toggle('loading', state === 'loading');
		root.classList.toggle('ready', state === 'ready');
		root.classList.toggle('error', state === 'error' || state === 'tooLarge');
		root.classList.toggle('git-lfs', state === 'gitLfs');
		root.classList.toggle('zoom-in', state === 'ready');
		if (this._messageText) {
			this._messageText.textContent = state === 'gitLfs'
				// allow-any-unicode-next-line
				? localize('paradis.imagePreview.gitLfs', "この画像は Git LFS で保存されており、プレビューできません。")
				: state === 'tooLarge'
					// allow-any-unicode-next-line
					? localize('paradis.imagePreview.tooLarge', "画像が大きすぎるため、プレビューできません。")
					// allow-any-unicode-next-line
					: localize('paradis.imagePreview.loadError', "イメージの読み込み中にエラーが発生しました。");
		}
		root.setAttribute('aria-busy', String(state === 'loading'));
		if (this.input instanceof ParadisImageInput) {
			root.setAttribute('aria-label', basename(this.input.resource));
		}
	}

	private _clearDisplayed(): void {
		const displayed = this._displayed;
		if (!displayed) {
			return;
		}
		this._displayed = undefined;
		displayed.element.remove();
		this._releaseUrl(displayed.data.url);
		this._cacheLease.clear();
		this._scale = 'fit';
		this._setState('empty');
		this._updateStatus();
	}

	/** 覚えに入っていない Blob URL（`git:` や大きすぎる画像）は、使い終わったら手放す。 */
	private _releaseUrl(url: string | undefined): void {
		if (url && !IMAGE_CACHE.owns(url)) {
			URL.revokeObjectURL(url);
		}
	}

	private _numericScale(): number {
		if (this._scale !== 'fit') {
			return this._scale;
		}
		// 「画像全体」から倍率を変えるときは、今の見た目の倍率から始める。
		const image = this._displayed?.element;
		return image?.naturalWidth ? image.clientWidth / image.naturalWidth : 1;
	}

	private _rootHasFocus(): boolean {
		return !!this._root && dom.isAncestorOfActiveElement(this._root);
	}

	private async _reopenWithDefaultEditor(): Promise<void> {
		const input = this.input;
		if (input instanceof ParadisImageInput) {
			await this._editorService.replaceEditors([{ editor: input, replacement: { resource: input.resource, options: { override: DEFAULT_EDITOR_ASSOCIATION.id } } }], this.group);
		}
	}

	// --- ステータスバー（upstream の 3 項目と同じ並び: 倍率 102、寸法 101、大きさ 100） ---

	private _updateStatus(): void {
		const displayed = this._displayed;
		if (!displayed || this._state !== 'ready' || !this.isActiveImage()) {
			this._hideStatus();
			return;
		}
		const zoom = formatParadisImageScale(this._scale);
		// allow-any-unicode-next-line
		this._setEntry(this._zoomEntry, 'status.paradis.imagePreview.zoom', localize('paradis.imagePreview.zoomStatus', "イメージのズーム"), zoom, 102, PARADIS_IMAGE_SELECT_ZOOM_COMMAND_ID);
		const size = `${displayed.element.naturalWidth}x${displayed.element.naturalHeight}`;
		// allow-any-unicode-next-line
		this._setEntry(this._sizeEntry, 'status.paradis.imagePreview.size', localize('paradis.imagePreview.sizeStatus', "イメージ サイズ"), size, 101);
		// allow-any-unicode-next-line
		this._setEntry(this._binarySizeEntry, 'status.paradis.imagePreview.binarySize', localize('paradis.imagePreview.binarySizeStatus', "イメージ バイナリ サイズ"), ByteSize.formatSize(displayed.data.size), 100);
	}

	private _setEntry(slot: MutableDisposable<IStatusbarEntryAccessor>, id: string, name: string, text: string, priority: number, command?: string): void {
		const entry = { name, text, ariaLabel: text, command };
		if (slot.value) {
			slot.value.update(entry);
		} else {
			slot.value = this._statusbarService.addEntry(entry, id, StatusbarAlignment.RIGHT, priority);
		}
	}

	private _hideStatus(): void {
		this._zoomEntry.clear();
		this._sizeEntry.clear();
		this._binarySizeEntry.clear();
	}
}

/** PNG 以外の画像をクリップボードへ入れるため PNG にする（upstream と同じく canvas で描き直す）。 */
function toPngBlob(image: HTMLImageElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const canvas = image.ownerDocument.createElement('canvas');
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext('2d');
		if (!context) {
			reject(new Error('no 2d context'));
			return;
		}
		context.drawImage(image, 0, 0);
		canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/png');
	});
}

/** 操作の対象の画像ビューア（前面のエディタ、または差分のどちらかの側）。 */
export function getActiveParadisImageEditor(editorService: IEditorService): ParadisImageFileEditor | undefined {
	const active = editorService.activeEditorPane;
	if (active instanceof ParadisImageFileEditor) {
		return active;
	}
	if (active instanceof SideBySideEditor) {
		for (const pane of [active.getPrimaryEditorPane(), active.getSecondaryEditorPane()]) {
			if (pane instanceof ParadisImageFileEditor && pane.isActiveImage()) {
				return pane;
			}
		}
	}
	return undefined;
}
