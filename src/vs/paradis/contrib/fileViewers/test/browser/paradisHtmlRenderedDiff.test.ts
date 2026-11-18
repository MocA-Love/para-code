/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, strictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildParadisHtmlRenderedDiffPages, markParadisHtmlRenderedDiff, parseParadisHtmlDiffDocument, PARADIS_HTML_RENDERED_DIFF_MAX_ELEMENTS, serializeParadisHtmlDiffDocument, stopParadisHtmlScripts } from '../../browser/paradisHtmlRenderedDiff.js';

function parse(body: string, head = ''): Document {
	return parseParadisHtmlDiffDocument(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`);
}

/** 印を付けた両側の body と結果。 */
function mark(original: string, modified: string, layout: 'split' | 'unified', heads: readonly [string, string] = ['', '']) {
	const o = parse(original, heads[0]);
	const m = parse(modified, heads[1]);
	const result = markParadisHtmlRenderedDiff(o, m, layout);
	return { result, original: o.body.innerHTML, modified: m.body.innerHTML };
}

suite('paradisHtmlRenderedDiff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stops scripts, event handlers, javascript: URLs, refreshes and the author base', () => {
		const doc = parseParadisHtmlDiffDocument('<html><head><base href="https://example.com/"><meta http-equiv="Refresh" content="0;url=x"><meta charset="utf-8"><script>alert(1)</script></head>'
			+ '<body onload="x()"><a href=" javascript:alert(1)">a</a><a href="https://example.com/">b</a><img src="a.png" onerror="y()"><script src="b.js"></script></body></html>');
		const stopped = stopParadisHtmlScripts(doc).stopped;
		deepStrictEqual({ stopped, head: doc.head.innerHTML, body: doc.body.outerHTML }, {
			stopped: 5,
			head: '<meta charset="utf-8">',
			body: '<body><a>a</a><a href="https://example.com/">b</a><img src="a.png"></body>',
		});
	});

	test('split: marks the changed words in both sides inside a wrapper, and anchors the pairs', () => {
		deepStrictEqual(mark('<main><h1>Title</h1><p>The quick fox</p></main>', '<main><h1>Title</h1><p>The slow fox</p></main>', 'split'), {
			result: { changes: 1, styleChanges: 0 },
			original: '<main data-paradis-rdiff-anchor="0"><h1 data-paradis-rdiff-anchor="1">Title</h1><p data-paradis-rdiff-anchor="2" data-paradis-rdiff-change="0">The <del class="paradis-rdiff-w">quick</del> fox</p></main>',
			modified: '<main data-paradis-rdiff-anchor="0"><h1 data-paradis-rdiff-anchor="1">Title</h1><p data-paradis-rdiff-anchor="2" data-paradis-rdiff-change="0">The <ins class="paradis-rdiff-w">slow</ins> fox</p></main>',
		});
	});

	test('split: an added and a removed element are marked on their own side only', () => {
		deepStrictEqual(mark('<section><p>keep</p><p>gone away</p></section>', '<section><p>keep</p><ul><li>new</li></ul></section>', 'split'), {
			result: { changes: 2, styleChanges: 0 },
			original: '<section data-paradis-rdiff-anchor="0"><p data-paradis-rdiff-anchor="1">keep</p><p data-paradis-rdiff="removed" data-paradis-rdiff-change="0">gone away</p></section>',
			modified: '<section data-paradis-rdiff-anchor="0"><p data-paradis-rdiff-anchor="1">keep</p><ul data-paradis-rdiff="added" data-paradis-rdiff-change="1"><li>new</li></ul></section>',
		});
	});

	test('unified: inserts the removed element and the removed words into the modified side', () => {
		const marked = mark('<div><p>first</p><p>old line</p><p>The quick fox</p></div>', '<div><p>first</p><p>The slow fox</p></div>', 'unified');
		deepStrictEqual({ result: marked.result, modified: marked.modified }, {
			result: { changes: 2, styleChanges: 0 },
			modified: '<div><p>first</p><p data-paradis-rdiff="removed" data-paradis-rdiff-change="0">old line</p><p data-paradis-rdiff-change="1">The <del class="paradis-rdiff-w">quick</del><ins class="paradis-rdiff-w">slow</ins> fox</p></div>',
		});
	});

	test('a class-only change gets the dotted mark and counts as a CSS change with the <style> changes', () => {
		deepStrictEqual(mark('<p class="a">same</p>', '<p class="b">same</p>', 'split', ['<style>p{color:red}</style>', '<style>p{color:blue}</style>']), {
			result: { changes: 1, styleChanges: 2 },
			original: '<p class="a" data-paradis-rdiff-anchor="0" data-paradis-rdiff-change="0" data-paradis-rdiff="style">same</p>',
			modified: '<p class="b" data-paradis-rdiff-anchor="0" data-paradis-rdiff-change="0" data-paradis-rdiff="style">same</p>',
		});
	});

	test('does not put word marks inside a textarea, and marks a changed link target without text changes', () => {
		deepStrictEqual(mark('<form><textarea>one two</textarea></form><p><a href="a.html">same</a></p>', '<form><textarea>one three</textarea></form><p><a href="b.html">same</a></p>', 'split').modified,
			'<form data-paradis-rdiff-anchor="0"><textarea data-paradis-rdiff-anchor="1" data-paradis-rdiff-change="0" data-paradis-rdiff="changed">one three</textarea></form>'
			+ '<p data-paradis-rdiff-anchor="2" data-paradis-rdiff-change="1" data-paradis-rdiff="changed"><a href="b.html">same</a></p>');
	});

	test('a reformatted document without visible changes has no marks', () => {
		strictEqual(mark('<div>\n  <p>same   text</p>\n</div>', '<div><p>same text</p></div>', 'split').result.changes, 0);
	});

	test('serializing keeps the doctype and puts the head html first and the mark style last', () => {
		const doc = parseParadisHtmlDiffDocument('<!DOCTYPE html><html lang="ja"><head><title>t</title></head><body><p>x</p></body></html>');
		strictEqual(serializeParadisHtmlDiffDocument(doc, '<base href="http://127.0.0.1:1/a/">', '.m{}'),
			'<!DOCTYPE html>\n<html lang="ja"><head><base href="http://127.0.0.1:1/a/"><title>t</title><style>.m{}</style></head><body><p>x</p></body></html>');
	});

	test('builds both pages for split and only the modified page for unified, and gives up on huge documents', () => {
		const split = buildParadisHtmlRenderedDiffPages('<p>a</p><script>x()</script>', '<p>b</p>', 'split', '');
		const unified = buildParadisHtmlRenderedDiffPages('<p>a</p>', '<p>b</p>', 'unified', '');
		const huge = buildParadisHtmlRenderedDiffPages('<p>a</p>', '<b></b>'.repeat(PARADIS_HTML_RENDERED_DIFF_MAX_ELEMENTS + 1), 'split', '');
		deepStrictEqual([split?.stoppedScripts, split?.changes, typeof split?.originalHtml, typeof unified?.originalHtml, huge], [1, 1, 'string', 'undefined', undefined]);
	});
});
