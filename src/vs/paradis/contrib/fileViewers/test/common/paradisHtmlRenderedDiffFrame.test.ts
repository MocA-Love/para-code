/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisHtmlRenderedDiffFrameDocument, paradisReadHtmlRenderedDiffMessage, PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY } from '../../common/paradisHtmlRenderedDiffFrame.js';

suite('paradisHtmlRenderedDiffFrame', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads only messages with the token and the expected shape', () => {
		const key = { type: 'keydown', key: 'p', code: 'KeyP', keyCode: 80, metaKey: true };
		deepStrictEqual([
			paradisReadHtmlRenderedDiffMessage({ token: 't', [PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY]: 'link', href: 'https://example.com/' }, 't'),
			paradisReadHtmlRenderedDiffMessage({ token: 'x', [PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY]: 'link', href: 'https://example.com/' }, 't'),
			paradisReadHtmlRenderedDiffMessage({ token: 't', [PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY]: 'key', event: key }, 't'),
			paradisReadHtmlRenderedDiffMessage({ token: 't', [PARADIS_HTML_RENDERED_DIFF_MESSAGE_KEY]: 'key', event: { ...key, type: 'click' } }, 't'),
		], [
			{ type: 'link', href: 'https://example.com/' },
			undefined,
			{ type: 'key', event: { type: 'keydown', key: 'p', code: 'KeyP', keyCode: 80, shiftKey: false, altKey: false, ctrlKey: false, metaKey: true, repeat: false } },
			undefined,
		]);
	});

	test('never lets the pages run scripts, and keeps a closing script tag in a page from ending the frame script', () => {
		const html = paradisHtmlRenderedDiffFrameDocument({
			originalHtml: '<p>a</p></script><script>alert(1)</script>',
			modifiedHtml: '<p>b</p>',
			labels: { original: 'Before', modified: 'After <b>' },
			token: 't',
			zoom: 1,
			fromHost: '(function(){return true;})',
			changeAttribute: 'data-c',
			anchorAttribute: 'data-a',
		});
		deepStrictEqual({
			sandbox: /"sandbox":"([^"]*)"/.exec(html)?.[1],
			scripts: html.match(/<script>/g)?.length,
			closing: html.match(/<\/script>/g)?.length,
			caption: html.includes('After &#60;b&#62;'),
		}, { sandbox: 'allow-same-origin allow-pointer-lock', scripts: 1, closing: 1, caption: true });
	});
});
