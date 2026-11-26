/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 端末の要求の承認で、ペインが上限（10 台）まで端末を持っているときに出す確認。新しい端末を渡す代わりに外す 1 台を、
// 利用者が一覧から選ぶ。UI キットの確認（S 段、paradisConfirmDialog.ts）の本文に、ラジオの一覧を描く。
//
// ボタンは「拒否」と「選んだ端末を外して渡す」。最初のフォーカス（Enter）と Esc・閉じるは拒否のまま。表示直後の押下と
// ⌘D の聞き直し・締め切り・自動の断りは、呼ぶ側の承認のサービス（askApproval）が行う。
// 選ぶ行は本文の中の <a role="radio">（本家の Dialog は本文の a だけを Tab の巡回に入れる）。

import './media/paradisMobileReleasePick.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { PARADIS_AGENT_APPROVAL_DIALOG_CLASS } from '../../agentBrowser/common/paradisAgentApprovalDialog.js';
import { IParadisAgentApprovalPresentation } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisConfirmServices, paradisConfirm } from '../../confirmDialog/browser/paradisConfirmDialog.js';

/** 外す端末を選ぶ確認の箱に付くクラス。 */
export const PARADIS_MOBILE_RELEASE_PICK_CLASS = 'paradis-mobile-release-pick';

/** 確認に出す中身。名前と文は、呼ぶ側が無害化したもの。 */
export interface IParadisMobileReleasePick {
	/** 本文の文（理由・使いたい端末・承認するとできること）。 */
	readonly lines: readonly string[];
	/** 一覧の見出し。 */
	readonly listLabel: string;
	/** 今持っている端末（割り当てた順）。 */
	readonly devices: readonly { readonly id: string; readonly name: string }[];
	readonly approveLabel: string;
	/** 選ばれている端末の id（初めは呼ぶ側が決める。聞き直しでも、選んだものを保つ）。 */
	selectedId: string;
}

/** 外す端末を選ぶ確認を出す。拒否・Esc・閉じる・取り消しは 'deny' か undefined。選んだ端末は `pick.selectedId` に入る。 */
export async function paradisShowMobileReleasePick(services: IParadisConfirmServices, pick: IParadisMobileReleasePick, presentation: IParadisAgentApprovalPresentation): Promise<'approve' | 'deny' | undefined> {
	const store = new DisposableStore();
	try {
		return await paradisConfirm<'approve' | 'deny'>(services, {
			message: presentation.message,
			detail: presentation.notice,
			buttons: [
				{ label: localize('paradis.mobileReleasePick.deny', "拒否"), kind: 'secondary', run: () => 'deny' },
				{ label: pick.approveLabel, kind: 'primary', run: () => 'approve' },
			],
			cancelIndex: 0,
			extraClasses: [PARADIS_AGENT_APPROVAL_DIALOG_CLASS, PARADIS_MOBILE_RELEASE_PICK_CLASS, presentation.markerClass],
			renderBody: container => paradisRenderMobileReleasePickBody(container, pick, store),
			token: presentation.token,
		});
	} finally {
		store.dispose();
	}
}

/** 確認の本文を組む。選ぶ行のリスナーは `store` に入れる。 */
export function paradisRenderMobileReleasePickBody(container: HTMLElement, pick: IParadisMobileReleasePick, store: DisposableStore): void {
	const body = append(container, $('.pmrp-body'));
	for (const line of pick.lines) {
		append(body, $('p', undefined, line));
	}
	append(body, $('p.pmrp-list-label', undefined, pick.listLabel));

	const list = append(body, $('.pmrp-list', { role: 'radiogroup', 'aria-label': pick.listLabel }));
	const options: { readonly id: string; readonly row: HTMLAnchorElement; readonly icon: HTMLElement }[] = [];
	const select = (id: string) => {
		pick.selectedId = id;
		for (const option of options) {
			const checked = option.id === id;
			option.row.setAttribute('aria-checked', String(checked));
			option.row.classList.toggle('checked', checked);
			option.icon.className = `pmrp-radio ${ThemeIcon.asClassName(checked ? Codicon.circleLargeFilled : Codicon.circleLarge)}`;
		}
	};
	for (const device of pick.devices) {
		const row = append(list, $<HTMLAnchorElement>('a.pmrp-option', { role: 'radio', tabindex: '0' }));
		const icon = append(row, $('span.pmrp-radio'));
		append(row, $('span.pmrp-name', undefined, device.name));
		options.push({ id: device.id, row, icon });
		store.add(addDisposableListener(row, EventType.CLICK, event => {
			event.preventDefault();
			select(device.id);
		}));
		store.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
			const key = new StandardKeyboardEvent(event);
			if (key.equals(KeyCode.Enter) || key.equals(KeyCode.Space)) {
				// 本家の Dialog の Enter（フォーカスのあるボタンを押す）に渡さない
				key.preventDefault();
				key.stopPropagation();
				select(device.id);
			}
		}));
	}
	select(pick.selectedId);
}
