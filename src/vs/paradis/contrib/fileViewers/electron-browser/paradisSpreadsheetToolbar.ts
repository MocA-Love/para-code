/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分のヘッダーで共有する小物(既定アプリで開くボタン、アイコンボタン)。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

const $ = dom.$;

/** ヘッダー用のアイコンボタンを作る。 */
export function appendIconButton(parent: HTMLElement, icon: ThemeIcon, title: string, disposables: DisposableStore, onClick: () => void): HTMLButtonElement {
	const button = dom.append(parent, $('button.paradis-spreadsheet-iconbtn')) as HTMLButtonElement;
	button.title = title;
	dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
	disposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, onClick));
	return button;
}

/** ローカルファイル(file スキーム)なら「既定アプリで開く」ボタンを追加する。 */
export function appendOpenInAppButton(parent: HTMLElement, resource: URI | undefined, nativeHostService: INativeHostService, disposables: DisposableStore): void {
	if (!resource || resource.scheme !== Schemas.file) {
		return;
	}
	// allow-any-unicode-next-line
	appendIconButton(parent, Codicon.linkExternal, localize('paradis.spreadsheet.openInApp', "既定のアプリで開く"), disposables, () => {
		void nativeHostService.openExternal(resource.toString(true));
	});
}
