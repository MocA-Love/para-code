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
		const restored = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', restoreTo: 300, expectAt: 0, expectContainer: 'div#q379-list', text: 'nothing here' });
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

	// 探している間に利用者が動かした分や、別の領域は戻さない（q.html Q379 のレビュー）
	test('scrolling back happens only when the container is still where the tool left it', async () => {
		root.innerHTML = '<div id="q379-list" style="height: 100px; overflow: auto;"><div style="height: 1000px;"></div></div>';
		const list = mainWindow.document.getElementById('q379-list')!;
		list.scrollTop = 500;
		const userMoved = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', restoreTo: 300, expectAt: 400, expectContainer: 'div#q379-list', text: 'nothing here' });
		const afterUser = list.scrollTop;
		const otherArea = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', restoreTo: 300, expectAt: 500, expectContainer: 'div.other', text: 'nothing here' });
		const afterOther = list.scrollTop;
		const ours = await runInPage({ mode: 'scroll', container: '#q379-list', direction: 'down', restoreTo: 300, expectAt: 500, expectContainer: 'div#q379-list', text: 'nothing here' });
		assert.deepStrictEqual({
			userMoved: [userMoved.restored, afterUser],
			otherArea: [otherArea.restored, afterOther],
			ours: [ours.restored, list.scrollTop],
		}, {
			userMoved: [false, 500],
			otherArea: [false, 500],
			ours: [true, 300],
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

// q.html Q448 の ③④: 該当なし・時間切れのときに添える近い候補（ページを 1 回読むだけ。数件まで、入力値は出さない）
suite('paradisBrowserQueryPageScript (close matches after a miss)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;
	setup(() => {
		root = mainWindow.document.createElement('div');
		root.style.cssText = 'position: fixed; left: 0; top: 0; width: 400px; z-index: 2147483647; background: white;';
		mainWindow.document.body.appendChild(root);
	});
	teardown(() => root.remove());

	test('a text that matches nothing lists visible elements with similar text as locators, but never what is typed in a field', async () => {
		root.innerHTML = [
			'<button>保存する</button>',
			'<span>保存して閉じる</span>',
			'<div style="display: none;">保存しよう</div>',
			'<input aria-label="メール" value="保存しまsecret@example.com">',
			'<div contenteditable="true">保存し ま typed by the user</div>',
		].join('');
		const located = await runInPage({ mode: 'locate', purpose: 'click', ref: 'q448', text: '保存しま' });
		const near = located.near as { candidates: unknown[]; inFields: number };
		assert.deepStrictEqual({
			matched: located.matched,
			candidates: near.candidates,
			inFields: near.inFields,
			leaks: /secret@example\.com|typed by the user/.test(JSON.stringify(located)),
		}, {
			matched: 0,
			candidates: [{ text: '保存して閉じる' }, { role: 'button', name: '保存する', text: '保存する' }],
			inFields: 1,
			leaks: false,
		});
	});

	test('candidates are capped and cut, and role + name lists the elements of that role with a close name', async () => {
		root.innerHTML = Array.from({ length: 12 }, (_, index) => `<button>Q448 Item ${index} ${'x'.repeat(index === 0 ? 100 : 0)}</button>`).join('');
		const many = await runInPage({ mode: 'text', text: 'Q448 Item 99', offset: 0, maxChars: 100 });
		const byRole = await runInPage({ mode: 'locate', purpose: 'click', ref: 'q448', role: 'button', name: 'Q448 Itme 3' });
		const candidates = (many.near as { candidates: { text?: string; name?: string }[] }).candidates;
		const roleNear = byRole.near as { candidates: { role?: string; name?: string }[]; roleCount: number };
		assert.deepStrictEqual({
			count: candidates.length,
			longest: Math.max(...candidates.map(candidate => Math.max(candidate.text?.length ?? 0, candidate.name?.length ?? 0))) <= 60,
			roleFirst: roleNear.candidates[0],
			roleCountAtLeast12: roleNear.roleCount >= 12,
			roleCandidates: roleNear.candidates.length <= 5,
		}, {
			count: 5,
			longest: true,
			roleFirst: { role: 'button', name: 'Q448 Item 3' },
			roleCountAtLeast12: true,
			roleCandidates: true,
		});
	});

	test('a selector that matches nothing says which parts are missing, similar ids, classes and attribute values, and when only the last part matches', async () => {
		root.innerHTML = [
			'<button id="q448-save-button" class="q448-primary" data-testid="q448-save-draft">Save</button>',
			'<div class="q448-list"></div>',
			'<div class="q448-row"></div><div class="q448-row"></div>',
			'<input type="password" data-testid="q448-pass-1234">',
		].join('');
		const byId = await runInPage({ mode: 'nearMiss', selector: '#q448-save-btn' });
		const byParts = await runInPage({ mode: 'nearMiss', selector: '.q448-list > .q448-row' });
		const byAttribute = await runInPage({ mode: 'nearMiss', selector: 'button[data-testid="q448-save-drafts"]' });
		const byPassword = await runInPage({ mode: 'nearMiss', selector: '[data-testid="q448-pass-123"]' });
		assert.deepStrictEqual({
			byId: byId.near,
			byParts: byParts.near,
			byAttribute: byAttribute.near,
			byPassword: byPassword.near,
		}, {
			byId: { missingParts: ['#q448-save-btn'], similar: [{ instead: '#q448-save-btn', selector: '#q448-save-button', count: 1 }] },
			byParts: { lastPart: { part: '.q448-row', count: 2 } },
			byAttribute: { missingParts: ['[data-testid="q448-save-drafts"]'], similar: [{ instead: '[data-testid="q448-save-drafts"]', selector: '[data-testid="q448-save-draft"]', count: 1 }] },
			byPassword: { missingParts: ['[data-testid="q448-pass-123"]'] },
		});
	});
});
