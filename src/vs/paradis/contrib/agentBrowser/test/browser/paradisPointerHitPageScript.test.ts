/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_POINTER_HIT_PAGE_SCRIPT } from '../../common/paradisPointerHitPageScript.js';

type PointerHit = (el: Element, hit: Element) => 'self' | 'child' | 'ancestor' | 'other';
type PointerReaches = (el: Element, hit: Element, purpose: 'click' | 'fill') => boolean;

/** ページの中と同じ定義を、このテストの文書で動かす。 */
function pointerHit(): PointerHit {
	return new Function(`${PARADIS_POINTER_HIT_PAGE_SCRIPT}\nreturn pointerHit;`)();
}

function pointerReaches(): PointerReaches {
	return new Function(`${PARADIS_POINTER_HIT_PAGE_SCRIPT}\nreturn pointerReaches;`)();
}

/** 要素の中心で elementFromPoint が返す要素（click_by の hitAt と同じ点）。 */
function landedAt(el: Element): Element {
	const rect = el.getBoundingClientRect();
	return mainWindow.document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
}

suite('paradisPointerHitPageScript', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;
	setup(() => {
		root = mainWindow.document.createElement('div');
		root.style.cssText = 'position: fixed; left: 0; top: 0; z-index: 2147483647; background: white;';
		mainWindow.document.body.appendChild(root);
	});
	teardown(() => root.remove());

	// 実利用で 141 回あった「ボタンが自分の中の span を覆っている」と、shadow DOM の中のボタンを覆いと取り違えない
	test('the element, its contents, its shadow tree and an ancestor that takes the pointer are not covering', () => {
		const doc = mainWindow.document;
		root.innerHTML = '<button id="save" style="width: 120px; height: 40px;"><span id="label" style="pointer-events: none;">Save</span></button><div id="sibling">Other</div><x-card id="card"><span id="slotted">Slotted</span></x-card>';
		const card = doc.getElementById('card')!;
		const shadow = card.attachShadow({ mode: 'open' });
		shadow.innerHTML = '<div id="frame"><button id="inner"><slot></slot></button></div>';
		const save = doc.getElementById('save')!;
		const label = doc.getElementById('label')!;
		const rect = label.getBoundingClientRect();
		const landed = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
		const hit = pointerHit();
		assert.deepStrictEqual({
			landedOnButton: landed === save,
			spanUnderItsButton: hit(label, landed),
			buttonOverItsSpan: hit(save, label),
			self: hit(save, save),
			sibling: hit(save, doc.getElementById('sibling')!),
			hostOverShadowButton: hit(card, shadow.getElementById('inner')!),
			shadowButtonOverSlotted: hit(doc.getElementById('slotted')!, shadow.getElementById('inner')!),
			hostOverItsShadowFrame: hit(shadow.getElementById('frame')!, card),
		}, {
			landedOnButton: true,
			spanUnderItsButton: 'ancestor',
			buttonOverItsSpan: 'child',
			self: 'self',
			sibling: 'other',
			hostOverShadowButton: 'child',
			shadowButtonOverSlotted: 'ancestor',
			hostOverItsShadowFrame: 'ancestor',
		});
	});

	// 祖先が受けるのは目的の要素が pointer-events: none のときだけ。切り取られて見えない要素の点で祖先を押さない
	test('an ancestor takes the click only for an element without pointer events, never for a field or a clipped element', () => {
		root.id = 'root';
		root.style.width = '400px';
		root.style.height = '400px';
		root.innerHTML = '<button id="save" style="width: 120px; height: 40px;"><span id="label" style="pointer-events: none;">Save</span></button>'
			+ '<div id="clip" style="width: 100px; height: 60px; overflow: hidden;"><div style="height: 200px;"></div><button id="clipped" style="width: 80px; height: 30px;">Hidden</button></div>'
			+ '<label id="wrap"><input id="field" style="width: 120px; pointer-events: none;"></label>';
		const doc = mainWindow.document;
		const reaches = pointerReaches();
		const label = doc.getElementById('label')!;
		const clipped = doc.getElementById('clipped')!;
		const field = doc.getElementById('field')!;
		assert.deepStrictEqual({
			spanForClick: reaches(label, landedAt(label), 'click'),
			spanForFill: reaches(label, landedAt(label), 'fill'),
			buttonItself: reaches(doc.getElementById('save')!, landedAt(label), 'click'),
			clippedLandsOn: landedAt(clipped).id || landedAt(clipped).localName,
			clippedForClick: reaches(clipped, landedAt(clipped), 'click'),
			fieldWithoutPointerForFill: reaches(field, landedAt(field), 'fill'),
		}, {
			spanForClick: true,
			spanForFill: false,
			buttonItself: true,
			clippedLandsOn: 'root',
			clippedForClick: false,
			fieldWithoutPointerForFill: false,
		});
	});

	// q.html Q396: カード全体を押せるリンクが中の文字を覆う型は、そのリンクが受けるので押してよい。
	// 目的の要素がボタン・チェックボックス・タブなど対話できる要素なら、外のリンクが受けるのは取り違えなので断る
	test('a link or button that holds a non-interactive element takes the click, but not one around a button, checkbox or tab', () => {
		const doc = mainWindow.document;
		root.innerHTML = '<style>#card::after, #outer::after, #box::after, #checkCard::after, #tabCard::after, #iconCard::after { content: ""; position: absolute; inset: 0; }</style>'
			+ '<a id="card" href="#card" style="position: relative; display: block; width: 300px; height: 80px;"><p id="title" style="margin: 0;">Title</p></a>'
			+ '<a id="outer" href="#outer" style="position: relative; display: block; width: 300px; height: 80px;"><button id="inner" style="width: 120px; height: 40px;">Inner</button></a>'
			+ '<div id="box" style="position: relative; width: 300px; height: 80px;"><p id="plain" style="margin: 0;">Plain</p></div>'
			+ '<a id="checkCard" href="#check" style="position: relative; display: block; width: 300px; height: 40px;"><input id="check" type="checkbox"></a>'
			+ '<a id="tabCard" href="#tab" style="position: relative; display: block; width: 300px; height: 40px;"><span id="tab" role="tab">Tab</span></a>'
			+ '<a id="iconCard" href="#icon" style="position: relative; display: block; width: 300px; height: 40px;"><h3 style="margin: 0;"><svg id="icon" width="20" height="20"></svg></h3></a>';
		const reaches = pointerReaches();
		const title = doc.getElementById('title')!;
		const inner = doc.getElementById('inner')!;
		const plain = doc.getElementById('plain')!;
		const check = doc.getElementById('check')!;
		const tab = doc.getElementById('tab')!;
		const icon = doc.getElementById('icon')!;
		assert.deepStrictEqual({
			landsOn: [landedAt(title).id, landedAt(inner).id, landedAt(plain).id, landedAt(check).id, landedAt(tab).id, landedAt(icon).id],
			titleForClick: reaches(title, landedAt(title), 'click'),
			titleForFill: reaches(title, landedAt(title), 'fill'),
			buttonInLink: reaches(inner, landedAt(inner), 'click'),
			plainAncestor: reaches(plain, landedAt(plain), 'click'),
			checkboxInLink: reaches(check, landedAt(check), 'click'),
			tabInLink: reaches(tab, landedAt(tab), 'click'),
			iconInHeadingInLink: reaches(icon, landedAt(icon), 'click'),
		}, {
			landsOn: ['card', 'outer', 'box', 'checkCard', 'tabCard', 'iconCard'],
			titleForClick: true,
			titleForFill: false,
			buttonInLink: false,
			plainAncestor: false,
			checkboxInLink: false,
			tabInLink: false,
			iconInHeadingInLink: true,
		});
	});
});
