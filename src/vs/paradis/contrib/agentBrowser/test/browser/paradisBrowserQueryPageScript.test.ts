/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_BROWSER_QUERY_PAGE_SCRIPT } from '../../common/paradisBrowserQueryPageScript.js';

/** ページの中と同じ関数を、このテストの文書で動かす（spec は paradisBrowserQuery.ts の IParadisQuerySpec）。 */
function runInPage(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
	const run = new Function(`return (${PARADIS_BROWSER_QUERY_PAGE_SCRIPT});`)() as (spec: Record<string, unknown>, els: readonly Element[]) => Promise<Record<string, unknown>>;
	return run(spec, []);
}

suite('paradisBrowserQueryPageScript (scroll_to)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;
	setup(() => {
		root = mainWindow.document.createElement('div');
		root.style.cssText = 'position: fixed; left: 0; top: 0; width: 400px; z-index: 2147483647; background: white;';
		mainWindow.document.body.appendChild(root);
	});
	teardown(() => root.remove());

	// q.html Q379 の 5: 下へ探すなら先頭、上へ探すなら末尾から探し直し、見つからなければ始めの位置へ戻す
	test('a scroll step reports where it began, a reset goes to either end, and the position can be restored', async () => {
		root.innerHTML = '<div id="q379-list" style="height: 100px; overflow: auto;"><div style="height: 1000px;"></div></div>';
		const list = mainWindow.document.getElementById('q379-list')!;
		list.scrollTop = 300;
		const step = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', stepPx: 100, text: 'nothing here' });
		const toEnd = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'up', reset: true, resetTo: 'end', text: 'nothing here' });
		const atEnd = list.scrollTop;
		const toStart = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', reset: true, text: 'nothing here' });
		const atStart = list.scrollTop;
		const restored = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', restoreTo: 300, text: 'nothing here' });
		assert.deepStrictEqual({
			step: [step.before, step.position, step.moved, step.max, step.extent],
			toEnd: [toEnd.before, atEnd],
			toStart: [toStart.before, atStart],
			restored: [restored.restored, list.scrollTop],
		}, {
			step: [300, 400, 100, 900, 1000],
			toEnd: [400, 900],
			toStart: [900, 0],
			restored: [true, 300],
		});
	});

	test('a miss explains a value in a form field, collapsed sections, an open dialog and other scrollable areas', async () => {
		root.innerHTML = [
			'<div id="q379-main" style="height: 100px; overflow: auto;"><div style="height: 600px;"><input id="q379-company" aria-label="Company" value="Acme Trading"></div></div>',
			'<div id="q379-side" style="height: 60px; overflow: auto;"><div style="height: 300px;"></div></div>',
			'<button aria-expanded="false">Q379 Details</button>',
			'<div role="dialog" aria-label="Q379 Notice">Read me</div>',
			'<input type="text" aria-label="Q379 Buyer name">',
		].join('');
		const hints = await runInPage({ mode: 'scrollMiss', container: '#q379-main', direction: 'down', text: 'acme' });
		const roleHints = await runInPage({ mode: 'scrollMiss', container: '#q379-main', direction: 'down', role: 'textbox', name: 'Q379 Seller name' });
		const inField = hints.inField as { count: number; first: { name?: string } };
		const collapsed = hints.collapsed as { names: string[] };
		const sameRole = roleHints.sameRole as string[];
		assert.deepStrictEqual({
			inField: [inField.count, inField.first.name],
			collapsed: collapsed.names.includes('Q379 Details'),
			dialog: hints.dialog,
			other: (hints.otherContainers as string[]).includes('div#q379-side'),
			sameRole: sameRole.filter(name => name === 'Company' || name.startsWith('Q379')),
		}, {
			inField: [1, 'Company'],
			collapsed: true,
			dialog: 'Q379 Notice',
			other: true,
			sameRole: ['Company', 'Q379 Buyer name'],
		});
	});
});
