/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
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
			scheduleFrame,
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

	test('folds one more level at a time until a free span of 40px is left to drag the window, and only as far as needed', async () => {
		const doc = mainWindow.document;
		const style = doc.createElement('style');
		// 段ごとに隠す部品 (本物の規則は paradisTitlebarFit.css。ここでは段の数え方だけを見る)
		style.textContent = '.t-root.paradis-fold-1 .t-a, .t-root.paradis-fold-2 .t-b, .t-root.paradis-fold-3 .t-c { display: none; }';
		doc.head.appendChild(style);
		const root = doc.createElement('div');
		root.className = 't-root';
		root.style.cssText = 'display: flex; width: 600px; height: 30px;';
		const left = doc.createElement('div');
		left.style.cssText = 'display: flex; width: 300px; flex: none;';
		const center = doc.createElement('div');
		center.className = 'titlebar-center';
		center.style.cssText = 'display: flex; width: 200px; flex: none;';
		const windowTitle = doc.createElement('div');
		windowTitle.className = 'window-title';
		const commandCenter = doc.createElement('div');
		commandCenter.className = 'command-center';
		commandCenter.style.cssText = 'width: 200px;';
		windowTitle.appendChild(commandCenter);
		center.appendChild(windowTitle);
		const right = doc.createElement('div');
		right.className = 'titlebar-right';
		right.style.cssText = 'display: flex; width: 100px; flex: none;';
		root.append(left, center, right);
		doc.body.appendChild(root);
		const item = (className: string, width: number, parent: HTMLElement) => {
			const element = doc.createElement('div');
			element.className = className;
			element.style.cssText = `width: ${width}px; flex: none;`;
			parent.appendChild(element);
			return element;
		};
		item('t-a', 60, left);
		item('t-b', 100, left);
		const last = item('t-c', 120, left);
		const rightItem = item('t-right', 100, right);

		const observers: TestResizeObserver[] = [];
		const fit = createParadisTitlebarFit(root, left, {
			scheduleFrame,
			resizeObserverCtor: class extends TestResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					super(callback);
					observers.push(this);
				}
			}
		});
		const folds = () => [...root.classList].filter(name => name.startsWith('paradis-fold-')).sort().join(' ');
		try {
			// 空き 20px → 1 段 (t-a を隠すと 80px 空く) で止まる
			observers[0].fire();
			const oneLevel = folds();
			// t-c が広がって 1 段では 20px しか空かない → 2 段 (t-b) まで
			last.style.width = '220px';
			await flushMutations();
			observers[0].fire();
			const twoLevels = folds();
			// 畳めない部品で埋まっている → 最後の段まで畳む
			const fixed = item('t-fixed', 300, left);
			await flushMutations();
			observers[0].fire();
			const allLevels = folds();
			// 空きが十分なら畳まない
			fixed.remove();
			last.style.width = '20px';
			await flushMutations();
			observers[0].fire();
			const none = folds();
			// 右側の子 (通知の件数など) が広がると、外枠の幅が同じでも測り直して段を上げる
			last.style.width = '140px';
			rightItem.style.width = '40px';
			await flushMutations();
			observers[0].fire();
			const rightNarrow = folds();
			rightItem.style.width = '100px';
			rightItem.textContent = '3';
			await flushMutations();
			const rightGrew = folds();
			fit.dispose();
			assert.deepStrictEqual({ oneLevel, twoLevels, allLevels, none, rightNarrow, rightGrew, afterDispose: folds() }, {
				oneLevel: 'paradis-fold-1',
				twoLevels: 'paradis-fold-1 paradis-fold-2',
				allLevels: 'paradis-fold-1 paradis-fold-2 paradis-fold-3 paradis-fold-4 paradis-fold-5',
				none: '',
				rightNarrow: '',
				rightGrew: 'paradis-fold-1',
				afterDispose: '',
			});
		} finally {
			fit.dispose();
			root.remove();
			style.remove();
		}
	});

	test('narrows the command center as the last fold, when folding the fork widgets still leaves no room to drag the window', async () => {
		const doc = mainWindow.document;
		const style = doc.createElement('style');
		// 本物の規則は paradisTitlebarFit.css の fold 5 (38vw → max(160px, 24vw))。ここでは段の数え方と、縮めた幅を空きに数えることだけを見る
		style.textContent = '.t-root.paradis-fold-5 .command-center { width: 140px !important; }';
		doc.head.appendChild(style);
		const root = doc.createElement('div');
		root.className = 't-root';
		root.style.cssText = 'display: flex; width: 600px; height: 30px;';
		const left = doc.createElement('div');
		left.style.cssText = 'display: flex; width: 300px; flex: none;';
		const center = doc.createElement('div');
		center.className = 'titlebar-center';
		center.style.cssText = 'display: flex; width: 200px; flex: none;';
		const windowTitle = doc.createElement('div');
		windowTitle.className = 'window-title';
		const commandCenter = doc.createElement('div');
		commandCenter.className = 'command-center';
		commandCenter.style.cssText = 'width: 200px;';
		windowTitle.appendChild(commandCenter);
		center.appendChild(windowTitle);
		const right = doc.createElement('div');
		right.className = 'titlebar-right';
		right.style.cssText = 'display: flex; width: 100px; flex: none;';
		root.append(left, center, right);
		doc.body.appendChild(root);
		// 畳めない部品 (利用リミットのロゴなど) で左右が埋まっている。コマンドセンターとの空きは 10px と 0px
		for (const [parent, width] of [[left, 290], [right, 100]] as const) {
			const element = doc.createElement('div');
			element.style.cssText = `width: ${width}px; flex: none;`;
			parent.appendChild(element);
		}

		const observers: TestResizeObserver[] = [];
		const fit = createParadisTitlebarFit(root, left, {
			scheduleFrame,
			resizeObserverCtor: class extends TestResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					super(callback);
					observers.push(this);
				}
			}
		});
		try {
			observers[0].fire();
			const folds = [...root.classList].filter(name => name.startsWith('paradis-fold-')).sort().join(' ');
			assert.deepStrictEqual({ folds, commandCenterWidth: commandCenter.getBoundingClientRect().width }, {
				folds: 'paradis-fold-1 paradis-fold-2 paradis-fold-3 paradis-fold-4 paradis-fold-5',
				commandCenterWidth: 140,
			});
		} finally {
			fit.dispose();
			root.remove();
			style.remove();
		}
	});

	test('without the command center, folds while the window title text in the center is cut off, and measures again when the title changes', async () => {
		const doc = mainWindow.document;
		const style = doc.createElement('style');
		// 段ごとに隠す部品 (本物の規則は paradisTitlebarFit.css)。中央の文字は upstream と同じく縮んで省略記号になる
		style.textContent = '.t-root.paradis-fold-1 .t-a, .t-root.paradis-fold-2 .t-b { display: none; }';
		doc.head.appendChild(style);
		const root = doc.createElement('div');
		root.className = 't-root';
		root.style.cssText = 'display: flex; height: 30px; font: 10px monospace;';
		const left = doc.createElement('div');
		left.style.cssText = 'display: flex; flex: none;';
		const center = doc.createElement('div');
		center.className = 'titlebar-center';
		center.style.cssText = 'display: flex; flex: 0 1 auto; min-width: 0;';
		const windowTitle = doc.createElement('div');
		windowTitle.className = 'window-title';
		windowTitle.style.cssText = 'flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;';
		windowTitle.textContent = 'para (Workspace) [SSH: host]';
		center.appendChild(windowTitle);
		const right = doc.createElement('div');
		right.className = 'titlebar-right';
		right.style.cssText = 'display: flex; flex: none;';
		root.append(left, center, right);
		doc.body.appendChild(root);
		for (const [className, width, parent] of [['t-a', 100, left], ['t-b', 100, left], ['t-right', 50, right]] as const) {
			const element = doc.createElement('div');
			element.className = className;
			element.style.cssText = `width: ${width}px; flex: none;`;
			parent.appendChild(element);
		}
		const titleWidth = windowTitle.scrollWidth;

		const observers: TestResizeObserver[] = [];
		const fit = createParadisTitlebarFit(root, left, {
			scheduleFrame,
			resizeObserverCtor: class extends TestResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					super(callback);
					observers.push(this);
				}
			}
		});
		const folds = () => [...root.classList].filter(name => name.startsWith('paradis-fold-')).sort().join(' ');
		const resize = (width: number) => {
			root.style.width = `${width}px`;
			observers[0].fire();
			return folds();
		};
		try {
			// 文字が収まる幅では畳まない (空きの計算に文字は入れないので、ドラッグの空きは足りている)
			const fits = resize(250 + titleWidth + 10);
			// 文字が 50px 切れる → 1 段 (t-a の 100px) 畳めば収まる
			const cutOff = resize(250 + titleWidth - 50);
			// 窓の幅は同じまま、タイトルが 1 段では収まらないほど長くなった → 2 段まで
			windowTitle.textContent = 'para (Workspace) [SSH: host] - Para Code';
			await flushMutations();
			const longerTitle = folds();
			// コマンドセンターを出しているあいだは、文字の長さでは畳まない
			windowTitle.textContent = '';
			const commandCenter = doc.createElement('div');
			commandCenter.className = 'command-center';
			commandCenter.style.cssText = 'width: 10px;';
			windowTitle.appendChild(commandCenter);
			await flushMutations();
			const withCommandCenter = folds();
			assert.deepStrictEqual({ fits, cutOff, longerTitle, withCommandCenter }, {
				fits: '',
				cutOff: 'paradis-fold-1',
				longerTitle: 'paradis-fold-1 paradis-fold-2',
				withCommandCenter: '',
			});
		} finally {
			fit.dispose();
			root.remove();
			style.remove();
		}
	});

	test('measures the fold again once per frame, and not at all while the title bar keeps its widths (the CPU/RAM text changes every second)', async () => {
		const doc = mainWindow.document;
		const root = doc.createElement('div');
		root.style.cssText = 'display: flex; width: 600px; height: 30px;';
		const left = doc.createElement('div');
		left.style.cssText = 'display: flex; width: 300px; flex: none;';
		root.appendChild(left);
		doc.body.appendChild(root);
		const usage = doc.createElement('div');
		usage.style.cssText = 'width: 120px; flex: none;';
		usage.textContent = 'CPU 12%';
		left.appendChild(usage);

		const observers: TestResizeObserver[] = [];
		let measured = 0;
		const fit = createParadisTitlebarFit(root, left, {
			scheduleFrame,
			resizeObserverCtor: class extends TestResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					super(callback);
					observers.push(this);
				}
			},
			onDidMeasureFold: () => measured++,
		});
		try {
			observers[0].fire();
			const first = measured;
			// 文字だけ変わって幅は同じ (3 回書き換えても 1 フレームにまとまり、測り直さない)
			usage.textContent = 'CPU 13%';
			usage.firstChild!.textContent = 'CPU 14%';
			usage.textContent = 'CPU 15%';
			await flushMutations();
			const sameWidth = measured - first;
			// 幅も変わる書き換えを 3 回 → 1 フレームで 1 回だけ測る
			usage.style.width = '140px';
			usage.textContent = 'CPU 100%';
			usage.textContent = 'CPU 99%';
			usage.textContent = 'CPU 98%';
			await flushMutations();
			const widthChanged = measured - first;
			assert.deepStrictEqual({ first, sameWidth, widthChanged }, { first: 1, sameWidth: 0, widthChanged: 1 });
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

/** MutationObserver の通知はマイクロタスクで届き、update は {@link scheduleFrame} の次の回にまとめられるので、両方が済むまで待つ。 */
function flushMutations(): Promise<void> {
	return new Promise(resolve => setTimeout(() => setTimeout(resolve, 0), 0));
}

/** テストでは描画のフレームの代わりに次のタスクで走らせる (見えていない窓ではフレームが来ないことがある)。 */
function scheduleFrame(runner: () => void): IDisposable {
	const handle = setTimeout(runner, 0);
	return toDisposable(() => clearTimeout(handle));
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
