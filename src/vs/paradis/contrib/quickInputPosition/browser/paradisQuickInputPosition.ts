/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * 位置を一度だけ移し終えた印。fork 自前のキーで持ち、upstream の位置 (`workbench.quickInput.viewState`) は読まない。
 * upstream と同じく APPLICATION / MACHINE (位置はウィンドウの大きさに対する割合で、マシンごとのもの)。
 */
export const PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY = 'paradis.quickInput.centered';

/**
 * コマンドパレット・ファイルに移動・名前の変更などの quick input を、upstream の「中央」(上端が窓の高さの 25%。
 * 「レイアウトのカスタマイズ」の Quick Input Position: Center と同じ) に一度だけ移す (Q593 案 B)。
 *
 * - 位置は upstream が `workbench.quickInput.viewState` に保存するので、ここでは最初の 1 回 `setAlignment('center')` を
 *   呼ぶだけ。後で利用者が題名をつかんで動かした位置・ダブルクリックで上に戻した位置はそのまま効く
 * - upstream のドラッグの仕組みは quick input を初めて開いたときに作られ、それより前の `setAlignment` は効かない。
 *   そこで最初に開いたとき (`onShow`) に呼ぶ。開く処理の中で同期に呼ぶので、上に出てから下がる様子は見えない
 * - 利用者が既に動かしていた (`custom`) か中央にしていた場合は触らず、印だけ付ける
 * - 部品の横に出すもの (anchor・overlay) は upstream が位置を決め、`setAlignment` も効かないので、次に開いたときに回す
 * - 補助ウィンドウでは upstream が位置を保存しないので、メインのウィンドウで開いたときだけ移す
 */
export class ParadisQuickInputPosition extends Disposable {

	static readonly ID = 'workbench.contrib.paradisQuickInputPosition';

	private readonly showListener = this._register(new MutableDisposable());

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		if (this.storageService.getBoolean(PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		this.showListener.value = this.quickInputService.onShow(() => this.onDidShow());
	}

	private onDidShow(): void {
		if (this.quickInputService.currentQuickInput?.anchor !== undefined) {
			return;
		}
		if (this.layoutService.activeContainer !== this.layoutService.mainContainer) {
			return;
		}
		if (this.quickInputService.alignment.get() === 'top') {
			this.quickInputService.setAlignment('center');
			if (this.quickInputService.alignment.get() !== 'center') {
				return; // 動かせなかった。印を付けず、次に開いたときにやり直す
			}
		}
		this.storageService.store(PARADIS_QUICK_INPUT_CENTERED_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.showListener.clear();
	}
}
