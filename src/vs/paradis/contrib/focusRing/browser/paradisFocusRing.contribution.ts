/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork の画面で、マウスで押した後に残るフォーカスの枠を消し、キーボードで移ったときだけ出す
// （中身は paradisFocusRing.ts と media/paradisFocusRing.css）。補助ウィンドウ（ブラウザ一覧・エージェント一覧など）にも付ける。

import './media/paradisFocusRing.css';
import { onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { installParadisFocusQuieting } from './paradisFocusRing.js';

class ParadisFocusRingContribution extends Disposable {

	static readonly ID = 'workbench.contrib.paradisFocusRing';

	constructor() {
		super();
		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(installParadisFocusQuieting(window));
		}, { window: mainWindow, disposables: this._store }));
	}
}

registerWorkbenchContribution2(ParadisFocusRingContribution.ID, ParadisFocusRingContribution, WorkbenchPhase.AfterRestored);
