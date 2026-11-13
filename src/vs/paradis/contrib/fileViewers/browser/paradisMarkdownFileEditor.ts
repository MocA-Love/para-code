/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown レンダリングビューア（読み取り専用）。VS Code 標準の renderMarkdownDocument と同じ変換
// （marked ベースのレンダラ + シンタックスハイライト。paradisMarkdownDocumentRenderer）
// と標準プレビュー CSS（DEFAULT_MARKDOWN_STYLES）を流用し、webview に表示する。
//
// この webview は service worker を使わない（`disableServiceWorker`）。そのぶん相対パスの画像は
// 読み込みの時点で data: URI へ埋め込む（paradisMarkdownInlineResources）。書く側から見た記法は
// 変わらない。理由の詳細は同モジュールの冒頭を参照。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual } from '../../../../base/common/resources.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { DEFAULT_MARKDOWN_STYLES } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { renderParadisMarkdownDocumentDeferred } from './paradisMarkdownDocumentRenderer.js';
import { applyParadisFrontMatter, PARADIS_FRONTMATTER_STYLES, ParadisFrontMatterStyle } from './paradisMarkdownFrontMatter.js';
import { ParadisViewerOpenKind } from '../common/paradisViewerOpenTiming.js';
import { PARADIS_VIEWER_BODY_ROOT_ID, paradisViewerBodySwapScript, type IParadisRenderedDocument } from '../common/paradisViewerBodySwap.js';
import { inlineParadisMarkdownMedia, ParadisInlineMediaCache, PARADIS_INLINE_MEDIA_LIMITS, PARADIS_INLINE_MEDIA_STYLES } from './paradisMarkdownInlineResources.js';
import { paradisMarkdownLinkToOpen, rewriteParadisMarkdownLinks } from './paradisMarkdownLinks.js';
import { containsParadisMermaidBlock, IParadisMermaidZoomLabels, loadParadisMermaidScriptSource, markedMermaidExtension, PARADIS_MERMAID_RERUN_SCRIPT, PARADIS_MERMAID_ZOOM_STYLES, paradisMermaidZoomScript } from './paradisMarkdownMermaid.js';
import { markedParadisAlertExtension, PARADIS_MARKDOWN_ALERT_STYLES } from './paradisMarkdownAlerts.js';
import { ParadisRenderedFileEditor } from './paradisRenderedFileEditor.js';
import { createParadisViewerReloadButton, ParadisViewerZoomControls, paradisViewerZoomMessage, paradisViewerZoomScript } from './paradisViewerZoom.js';
import { appendParadisViewerToolbarSeparator } from './paradisViewerToolbar.js';
import { ParadisMarkdownWidthControl } from './paradisMarkdownWidthControl.js';
import { PARADIS_MARKDOWN_WIDTH_SETTING, PARADIS_MARKDOWN_WIDTH_STYLES, paradisMarkdownWidthClass, paradisMarkdownWidthMessage, paradisMarkdownWidthScript, paradisResolveMarkdownWidth, ParadisMarkdownWidth } from '../common/paradisMarkdownWidth.js';
import { IParadisCodeCopyLabels, PARADIS_CODE_COPY_RERUN_SCRIPT, PARADIS_CODE_COPY_STYLES, paradisCodeCopiedMessage, paradisCodeCopyScript, paradisReadCodeCopyRequest } from '../common/paradisMarkdownCodeCopy.js';
import { IParadisViewerScrollState } from '../common/paradisViewerScroll.js';
import { paradisRecoverMarkdownCodeSources } from '../common/paradisMarkdownCodeSource.js';
import { PARADIS_MARKDOWN_EDITOR_ID } from './paradisFileViewers.js';
import { ParadisFileViewerInput } from './paradisFileViewerInput.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { localize } from '../../../../nls.js';

/** 図の拡大の窓の文言。 */
function mermaidZoomLabels(): IParadisMermaidZoomLabels {
	return {
		expand: localize('paradis.markdown.mermaid.expand', "図を拡大"),
		dialog: localize('paradis.markdown.mermaid.dialog', "拡大した図"),
		zoomOut: localize('paradis.markdown.mermaid.zoomOut', "縮小"),
		zoomIn: localize('paradis.markdown.mermaid.zoomIn', "拡大"),
		fit: localize('paradis.markdown.mermaid.fit', "画面に合わせる"),
		copy: localize('paradis.markdown.mermaid.copy', "PNG でコピー"),
		close: localize('paradis.markdown.mermaid.close', "閉じる"),
		copied: localize('paradis.markdown.mermaid.copied', "コピーしました"),
		copyFailed: localize('paradis.markdown.mermaid.copyFailed', "コピーできませんでした"),
	};
}

/** コードのブロックの「コピー」の文言。 */
function codeCopyLabels(): IParadisCodeCopyLabels {
	return {
		copy: localize('paradis.markdown.codeCopy', "コピー"),
		copied: localize('paradis.markdown.codeCopied', "コピーしました"),
		copyFailed: localize('paradis.markdown.codeCopyFailed', "コピーできませんでした"),
	};
}

export class ParadisMarkdownFileEditor extends ParadisRenderedFileEditor {

	static readonly ID = PARADIS_MARKDOWN_EDITOR_ID;

	private readonly _zoom: ParadisViewerZoomControls;
	/** 埋め込んだ画像の data: URI。保存のたびの描き直しで、同じ画像を base64 にし直さない。 */
	private readonly _mediaCache = new ParadisInlineMediaCache();
	/** `_mediaCache` がどの文書の画像を覚えているか。 */
	private _mediaCacheResource: URI | undefined;
	/** 帯の「読みやすい | 広い | 全幅」。 */
	private _widthControl: ParadisMarkdownWidthControl | undefined;
	/**
	 * 帯でこのファイルに選んだ幅。選んでいないファイルは設定の既定に従う（設定を替えれば開いたままでも替わる）。
	 * スクロールの位置と一緒にファイルごとに覚える（{@link computeExtraViewState}）。
	 */
	private _chosenWidth: { readonly resource: URI; readonly width: ParadisMarkdownWidth } | undefined;
	/**
	 * いま描いた文書のコードのブロックの、画面の文字 → 書いたままの中身（行頭のタブを marked が空白に広げたもの
	 * だけ）。コピーで元のタブに戻す。
	 */
	private _codeSources = new Map<string, string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService webviewService: IWebviewService,
		@ITextFileService textFileService: ITextFileService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@INotificationService notificationService: INotificationService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
	) {
		super(PARADIS_MARKDOWN_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService, layoutService, configurationService, notificationService, textResourceConfigurationService, editorService, editorGroupService);
		// 拡大縮小はページ内のスクリプトで反映する（Markdown はスクリプトを常に許可している）。
		this._zoom = this._register(new ParadisViewerZoomControls(() => void this.webview?.postMessage(paradisViewerZoomMessage(this._zoom.factor))));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MARKDOWN_WIDTH_SETTING)) {
				this._showWidth();
			}
		}));
	}

	/** いまの文書の本文の幅（帯で選んだ幅 → 設定の既定）。 */
	private _widthFor(resource: URI | undefined): ParadisMarkdownWidth {
		const chosen = resource && this._chosenWidth && isEqual(this._chosenWidth.resource, resource) ? this._chosenWidth.width : undefined;
		return paradisResolveMarkdownWidth(chosen, this._configurationService.getValue(PARADIS_MARKDOWN_WIDTH_SETTING));
	}

	/** いまの幅を帯とページに出す（ページは描き直さず、ズームと同じく postMessage で替える）。 */
	private _showWidth(): void {
		const width = this._widthFor(this.input?.resource);
		if (this._widthControl) {
			this._widthControl.value = width;
		}
		void this.webview?.postMessage(paradisMarkdownWidthMessage(width));
	}

	/** 帯で幅を選んだ。このファイルに覚える。 */
	private _chooseWidth(width: ParadisMarkdownWidth): void {
		const resource = this.input?.resource;
		if (!resource) {
			return;
		}
		this._chosenWidth = { resource, width };
		this._showWidth();
	}

	protected override computeExtraViewState(resource: URI): Omit<IParadisViewerScrollState, 'scrollProgress'> {
		return this._chosenWidth && isEqual(this._chosenWidth.resource, resource) ? { markdownWidth: this._chosenWidth.width } : {};
	}

	protected override restoreExtraViewState(resource: URI, state: IParadisViewerScrollState | undefined): void {
		this._chosenWidth = state?.markdownWidth ? { resource, width: state.markdownWidth } : undefined;
		if (this._widthControl) {
			this._widthControl.value = this._widthFor(resource);
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		// 同じペインで別の文書へ移るときは、前の文書の画像を抱えたままにしない（clearInput を経ずに
		// 入力が差し替わることがある）。
		const resource = (input as ParadisFileViewerInput).resource;
		if (!isEqual(this._mediaCacheResource, resource)) {
			this._mediaCache.clear();
			this._mediaCacheResource = resource;
		}
		await super.setInput(input, options, context, token);
	}

	override clearInput(): void {
		// 別の文書へ移るときは、前の文書の画像を抱えたままにしない。
		this._mediaCache.clear();
		this._mediaCacheResource = undefined;
		super.clearInput();
	}

	override dispose(): void {
		this._mediaCache.dispose();
		super.dispose();
	}

	protected override onCreateToolbar(toolbar: HTMLElement): void {
		// 本文の幅はズームの左。帯が狭いときは 1 つのボタンに畳む（区切り線は狭い帯では出ない）。
		this._widthControl = this._register(new ParadisMarkdownWidthControl(toolbar, this._widthFor(undefined), width => this._chooseWidth(width), this._contextMenuService));
		appendParadisViewerToolbarSeparator(toolbar);
		this._zoom.createButtons(toolbar);
		// .md の変更は自動で描き直すが、参照している画像だけを差し替えたときや変更の通知が届かないときのために、
		// HTML と同じ位置に置く。同じ内容でも送り直し、画像も読み直す
		this._register(createParadisViewerReloadButton(toolbar, () => this.requestRerender()));
	}

	// Mermaid ブロック（```mermaid```）を webview 内で mermaid.js に描画させ、スクロール位置の復元と
	// 検索結果の色付けをするため許可する。実行できるスクリプトは CSP の `script-src 'nonce-...'` により、
	// この HTML が自分で埋め込んだ nonce 付き <script>（vendored mermaid.js 本体 + 初期化コード、
	// ビューアの補助スクリプト）だけに限定される。
	protected override get allowScripts(): boolean {
		return true;
	}

	// 画像は data: で埋め込むので、`vscode-resource` を解決する service worker は要らない。
	protected override disableServiceWorkerFor(_resource: URI): boolean {
		return true;
	}

	protected override get openTimingKind(): ParadisViewerOpenKind {
		return 'markdown';
	}

	// webview 基盤は `#見出し` 以外のリンクを通知するだけで自分では開かないので、ここで開く。
	// 相対パスのリンクは描画時に絶対 URI へ書き換え済み（paradisMarkdownLinks）。
	protected override onWebviewCreated(webview: IOverlayWebview, store: DisposableStore): void {
		store.add(webview.onDidClickLink(link => {
			const target = paradisMarkdownLinkToOpen(link);
			if (target) {
				this._openerService.open(target, { fromUserGesture: true, allowContributedOpeners: true }).catch(onUnexpectedError);
			}
		}));
		// コードのブロックの「コピー」。ページから届いた中身をそのままクリップボードへ書き、結果を返す。
		store.add(webview.onMessage(({ message }) => {
			const request = paradisReadCodeCopyRequest(message);
			if (!request) {
				return;
			}
			this._clipboardService.writeText(this._codeSources.get(request.text) ?? request.text).then(() => true, err => {
				onUnexpectedError(err);
				return false;
			}).then(ok => webview.postMessage(paradisCodeCopiedMessage(request.id, ok)));
		}));
	}

	/** 標準 Markdown プレビューと同じ `markdown.preview.frontMatter` 設定を読む（不正値は既定の table 扱い）。 */
	private _getFrontMatterStyle(resource: URI): ParadisFrontMatterStyle {
		const value = this._configurationService.getValue<string>('markdown.preview.frontMatter', { resource });
		switch (value) {
			case 'hide':
			case 'codeBlock':
				return value;
			default:
				return 'table';
		}
	}

	protected override async renderDocument(text: string, resource: URI, _webview: IOverlayWebview, token: CancellationToken): Promise<IParadisRenderedDocument> {
		// フロントマターを素の Markdown として marked に渡すと、先頭の `---` が水平線、
		// 閉じの `---` が setext 見出し記法と解釈されて YAML 全体が巨大な見出しに化ける。
		// 事前に分離し、設定スタイルに応じた表示（非表示 / YAML コードブロック / テーブル）に置き換える。
		const frontMatter = applyParadisFrontMatter(text, this._getFrontMatterStyle(resource));

		// upstream の renderMarkdownDocument と同じ結果を、文書の大きさに比例する時間で返す（理由は同モジュールの冒頭）。
		// 色付けしたコードは消毒の後に差し込む（下の rewriteBody。理由は paradisMarkdownDocumentRenderer.ts の冒頭）。
		const rendered = await renderParadisMarkdownDocumentDeferred(frontMatter.markdown, this._extensionService, this._languageService, {
			allowRelativeMediaPaths: true,
			allowRelativeLinkPaths: true,
			markedExtensions: [markedMermaidExtension(), markedParadisAlertExtension()],
		}, token);

		// サニタイズ済みの HTML を受け取ってから、ローカルの画像だけを data: に差し替える。
		// <base href> は置かない。置いても service worker が無ければ解決できず、その一方で
		// 文書内アンカー（#見出し）の解決先を歪めるだけになるため。
		const workspaceFolder = this._workspaceContextService.getWorkspaceFolder(resource)?.uri;
		const media = await inlineParadisMarkdownMedia(
			rendered.html,
			resource,
			workspaceFolder,
			this._fileService,
			token,
			PARADIS_INLINE_MEDIA_LIMITS,
			body => {
				rendered.insertHighlightedCode(body);
				rewriteParadisMarkdownLinks(body, resource, workspaceFolder);
			},
			this._mediaCache);

		// 同じ webview の描き直しでは同じ nonce（本文だけを差し替えるとき、外側の CSP がそのまま使えるように）。
		const nonce = this.documentNonce;
		const colorMap = TokenizationRegistry.getColorMap();
		const tokenCss = colorMap ? generateTokensCSSForColorMap(colorMap) : '';

		// mermaid ブロックを含む文書だけ vendored mermaid.js（約3.5MB）を読み込む。含まない文書で
		// 毎回読み込む無駄を避けるための条件分岐。
		const hasMermaid = containsParadisMermaidBlock(media.html);
		const mermaidScriptSource = hasMermaid ? await loadParadisMermaidScriptSource(this._fileService) : undefined;
		if (token.isCancellationRequested) {
			return { html: '' };
		}
		const mermaidEnabled = hasMermaid && mermaidScriptSource !== undefined;
		const body = `${frontMatter.htmlPrefix}${media.html}`;
		this._codeSources = paradisRecoverMarkdownCodeSources(frontMatter.markdown, rendered.codeSources);
		const width = this._widthFor(resource);

		// 実行できるのは、この HTML 自身が埋め込む nonce 付き <script>（ビューアの補助スクリプトと、
		// mermaid を使う文書では vendored mermaid.js 本体 + 直後の初期化コード）だけであり、
		// Markdown の記述内容や外部ソースからスクリプトを注入する余地はない。
		const scriptSrc = ` script-src 'nonce-${nonce}';`;

		const html = `<!DOCTYPE html>
<html class="${paradisMarkdownWidthClass(width)}">
	<head>
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${nonce}'; font-src https: data:;${scriptSrc}">
		<style nonce="${nonce}">
			html { zoom: ${this._zoom.factor}; }
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_MARKDOWN_WIDTH_STYLES}
			${PARADIS_CODE_COPY_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${PARADIS_INLINE_MEDIA_STYLES}
			${tokenCss}
			.paradis-mermaid.mermaid { display: flex; justify-content: center; background: none; }
			${PARADIS_MARKDOWN_ALERT_STYLES}
			${mermaidEnabled ? PARADIS_MERMAID_ZOOM_STYLES : ''}
		</style>
	</head>
	<body class="paradis-markdown-body">
		<div id="${PARADIS_VIEWER_BODY_ROOT_ID}">${body}</div>
		${mermaidEnabled ? paradisMermaidZoomScript(nonce, mermaidZoomLabels()) : ''}
		${mermaidEnabled ? this._renderMermaidScripts(nonce, mermaidScriptSource!) : ''}
		${paradisViewerZoomScript(nonce)}
		${paradisMarkdownWidthScript(nonce)}
		${paradisCodeCopyScript(nonce, codeCopyLabels())}
		${paradisViewerBodySwapScript(nonce, PARADIS_CODE_COPY_RERUN_SCRIPT + (mermaidEnabled ? PARADIS_MERMAID_RERUN_SCRIPT : ''))}
		${this.viewerPageScripts(resource, nonce)}
	</body>
</html>`;
		// 2 回目以降の描き直しは、外側（nonce・配色・Mermaid の有無）が同じなら本文だけを送る。Mermaid 本体（約 3.5MB）と
		// スタイルは最初の 1 回だけ読み込む。倍率と本文の幅はページへ別に送っているので鍵に入れない（`<html>` は差し替えの外）。
		return { html, swap: { key: `${nonce}\n${mermaidEnabled}\n${tokenCss}`, body } };
	}

	/**
	 * vendored mermaid.js 本体と、それに続く初期化コードを nonce 付き <script> として埋め込む。
	 *
	 * `securityLevel: 'strict'` で HTML ラベル注入やクリックイベント等のスクリプト機能を無効化する
	 * （mermaid 標準のサンドボックスモード）。テーマは `--vscode-editor-background` の輝度から
	 * 単純に判定する（webview 内側のこのドキュメント自身には `vscode-dark` 等のクラスが付かないため）。
	 */
	private _renderMermaidScripts(nonce: string, mermaidScriptSource: string): string {
		return `<script nonce="${nonce}">${mermaidScriptSource}</script>
		<script nonce="${nonce}">
			(function () {
				function isDarkBackground() {
					var probe = document.createElement('div');
					probe.style.color = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background');
					document.body.appendChild(probe);
					var rgb = getComputedStyle(probe).color;
					document.body.removeChild(probe);
					var m = rgb.match(/\\d+/g);
					if (!m || m.length < 3) { return false; }
					return (0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])) < 128;
				}
				try {
					mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDarkBackground() ? 'dark' : 'default' });
					var run = mermaid.run({ querySelector: '.paradis-mermaid' });
					var done = function () { if (window.__paradisMermaidZoom) { window.__paradisMermaidZoom.decorate(); } };
					if (run && run.then) { run.then(done, function (err) { console.error('[paradis] mermaid render failed', err); done(); }); } else { done(); }
				} catch (err) {
					console.error('[paradis] mermaid render failed', err);
				}
			})();
		</script>`;
	}
}
