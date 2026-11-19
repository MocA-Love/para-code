/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual, throws } from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import * as marked from '../../../../../base/common/marked/marked.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { alignParadisRenderedItems, diffParadisRenderedText, IParadisRenderedDiffItem, IParadisRenderedDiffRow, IParadisRenderedTextSegment, isParadisRenderedDiffTooLarge, paradisMarkdownRenderedDiffItems, PARADIS_RENDERED_DIFF_LIMITS } from '../../common/paradisRenderedDiff.js';

function items(...values: readonly string[]): IParadisRenderedDiffItem[] {
	return values.map(value => {
		const [kind, key] = value.split(':');
		return { kind, key };
	});
}

/** 行を `=0/0`・`~1/2`・`-3`・`+4` の短い形にする。 */
function show(rows: readonly IParadisRenderedDiffRow[]): string[] {
	return rows.map(row => {
		switch (row.kind) {
			case 'equal': return `=${row.original}/${row.modified}`;
			case 'changed': return `~${row.original}/${row.modified}`;
			case 'removed': return `-${row.original}`;
			case 'added': return `+${row.modified}`;
		}
	});
}

/** 区間を `=…`・`-…`・`+…` の短い形にする。 */
function showText(segments: readonly IParadisRenderedTextSegment[]): string[] {
	return segments.map(segment => `${segment.kind === 'equal' ? '=' : segment.kind === 'removed' ? '-' : '+'}${segment.text}`);
}

/** 区間から両側の文字列を組み立て直す（位置が元の文字列と合っているかを見る）。 */
function rebuild(original: string, modified: string, segments: readonly IParadisRenderedTextSegment[]): void {
	let o = '';
	let m = '';
	for (const segment of segments) {
		if (segment.kind !== 'added') {
			strictEqual(original.slice(segment.originalStart, segment.originalStart + segment.originalLength), segment.text);
			o += segment.text;
		}
		if (segment.kind !== 'removed') {
			strictEqual(modified.slice(segment.modifiedStart, segment.modifiedStart + segment.modifiedLength), segment.text);
			m += segment.text;
		}
	}
	deepStrictEqual([o, m], [original, modified]);
}

suite('paradisRenderedDiff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('alignParadisRenderedItems', () => {
		test('an insertion in the middle does not turn the following blocks into changes', () => {
			const original = items('heading:Title', 'paragraph:one', 'paragraph:two', 'paragraph:three');
			const modified = items('heading:Title', 'paragraph:one', 'code:new', 'paragraph:two', 'paragraph:three');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['=0/0', '=1/1', '+2', '=2/3', '=3/4']);
		});

		test('a rewritten block of the same kind becomes a change, deletions and additions around it stay apart', () => {
			const original = items('heading:Title', 'paragraph:The quick brown fox jumps', 'table:| a |', 'paragraph:end');
			const modified = items('heading:Title', 'list:- new item', 'paragraph:The quick brown cat jumps', 'paragraph:end');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['=0/0', '+1', '~1/2', '-2', '=3/3']);
		});

		test('blocks of different kinds are never paired, even with the same text', () => {
			const original = items('heading:Install the tool', 'paragraph:x');
			const modified = items('paragraph:Install the tool', 'paragraph:x');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['-0', '+0', '=1/1']);
		});

		test('a single block on each side is paired when the kinds match, however different the text is', () => {
			deepStrictEqual(show(alignParadisRenderedItems(items('paragraph:aaaa'), items('paragraph:zzzz'))), ['~0/0']);
		});

		test('dissimilar blocks in a larger gap are not paired', () => {
			const original = items('paragraph:alpha beta gamma', 'paragraph:totally unrelated words');
			const modified = items('paragraph:alpha beta gamma delta', 'paragraph:0123456789');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['~0/0', '-1', '+1']);
		});

		test('repeated identical blocks (rules, empty items) keep their order', () => {
			const original = items('hr:---', 'paragraph:a', 'hr:---', 'paragraph:b', 'hr:---');
			const modified = items('hr:---', 'paragraph:a', 'hr:---', 'hr:---', 'paragraph:b', 'hr:---');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['=0/0', '=1/1', '=2/2', '+3', '=3/4', '=4/5']);
		});

		test('uses the rendered text for similarity when given', () => {
			// 記法（リンクの書き方）が違っても、描いた文字が同じなら近いとみなす
			const original: IParadisRenderedDiffItem[] = [{ kind: 'paragraph', key: 'See [docs](a.md) for details', text: 'See docs for details' }, { kind: 'paragraph', key: 'x', text: 'x' }];
			const modified: IParadisRenderedDiffItem[] = [{ kind: 'paragraph', key: 'See <https://example.com/docs> for details', text: 'See docs for details' }, { kind: 'paragraph', key: 'y', text: 'y' }];
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['~0/0', '-1', '+1']);
		});

		test('a gap larger than the candidate limit falls back to deletions and additions', () => {
			const original = items('paragraph:one two three', 'paragraph:four five six');
			const modified = items('paragraph:one two three!', 'paragraph:four five six!');
			deepStrictEqual(show(alignParadisRenderedItems(original, modified)), ['~0/0', '~1/1']);
			deepStrictEqual(show(alignParadisRenderedItems(original, modified, { maxCandidatePairs: 3 })), ['-0', '-1', '+0', '+1']);
		});

		test('table rows and cells align with the same function', () => {
			// 表の行（セルを区切りでつないだ鍵）を突き合わせ、変わった行はセルどうしを突き合わせる
			const row = (...cells: string[]) => ({ kind: 'row', key: cells.join('\u001f') });
			const rows = alignParadisRenderedItems([row('a', '1'), row('b', '2'), row('c', '3')], [row('a', '1'), row('b', '20'), row('c', '3'), row('d', '4')]);
			deepStrictEqual(show(rows), ['=0/0', '~1/1', '=2/2', '+3']);
			const cell = (key: string) => ({ kind: 'cell', key });
			deepStrictEqual(show(alignParadisRenderedItems([cell('b'), cell('2')], [cell('b'), cell('20')])), ['=0/0', '~1/1']);
		});

		test('empty sides', () => {
			deepStrictEqual(show(alignParadisRenderedItems([], items('paragraph:a', 'hr:---'))), ['+0', '+1']);
			deepStrictEqual(show(alignParadisRenderedItems(items('paragraph:a'), [])), ['-0']);
			deepStrictEqual(show(alignParadisRenderedItems([], [])), []);
		});

		test('cancellation throws', () => {
			const source = new CancellationTokenSource();
			source.cancel();
			const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'paragraph', key: `p${i}` }));
			throws(() => alignParadisRenderedItems(many, many.slice(1).concat({ kind: 'paragraph', key: 'x' }), { token: source.token }), CancellationError);
			source.dispose();
		});
	});

	suite('diffParadisRenderedText', () => {
		test('marks only the changed English words', () => {
			const original = 'The quick brown fox jumps over the dog.';
			const modified = 'The quick red fox leaps over the dog.';
			const segments = diffParadisRenderedText(original, modified);
			deepStrictEqual(showText(segments), ['=The quick ', '-brown', '+red', '= fox ', '-jumps', '+leaps', '= over the dog.']);
			rebuild(original, modified, segments);
		});

		test('splits Japanese into words instead of the whole sentence', () => {
			const original = '今日は東京へ行きます。';
			const modified = '明日は東京へ行きます。';
			const segments = diffParadisRenderedText(original, modified);
			rebuild(original, modified, segments);
			// 変わった語だけが印になり、後ろの「東京へ行きます。」は同じ区間に残る
			strictEqual(segments[segments.length - 1].kind, 'equal');
			strictEqual(segments[segments.length - 1].text.endsWith('東京へ行きます。'), true);
			strictEqual(segments.filter(segment => segment.kind !== 'equal').every(segment => segment.text.length <= 2), true);
		});

		test('line granularity for code', () => {
			const original = 'const a = 1;\nconst b = 2;\nreturn a + b;\n';
			const modified = 'const a = 1;\nconst b = 3;\nreturn a + b;\nconsole.log(a);';
			const segments = diffParadisRenderedText(original, modified, 'line');
			deepStrictEqual(showText(segments), ['=const a = 1;\n', '-const b = 2;\n', '+const b = 3;\n', '=return a + b;\n', '+console.log(a);']);
			rebuild(original, modified, segments);
		});

		test('identical and empty texts', () => {
			deepStrictEqual(showText(diffParadisRenderedText('same', 'same')), ['=same']);
			deepStrictEqual(showText(diffParadisRenderedText('', '')), []);
			deepStrictEqual(showText(diffParadisRenderedText('', 'new text')), ['+new text']);
			deepStrictEqual(showText(diffParadisRenderedText('old text', '')), ['-old text']);
		});

		test('falls back to replacing the whole text over the unit limit', () => {
			const segments = diffParadisRenderedText('a b c d', 'a b x d', 'word', { maxUnits: 3 });
			deepStrictEqual(showText(segments), ['-a b c d', '+a b x d']);
			rebuild('a b c d', 'a b x d', segments);
		});

		test('cancellation throws', () => {
			const source = new CancellationTokenSource();
			source.cancel();
			throws(() => diffParadisRenderedText('a b c', 'a x c', 'word', { token: source.token }), CancellationError);
			source.dispose();
		});
	});

	suite('paradisMarkdownRenderedDiffItems', () => {
		function lex(text: string) {
			const tokens = new marked.Marked().lexer(text);
			return { tokens, items: paradisMarkdownRenderedDiffItems(tokens, tokens.links) };
		}

		test('skips blank lines, trims raw text and keeps the token index', () => {
			const { tokens, items: result } = lex('# Title\n\nSome text.\n\n---\n\n```mermaid\ngraph TD\n```\n\n```js\nx\n```\n');
			deepStrictEqual(result.map(item => [item.kind, item.key, tokens[item.tokenIndex].type]), [
				['heading', '# Title', 'heading'],
				['paragraph', 'Some text.', 'paragraph'],
				['hr', '---', 'hr'],
				['mermaid', '```mermaid\ngraph TD\n```', 'code'],
				['code', '```js\nx\n```', 'code'],
			]);
		});

		test('a changed reference link definition changes the paragraph that uses it', () => {
			const before = lex('See [the docs][docs].\n\nOther.\n\n[docs]: https://example.com/a\n');
			const after = lex('See [the docs][docs].\n\nOther.\n\n[docs]: https://example.com/b\n');
			deepStrictEqual(show(alignParadisRenderedItems(before.items, after.items)), ['~0/0', '=1/1']);
		});

		test('an inserted section keeps the rest aligned', () => {
			const before = lex('# A\n\nalpha\n\n# B\n\nbeta\n');
			const after = lex('# A\n\nalpha\n\n## New\n\nnew text\n\n# B\n\nbeta changed\n');
			deepStrictEqual(show(alignParadisRenderedItems(before.items, after.items)), ['=0/0', '=1/1', '+2', '+3', '=2/4', '~3/5']);
		});
	});

	test('isParadisRenderedDiffTooLarge', () => {
		const max = PARADIS_RENDERED_DIFF_LIMITS.maxDocumentLength;
		deepStrictEqual([
			isParadisRenderedDiffTooLarge({ length: max }, { length: 10 }),
			isParadisRenderedDiffTooLarge({ length: 10 }, { length: max + 1 }),
			isParadisRenderedDiffTooLarge({ length: 10, blocks: PARADIS_RENDERED_DIFF_LIMITS.maxBlocks + 1 }, { length: 10 }),
		], [false, true, true]);
	});
});
