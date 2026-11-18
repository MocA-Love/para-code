/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// プレビュー差分の片側の Markdown を、Markdown のビューアと同じ変換で描いて一番上のブロックに分ける。
// PC の差分エディタ（paradisMarkdownRenderedDiffView）と、スマホへ送る差分（mobileRelay の
// paradisMobileRenderedDiffRequests）の両方が使う。

import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ILanguageService } from '../../../../editor/common/languages/language.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { paradisMarkdownRenderedDiffItems } from '../common/paradisRenderedDiff.js';
import { markedParadisAlertExtension } from './paradisMarkdownAlerts.js';
import { renderParadisMarkdownDocumentDeferred } from './paradisMarkdownDocumentRenderer.js';
import { applyParadisFrontMatter } from './paradisMarkdownFrontMatter.js';
import { IParadisInlineMediaLimits, inlineParadisMarkdownMediaInBody, parseParadisMarkdownHtml, PARADIS_INLINE_MEDIA_LIMITS } from './paradisMarkdownInlineResources.js';
import { rewriteParadisMarkdownLinks } from './paradisMarkdownLinks.js';
import { markedMermaidExtension } from './paradisMarkdownMermaid.js';
import type { IParadisRenderedDiffSide } from './paradisRenderedDiffDom.js';

/** 片側の描画の結果。 */
export interface IParadisMarkdownRenderedDiffSide extends IParadisRenderedDiffSide {
	/** 描いた木に画像があったか（古い側の画像を今の作業ツリーから読んだことを知らせる）。 */
	readonly hasImages: boolean;
}

/** 描くのに使うサービス。 */
export interface IParadisMarkdownRenderedDiffServices {
	readonly extensionService: IExtensionService;
	readonly languageService: ILanguageService;
	readonly fileService: IFileService;
}

/**
 * 片側を Markdown のビューアと同じ変換で描き、一番上のブロックに分ける。ブロックの数が合わなければ `undefined`
 * （文書の生の HTML が包みを閉じた・増やした。どのブロックがどの描画か決められない）。
 *
 * `resource` は相対パスの画像とリンクを解決する元のファイル（ディスクの上のファイル）。
 */
export async function renderParadisMarkdownRenderedDiffSide(
	text: string,
	resource: URI,
	workspaceFolder: URI | undefined,
	blockClass: string,
	services: IParadisMarkdownRenderedDiffServices,
	token: CancellationToken,
	mediaLimits: IParadisInlineMediaLimits = PARADIS_INLINE_MEDIA_LIMITS,
): Promise<IParadisMarkdownRenderedDiffSide | undefined> {
	// front matter は YAML のコードのブロックとして 1 つのブロックで比べる。
	const frontMatter = applyParadisFrontMatter(text, 'codeBlock');
	const rendered = await renderParadisMarkdownDocumentDeferred(frontMatter.markdown, services.extensionService, services.languageService, {
		allowRelativeMediaPaths: true,
		allowRelativeLinkPaths: true,
		markedExtensions: [markedMermaidExtension(), markedParadisAlertExtension()],
		blockClass,
	}, token);
	const doc = parseParadisMarkdownHtml(rendered.html);
	rendered.insertHighlightedCode(doc.body);
	rewriteParadisMarkdownLinks(doc.body, resource, workspaceFolder);
	await inlineParadisMarkdownMediaInBody(doc.body, resource, workspaceFolder, services.fileService, token, mediaLimits);
	const blocks = Array.from(doc.body.children).filter((element): element is HTMLElement => element.classList.contains(blockClass));
	const items = paradisMarkdownRenderedDiffItems(rendered.tokens, rendered.tokens.links);
	if (blocks.length !== items.length) {
		return undefined;
	}
	return { blocks, items, hasImages: doc.body.innerHTML.includes('<img') };
}
