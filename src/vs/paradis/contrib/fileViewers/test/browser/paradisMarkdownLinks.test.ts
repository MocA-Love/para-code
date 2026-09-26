/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMarkdownLinkToOpen, rewriteParadisMarkdownLinks } from '../../browser/paradisMarkdownLinks.js';

suite('paradisMarkdownLinks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DOC = URI.from({ scheme: Schemas.file, path: '/repo/docs/readme.md' });
	const FOLDER = URI.from({ scheme: Schemas.file, path: '/repo' });

	test('rewrites relative links to absolute URIs and leaves anchors and external links alone', () => {
		const doc = new DOMParser().parseFromString([
			'<a href="#intro">a</a>',
			'<a href="https://example.com/x?y=1#z">b</a>',
			'<a href="guide.md">c</a>',
			'<a href="../CHANGELOG.md#v1-0">d</a>',
			'<a href="/src/main.ts#L10">e</a>',
			'<a href="my%20notes.md">f</a>',
			'<p><a href="./sub/">g</a></p>',
		].join(''), 'text/html');

		const rewritten = rewriteParadisMarkdownLinks(doc.body, DOC, FOLDER);
		const hrefs: string[] = [];
		for (const anchor of doc.body.getElementsByTagName('a')) {
			hrefs.push(anchor.getAttribute('href') ?? '');
		}

		assert.deepStrictEqual({ rewritten, hrefs }, {
			rewritten: 5,
			hrefs: [
				'#intro',
				'https://example.com/x?y=1#z',
				'file:///repo/docs/guide.md',
				'file:///repo/CHANGELOG.md#v1-0',
				'file:///repo/src/main.ts#L10',
				'file:///repo/docs/my%20notes.md',
				'file:///repo/docs/sub',
			],
		});
	});

	test('decides which clicked links to open and drops heading fragments of files', () => {
		const open = (link: string) => paradisMarkdownLinkToOpen(link)?.toString();
		assert.deepStrictEqual([
			open('https://example.com/a#b'),
			open('file:///repo/CHANGELOG.md#v1-0'),
			open('file:///repo/src/main.ts#L10'),
			open('vscode-webview://abc/fake.html'),
			open('command:workbench.action.openSettings'),
		], [
			'https://example.com/a#b',
			'file:///repo/CHANGELOG.md',
			'file:///repo/src/main.ts#L10',
			undefined,
			undefined,
		]);
	});
});
