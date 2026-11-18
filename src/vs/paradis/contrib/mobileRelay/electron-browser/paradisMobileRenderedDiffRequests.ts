/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分の画面の Markdown の「差分」（scm.rendered-diff.v1）。PC の差分エディタのプレビュー差分を 1 列の形で作り、
// HTML の文書にして返す（Excel・Word の差分と同じく、アプリは WebView に出すだけ）。
//
// scm の `renderedDiff` { ws, path, original: 'head' | 'index' | 'missing', modified: 'index' | 'worktree' | 'missing' }
// → `{ t: 'renderedDiff', html, changes }`。プレビュー差分にできない（大きい・突き合わせられない）ときは
// `{ error, fallback: 'raw' }`（アプリは Raw を勧める）。同じモバイルから次の要求が来たら前の描画は止め、前の要求には
// `{ error: 'superseded' }` を返す。対象は Markdown だけ（HTML は別の capability で足す）。

import { mainWindow } from '../../../../base/browser/window.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { readParadisFileHead } from '../../../../platform/files/common/paradisReadFileHead.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { isParadisRenderedDiffTooLarge, PARADIS_RENDERED_DIFF_LIMITS } from '../../fileViewers/common/paradisRenderedDiff.js';
import { IParadisMarkdownRenderedDiffServices, renderParadisMarkdownRenderedDiffSide } from '../../fileViewers/browser/paradisMarkdownRenderedDiffSide.js';
import { buildParadisRenderedDiff } from '../../fileViewers/browser/paradisRenderedDiffDom.js';
import { paradisMobileRelativeSegments, paradisResolveMobileFileAt, PARADIS_MOBILE_FILE_AT_LIMIT } from './paradisMobileFileAtRequests.js';
import { IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';
import { PARADIS_MOBILE_RENDERED_DIFF_HTML_MAX_BYTES, PARADIS_MOBILE_RENDERED_DIFF_MEDIA_LIMITS, renderParadisMobileRenderedDiffHtml } from './paradisMobileRenderedDiffHtml.js';
import { paradisParseMobileDiffModified, paradisParseMobileDiffOriginal } from './paradisMobileWordDiffRequests.js';

/** 置き換えられた要求に返すエラー（アプリはこれを表示せずに捨てる。Word の差分と同じ）。 */
const SUPERSEDED = 'superseded';

/** プレビュー差分にする拡張子（Markdown のビューアと同じ）。 */
export function isParadisMobileRenderedDiffPath(path: string): boolean {
	return /\.(?:md|markdown)$/i.test(path);
}

/** モバイル → 進めている描画と、その要求への返事。 */
const operations = new Map<string, { readonly cancellation: CancellationTokenSource; readonly reply: (body: object) => void }>();

type Side = 'head' | 'index' | 'worktree' | 'missing';

/**
 * その側の文字（その側に無ければ空）。作業ツリーで解決できない（スペースの外へ出る・読めない）パスは `invalid`、
 * 読む上限を超えるものは `tooLarge`。
 */
async function readSide(context: Pick<IParadisMobileRequestContext, 'root' | 'resolvePath' | 'runGit'>, remoteAgentService: IRemoteAgentService, fileService: IFileService, path: string, side: Side): Promise<{ readonly text: string } | 'invalid' | 'tooLarge'> {
	if (side === 'missing') {
		return { text: '' };
	}
	const uri = await paradisResolveMobileFileAt(context, remoteAgentService, path, side);
	if (uri === undefined) {
		return side === 'worktree' ? 'invalid' : { text: '' };
	}
	const content = await readParadisFileHead(fileService, uri, { length: PARADIS_MOBILE_FILE_AT_LIMIT + 1 });
	return content.value.byteLength > PARADIS_MOBILE_FILE_AT_LIMIT ? 'tooLarge' : { text: VSBuffer.wrap(content.value.buffer).toString() };
}

const tooLarge = () => localize('paradis.mobile.renderedDiff.tooLarge', "大きいのでプレビュー差分を出せません。Raw で確かめてください。");

/**
 * 両側を描いて 1 列のプレビュー差分の HTML を作る。プレビュー差分にできなければ理由の文言。
 * 相対パスの画像とリンクは、どちらの側も今の作業ツリーの同じファイルを元に解決する（PC の差分エディタと同じ）。
 * `modifiedOnDisk` は変更後が作業ツリーの版か（そうでなければ、変更後の画像にも断り書きを出す）。
 */
async function renderMarkdownDiff(root: URI, path: string, originalText: string, modifiedText: string, modifiedOnDisk: boolean, services: IParadisMarkdownRenderedDiffServices, token: CancellationToken): Promise<{ readonly html: string; readonly changes: number } | string> {
	if (isParadisRenderedDiffTooLarge({ length: originalText.length }, { length: modifiedText.length })) {
		return tooLarge();
	}
	const resource = joinPath(root, ...paradisMobileRelativeSegments(path)!);
	const blockClass = `paradis-rdiff-src-${generateUuid().replace(/-/g, '')}`;
	const [original, modified] = await Promise.all([
		renderParadisMarkdownRenderedDiffSide(originalText, resource, root, blockClass, services, token, PARADIS_MOBILE_RENDERED_DIFF_MEDIA_LIMITS),
		renderParadisMarkdownRenderedDiffSide(modifiedText, resource, root, blockClass, services, token, PARADIS_MOBILE_RENDERED_DIFF_MEDIA_LIMITS),
	]);
	if (!original || !modified) {
		return localize('paradis.mobile.renderedDiff.unsupported', "この文書はプレビュー差分で表示できません。Raw で確かめてください。");
	}
	if (original.blocks.length > PARADIS_RENDERED_DIFF_LIMITS.maxBlocks || modified.blocks.length > PARADIS_RENDERED_DIFF_LIMITS.maxBlocks) {
		return tooLarge();
	}
	const result = buildParadisRenderedDiff(mainWindow.document.implementation.createHTMLDocument(''), original, modified, 'unified', {
		original: localize('paradis.mobile.renderedDiff.originalCaption', "変更前"),
		modified: localize('paradis.mobile.renderedDiff.modifiedCaption', "変更後"),
		before: localize('paradis.mobile.renderedDiff.before', "変更前"),
		after: localize('paradis.mobile.renderedDiff.after', "変更後"),
	}, token);
	// 作業ツリーに無い版（HEAD・インデックス）の画像だけ、今の作業ツリーのもので代わりに出している
	const note = original.hasImages || (modified.hasImages && !modifiedOnDisk)
		? localize('paradis.mobile.renderedDiff.imagesFromWorkingTree', "画像は今の作業ツリーのものです")
		: undefined;
	replaceOutsideImages(result.root);
	const html = renderParadisMobileRenderedDiffHtml(result.root.outerHTML, note, generateUuid().replace(/-/g, ''));
	if (VSBuffer.fromString(html).byteLength > PARADIS_MOBILE_RENDERED_DIFF_HTML_MAX_BYTES) {
		return tooLarge();
	}
	return { html, changes: result.changes };
}

/**
 * 埋め込めなかった画像（外の URL・上限を超えた画像）を代わりの文字（alt）に置き換える。スマホの文書は CSP で
 * data: 以外を読まないので、残すと壊れた画像の印になる（アプリの Markdown の表示も外の画像は alt で出す）。
 */
export function replaceOutsideImages(root: HTMLElement): void {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
	const images: Element[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if ((node as Element).tagName === 'IMG') {
			images.push(node as Element);
		}
	}
	for (const image of images) {
		if (image.getAttribute('src')?.startsWith('data:')) {
			continue;
		}
		const alt = image.getAttribute('alt')?.trim();
		if (alt) {
			const text = root.ownerDocument.createElement('span');
			text.className = 'paradis-mobile-rdiff-ext-img';
			text.textContent = alt;
			image.replaceWith(text);
		} else {
			image.remove();
		}
	}
}

registerParadisMobileRequestHandler('scm', 'renderedDiff', {
	handle(accessor, request, context) {
		const fileService = accessor.get(IFileService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const services: IParadisMarkdownRenderedDiffServices = { fileService, extensionService: accessor.get(IExtensionService), languageService: accessor.get(ILanguageService) };
		const original = paradisParseMobileDiffOriginal(request.original);
		const modified = paradisParseMobileDiffModified(request.modified);
		if (typeof request.path !== 'string' || original === undefined || modified === undefined || (original === 'missing' && modified === 'missing')) {
			context.reply({ error: 'invalid renderedDiff request' });
			return;
		}
		const root = context.root;
		if (root === undefined) {
			context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
			return;
		}
		if (paradisMobileRelativeSegments(request.path) === undefined) {
			context.reply({ error: 'invalid path' });
			return;
		}
		if (!isParadisMobileRenderedDiffPath(request.path)) {
			context.reply({ error: 'unsupported file type' });
			return;
		}
		const key = context.mobileId ?? '';
		const previous = operations.get(key);
		if (previous !== undefined) {
			previous.reply({ error: SUPERSEDED });
			previous.cancellation.dispose(true);
		}
		const cancellation = new CancellationTokenSource();
		const operation = { cancellation, reply: (body: object) => context.reply(body) };
		operations.set(key, operation);
		const path = request.path;
		return (async () => {
			try {
				const [originalSide, modifiedSide] = await Promise.all([
					readSide(context, remoteAgentService, fileService, path, original),
					readSide(context, remoteAgentService, fileService, path, modified),
				]);
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				if (originalSide === 'invalid' || modifiedSide === 'invalid') {
					context.reply({ error: 'invalid path' });
					return;
				}
				if (originalSide === 'tooLarge' || modifiedSide === 'tooLarge') {
					context.reply({ error: tooLarge(), fallback: 'raw' });
					return;
				}
				const result = await renderMarkdownDiff(root, path, originalSide.text, modifiedSide.text, modified === 'worktree', services, cancellation.token);
				if (cancellation.token.isCancellationRequested) {
					return;
				}
				context.reply(typeof result === 'string' ? { error: result, fallback: 'raw' } : { t: 'renderedDiff', html: result.html, changes: result.changes });
			} catch {
				if (!cancellation.token.isCancellationRequested) {
					context.reply({ error: localize('paradis.mobile.renderedDiff.failed', "プレビュー差分を作れませんでした。Raw で確かめてください。"), fallback: 'raw' });
				}
			} finally {
				if (operations.get(key) === operation) {
					operations.delete(key);
					cancellation.dispose();
				}
			}
		})();
	},
});
