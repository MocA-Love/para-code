/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPreviewLinkToFile } from '../../common/paradisHtmlPreview.js';

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
});
