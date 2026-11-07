/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPreviewLinkTarget, paradisPreviewLinkToFile } from '../../common/paradisHtmlPreview.js';

suite('paradisPreviewLinkToFile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns a link inside the served folder back into the file, and leaves other links to the caller', () => {
		const base = { url: 'http://127.0.0.1:5000/token/', root: URI.file('/work/site') };
		const open = (link: string) => paradisPreviewLinkToFile(link, base)?.toString();
		assert.deepStrictEqual({
			page: open('http://127.0.0.1:5000/token/docs/other%20page.html#top'),
			external: open('https://example.com/'),
			outside: open('http://127.0.0.1:5000/token/../secret'),
			folder: open('http://127.0.0.1:5000/token/'),
		}, {
			page: URI.file('/work/site/docs/other page.html').toString(),
			external: undefined,
			outside: undefined,
			folder: undefined,
		});
	});

	test('opens only http(s) and mailto outside the folder, and never hands a preview server URL to the browser', () => {
		const base = { url: 'http://127.0.0.1:5000/0123456789abcdef0123456789abcdef/', root: URI.file('/work/site') };
		const kind = (link: string) => paradisPreviewLinkTarget(link, base)?.kind;
		assert.deepStrictEqual({
			inside: kind('http://127.0.0.1:5000/0123456789abcdef0123456789abcdef/a.html'),
			https: kind('https://example.com/'),
			mailto: kind('mailto:someone@example.com'),
			file: kind('file:///etc/passwd'),
			sameServerOutside: kind('http://127.0.0.1:5000/other'),
			otherPreview: kind('http://localhost:6000/fedcba9876543210fedcba9876543210/x.html'),
			devServer: kind('http://localhost:3000/'),
		}, {
			inside: 'file',
			https: 'external',
			mailto: 'external',
			file: undefined,
			sameServerOutside: undefined,
			otherPreview: undefined,
			devServer: 'external',
		});
	});
});
