// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { ancestorPaths, baseName, dirState, flattenTree, formatSize, joinPath, needsLoad, parentPath, type DirCache } from './fileTree.js';
import { buildCodeHtml, codeLines, defaultViewerMode, filesTarget, parseFocusLine, resolveUnknownTarget, viewerBreadcrumb, viewerFetchOf, viewerKindOf } from './fileViewerModel.js';

const cache: DirCache = {
	'': { entries: [{ name: 'src', dir: true }, { name: 'docs', dir: true }, { name: 'README.md', dir: false, size: 3400 }] },
	src: { entries: [{ name: 'auth', dir: true }, { name: 'index.ts', dir: false, size: 12 }] },
	'src/auth': { loading: true },
	docs: { entries: [], error: '読み込めませんでした' },
};

describe('flattenTree', () => {
	it('開いているフォルダだけをたどり、深さを付ける', () => {
		expect(flattenTree(cache, new Set(['src'])).map(row => [row.kind, row.path, row.depth])).toEqual([
			['dir', 'src', 0],
			['dir', 'src/auth', 1],
			['file', 'src/index.ts', 1],
			['dir', 'docs', 0],
			['file', 'README.md', 0],
		]);
	});

	it('開いたフォルダが読み込み中・失敗なら、その下に状態の行を1つ置く', () => {
		const rows = flattenTree(cache, new Set(['src', 'src/auth', 'docs', 'missing']));
		expect(rows.filter(row => row.kind === 'loading' || row.kind === 'error').map(row => [row.kind, row.path, row.depth])).toEqual([
			['loading', 'src/auth', 2],
			['error', 'docs', 1],
		]);
	});

	it('継承されたキーを読み込み済みのフォルダと取り違えない', () => {
		expect(dirState({}, 'constructor')).toBeUndefined();
		expect(needsLoad({}, 'constructor')).toBe(true);
	});
});

describe('needsLoad', () => {
	it('未読み込み・失敗なら読みに行き、読み込み中・読み込み済みなら行かない', () => {
		expect(needsLoad(cache, 'lib')).toBe(true);
		expect(needsLoad(cache, 'docs')).toBe(true);
		expect(needsLoad(cache, 'src/auth')).toBe(false);
		expect(needsLoad(cache, 'src')).toBe(false);
	});
});

describe('パスの操作', () => {
	it('つなぐ・親・名前・祖先', () => {
		expect(joinPath('', 'a')).toBe('a');
		expect(joinPath('a', 'b')).toBe('a/b');
		expect(parentPath('a/b/c.ts')).toBe('a/b');
		expect(parentPath('c.ts')).toBe('');
		expect(baseName('a/b/c.ts')).toBe('c.ts');
		expect(ancestorPaths('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
		expect(ancestorPaths('')).toEqual([]);
	});

	it('大きさを読みやすくする', () => {
		expect(formatSize(512)).toBe('512 B');
		expect(formatSize(3400)).toBe('3.3 KB');
		expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
	});
});

describe('filesTarget', () => {
	it('path が無ければ根のツリー', () => {
		expect(filesTarget(undefined, undefined)).toEqual({ kind: 'tree', reveal: undefined });
		expect(filesTarget('/', undefined)).toEqual({ kind: 'tree', reveal: undefined });
	});

	it('印があればそのとおり、無ければ親を読むまで分からない', () => {
		expect(filesTarget('src/a.ts', 'file')).toEqual({ kind: 'file', path: 'src/a.ts' });
		expect(filesTarget('src/', 'dir')).toEqual({ kind: 'tree', reveal: 'src' });
		expect(filesTarget('src/a.ts', undefined)).toEqual({ kind: 'unknown', path: 'src/a.ts' });
	});

	it('一致行は正の整数だけを受け付ける', () => {
		expect(parseFocusLine('12')).toBe(12);
		expect(parseFocusLine('0')).toBeUndefined();
		expect(parseFocusLine('1e3')).toBeUndefined();
		expect(parseFocusLine(undefined)).toBeUndefined();
	});

	it('親の一覧でフォルダかファイルかを決め、見つからなければファイルとして開く', () => {
		const entries = [{ name: 'auth', dir: true }, { name: 'a.ts', dir: false }];
		expect(resolveUnknownTarget('src/auth', entries)).toEqual({ kind: 'tree', reveal: 'src/auth' });
		expect(resolveUnknownTarget('src/a.ts', entries)).toEqual({ kind: 'file', path: 'src/a.ts' });
		expect(resolveUnknownTarget('src/gone.ts', entries)).toEqual({ kind: 'file', path: 'src/gone.ts' });
	});
});

describe('viewerKindOf / 表示の既定', () => {
	it('拡張子で種類と取り方を決める', () => {
		expect(viewerKindOf('a/book.xlsx')).toBe('spreadsheet');
		expect(viewerKindOf('spec.docx')).toBe('docx');
		expect(viewerKindOf('a.pdf')).toBe('pdf');
		expect(viewerKindOf('logo.PNG')).toBe('image');
		expect(viewerKindOf('clip.mov')).toBe('av');
		expect(viewerKindOf('README.md')).toBe('markdown');
		expect(viewerKindOf('index.html')).toBe('html');
		expect(viewerKindOf('a.ts')).toBe('other');
		expect(viewerFetchOf('image')).toBe('media');
		expect(viewerFetchOf('markdown')).toBe('text');
	});

	it('文書はプレビュー、コードと検索の一致行から開いたときはソース', () => {
		expect(defaultViewerMode('markdown', undefined)).toBe('render');
		expect(defaultViewerMode('markdown', 12)).toBe('code');
		expect(defaultViewerMode('other', undefined)).toBe('code');
	});

	it('パンくずはスペース名から含むフォルダまで、どれも押せる', () => {
		expect(viewerBreadcrumb('para-code', 'src/auth/a.ts').map(item => [item.label, item.target, item.current])).toEqual([
			['para-code', '', false],
			['src', 'src', false],
			['auth', 'src/auth', false],
		]);
		expect(viewerBreadcrumb('para-code', 'README.md').map(item => item.label)).toEqual(['para-code']);
	});
});

describe('codeLines / buildCodeHtml', () => {
	it('PC のハイライトを <br> で行に分ける', () => {
		const html = '<div class="monaco-tokenized-source"><span class="mtk1">a</span><br/><span class="mtk2">b</span><br/></div>';
		expect(codeLines({ content: 'a\nb\n', html })).toEqual(['<span class="mtk1">a</span>', '<span class="mtk2">b</span>']);
	});

	it('ハイライトが無ければ本文をエスケープして使う', () => {
		expect(codeLines({ content: 'if (a < b) {\r\n}\n', html: undefined })).toEqual(['if (a &lt; b) {', '}']);
		expect(codeLines({ content: '', html: undefined })).toEqual(['']);
	});

	it('行番号を付け、一致行にだけ印とスクロールを付ける', () => {
		const result = { content: 'a\nb', truncated: false, size: 3 };
		const plain = buildCodeHtml(result);
		expect(plain).toContain('<i>1</i>');
		expect(plain).toContain('<i>2</i>');
		expect(plain).not.toContain('<script>');
		const focused = buildCodeHtml(result, 2);
		expect(focused).toContain('<div class="l f"><i>2</i>');
		expect(focused).toContain('<script>');
	});
});
