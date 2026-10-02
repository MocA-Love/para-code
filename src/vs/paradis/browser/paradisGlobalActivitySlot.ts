/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アクティビティバーの左下（アカウントと設定の歯車の間）に fork のボタンを差し込む口。
//
// upstream の `globalCompositeBar.ts` は、アカウントと歯車の 2 つを決め打ちで並べ、知らないボタンは
// エラーにする。そこへの PARA-PATCH は「この口に問い合わせる」だけにして、ボタンの本体は登録した側
// （今はファイル転送: `contrib/fileTransfer/electron-browser/paradisFileTransferActivity.ts`）に置く。
// 特定の機能に依存しないよう、ここは base と platform だけを import する。
//
// Web にも載る（globalCompositeBar.ts が import する）ので、Electron の物を import しない。
// 登録はモジュールの読み込み時に行う（アクティビティバーが作られる前に、集約 import で読み込まれる）。
// 何も登録されない Web と Agent Sessions ウィンドウでは、左下は upstream のまま。

import { IActionViewItem } from '../../base/browser/ui/actionbar/actionbar.js';
import { IActionViewItemOptions } from '../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, IAction } from '../../base/common/actions.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';

export interface IParadisGlobalActivityEntry {
	/** ボタンの ID。ActionBar に積む Action の ID になる。 */
	readonly id: string;
	/**
	 * 表示部品を作る。`options` は upstream がアカウント・歯車に渡すもの（`ICompositeBarActionViewItemOptions`。
	 * ここは workbench を import しないので、受け取る側で確かめて使う）。
	 */
	createViewItem(instantiationService: IInstantiationService, options: IActionViewItemOptions): IActionViewItem;
}

const entries: IParadisGlobalActivityEntry[] = [];

/** ボタンを登録する。アクティビティバーが作られた後の登録は、次に作られるまで反映されない。 */
export function registerParadisGlobalActivityEntry(entry: IParadisGlobalActivityEntry): IDisposable {
	entries.push(entry);
	return toDisposable(() => {
		const index = entries.indexOf(entry);
		if (index >= 0) {
			entries.splice(index, 1);
		}
	});
}

/** ActionBar に積む Action（アカウントの後ろ・歯車の前）。後片付けは `store` に任せる。 */
export function paradisGlobalActivityActions(store: DisposableStore): IAction[] {
	return entries.map(entry => store.add(new Action(entry.id)));
}

/** fork のボタンなら表示部品を作る。違えば undefined（upstream の分岐へ進む）。 */
export function paradisCreateGlobalActivityViewItem<TOptions extends IActionViewItemOptions>(action: IAction, instantiationService: IInstantiationService, options: TOptions): IActionViewItem | undefined {
	const entry = entries.find(candidate => candidate.id === action.id);
	return entry?.createViewItem(instantiationService, options);
}
