/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown レンダリングビューア（読み取り専用）。VS Code 標準の renderMarkdownDocument
// （extensions/markdown-language-features と同じ marked ベースのレンダラ + シンタックスハイライト）
// と標準プレビュー CSS（DEFAULT_MARKDOWN_STYLES）を流用し、webview に表示する。
// 相対パスの画像は <base href> と localResourceRoots で解決する。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { escape } from '../../../../base/common/strings.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { dirname } from '../../../../base/common/resources.js';
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
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IOverlayWebview, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { DEFAULT_MARKDOWN_STYLES, renderMarkdownDocument } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
import { applyParadisFrontMatter, PARADIS_FRONTMATTER_STYLES, ParadisFrontMatterStyle } from './paradisMarkdownFrontMatter.js';
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
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super(PARADIS_MARKDOWN_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, textModelService, instantiationService, layoutService, configurationService);
	}

	protected override get allowScripts(): boolean {
		return false;
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

		const nonce = generateUuid();
		const dir = dirname(resource);
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		// skipEncoding=true は `"` 等をそのまま残すため、属性値に埋める前に HTML エスケープする
		// (" を含むディレクトリ名で <base href> 属性を突き破る任意マークアップ注入を防ぐ)。
		const baseHref = escape(asWebviewUri(dir, remoteInfo).toString(true)).replace(/"/g, '&quot;');

		const colorMap = TokenizationRegistry.getColorMap();
		const tokenCss = colorMap ? generateTokensCSSForColorMap(colorMap) : '';

		return `<!DOCTYPE html>
<html>
	<head>
		<base href="${baseHref}/">
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https: data:; style-src 'nonce-${nonce}'; font-src https: data:;">
		<style nonce="${nonce}">
			${DEFAULT_MARKDOWN_STYLES}
			${PARADIS_FRONTMATTER_STYLES}
			${tokenCss}
			${this.getTransparencyBackgroundCssRule('body.paradis-markdown-body')}
		</style>
	</head>
	<body class="paradis-markdown-body">
		${frontMatter.htmlPrefix}${rendered}
	</body>
</html>`;
	}
}
