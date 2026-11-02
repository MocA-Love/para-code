/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mainWindow } from '../../../../../base/browser/window.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ParadisModalFocus } from '../../browser/paradisModalFocus.js';

/**
 * 別のモーダル（コマンドパレットから開く紐付けのダイアログなど）を開いたときと同じく、普通の ParadisModalFocus を 1 つ開く。
 * 同じウィンドウで開いているモーダルは閉じられる。返り値を dispose すると閉じる。
 */
export function paradisOpenAnotherModal(): IDisposable {
	const backdrop = mainWindow.document.createElement('div');
	const modal = mainWindow.document.createElement('div');
	modal.tabIndex = -1;
	backdrop.appendChild(modal);
	mainWindow.document.body.appendChild(backdrop);
	const focus = new ParadisModalFocus({ backdrop, modal, onEscape: () => { }, close: () => { } });
	return toDisposable(() => {
		backdrop.remove();
		focus.dispose();
	});
}
