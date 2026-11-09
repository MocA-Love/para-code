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
import { IQuickInput, IQuickInputService, QuickInputAlignment } from '../../../../../platform/quickinput/common/quickInput.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, ParadisQuickInputPosition } from '../../browser/paradisQuickInputPosition.js';

/** upstream の QuickInputService のうち、位置の移し替えが使う所だけ。setAlignment は anchored のとき何もしない (upstream と同じ)。 */
class TestQuickInputService {
	private readonly showEmitter = new Emitter<void>();
	readonly onShow = this.showEmitter.event;
	readonly alignment = observableValue<QuickInputAlignment>('alignment', 'top');
	currentQuickInput: Partial<IQuickInput> | undefined;
	readonly calls: string[] = [];

	setAlignment(alignment: 'top' | 'center'): void {
		this.calls.push(alignment);
		if (this.currentQuickInput?.anchor === undefined) {
			this.alignment.set(alignment, undefined);
		}
	}

	show(input: Partial<IQuickInput>, alignment?: QuickInputAlignment): void {
		this.currentQuickInput = input;
		if (alignment) {
			this.alignment.set(alignment, undefined);
		}
		this.showEmitter.fire();
	}

	dispose(): void {
		this.showEmitter.dispose();
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
				quickInput.show({}, 'top');
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
