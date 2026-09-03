/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown レンダリングビューア（読み取り専用）。VS Code 標準の renderMarkdownDocument
// （extensions/markdown-language-features と同じ marked ベースのレンダラ + シンタックスハイライト）
// と標準プレビュー CSS（DEFAULT_MARKDOWN_STYLES）を流用し、webview に表示する。
//
// この webview は service worker を使わない（`disableServiceWorker`）。そのぶん相対パスの画像は
// 読み込みの時点で data: URI へ埋め込む（paradisMarkdownInlineResources）。書く側から見た記法は
// 変わらない。理由の詳細は同モジュールの冒頭を参照。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { DEFAULT_MARKDOWN_STYLES, renderMarkdownDocument } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { applyParadisFrontMatter, PARADIS_FRONTMATTER_STYLES, ParadisFrontMatterStyle } from './paradisMarkdownFrontMatter.js';
import { inlineParadisMarkdownMedia, PARADIS_INLINE_MEDIA_STYLES } from './paradisMarkdownInlineResources.js';
import { containsParadisMermaidBlock, loadParadisMermaidScriptSource, markedMermaidExtension, paradisMarkdownCspContent } from './paradisMarkdownMermaid.js';
import { ParadisRenderedFileEditor } from './paradisRenderedFileEditor.js';
import { PARADIS_MARKDOWN_EDITOR_ID } from './paradisFileViewers.js';

export class ParadisMarkdownFileEditor extends ParadisRenderedFileEditor {

	static readonly ID = PARADIS_MARKDOWN_EDITOR_ID;

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
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super(PARADIS_MARKDOWN_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService, layoutService, configurationService, notificationService);
	}

	// Mermaid ブロック（```mermaid```）を webview 内で mermaid.js に描画させるため許可する。実行できる
	// スクリプトは CSP の `script-src 'nonce-...'` により、この HTML が自分で埋め込んだ nonce 付き
	// <script>（vendored mermaid.js 本体 + 初期化コード）だけに限定される。
	protected override get allowScripts(): boolean {
		return true;
	}

	// 画像は data: で埋め込むので、`vscode-resource` を解決する service worker は要らない。
	protected override disableServiceWorkerFor(_resource: URI): boolean {
		return true;
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

	protected override async renderDocument(text: string, resource: URI, _webview: IOverlayWebview, token: CancellationToken): Promise<string> {
		// フロントマターを素の Markdown として marked に渡すと、先頭の `---` が水平線、
		// 閉じの `---` が setext 見出し記法と解釈されて YAML 全体が巨大な見出しに化ける。
		// 事前に分離し、設定スタイルに応じた表示（非表示 / YAML コードブロック / テーブル）に置き換える。
		const frontMatter = applyParadisFrontMatter(text, this._getFrontMatterStyle(resource));

		const rendered = await renderMarkdownDocument(frontMatter.markdown, this._extensionService, this._languageService, {
			sanitizerConfig: {
				allowRelativeMediaPaths: true,
				allowRelativeLinkPaths: true,
			},
			markedExtensions: [markedMermaidExtension()],
		}, token);

		// サニタイズ済みの HTML を受け取ってから、ローカルの画像だけを data: に差し替える。
		// <base href> は置かない。置いても service worker が無ければ解決できず、その一方で
		// 文書内アンカー（#見出し）の解決先を歪めるだけになるため。
		const media = await inlineParadisMarkdownMedia(
			rendered,
			resource,
			this._workspaceContextService.getWorkspaceFolder(resource)?.uri,
			this._fileService,
			token);

		const nonce = generateUuid();
		const colorMap = TokenizationRegistry.getColorMap();
		const tokenCss = colorMap ? generateTokensCSSForColorMap(colorMap) : '';

		// mermaid ブロックを含む文書だけ vendored mermaid.js（約3.5MB）を読み込む。含まない文書で
		// 毎回読み込む無駄を避けるための条件分岐。
		const hasMermaid = containsParadisMermaidBlock(media.html);
		const mermaidScriptSource = hasMermaid ? await loadParadisMermaidScriptSource(this._fileService) : undefined;
		if (token.isCancellationRequested) {
			return '';
		}
		const mermaidEnabled = hasMermaid && mermaidScriptSource !== undefined;

		return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="${paradisMarkdownCspContent(nonce, mermaidEnabled)}">
		<style nonce="${nonce}">
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${PARADIS_INLINE_MEDIA_STYLES}
			${tokenCss}
			${this.getTransparencyBackgroundCssRule('body.paradis-markdown-body')}
			.paradis-mermaid.mermaid { display: flex; justify-content: center; background: none; }
		</style>
	</head>
	<body class="paradis-markdown-body">
		${frontMatter.htmlPrefix}${media.html}
		${mermaidEnabled ? this._renderMermaidScripts(nonce, mermaidScriptSource!) : ''}
	</body>
</html>`;
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
					mermaid.run({ querySelector: '.paradis-mermaid' });
				} catch (err) {
					console.error('[paradis] mermaid render failed', err);
				}
			})();
		</script>`;
	}
}
