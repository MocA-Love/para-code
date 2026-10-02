// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { buildFileDecorationIndex, EMPTY_DECORATIONS, fileDecorationOf } from './fileDecorations.js';

const index = buildFileDecorationIndex([
	{ x: ' ', y: 'M', path: 'src/app/main.ts' },
	{ x: 'A', y: ' ', path: 'src/app/new.ts' },
	{ x: ' ', y: 'D', path: 'src/old/gone.ts' },
	{ x: 'U', y: 'U', path: 'src/conflict.ts' },
	{ x: 'R', y: ' ', path: 'lib/renamed.ts', oldPath: 'lib/before.ts' },
	{ x: '?', y: '?', path: 'docs/' },
	{ x: '?', y: '?', path: 'notes.txt' },
	// 古い PC は引用したまま送る
	{ x: '?', y: '?', path: '"a b.txt"' },
	{ x: ' ', y: 'M', path: '"\\346\\227\\245\\346\\234\\254/\\350\\250\\255\\350\\250\\210.md"' },
	{ x: ' ', y: 'M', path: '資料/メモ 1.md' },
]);

const view = (path: string, dir: boolean, ignored?: boolean) => {
	const found = fileDecorationOf(index, { path, dir, ignored });
	return found === undefined ? undefined : [found.kind, found.badge, found.color];
};

describe('fileDecorationOf', () => {
	it('ファイルは状態の色と文字、フォルダは配下で最も強い状態の色と点', () => {
		expect({
			modified: view('src/app/main.ts', false),
			added: view('src/app/new.ts', false),
			renamed: view('lib/renamed.ts', false),
			untrackedFile: view('notes.txt', false),
			conflict: view('src/conflict.ts', false),
			// 競合 > 削除 > 変更 > 追加
			src: view('src', true),
			app: view('src/app', true),
			// 削除は一覧に出ないので、フォルダの点だけで伝わる
			old: view('src/old', true),
			clean: view('README.md', false),
		}).toEqual({
			modified: ['modified', 'M', '#E2C08D'],
			added: ['added', 'A', '#81b88b'],
			renamed: ['renamed', 'R', '#73C991'],
			untrackedFile: ['untracked', 'U', '#73C991'],
			conflict: ['conflict', '!', '#e4676b'],
			src: ['conflict', '•', '#e4676b'],
			app: ['modified', '•', '#E2C08D'],
			old: ['deleted', '•', '#c74e39'],
			clean: undefined,
		});
	});

	it('日本語・空白のパスにも色が付く（引用されて届いても）', () => {
		expect({
			spaced: view('a b.txt', false),
			quotedJapanese: view('日本/設計.md', false),
			quotedFolder: view('日本', true),
			plainJapanese: view('資料/メモ 1.md', false),
		}).toEqual({
			spaced: ['untracked', 'U', '#73C991'],
			quotedJapanese: ['modified', 'M', '#E2C08D'],
			quotedFolder: ['modified', '•', '#E2C08D'],
			plainJapanese: ['modified', 'M', '#E2C08D'],
		});
	});

	it('外し済みの印がある応答のパスは外し直さない', () => {
		const unquoted = buildFileDecorationIndex([{ x: '?', y: '?', path: '"quoted".txt' }, { x: '?', y: '?', path: '"x"' }], true);
		expect([fileDecorationOf(unquoted, { path: '"quoted".txt', dir: false })?.kind, fileDecorationOf(unquoted, { path: '"x"', dir: false })?.kind, fileDecorationOf(unquoted, { path: 'x', dir: false })]).toEqual(['untracked', 'untracked', undefined]);
	});

	it('未追跡のフォルダは配下も全部未追跡、無視は文字なしで灰', () => {
		expect({
			docs: view('docs', true),
			inside: view('docs/guide/a.md', false),
			insideDir: view('docs/guide', true),
			ignored: view('node_modules', true, true),
			// 状態がある行は無視の印より状態を優先する
			trackedIgnored: view('src/app/main.ts', false, true),
			empty: fileDecorationOf(EMPTY_DECORATIONS, { path: 'a', dir: false }),
		}).toEqual({
			docs: ['untracked', '•', '#73C991'],
			inside: ['untracked', 'U', '#73C991'],
			insideDir: ['untracked', '•', '#73C991'],
			ignored: ['ignored', undefined, '#8C8C8C'],
			trackedIgnored: ['modified', 'M', '#E2C08D'],
			empty: undefined,
		});
	});
});
