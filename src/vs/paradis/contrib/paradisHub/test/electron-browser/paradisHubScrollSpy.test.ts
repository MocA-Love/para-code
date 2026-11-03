/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisHubScrollSpy, paradisHubRevealNavItem } from '../../electron-browser/paradisHubNav.js';

/** 監視した節を、呼ばれたときに全部「見えている」と知らせるだけの IntersectionObserver。 */
class TestIntersectionObserver {
	static last: TestIntersectionObserver | undefined;
	private readonly targets: Element[] = [];

	constructor(private readonly callback: IntersectionObserverCallback) {
		TestIntersectionObserver.last = this;
	}

	observe(target: Element): void {
		this.targets.push(target);
	}

	disconnect(): void { }

	fire(): void {
		this.callback(this.targets.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
	}
}

suite('ParadisHubScrollSpy', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function block(parent: HTMLElement, height: number, id?: string): HTMLElement {
		const element = parent.appendChild(mainWindow.document.createElement('div'));
		element.style.cssText = `height: ${height}px; margin: 0; padding: 0;`;
		if (id) {
			element.id = id;
		}
		return element;
	}

	/** 高さ 100px の本文に、300・50・50・30px の節 a〜d を並べる。 */
	function create() {
		const doc = mainWindow.document;
		const root = doc.body.appendChild(doc.createElement('div'));
		store.add(toDisposable(() => root.remove()));
		const nav = root.appendChild(doc.createElement('nav'));
		nav.style.cssText = 'height: 40px; overflow-y: auto; margin: 0; padding: 0; border: none;';
		const content = root.appendChild(doc.createElement('div'));
		content.style.cssText = 'height: 100px; overflow-y: auto; margin: 0; padding: 0;';
		const sections = ([['a', 300], ['b', 50], ['c', 50], ['d', 30]] as const).map(([id, height]) => ({ id, element: block(content, height, id) }));
		const items = new Map<string, HTMLElement>(sections.map(section => [section.id, block(nav, 20)]));
		const selected: string[] = [];
		const spy = store.add(new ParadisHubScrollSpy({
			content,
			nav,
			sections,
			navItem: id => items.get(id),
			onDidSelect: id => selected.push(id),
			intersectionObserver: TestIntersectionObserver as unknown as typeof IntersectionObserver,
		}));
		TestIntersectionObserver.last!.fire();
		const scrollTo = (top: number) => {
			content.scrollTop = top;
			content.dispatchEvent(new Event('scroll'));
		};
		return { spy, content, nav, sections, selected, scrollTo };
	}

	// 長い節 a が本文を埋めている間は a のまま、b の上端が本文の上端に来たら b、一番下まで来たら最後の d
	test('selects the section at the top of the content, and the last one at the bottom', () => {
		const { selected, scrollTo } = create();
		scrollTo(150);
		scrollTo(300);
		scrollTo(330);
		assert.deepStrictEqual(selected, ['a', 'b', 'd']);
	});

	test('skips the sections hidden by the search', () => {
		const { sections, selected, scrollTo } = create();
		sections[3].element.style.display = 'none';
		sections[1].element.style.display = 'none';
		scrollTo(280);
		assert.deepStrictEqual(selected, ['a', 'c']);
	});

	// ナビを押してスクロールしている間は選択を変えず、止まった後も選び直さない（次のスクロールから追従する）
	test('does not change the selection while scrolling to a clicked section', () => {
		const { spy, content, selected, scrollTo } = create();
		spy.suppress('c');
		scrollTo(330);
		content.dispatchEvent(new Event('scrollend'));
		const afterEnd = [...selected];
		scrollTo(300);
		assert.deepStrictEqual({ afterEnd, selected }, { afterEnd: ['a'], selected: ['a', 'b'] });
	});

	// 選んだ項目がナビの外に出たら、ナビだけをスクロールして見える位置に入れる
	test('scrolls only the nav to show the selected item', () => {
		const { nav, scrollTo } = create();
		scrollTo(330);
		const afterBottom = nav.scrollTop;
		scrollTo(0);
		assert.deepStrictEqual({ afterBottom, afterTop: nav.scrollTop }, { afterBottom: 40, afterTop: 0 });
	});

	test('leaves the nav alone when the item is already shown', () => {
		const { nav } = create();
		const item = nav.children[1] as HTMLElement;
		paradisHubRevealNavItem(nav, item);
		assert.strictEqual(nav.scrollTop, 0);
	});
});
