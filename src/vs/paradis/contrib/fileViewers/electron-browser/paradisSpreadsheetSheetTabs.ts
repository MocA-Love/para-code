/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel のビューアと比較の下に並べるシートのタブ。UI キットのタブ（paradisTabs.ts、32・muted、選んだものは strong の文字と
// 2px のアクセントの線）で描き、下に置くタブなので線は上端に引く（media/paradisSpreadsheet.css）。Excel のシートの色は、
// キットの線と重ならないよう名前の前の 8px の点にする。役目（tablist・tab・aria-selected）と矢印キーは
// wireParadisOfficeTabList（paradisOfficeAccessibility.ts）が付ける。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { PARADIS_TABS_CLASS, paradisTabClasses, scrollParadisTabsWithWheel } from '../../../browser/paradisTabs.js';
import { setParadisOfficeRowHover } from './paradisOfficeInspectorParts.js';

/**
 * タブを並べる入れ物（`.paradis-spreadsheet-tabs`）をキットのタブの列にする。シートが多くて列があふれたときに、
 * 縦のホイールしかないマウスでも端のタブへ送れるようにする（返す物は入れ物を捨てるときに一緒に捨てる）。
 */
export function styleParadisSpreadsheetSheetTabList(container: HTMLElement): IDisposable {
	container.classList.add(PARADIS_TABS_CLASS);
	return scrollParadisTabsWithWheel(container);
}

export interface IParadisSpreadsheetSheetTabOptions {
	/** タブに出す名前（比較では「(+)」「(-)」の付いた名前）。 */
	readonly label: string;
	/** Excel のシートの色（`#RRGGBB` など）。無ければ点を出さない。 */
	readonly tabColor?: string;
	readonly protectedSheet?: boolean;
}

/**
 * シートのタブを 1 つ足す（キットのタブ）。選んだ状態は `aria-selected` で、wireParadisOfficeTabList が付ける。
 * 保護されたシートでは、タブ全体に本家のホバーで「このシートは保護されています」を出す（`store` はタブを描き直すときに捨てる物）。
 */
export function appendParadisSpreadsheetSheetTab(container: HTMLElement, options: IParadisSpreadsheetSheetTabOptions, store: DisposableStore): HTMLButtonElement {
	const tab = dom.append(container, dom.$('button.paradis-spreadsheet-tab')) as HTMLButtonElement;
	tab.type = 'button';
	tab.classList.add(...paradisTabClasses());
	if (options.tabColor) {
		const dot = dom.append(tab, dom.$('span.paradis-spreadsheet-tab-dot'));
		dot.setAttribute('aria-hidden', 'true');
		// シートごとに違う色なので、ここだけは inline で塗る（Excel のファイルが持つ色で、テーマの色ではない）。
		dot.style.backgroundColor = options.tabColor;
	}
	if (options.protectedSheet) {
		const lock = dom.append(tab, dom.$(`span.paradis-spreadsheet-tab-lock${ThemeIcon.asCSSSelector(Codicon.lock)}`));
		lock.setAttribute('aria-hidden', 'true');
		setParadisOfficeRowHover(tab, localize('paradis.spreadsheet.protected', "このシートは保護されています"), store);
	}
	dom.append(tab, dom.$('span')).textContent = options.label;
	return tab;
}
