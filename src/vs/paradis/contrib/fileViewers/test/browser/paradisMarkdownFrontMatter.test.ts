/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual, ok } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyParadisFrontMatter, extractParadisFrontMatter } from '../../browser/paradisMarkdownFrontMatter.js';

suite('paradisMarkdownFrontMatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DOC = '---\nname: my-skill\ndescription: "a \\"quoted\\" description"\n---\n\n# Title\n\nbody';

	suite('extractParadisFrontMatter', () => {

		test('splits frontmatter and body', () => {
			deepStrictEqual(extractParadisFrontMatter(DOC), {
				content: 'name: my-skill\ndescription: "a \\"quoted\\" description"',
				body: '\n# Title\n\nbody',
			});
		});

		test('handles BOM, CRLF and trailing whitespace on delimiters', () => {
			deepStrictEqual(extractParadisFrontMatter('﻿--- \r\ntitle: x\r\n---\t\r\nbody'), {
				content: 'title: x\r',
				body: 'body',
			});
		});

		test('is not frontmatter when delimiter is missing, indented or not at start', () => {
			strictEqual(extractParadisFrontMatter('# Title\n\n---\nkey: value\n---'), undefined);
			strictEqual(extractParadisFrontMatter('---\nkey: value'), undefined);
			strictEqual(extractParadisFrontMatter(' ---\nkey: value\n---'), undefined);
			strictEqual(extractParadisFrontMatter('---\nkey: value\n ---'), undefined);
		});
	});

	suite('applyParadisFrontMatter', () => {

		test('hide drops the frontmatter entirely', () => {
			deepStrictEqual(applyParadisFrontMatter(DOC, 'hide'), {
				markdown: '\n# Title\n\nbody',
				htmlPrefix: '',
			});
		});

		test('codeBlock turns the frontmatter into a yaml fence', () => {
			deepStrictEqual(applyParadisFrontMatter('---\nname: x\n---\nbody', 'codeBlock'), {
				markdown: '```yaml\nname: x\n```\n\nbody',
				htmlPrefix: '',
			});
		});

		test('codeBlock uses a longer fence when the content contains backticks', () => {
			const result = applyParadisFrontMatter('---\ncmd: ```echo```\n---\nbody', 'codeBlock');
			ok(result.markdown.startsWith('````yaml\n'), result.markdown);
		});

		test('table renders scalar entries with quotes stripped and html escaped', () => {
			deepStrictEqual(applyParadisFrontMatter(DOC, 'table'), {
				markdown: '\n# Title\n\nbody',
				htmlPrefix: '<table class="frontmatter"><tbody>'
					+ '<tr><th>name</th><td>my-skill</td></tr>'
					+ '<tr><th>description</th><td>a "quoted" description</td></tr>'
					+ '</tbody></table>\n',
			});
		});

		test('table escapes html in keys and values', () => {
			const result = applyParadisFrontMatter('---\ntitle: <img src=x onerror=alert(1)>\n---\nbody', 'table');
			ok(!result.htmlPrefix.includes('<img'), result.htmlPrefix);
			ok(result.htmlPrefix.includes('&lt;img'), result.htmlPrefix);
		});

		test('table renders lists, nested mappings, block scalars, comments and blank lines', () => {
			const doc = [
				'---',
				'# a comment',
				'tags:',
				'  - one',
				'  - two',
				'',
				'metadata:',
				'  type: user',
				'notes: |',
				'  line1',
				'  line2',
				'---',
				'body',
			].join('\n');
			deepStrictEqual(applyParadisFrontMatter(doc, 'table').htmlPrefix,
				'<table class="frontmatter"><tbody>'
				+ '<tr><th>tags</th><td><ul><li>one</li><li>two</li></ul></td></tr>'
				+ '<tr><th>metadata</th><td><code>type: user</code></td></tr>'
				+ '<tr><th>notes</th><td>line1\nline2</td></tr>'
				+ '</tbody></table>\n');
		});

		test('table renders empty frontmatter as nothing', () => {
			deepStrictEqual(applyParadisFrontMatter('---\n---\nbody', 'table'), {
				markdown: 'body',
				htmlPrefix: '',
			});
		});

		test('table falls back to codeBlock for structures the subset parser rejects', () => {
			const result = applyParadisFrontMatter('---\njust some text without a colon\n---\nbody', 'table');
			strictEqual(result.htmlPrefix, '');
			ok(result.markdown.startsWith('```yaml\n'), result.markdown);
		});

		test('document without frontmatter passes through unchanged', () => {
			deepStrictEqual(applyParadisFrontMatter('# Title\nbody', 'table'), {
				markdown: '# Title\nbody',
				htmlPrefix: '',
			});
		});
	});
});
