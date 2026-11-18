/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown の差分の「プレビュー差分」。単体の差分エディタ（paradisFileDiffEditor）の上にバーを置き、
// 「テキスト差分 | プレビュー差分」と「左右 | 1 列」を切り替える。プレビュー差分は両側を Markdown のビューアと
// 同じ変換で描き、ブロック・項目・行・語の突き合わせ（common/paradisRenderedDiff）の結果を webview に出す。
//
// プレビュー差分は読むだけ（右側の編集・差分の行への AI メモ・資料のコメント・編集中の印は出さない）。
// それらはバーで「テキスト差分」に戻して使う。古い側（git: など）の相対パスの画像は今の作業ツリーのものを使い、
// バーに断り書きを出す。大きい文書はプレビュー差分を出さずにテキスト差分のままにする。

import * as dom from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { DEFAULT_MARKDOWN_STYLES } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { IOverlayWebview } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { isParadisRenderedDiffTooLarge, paradisMarkdownRenderedDiffItems, PARADIS_RENDERED_DIFF_LIMITS } from '../common/paradisRenderedDiff.js';
import { paradisFindHighlightScript } from '../common/paradisViewerScroll.js';
import { markedParadisAlertExtension, PARADIS_MARKDOWN_ALERT_STYLES } from './paradisMarkdownAlerts.js';
import { renderParadisMarkdownDocumentDeferred } from './paradisMarkdownDocumentRenderer.js';
import { applyParadisFrontMatter, PARADIS_FRONTMATTER_STYLES } from './paradisMarkdownFrontMatter.js';
import { inlineParadisMarkdownMediaInBody, PARADIS_INLINE_MEDIA_LIMITS, PARADIS_INLINE_MEDIA_STYLES } from './paradisMarkdownInlineResources.js';
import { paradisMarkdownLinkToOpen, rewriteParadisMarkdownLinks } from './paradisMarkdownLinks.js';
import { containsParadisMermaidBlock, loadParadisMermaidScriptSource, markedMermaidExtension, paradisMermaidScripts } from './paradisMarkdownMermaid.js';
import { buildParadisRenderedDiff, IParadisRenderedDiffSide, paradisRenderedDiffGoMessage, paradisRenderedDiffNavigationScript, ParadisRenderedDiffLayout, PARADIS_RENDERED_DIFF_STYLES } from './paradisRenderedDiffDom.js';
import { PARADIS_FILE_DIFF_EDITOR_ID } from './paradisFileViewers.js';
import { ParadisOverlayWebviewPane } from './paradisOverlayWebviewPane.js';
import { appendParadisViewerToolbarGroup, appendParadisViewerToolbarIconButton, appendParadisViewerToolbarSeparator, createParadisViewerToolbar, IParadisViewerToolbar } from './paradisViewerToolbar.js';
import { ParadisViewerZoomControls, paradisViewerZoomMessage, paradisViewerZoomScript } from './paradisViewerZoom.js';
import './media/paradisRenderedDiff.css';

/** 差分の表示。`text` は本家のテキスト差分、`rendered` はプレビュー差分。 */
export type ParadisFileDiffViewMode = 'text' | 'rendered';

/** 開いたときの表示の設定。 */
export const PARADIS_MARKDOWN_DIFF_VIEW_SETTING = 'paradis.markdownViewer.diffView';
/** 設定の値。`remember` は前回バーで選んだ表示。 */
export type ParadisMarkdownDiffViewSetting = 'rendered' | 'text' | 'remember';
export const PARADIS_MARKDOWN_DIFF_VIEW_SETTINGS: readonly ParadisMarkdownDiffViewSetting[] = ['rendered', 'text', 'remember'];

const LAST_MODE_STORAGE_KEY = 'paradis.markdownViewer.diffView.lastMode';
const LAYOUT_STORAGE_KEY = 'paradis.markdownViewer.diffView.layout';

/** この幅（px）より狭いと、左右を選んでいても 1 列で出す。 */
const SPLIT_MIN_WIDTH = 700;

/** 設定とバーで選んだ表示から、開いたときの表示を決める。 */
export function paradisInitialDiffViewMode(setting: unknown, last: unknown): ParadisFileDiffViewMode {
	if (setting === 'text') {
		return 'text';
	}
	if (setting === 'remember') {
		return last === 'text' ? 'text' : 'rendered';
	}
	return 'rendered';
}

/** 選んだ並べ方とエディタの幅から、実際の並べ方を決める。 */
export function paradisEffectiveDiffLayout(chosen: ParadisRenderedDiffLayout, width: number): ParadisRenderedDiffLayout {
	return chosen === 'split' && width > 0 && width < SPLIT_MIN_WIDTH ? 'unified' : chosen;
}

/** 差分エディタがこの部品に渡すもの。 */
export interface IParadisRenderedDiffHost {
	/** ビューアの根（バーを先頭に置く）。 */
	readonly root: HTMLElement;
	/** バーの下の領域（webview のアンカーを置く）。 */
	readonly content: HTMLElement;
	readonly window: () => CodeWindow;
	/** テキスト差分を見せる・隠す。 */
	setTextVisible(visible: boolean): void;
}

interface IParadisRenderedDiffInput {
	readonly original: URI;
	readonly modified: URI;
	readonly originalModel: ITextModel;
	readonly modifiedModel: ITextModel;
}

/** 片側の描画の結果。 */
interface IRenderedSide extends IParadisRenderedDiffSide {
	/** 描いた木に画像があったか（古い側の画像を今の作業ツリーから読んだことを知らせる）。 */
	readonly hasImages: boolean;
}

export class ParadisMarkdownRenderedDiffView extends Disposable {

	private readonly _toolbar: IParadisViewerToolbar;
	private readonly _modeSegmented: ParadisSegmented<ParadisFileDiffViewMode>;
	private readonly _layoutSegmented: ParadisSegmented<ParadisRenderedDiffLayout>;
	private readonly _legend: HTMLElement;
	private readonly _note: HTMLElement;
	private readonly _navigation: HTMLElement;
	private readonly _position: HTMLElement;
	private readonly _zoomGroup: HTMLElement;
	private readonly _webviewContainer: HTMLElement;
	private readonly _zoom: ParadisViewerZoomControls;
	private readonly _pane: ParadisOverlayWebviewPane;
	private readonly _inputStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _render = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _rerender = this._register(new RunOnceScheduler(() => this._renderNow(), 300));

	private _input: IParadisRenderedDiffInput | undefined;
	private _mode: ParadisFileDiffViewMode = 'text';
	private _layout: ParadisRenderedDiffLayout;
	private _width = 0;
	private _visible = false;
	/** いま webview に出している文書の並べ方（幅で替わったら描き直す）。 */
	private _renderedLayout: ParadisRenderedDiffLayout | undefined;
	/** プレビュー差分を出せない理由（大きすぎる・突き合わせられない）。あればテキスト差分に固定する。 */
	private _unavailable: string | undefined;
	private _changes = 0;
	private _current = -1;

	constructor(
		private readonly _host: IParadisRenderedDiffHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
	) {
		super();
		this._layout = this._storageService.get(LAYOUT_STORAGE_KEY, StorageScope.PROFILE) === 'unified' ? 'unified' : 'split';

		// バーは差分の領域の上に置く（ほかのビューアの「プレビュー | ソース」と同じ帯）。
		this._toolbar = createParadisViewerToolbar(_host.root, 'paradis-rendered-diff-toolbar', localize('paradis.renderedDiff.toolbar', "差分の表示"));
		_host.root.insertBefore(this._toolbar.element, _host.content);
		const start = this._toolbar.start;
		this._modeSegmented = this._register(new ParadisSegmented<ParadisFileDiffViewMode>(start, {
			ariaLabel: localize('paradis.renderedDiff.mode', "差分の表示"),
			value: this._mode,
			items: [
				{ value: 'text', label: localize('paradis.renderedDiff.text', "テキスト差分") },
				{ value: 'rendered', label: localize('paradis.renderedDiff.rendered', "プレビュー差分") },
			],
		}));
		this._modeSegmented.element.classList.add('paradis-file-viewer-toggle');
		this._register(this._modeSegmented.onDidChange(mode => this._chooseMode(mode)));
		this._layoutSegmented = this._register(new ParadisSegmented<ParadisRenderedDiffLayout>(start, {
			ariaLabel: localize('paradis.renderedDiff.layout', "並べ方"),
			value: this._layout,
			items: [
				{ value: 'split', label: localize('paradis.renderedDiff.split', "左右") },
				{ value: 'unified', label: localize('paradis.renderedDiff.unified', "1 列") },
			],
		}));
		this._register(this._layoutSegmented.onDidChange(layout => this._chooseLayout(layout)));
		this._legend = dom.append(start, dom.$('.paradis-viewer-toolbar-legend.paradis-rendered-diff-legend'));
		for (const [kind, label] of [['added', localize('paradis.renderedDiff.added', "追加")], ['removed', localize('paradis.renderedDiff.removed', "削除")], ['changed', localize('paradis.renderedDiff.changed', "変更")]] as const) {
			const item = dom.append(this._legend, dom.$('span.paradis-rendered-diff-legend-item'));
			dom.append(item, dom.$(`span.paradis-rendered-diff-legend-swatch.paradis-rendered-diff-legend-${kind}`)).setAttribute('aria-hidden', 'true');
			dom.append(item, dom.$('span')).textContent = label;
		}
		this._note = dom.append(start, dom.$('span.paradis-viewer-toolbar-text.paradis-rendered-diff-note'));

		const end = this._toolbar.end;
		this._navigation = appendParadisViewerToolbarGroup(end, 'paradis-rendered-diff-nav');
		const previous = appendParadisViewerToolbarIconButton(this._navigation, Codicon.arrowUp, localize('paradis.renderedDiff.previous', "前の変更"));
		this._register(dom.addDisposableListener(previous, dom.EventType.CLICK, () => this._navigate(-1)));
		this._position = dom.append(this._navigation, dom.$('span.paradis-viewer-toolbar-position'));
		const next = appendParadisViewerToolbarIconButton(this._navigation, Codicon.arrowDown, localize('paradis.renderedDiff.next', "次の変更"));
		this._register(dom.addDisposableListener(next, dom.EventType.CLICK, () => this._navigate(1)));
		appendParadisViewerToolbarSeparator(end);
		this._zoom = this._register(new ParadisViewerZoomControls(() => void this._pane.webview?.postMessage(paradisViewerZoomMessage(this._zoom.factor))));
		this._zoomGroup = appendParadisViewerToolbarGroup(end, 'paradis-rendered-diff-zoom');
		this._zoom.createButtons(this._zoomGroup);

		this._webviewContainer = dom.append(_host.content, dom.$('.paradis-file-viewer-webview.paradis-rendered-diff-webview'));
		this._pane = this._register(instantiationService.createInstance(ParadisOverlayWebviewPane, this, {
			originKey: PARADIS_FILE_DIFF_EDITOR_ID,
			enableFindWidget: true,
			// 実行できるのは、この部品が埋め込む nonce 付きの補助スクリプト（移動・拡大・Mermaid）だけ（CSP）。
			allowScripts: true,
			onDidCreate: (webview, store) => this._onWebviewCreated(webview, store),
			onDidDispose: () => this._renderedLayout = undefined,
		}));
		// コードの配色は HTML に焼き込んでいるので、テーマが変わったら描き直す。
		this._register(themeService.onDidColorThemeChange(() => this._scheduleRender(0)));
		this._showControls();
	}

	get mode(): ParadisFileDiffViewMode {
		return this._input ? this._mode : 'text';
	}

	/** 開いた差分を受け取る。モデルの変更（右側の編集・ファイルの更新）に合わせて描き直す。 */
	setInput(original: URI, modified: URI, originalModel: ITextModel, modifiedModel: ITextModel): void {
		const store = new DisposableStore();
		this._inputStore.value = store;
		this._input = { original, modified, originalModel, modifiedModel };
		this._unavailable = undefined;
		this._changes = 0;
		this._current = -1;
		this._renderedLayout = undefined;
		this._pane.clearContent();
		store.add(originalModel.onDidChangeContent(() => this._scheduleRender()));
		store.add(modifiedModel.onDidChangeContent(() => this._scheduleRender()));
		this._toolbar.element.style.display = '';
		this._checkSize();
		const mode = this._unavailable ? 'text' : paradisInitialDiffViewMode(this._configurationService.getValue(PARADIS_MARKDOWN_DIFF_VIEW_SETTING), this._storageService.get(LAST_MODE_STORAGE_KEY, StorageScope.PROFILE));
		this._applyMode(mode);
	}

	/** Markdown 以外の差分が来た・閉じた。バーを隠してテキスト差分に戻す。 */
	clearInput(): void {
		this._inputStore.clear();
		this._render.clear();
		this._rerender.cancel();
		this._input = undefined;
		this._pane.release();
		this._pane.clearContent();
		this._toolbar.element.style.display = 'none';
		this._host.setTextVisible(true);
	}

	setVisible(visible: boolean): void {
		if (visible !== this._visible) {
			this._visible = visible;
			this._place();
		}
	}

	layout(width: number): void {
		this._width = width;
		if (this._mode === 'rendered' && this._renderedLayout && this._renderedLayout !== paradisEffectiveDiffLayout(this._layout, width)) {
			this._scheduleRender(100);
		}
	}

	focus(): void {
		this._pane.webview?.focus();
	}

	/** 大きすぎる文書はプレビュー差分を出さない。 */
	private _checkSize(): void {
		const input = this._input;
		if (input && isParadisRenderedDiffTooLarge({ length: input.originalModel.getValueLength() }, { length: input.modifiedModel.getValueLength() })) {
			this._unavailable = localize('paradis.renderedDiff.tooLarge', "大きいのでテキスト差分で表示しています");
		}
	}

	private _chooseMode(mode: ParadisFileDiffViewMode): void {
		if (this._configurationService.getValue(PARADIS_MARKDOWN_DIFF_VIEW_SETTING) === 'remember') {
			this._storageService.store(LAST_MODE_STORAGE_KEY, mode, StorageScope.PROFILE, StorageTarget.USER);
		}
		this._applyMode(mode);
	}

	private _chooseLayout(layout: ParadisRenderedDiffLayout): void {
		this._layout = layout;
		this._storageService.store(LAYOUT_STORAGE_KEY, layout, StorageScope.PROFILE, StorageTarget.USER);
		this._scheduleRender(0);
	}

	private _applyMode(mode: ParadisFileDiffViewMode): void {
		this._mode = this._unavailable ? 'text' : mode;
		this._modeSegmented.value = this._mode;
		this._host.setTextVisible(this._mode === 'text');
		this._showControls();
		this._place();
		if (this._mode === 'rendered') {
			this._scheduleRender(0);
		} else {
			this._render.clear();
			this._rerender.cancel();
		}
	}

	/** バーの中身をいまの状態に合わせる。 */
	private _showControls(): void {
		const rendered = this._mode === 'rendered';
		this._modeSegmented.setItemEnabled('rendered', !this._unavailable, this._unavailable);
		this._layoutSegmented.element.style.display = rendered ? '' : 'none';
		this._legend.style.display = rendered && this._changes > 0 ? '' : 'none';
		this._navigation.style.display = rendered ? '' : 'none';
		this._zoomGroup.style.display = rendered ? '' : 'none';
		this._layoutSegmented.value = this._layout;
		this._position.textContent = this._changes === 0
			? localize('paradis.renderedDiff.noChanges', "変更なし")
			: `${this._current < 0 ? '–' : this._current + 1} / ${this._changes}`;
		if (this._unavailable) {
			this._note.textContent = this._unavailable;
			this._note.title = this._unavailable;
		} else if (!rendered) {
			this._note.textContent = '';
			this._note.title = '';
		}
	}

	private _place(): void {
		const show = this._visible && this._mode === 'rendered' && !!this._input;
		if (!show) {
			this._pane.release();
			return;
		}
		const justClaimed = this._pane.place(true, this._host.window(), this._webviewContainer, () => ({ disableServiceWorker: true, localResourceRoots: [] }), () => this._place());
		if (justClaimed) {
			// claim で下地が作り直されると中身が消えうるので、描き直す。
			this._scheduleRender(0);
		}
	}

	private _onWebviewCreated(webview: IOverlayWebview, store: DisposableStore): void {
		store.add(webview.onDidClickLink(link => {
			const target = paradisMarkdownLinkToOpen(link);
			if (target) {
				this._openerService.open(target, { fromUserGesture: true, allowContributedOpeners: true }).catch(onUnexpectedError);
			}
		}));
	}

	private _navigate(delta: number): void {
		if (this._changes === 0) {
			return;
		}
		this._current = this._current < 0 ? (delta > 0 ? 0 : this._changes - 1) : (this._current + delta + this._changes) % this._changes;
		void this._pane.webview?.postMessage(paradisRenderedDiffGoMessage(this._current));
		this._showControls();
	}

	private _scheduleRender(delay?: number): void {
		if (this._mode !== 'rendered' || !this._input) {
			return;
		}
		this._rerender.schedule(delay);
	}

	private _renderNow(): void {
		const input = this._input;
		const webview = this._pane.webview;
		if (!input || this._mode !== 'rendered' || !webview || !this._pane.claimed) {
			return;
		}
		this._checkSize();
		if (this._unavailable) {
			this._applyMode('text');
			return;
		}
		const source = new CancellationTokenSource();
		this._render.value = source;
		const layout = paradisEffectiveDiffLayout(this._layout, this._width);
		this._renderDocument(input, layout, source.token).then(result => {
			if (source.token.isCancellationRequested || this._input !== input) {
				return;
			}
			if (typeof result === 'string') {
				this._unavailable = result;
				this._applyMode('text');
				return;
			}
			this._pane.setDocumentHtml(webview, input.modified, result.html);
			this._renderedLayout = layout;
			this._changes = result.changes;
			this._current = -1;
			this._note.textContent = result.note;
			this._note.title = result.note;
			this._showControls();
		}, error => {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
		});
	}

	/** 両側を描いて突き合わせ、webview に書く HTML を作る。プレビュー差分を出せないときは理由の文言を返す。 */
	private async _renderDocument(input: IParadisRenderedDiffInput, layout: ParadisRenderedDiffLayout, token: CancellationToken): Promise<{ readonly html: string; readonly changes: number; readonly note: string } | string> {
		const blockClass = `paradis-rdiff-src-${generateUuid().replace(/-/g, '')}`;
		// git: などディスクに無い版は、相対パスの画像とリンクを今の作業ツリーの同じファイルから解決する
		// （git: の URI のまま解決すると、クエリに入っている文書そのものを読んでしまう）。
		const originalBase = this._workingTreeResource(input.original);
		const modifiedBase = this._workingTreeResource(input.modified);
		const [original, modified] = await Promise.all([
			this._renderSide(input.originalModel.getValue(), originalBase, blockClass, token),
			this._renderSide(input.modifiedModel.getValue(), modifiedBase, blockClass, token),
		]);
		if (!original || !modified) {
			return localize('paradis.renderedDiff.unsupported', "この文書はプレビュー差分で表示できないため、テキスト差分で表示しています");
		}
		if (original.blocks.length > PARADIS_RENDERED_DIFF_LIMITS.maxBlocks || modified.blocks.length > PARADIS_RENDERED_DIFF_LIMITS.maxBlocks) {
			return localize('paradis.renderedDiff.tooLarge', "大きいのでテキスト差分で表示しています");
		}
		const target = this._host.root.ownerDocument.implementation.createHTMLDocument('');
		const result = buildParadisRenderedDiff(target, original, modified, layout, {
			original: localize('paradis.renderedDiff.originalCaption', "変更前"),
			modified: localize('paradis.renderedDiff.modifiedCaption', "変更後"),
			before: localize('paradis.renderedDiff.before', "変更前"),
			after: localize('paradis.renderedDiff.after', "変更後"),
		}, token);
		const body = result.root.outerHTML;
		const hasMermaid = containsParadisMermaidBlock(body);
		const mermaidScriptSource = hasMermaid ? await loadParadisMermaidScriptSource(this._fileService) : undefined;
		if (token.isCancellationRequested) {
			return { html: '', changes: 0, note: '' };
		}
		const nonce = generateUuid();
		const colorMap = TokenizationRegistry.getColorMap();
		const tokenCss = colorMap ? generateTokensCSSForColorMap(colorMap) : '';
		const html = `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${nonce}'; font-src https: data:; script-src 'nonce-${nonce}';">
		<style nonce="${nonce}">
			html { zoom: ${this._zoom.factor}; }
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${PARADIS_INLINE_MEDIA_STYLES}
			${tokenCss}
			.paradis-mermaid.mermaid { display: flex; justify-content: center; background: none; }
			${PARADIS_MARKDOWN_ALERT_STYLES}
			${PARADIS_RENDERED_DIFF_STYLES}
		</style>
	</head>
	<body class="paradis-markdown-body paradis-rdiff-body">
		${body}
		${mermaidScriptSource !== undefined ? paradisMermaidScripts(nonce, mermaidScriptSource) : ''}
		${paradisViewerZoomScript(nonce)}
		${paradisRenderedDiffNavigationScript(nonce)}
		${paradisFindHighlightScript(nonce)}
	</body>
</html>`;
		const note = modified.hasImages && modifiedBase !== input.modified
			? localize('paradis.renderedDiff.allImagesFromWorkingTree', "画像は今の作業ツリーのものです")
			: original.hasImages && originalBase !== input.original
				? localize('paradis.renderedDiff.imagesFromWorkingTree', "変更前の画像は今の作業ツリーのものです")
				: '';
		return { html, changes: result.changes, note };
	}

	/**
	 * 相対パスの画像とリンクを解決する元のファイル。ディスクの上のファイル（file:・vscode-remote:）はそのまま、git: などの
	 * 版は、同じパスの作業ツリーのファイル（パスを含むワークスペースフォルダーのスキームで）にする。
	 */
	private _workingTreeResource(resource: URI): URI {
		if (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) {
			return resource;
		}
		const folder = this._workspaceContextService.getWorkspace().folders.find(candidate => resource.path.startsWith(candidate.uri.path.endsWith('/') ? candidate.uri.path : `${candidate.uri.path}/`));
		return folder ? folder.uri.with({ path: resource.path }) : URI.file(resource.path);
	}

	/** 片側を Markdown のビューアと同じ変換で描き、一番上のブロックに分ける。ブロックの数が合わなければ `undefined`。 */
	private async _renderSide(text: string, resource: URI, blockClass: string, token: CancellationToken): Promise<IRenderedSide | undefined> {
		// front matter は YAML のコードのブロックとして 1 つのブロックで比べる。
		const frontMatter = applyParadisFrontMatter(text, 'codeBlock');
		const rendered = await renderParadisMarkdownDocumentDeferred(frontMatter.markdown, this._extensionService, this._languageService, {
			allowRelativeMediaPaths: true,
			allowRelativeLinkPaths: true,
			markedExtensions: [markedMermaidExtension(), markedParadisAlertExtension()],
			blockClass,
		}, token);
		// TrustedHTML はそのまま渡す（文字列にすると Trusted Types に弾かれる）。
		const doc = new DOMParser().parseFromString(rendered.html as unknown as string, 'text/html');
		rendered.insertHighlightedCode(doc.body);
		const workspaceFolder = this._workspaceContextService.getWorkspaceFolder(resource)?.uri;
		rewriteParadisMarkdownLinks(doc.body, resource, workspaceFolder);
		await inlineParadisMarkdownMediaInBody(doc.body, resource, workspaceFolder, this._fileService, token, PARADIS_INLINE_MEDIA_LIMITS);
		const blocks = Array.from(doc.body.children).filter((element): element is HTMLElement => element.classList.contains(blockClass));
		const items = paradisMarkdownRenderedDiffItems(rendered.tokens, rendered.tokens.links);
		if (blocks.length !== items.length) {
			// 文書の生の HTML が包みを閉じた・増やした。どのブロックがどの描画か決められない。
			return undefined;
		}
		return { blocks, items, hasImages: doc.body.innerHTML.includes('<img') };
	}
}
