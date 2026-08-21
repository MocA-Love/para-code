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

	protected override get allowScripts(): boolean {
		return false;
	}

	// 画像は data: で埋め込むので、`vscode-resource` を解決する service worker は要らない。
	protected override get disableServiceWorker(): boolean {
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
			}
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

		return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${nonce}'; font-src https: data:;">
		<style nonce="${nonce}">
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${PARADIS_INLINE_MEDIA_STYLES}
			${tokenCss}
			${this.getTransparencyBackgroundCssRule('body.paradis-markdown-body')}
		</style>
	</head>
	<body class="paradis-markdown-body">
		${frontMatter.htmlPrefix}${media.html}
	</body>
</html>`;
	}
}
