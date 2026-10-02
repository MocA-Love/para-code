// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { paradisParseMobileBookmarks } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileBrowserProtocol.js';
import { bookmarkFavicon, bookmarkFolderIcon, bookmarkFolderView, bookmarkLabel, bookmarkNavigateUrl, isCurrentBookmark } from './browserBookmarks.js';

const bookmarks = paradisParseMobileBookmarks({
	t: 'bookmarks',
	nodes: [
		{ type: 'folder', id: 'f1', title: '仕事', icon: 'briefcase', color: '#2563eb', children: [
			{ type: 'folder', id: 'f2', title: '', icon: 'unknown', children: [{ type: 'bookmark', id: 'b3', title: 'Deep', url: 'https://example.com/deep' }] },
			{ type: 'bookmark', id: 'b2', title: '', url: 'https://example.com/issues/' },
		] },
		{ type: 'bookmark', id: 'b1', title: 'Docs', url: 'https://Example.com/docs#intro', favicon: 'h1' },
		{ type: 'bookmark', id: 'bad', title: 'no url' },
		{ type: 'bookmark', id: 'js', title: 'Script', url: 'javascript:alert(1)' },
	],
	favicons: { h1: 'data:image/png;base64,AAAA', h2: 'https://example.com/favicon.ico' },
})!;

describe('browser bookmarks', () => {
	test('PC の一覧を読み、壊れた項目と data URI でない favicon を落とす', () => {
		expect({
			ids: bookmarks.nodes.map(node => node.id),
			favicons: Object.keys(bookmarks.favicons),
			leading: bookmarks.nodes.map(node => bookmarkFavicon(node, bookmarks)),
			labels: bookmarks.nodes.map(bookmarkLabel),
		}).toEqual({
			ids: ['f1', 'b1', 'js'],
			favicons: ['h1'],
			leading: [undefined, 'data:image/png;base64,AAAA', undefined],
			labels: ['仕事', 'Docs', 'Script'],
		});
	});

	test('今のページと同じ URL の項目を見分け、http(s) 以外は開かない', () => {
		expect({
			current: [isCurrentBookmark('https://Example.com/docs#intro', 'https://example.com/docs/'), isCurrentBookmark('https://example.com/docs', 'https://example.com/other'), isCurrentBookmark('https://example.com', undefined)],
			navigate: ['https://example.com/a', ' http://localhost:3000 ', 'javascript:alert(1)', 'file:///etc/passwd'].map(bookmarkNavigateUrl),
		}).toEqual({
			current: [true, false, false],
			navigate: ['https://example.com/a', 'http://localhost:3000', undefined, undefined],
		});
	});

	test('フォルダをたどる（道が切れたらそこまで）。アイコンは PC の名前から選び、知らない名前はフォルダ', () => {
		const deep = bookmarkFolderView(bookmarks, ['f1', 'f2']);
		const broken = bookmarkFolderView(bookmarks, ['f1', 'missing']);
		expect({
			deep: { trail: deep.trail.map(folder => folder.id), nodes: deep.nodes.map(node => node.id) },
			broken: { trail: broken.trail.map(folder => folder.id), nodes: broken.nodes.map(node => node.id) },
			icons: deep.trail.map(bookmarkFolderIcon),
			labels: deep.trail.map(bookmarkLabel),
		}).toEqual({
			deep: { trail: ['f1', 'f2'], nodes: ['b3'] },
			broken: { trail: ['f1'], nodes: ['f2', 'b2'] },
			icons: ['briefcase', 'folder'],
			labels: ['仕事', 'フォルダ'],
		});
	});
});
