/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IQuickAccessController } from '../../../../../platform/quickinput/common/quickAccess.js';
import { IQuickInput, IQuickInputService, QuickInputAlignment } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, ParadisQuickInputPosition } from '../../browser/paradisQuickInputPosition.js';
import { recenterQuickInput } from '../../browser/paradisQuickInputRecenter.js';
import { ParadisQuickInputScrim } from '../../browser/paradisQuickInputScrim.js';
import { mainWindow } from '../../../../../base/browser/window.js';

/**
 * upstream の QuickInputService のうち、位置の移し替えと幕が使う所だけ。setAlignment は anchored のときと、
 * 一度も開いていない (upstream のドラッグの仕組みが無い) とき何もしない (upstream と同じ)。
 */
class TestQuickInputService {
	private readonly showEmitter = new Emitter<void>();
	readonly onShow = this.showEmitter.event;
	private readonly hideEmitter = new Emitter<void>();
	readonly onHide = this.hideEmitter.event;
	cancelled = 0;
	readonly alignment = observableValue<QuickInputAlignment>('alignment', 'top');
	currentQuickInput: Partial<IQuickInput> | undefined;
	readonly calls: string[] = [];
	opened = true;
	readonly quickAccess: IQuickAccessController = {
		show: (prefix?: string) => {
			this.calls.push(`open ${prefix}`);
			this.show({});
		},
		pick: async () => undefined,
	};

	setAlignment(alignment: 'top' | 'center'): void {
		this.calls.push(alignment);
		if (this.opened && this.currentQuickInput?.anchor === undefined) {
			this.alignment.set(alignment, undefined);
		}
	}

	show(input: Partial<IQuickInput>, alignment?: QuickInputAlignment): void {
		this.opened = true;
		this.currentQuickInput = input;
		if (alignment) {
			this.alignment.set(alignment, undefined);
		}
		this.showEmitter.fire();
	}

	fireHide(): void {
		this.hideEmitter.fire();
	}

	async cancel(): Promise<void> {
		this.cancelled++;
		this.currentQuickInput = undefined;
		this.hideEmitter.fire();
	}

	dispose(): void {
		this.showEmitter.dispose();
		this.hideEmitter.dispose();
	}
}

suite('ParadisQuickInputPosition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(steps: (quickInput: TestQuickInputService, layout: { activeContainer: object; mainContainer: object }) => void, alreadyMoved = false) {
		const disposables = new DisposableStore();
		try {
			const storage = disposables.add(new InMemoryStorageService());
			if (alreadyMoved) {
				storage.store(PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			const quickInput = disposables.add(new TestQuickInputService());
			const mainContainer = {};
			const layout = { mainContainer, activeContainer: mainContainer };
			disposables.add(new ParadisQuickInputPosition(quickInput as Partial<IQuickInputService> as IQuickInputService, storage, layout as Partial<ILayoutService> as ILayoutService));
			steps(quickInput, layout);
			return { calls: quickInput.calls, alignment: quickInput.alignment.get(), marked: storage.getBoolean(PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, StorageScope.APPLICATION, false) };
		} finally {
			disposables.dispose();
		}
	}

	test('moves the first quick input of the main window to the center once, and leaves anchored, auxiliary and user positions alone', () => {
		assert.deepStrictEqual({
			// 上 → 中央。2 回目に開いても呼ばない
			fromTop: run(quickInput => {
				quickInput.show({});
				quickInput.show({});
			}),
			// 利用者が動かした位置は触らず、印だけ付ける
			userMoved: run(quickInput => quickInput.show({}, 'custom')),
			// 部品の横に出すもの (upstream が位置を custom と報告する) は飛ばし、次に開いたときに移す
			anchoredFirst: run(quickInput => {
				quickInput.show({ anchor: { x: 1, y: 1 } }, 'custom');
				quickInput.show({}, 'top');
			}),
			anchoredOnly: run(quickInput => quickInput.show({ anchor: { x: 1, y: 1 } }, 'custom')),
			// 補助ウィンドウでは upstream が位置を保存しないので、印を付けずにメインのウィンドウを待つ
			auxiliaryWindow: run((quickInput, layout) => {
				layout.activeContainer = {};
				quickInput.show({});
			}),
			// 前に移し終えていれば、上に戻した後でも触らない
			alreadyMoved: run(quickInput => quickInput.show({}), true),
		}, {
			fromTop: { calls: ['center'], alignment: 'center', marked: true },
			userMoved: { calls: [], alignment: 'custom', marked: true },
			anchoredFirst: { calls: ['center'], alignment: 'center', marked: true },
			anchoredOnly: { calls: [], alignment: 'custom', marked: false },
			auxiliaryWindow: { calls: [], alignment: 'top', marked: false },
			alreadyMoved: { calls: [], alignment: 'top', marked: true },
		});
	});
});

suite('recenterQuickInput', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(prepare: (quickInput: TestQuickInputService) => void) {
		const quickInput = new TestQuickInputService();
		try {
			prepare(quickInput);
			quickInput.calls.length = 0;
			recenterQuickInput(quickInput as Partial<IQuickInputService> as IQuickInputService);
			return { calls: quickInput.calls, alignment: quickInput.alignment.get() };
		} finally {
			quickInput.dispose();
		}
	}

	test('moves a quick input left near the top back to the center, and opens the command palette first when the position cannot be moved yet', () => {
		assert.deepStrictEqual({
			// 前にドラッグした位置 (custom) のまま閉じている。コマンドパレットから実行したときもこれ
			customWhileClosed: run(quickInput => {
				quickInput.show({}, 'custom');
				quickInput.currentQuickInput = undefined;
			}),
			// 一度も開いていない: パレットを開いてから中央に置く
			neverOpened: run(quickInput => {
				quickInput.opened = false;
			}),
			// 部品の横に出すものが開いている: パレットに替えてから中央に置く
			anchoredShown: run(quickInput => quickInput.show({ anchor: { x: 1, y: 1 } }, 'custom')),
		}, {
			customWhileClosed: { calls: ['center'], alignment: 'center' },
			neverOpened: { calls: ['center', 'open >', 'center'], alignment: 'center' },
			anchoredShown: { calls: ['center', 'open >', 'center'], alignment: 'center' },
		});
	});
});

suite('ParadisQuickInputScrim', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dims the window under a centered quick input only, and a press on it closes the quick input without reaching what is underneath', async () => {
		const disposables = new DisposableStore();
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		try {
			const quickInput = disposables.add(new TestQuickInputService());
			disposables.add(new ParadisQuickInputScrim(quickInput as Partial<IQuickInputService> as IQuickInputService, { activeContainer: container } as Partial<ILayoutService> as ILayoutService));
			const scrims = () => [...container.children].map(element => element.className);
			const hide = () => {
				quickInput.currentQuickInput = undefined;
				quickInput.fireHide();
			};

			quickInput.show({});
			const shown = scrims();
			quickInput.show({ title: 'next' });
			const replaced = scrims();
			hide();
			const hidden = scrims();
			quickInput.show({ anchor: { x: 1, y: 1 } });
			const anchored = scrims();
			quickInput.show({ ignoreFocusOut: true });
			const ignoreFocusOut = scrims();

			// 押す → 閉じる。離すまで幕は残り、click は幕で止まる
			quickInput.show({});
			const scrim = container.firstElementChild as HTMLElement;
			let clicksBelow = 0;
			const onBodyClick = () => clicksBelow++;
			mainWindow.document.body.addEventListener('click', onBodyClick);
			scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
			const whilePressed = { scrims: scrims(), cancelled: quickInput.cancelled };
			scrim.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
			scrim.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			await new Promise(resolve => setTimeout(resolve, 0));
			mainWindow.document.body.removeEventListener('click', onBodyClick);

			assert.deepStrictEqual({ shown, replaced, hidden, anchored, ignoreFocusOut, whilePressed, released: scrims(), clicksBelow }, {
				shown: ['paradis-quick-input-scrim paradis-modal-backdrop'],
				replaced: ['paradis-quick-input-scrim paradis-modal-backdrop'],
				hidden: [],
				anchored: [],
				ignoreFocusOut: [],
				whilePressed: { scrims: ['paradis-quick-input-scrim paradis-modal-backdrop'], cancelled: 1 },
				released: [],
				clicksBelow: 0,
			});
		} finally {
			disposables.dispose();
			container.remove();
		}
	});
});
