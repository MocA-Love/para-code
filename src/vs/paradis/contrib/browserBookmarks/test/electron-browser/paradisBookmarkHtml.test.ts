/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBookmark, IParadisBookmarkFolder } from '../../common/paradisBookmarkModel.js';
import {
	exportParadisBookmarksToHtml,
	importParadisBookmarksFromHtml,
} from '../../electron-browser/paradisBookmarkHtml.js';

suite('Paradis bookmark HTML', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exports nested folders, escaped text and attributes, timestamps, and favicons', () => {
		const nestedBookmark: IParadisBookmark = {
			id: 'bookmark',
			type: 'bookmark',
			url: 'https://example.com/?a=1&b="two"',
			title: 'A & <B> "quoted"',
			faviconHash: 'favicon',
			createdAt: 2_500,
		};
		const nestedFolder: IParadisBookmarkFolder = {
			id: 'folder',
			type: 'folder',
			title: 'Folder & <Group>',
			children: [nestedBookmark],
			createdAt: 1_500,
		};

		const html = exportParadisBookmarksToHtml(
			[nestedFolder],
			hash => hash === 'favicon' ? 'data:image/svg+xml,<svg title="x">&</svg>' : undefined,
		);

		assert.strictEqual(html, [
			'<!DOCTYPE NETSCAPE-Bookmark-file-1>',
			'<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
			'<TITLE>Bookmarks</TITLE>',
			'<H1>Bookmarks</H1>',
			'<DL><p>',
			'    <DT><H3 ADD_DATE="1">Folder &amp; &lt;Group&gt;</H3>',
			'    <DL><p>',
			'        <DT><A HREF="https://example.com/?a=1&amp;b=&quot;two&quot;" ADD_DATE="2" ICON="data:image/svg+xml,&lt;svg title=&quot;x&quot;&gt;&amp;&lt;/svg&gt;">A &amp; &lt;B&gt; &quot;quoted&quot;</A>',
			'    </DL><p>',
			'',
			'</DL><p>',
			'',
		].join('\n'));
	});

	test('imports nested folders with decoded entities, normalized URLs, timestamps, and data favicons', () => {
		const html = [
			'<!DOCTYPE NETSCAPE-Bookmark-file-1>',
			'<DL><p>',
			'<DT><H3 ADD_DATE="10">Outer &amp; More</H3>',
			'<DL><p>',
			'<DT><A HREF="https://example.com/" ADD_DATE="11" ICON="data:image/png;base64,AAAA">Example &lt;Home&gt;</A>',
			'<DT><H3 ADD_DATE="12">Inner</H3>',
			'<DL><p>',
			'<DT><A HREF="https://nested.example/path?q=1&amp;x=2" ADD_DATE="13">Nested</A>',
			'</DL><p>',
			'</DL><p>',
			'</DL><p>',
		].join('\n');

		assert.deepStrictEqual(importParadisBookmarksFromHtml(html), [
			{
				type: 'folder',
				title: 'Outer & More',
				createdAt: 10_000,
				children: [
					{
						type: 'bookmark',
						url: 'https://example.com',
						title: 'Example <Home>',
						faviconDataUri: 'data:image/png;base64,AAAA',
						createdAt: 11_000,
					},
					{
						type: 'folder',
						title: 'Inner',
						createdAt: 12_000,
						children: [
							{
								type: 'bookmark',
								url: 'https://nested.example/path?q=1&x=2',
								title: 'Nested',
								faviconDataUri: undefined,
								createdAt: 13_000,
							},
						],
					},
				],
			},
		]);
	});

	test('drops invalid entries and ignores unsafe non-data favicon values', () => {
		const html = [
			'<A HREF="https://outside.example" ADD_DATE="1">Outside root list</A>',
			'<DL><p>',
			'<DT><A ADD_DATE="2">Missing href</A>',
			'<DT><A HREF="about:blank" ADD_DATE="3">Blank</A>',
			'<DT><A HREF="https://valid.example/" ADD_DATE="4" ICON="https://icons.example/icon.png"></A>',
			'<DT><A HREF="https://unclosed.example" ADD_DATE="5">Unclosed',
			'</DL><p>',
		].join('\n');

		assert.deepStrictEqual(importParadisBookmarksFromHtml(html), [
			{
				type: 'bookmark',
				url: 'https://valid.example',
				title: 'https://valid.example',
				faviconDataUri: undefined,
				createdAt: 4_000,
			},
		]);
	});
});
