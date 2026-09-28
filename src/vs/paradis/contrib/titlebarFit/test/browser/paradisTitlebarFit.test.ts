/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisTitlebarFit } from '../../browser/paradisTitlebarFit.js';

suite('ParadisTitlebarFit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds by the title bar width, follows the visible menu bar, freezes while a panel is open and cleans up', async () => {
		const root = mainWindow.document.createElement('div');
		const left = mainWindow.document.createElement('div');
		root.appendChild(left);
		mainWindow.document.body.appendChild(root);
		const trigger = mainWindow.document.createElement('button');
		left.appendChild(trigger);

		const observers: TestResizeObserver[] = [];
		const fit = createParadisTitlebarFit(root, left, {
			resizeObserverCtor: class extends TestResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					super(callback);
					observers.push(this);
				}
			}
		});
		const observer = observers[0];
		const classes = () => [...root.classList].sort().join(' ');
		const resize = async (width: number) => {
			root.style.width = `${width}px`;
			await flushMutations();
			observer.fire();
			return classes();
		};

		try {
			const wide = await resize(1500);
			const narrow = await resize(1100);

			// パネルを開いているあいだは段を止め、閉じたら追いつく
			trigger.classList.add('active');
			await flushMutations();
			const frozen = await resize(900);
			trigger.classList.remove('active');
			await flushMutations();
			const caughtUp = classes();

			// メニューバーは要素の有無ではなく見えているか (幅があるか) で見る。付け替わったら観測先も移す
			const firstMenubar = appendMenubar(left, 200);
			await flushMutations();
			const menubarVisible = classes();
			const observedFirst = observer.observedMenubars();
			firstMenubar.style.display = 'none';
			observer.fire();
			const menubarHidden = classes();
			firstMenubar.remove();
			appendMenubar(left, 120);
			await flushMutations();
			const replaced = classes();
			const observedAfterReplace = observer.observedMenubars();

			fit.dispose();

			assert.deepStrictEqual({ wide, narrow, frozen, caughtUp, menubarVisible, observedFirst, menubarHidden, replaced, observedAfterReplace, afterDispose: classes(), disconnected: observer.disconnected }, {
				wide: '',
				narrow: 'paradis-fit-1200 paradis-fit-1400',
				frozen: 'paradis-fit-1200 paradis-fit-1400',
				caughtUp: 'paradis-fit-1000 paradis-fit-1200 paradis-fit-1400',
				menubarVisible: 'paradis-fit-1000 paradis-fit-1200 paradis-fit-1400 paradis-fit-menubar-visible',
				observedFirst: [200],
				menubarHidden: 'paradis-fit-1000 paradis-fit-1200 paradis-fit-1400',
				replaced: 'paradis-fit-1000 paradis-fit-1200 paradis-fit-1400 paradis-fit-menubar-visible',
				observedAfterReplace: [120],
				afterDispose: '',
				disconnected: true,
			});
		} finally {
			fit.dispose();
			root.remove();
		}
	});
});

function appendMenubar(left: HTMLElement, width: number): HTMLElement {
	const menubar = mainWindow.document.createElement('div');
	menubar.className = 'menubar';
	menubar.style.display = 'block';
	menubar.style.width = `${width}px`;
	menubar.style.height = '10px';
	menubar.dataset.testWidth = String(width);
	left.appendChild(menubar);
	return menubar;
}

/** MutationObserver の通知はマイクロタスクで届くので、それが済むまで待つ。 */
function flushMutations(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

/** 通知を手で起こせる ResizeObserver。observe した要素を覚えておく。 */
class TestResizeObserver implements ResizeObserver {
	private readonly observed = new Set<Element>();
	disconnected = false;

	constructor(private readonly callback: ResizeObserverCallback) { }

	observe(target: Element): void {
		this.observed.add(target);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	disconnect(): void {
		this.observed.clear();
		this.disconnected = true;
	}

	fire(): void {
		this.callback([], this);
	}

	/** 観測中のメニューバー (幅で見分ける)。 */
	observedMenubars(): number[] {
		return [...this.observed].filter(element => element.classList.contains('menubar')).map(element => Number((element as HTMLElement).dataset.testWidth));
	}
}
