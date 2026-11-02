/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量ダイアログの「スペース別」「作業実績」タブで、集計し直している間を見せる印。
//
// 期間を替えると会話ログを集計し直す（90 日だと数十秒かかることがある）。前の結果は薄くして残すが、
// それだけだと押したのに何も起きていないように見えるので、パネルの上端に細い進捗線を流し、
// ツールバーに「90 日分を集計しています…」と出す。

import * as dom from '../../../../base/browser/dom.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisActivityRangeDays } from './paradisActivityRange.js';

const $ = dom.$;

/**
 * パネルの上端の進捗線と、ツールバーの「集計しています…」の表示をまとめて出し入れする。
 */
export class ParadisActivityBusyIndicator extends Disposable {

	private readonly progressBar: ProgressBar;
	private readonly label: HTMLElement;
	private readonly labelText: HTMLElement;
	private busy = false;

	/**
	 * @param panel 進捗線を重ねるパネル（上端に重ねるので、パネルの高さは変わらない）。
	 * @param toolbar 文言を置くツールバー。
	 * @param before 文言をこの要素の前に置く（無ければツールバーの末尾）。
	 */
	constructor(panel: HTMLElement, toolbar: HTMLElement, before: HTMLElement | undefined) {
		super();
		const progressHost = $('.paradis-activity-progress');
		panel.prepend(progressHost);
		this.progressBar = this._register(new ProgressBar(progressHost, defaultProgressBarStyles));
		this.progressBar.hide();

		this.label = $('span.paradis-activity-busy');
		this.label.setAttribute('role', 'status');
		this.label.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.loading)}.codicon-modifier-spin`));
		this.labelText = dom.append(this.label, $('span'));
		this.label.style.display = 'none';
		toolbar.insertBefore(this.label, before ?? null);
	}

	/**
	 * 集計中かどうかを伝える。`showLabel` が false のとき（まだ一度も結果が無く、本文に「集計しています」を
	 * 出しているとき）はツールバーの文言を出さず、進捗線だけにする。
	 */
	setBusy(busy: boolean, rangeDays: ParadisActivityRangeDays, showLabel: boolean): void {
		if (busy) {
			// allow-any-unicode-next-line
			this.labelText.textContent = localize('paradis.activity.busy', "{0} 日分を集計しています…", rangeDays);
		}
		this.label.style.display = busy && showLabel ? '' : 'none';
		if (busy === this.busy) {
			return;
		}
		this.busy = busy;
		if (busy) {
			this.progressBar.infinite().show();
		} else {
			this.progressBar.stop().hide();
		}
	}
}
