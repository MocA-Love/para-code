/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisEffectiveDiffLayout, paradisInitialDiffViewMode } from '../../browser/paradisMarkdownRenderedDiffView.js';
import { buildParadisRenderedDiff, insertAtTextOffset, IParadisRenderedDiffSide, ParadisRenderedDiffLayout, wrapTextRanges } from '../../browser/paradisRenderedDiffDom.js';

const LABELS = { original: 'before', modified: 'after', before: 'old', after: 'new' };

/** `[種類, HTML]` の並びから片側を作る（ブロックは描いたときと同じく包みの div）。 */
function side(doc: Document, blocks: readonly (readonly [string, string])[]): IParadisRenderedDiffSide {
	return {
		blocks: blocks.map(([, html]) => {
			const element = doc.createElement('div');
			element.innerHTML = html;
			return element;
		}),
		items: blocks.map(([kind, html]) => ({ kind, key: html })),
	};
}

/** 組み立てた木を、ブロックごとに「印 + 中身の HTML」の短い形にする。 */
function show(doc: Document, original: readonly (readonly [string, string])[], modified: readonly (readonly [string, string])[], layout: ParadisRenderedDiffLayout): { readonly changes: number; readonly blocks: string[] } {
	const result = buildParadisRenderedDiff(doc, side(doc, original), side(doc, modified), layout, LABELS);
	const blocks = Array.from(result.root.querySelectorAll('.paradis-rdiff-b')).map(element => {
		const kind = ['added', 'removed', 'changed', 'ghost'].find(name => element.classList.contains(`paradis-rdiff-${name}`)) ?? 'equal';
		const content = Array.from(element.childNodes).filter(node => !(node instanceof HTMLElement && node.classList.contains('paradis-rdiff-gm')));
		const html = content.map(node => node instanceof HTMLElement ? node.outerHTML : node.textContent).join('').replace(/ class="paradis-rdiff-w"/g, '');
		return `${kind}: ${html}`;
	});
	return { changes: result.changes, blocks };
}

suite('paradisRenderedDiffDom', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('split: equal rows on both sides, ghosts for missing blocks, word marks in changed blocks', () => {
		const doc = document.implementation.createHTMLDocument('');
		const original: [string, string][] = [['heading', '<h1>Title</h1>'], ['paragraph', '<p>The quick brown fox</p>'], ['hr', '<hr>']];
		const modified: [string, string][] = [['heading', '<h1>Title</h1>'], ['paragraph', '<p>The quick red fox</p>'], ['code', '<pre><code>x</code></pre>'], ['hr', '<hr>']];
		deepStrictEqual(show(doc, original, modified, 'split'), {
			changes: 2,
			blocks: [
				'equal: <h1>Title</h1>', 'equal: <h1>Title</h1>',
				'changed: <p>The quick <del>brown</del> fox</p>', 'changed: <p>The quick <ins>red</ins> fox</p>',
				'ghost: ', 'added: <pre><code>x</code></pre>',
				'equal: <hr>', 'equal: <hr>',
			],
		});
	});

	test('unified: removed words are inserted with a strike-through where they were', () => {
		const doc = document.implementation.createHTMLDocument('');
		const original: [string, string][] = [['paragraph', '<p>Go to <a href="x">the docs</a> today</p>'], ['paragraph', '<p>gone</p>']];
		const modified: [string, string][] = [['paragraph', '<p>Go to <a href="x">the new docs</a> now</p>']];
		deepStrictEqual(show(doc, original, modified, 'unified'), {
			changes: 2,
			blocks: [
				'changed: <p>Go to <a href="x">the <ins>new</ins> docs</a> <del>today</del><ins>now</ins></p>',
				'removed: <p>gone</p>',
			],
		});
	});

	test('lists: items are matched, removed items are put back in the single column', () => {
		const doc = document.implementation.createHTMLDocument('');
		const original: [string, string][] = [['list', '<ul><li>one</li><li>two</li><li>three</li></ul>']];
		const modified: [string, string][] = [['list', '<ul><li>one</li><li>three!</li><li>four</li></ul>']];
		deepStrictEqual(show(doc, original, modified, 'unified').blocks, [
			'changed: <ul><li>one</li><li data-paradis-rdiff="removed">two</li><li>three<ins>!</ins></li><li data-paradis-rdiff="added">four</li></ul>',
		]);
	});

	test('tables: similar rows are matched cell by cell, the others are removed and added', () => {
		const doc = document.implementation.createHTMLDocument('');
		const table = (...rows: string[][]) => `<table><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
		const original: [string, string][] = [['table', table(['Tokyo', '61'], ['Sendai', '3'])]];
		const modified: [string, string][] = [['table', table(['Tokyo', '70'], ['Fukuoka', '23'])]];
		deepStrictEqual(show(doc, original, modified, 'split').blocks, [
			'changed: <table><tbody><tr><td>Tokyo</td><td><del>61</del></td></tr><tr data-paradis-rdiff="removed"><td>Sendai</td><td>3</td></tr></tbody></table>',
			'changed: <table><tbody><tr><td>Tokyo</td><td><ins>70</ins></td></tr><tr data-paradis-rdiff="added"><td>Fukuoka</td><td>23</td></tr></tbody></table>',
		]);
	});

	test('unified: diagrams and code put the old and the new version one above the other', () => {
		const doc = document.implementation.createHTMLDocument('');
		const result = show(doc, [['mermaid', '<div class="paradis-mermaid">graph A</div>']], [['mermaid', '<div class="paradis-mermaid">graph B</div>']], 'unified');
		deepStrictEqual(result.blocks, ['changed: <div class="paradis-rdiff-swap"><figure class="paradis-rdiff-swap-o"><figcaption>old</figcaption><div class="paradis-mermaid">graph A</div></figure><figure class="paradis-rdiff-swap-n"><figcaption>new</figcaption><div class="paradis-mermaid">graph B</div></figure></div>']);
	});

	test('wrapTextRanges and insertAtTextOffset work across nested elements', () => {
		const doc = document.implementation.createHTMLDocument('');
		const root = doc.createElement('p');
		root.innerHTML = 'ab<b>cd</b>ef';
		wrapTextRanges(root, [{ start: 1, length: 2 }, { start: 4, length: 1 }], 'ins');
		insertAtTextOffset(root, 6, doc.createTextNode('!'));
		deepStrictEqual(root.innerHTML.replace(/ class="paradis-rdiff-w"/g, ''), 'a<ins>b</ins><b><ins>c</ins>d</b><ins>e</ins>f!');
	});

	test('initial mode and effective layout', () => {
		deepStrictEqual([
			paradisInitialDiffViewMode(undefined, undefined),
			paradisInitialDiffViewMode('text', 'rendered'),
			paradisInitialDiffViewMode('remember', 'text'),
			paradisInitialDiffViewMode('remember', undefined),
			paradisInitialDiffViewMode(undefined, undefined, 'text'),
			paradisInitialDiffViewMode('remember', undefined, 'text'),
			paradisInitialDiffViewMode('rendered', 'text', 'text'),
			paradisEffectiveDiffLayout('split', 1200),
			paradisEffectiveDiffLayout('split', 560),
			paradisEffectiveDiffLayout('unified', 1200),
		], ['rendered', 'text', 'text', 'rendered', 'text', 'text', 'rendered', 'split', 'unified', 'unified']);
	});
});
