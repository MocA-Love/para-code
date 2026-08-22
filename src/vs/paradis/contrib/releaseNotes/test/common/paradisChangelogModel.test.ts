/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatInlineMarkdown, mergeChangelogs, parseParadisChangelog } from '../../common/paradisChangelogModel.js';

suite('Paradis Changelog Model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseParadisChangelog', () => {

		test('parses releases, sections and items in order', () => {
			const md = [
				'# Para Code 更新履歴',
				'',
				'導入文は無視される。',
				'',
				'## paracode-123（2026-08-22）',
				'',
				'### 改善',
				'',
				'- PDF と Word の表示が、開いた瞬間に出るようになりました',
				'- SSH 先の Markdown で、画像の表示が速くなりました',
				'',
				'### 修正',
				'',
				'- 常駐ターミナルの本数が0本と表示されていたのを直しました',
				'',
				'## paracode-122（2026-08-21）',
				'',
				'### 修正',
				'',
				'- Markdown プレビューが開けなくなっていた問題を修正しました',
			].join('\n');

			const releases = parseParadisChangelog(md);

			assert.strictEqual(releases.length, 2);
			assert.strictEqual(releases[0].version, 123);
			assert.strictEqual(releases[0].label, 'paracode-123');
			assert.strictEqual(releases[0].date, '2026-08-22');
			assert.deepStrictEqual(releases[0].sections.map(s => s.category), ['改善', '修正']);
			assert.strictEqual(releases[0].sections[0].items.length, 2);
			assert.strictEqual(releases[0].sections[1].items.length, 1);
			assert.strictEqual(releases[1].version, 122);
		});

		test('accepts ASCII parentheses and entries without a date', () => {
			const md = [
				'## paracode-9 (2026-01-02)',
				'',
				'### 改善',
				'',
				'- item a',
				'',
				'## paracode-8',
				'',
				'### 修正',
				'',
				'- item b',
			].join('\n');

			const releases = parseParadisChangelog(md);

			assert.strictEqual(releases.length, 2);
			assert.strictEqual(releases[0].date, '2026-01-02');
			assert.strictEqual(releases[1].date, undefined);
			assert.strictEqual(releases[1].version, 8);
		});

		test('ignores stray list items before any section heading', () => {
			const md = [
				'## paracode-5（2026-01-01）',
				'',
				'- 孤立した項目',
				'',
				'### 改善',
				'',
				'- 正しい項目',
			].join('\n');

			const releases = parseParadisChangelog(md);

			assert.strictEqual(releases.length, 1);
			assert.strictEqual(releases[0].sections.length, 1);
			assert.deepStrictEqual(releases[0].sections[0].items, ['正しい項目']);
		});

		test('returns an empty array for content without releases', () => {
			assert.deepStrictEqual(parseParadisChangelog('# タイトルだけ\n\n本文。'), []);
		});
	});

	suite('mergeChangelogs', () => {

		function release(version: number): any {
			return { version, label: `paracode-${version}`, date: '2026-08-22', sections: [] };
		}

		test('adds remote-only releases on top and prefers bundled text on duplicates', () => {
			const remote = [release(124), { ...release(123), date: 'remote-date' }, release(122)];
			const bundled = [{ ...release(123), date: 'bundled-date' }, release(122)];

			const merged = mergeChangelogs(remote, bundled);

			assert.deepStrictEqual(merged.map(r => r.version), [124, 123, 122]);
			assert.strictEqual(merged.find(r => r.version === 123)!.date, 'bundled-date');
		});

		test('keeps newest first ordering even if inputs are unordered', () => {
			const merged = mergeChangelogs([release(121), release(125)], [release(124), release(122)]);

			assert.deepStrictEqual(merged.map(r => r.version), [125, 124, 122, 121]);
		});

		test('returns bundled content when remote is unavailable', () => {
			const bundled = [release(123), release(122)];

			assert.deepStrictEqual(mergeChangelogs([], bundled).map(r => r.version), [123, 122]);
		});
	});

	suite('formatInlineMarkdown', () => {

		test('escapes raw HTML before applying inline markup', () => {
			assert.strictEqual(
				formatInlineMarkdown('<script>alert("x")</script>'),
				'&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
			);
		});

		test('converts code spans and bold text', () => {
			assert.strictEqual(
				formatInlineMarkdown('`fetch(\'./data.json\')` のような**実行中の読み込み**に対応'),
				'<code>fetch(\'./data.json\')</code> のような<strong>実行中の読み込み</strong>に対応'
			);
		});
	});
});
