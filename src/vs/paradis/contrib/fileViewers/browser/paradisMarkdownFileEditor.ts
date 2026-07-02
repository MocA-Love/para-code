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

import { generateUuid } from '../../../../base/common/uuid.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { TokenizationRegistry } from '../../../../editor/common/languages.js';
import { generateTokensCSSForColorMap } from '../../../../editor/common/languages/supports/tokenization.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { DEFAULT_MARKDOWN_STYLES, renderMarkdownDocument } from '../../../../workbench/contrib/markdown/browser/markdownDocumentRenderer.js';
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
		@IEditorService editorService: IEditorService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super(PARADIS_MARKDOWN_EDITOR_ID, group, telemetryService, themeService, storageService, webviewService, textFileService, fileService, editorService);
	}

	protected override get allowScripts(): boolean {
		return false;
	}

	protected override async renderDocument(text: string, resource: URI, _webview: IWebviewElement): Promise<string> {
		const rendered = await renderMarkdownDocument(text, this._extensionService, this._languageService, {
			sanitizerConfig: {
				allowRelativeMediaPaths: true,
				allowRelativeLinkPaths: true,
			}
		});

		const nonce = generateUuid();
		const dir = dirname(resource);
		const remoteInfo = resource.scheme === Schemas.vscodeRemote ? { isRemote: true, authority: resource.authority } : undefined;
		const baseHref = asWebviewUri(dir, remoteInfo).toString(true);

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
			${tokenCss}
		</style>
	</head>
	<body class="paradis-markdown-body">
		${rendered}
	</body>
</html>`;
	}
}
