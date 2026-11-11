/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ポートの転送の張り直しの確認（q.html の Q614、案 C）を、UI キットの確認（S 段、paradisConfirmDialog.ts）で描く。
// 中身の文と並びは common/paradisPortReforwardConfirm.ts が決める。
//
// ボタンは「拒否」と「N 件をつなぎ直す」。最初のフォーカス（Enter）と Esc・閉じるは拒否のまま、目立つ色（主）は実行の側に
// 付ける。表示直後の押下と ⌘D の聞き直し・締め切り・自動の断りは、呼ぶ側の承認のサービス（askApproval）が行う。
// 全部の一覧は畳んでおき、開閉は本文の中の <a role="button">（本家の Dialog は本文の a だけを Tab の巡回に入れる）。

import './media/paradisPortReforwardConfirm.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { IParadisAgentApprovalPresentation } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisConfirmServices, paradisConfirm } from '../../confirmDialog/browser/paradisConfirmDialog.js';
import { IParadisReforwardConfirm } from '../common/paradisPortReforwardConfirm.js';

/** 張り直しの確認の箱に付くクラス。 */
export const PARADIS_PORT_REFORWARD_CONFIRM_CLASS = 'paradis-port-reforward-confirm';

let listSerial = 0;

/** 張り直しの確認を出す。拒否・Esc・閉じる・取り消しは 'deny' か undefined。 */
export async function paradisShowReforwardConfirm(services: IParadisConfirmServices, confirm: IParadisReforwardConfirm, presentation: IParadisAgentApprovalPresentation): Promise<'approve' | 'deny' | undefined> {
	const store = new DisposableStore();
	try {
		return await paradisConfirm<'approve' | 'deny'>(services, {
			message: presentation.message,
			detail: presentation.notice,
			buttons: [
				{ label: localize('paradis.portTools.confirm.deny', "拒否"), kind: 'secondary', run: () => 'deny' },
				{ label: confirm.approveLabel, kind: 'primary', run: () => 'approve' },
			],
			cancelIndex: 0,
			extraClasses: [PARADIS_PORT_REFORWARD_CONFIRM_CLASS, presentation.markerClass],
			renderBody: container => paradisRenderReforwardConfirmBody(container, confirm, presentation.paneLabel, store),
			token: presentation.token,
		});
	} finally {
		store.dispose();
	}
}

/** 確認の本文を組む。開閉のリスナーは `store` に入れる。 */
export function paradisRenderReforwardConfirmBody(container: HTMLElement, confirm: IParadisReforwardConfirm, paneLabel: string, store: DisposableStore): void {
	const body = append(container, $('.pprc-body'));

	// 依頼元と理由
	const who = append(body, $('.pprc-who'));
	append(who, renderIcon(Codicon.terminal));
	const whoText = append(who, $('.pprc-who-text'));
	append(whoText, $('div', undefined, localize('paradis.portTools.confirm.pane', "頼んだターミナル: {0}", paneLabel)));
	if (confirm.reason !== undefined) {
		append(whoText, $('div', undefined, confirm.reason));
	}

	// 手元の番号が使用中のため外したもの
	for (const line of confirm.inUse) {
		const note = append(body, $('.pprc-note'));
		append(note, renderIcon(Codicon.info));
		append(note, $('div', undefined, line));
	}

	append(body, $('p.pprc-summary', undefined, confirm.summary));

	// 番号の粒と、一覧の開閉
	const ports = append(body, $('.pprc-ports'));
	for (const chip of confirm.chips) {
		createParadisChip(ports, String(chip.port), chip.changes ? 'warning' : 'neutral').classList.add('pprc-port');
	}
	const listId = `paradis-port-reforward-list-${++listSerial}`;
	const toggle = append(ports, $<HTMLAnchorElement>('a.pprc-toggle', { role: 'button', 'aria-expanded': 'false', 'aria-controls': listId }, confirm.openListLabel));
	toggle.classList.add(...paradisButtonClasses('ghost', true));

	// 番号が変わる行は畳まずに出す
	if (confirm.changed.length > 0) {
		const changed = append(body, $('.pprc-list'));
		for (const line of confirm.changed) {
			append(changed, $('div.changes', undefined, line));
		}
	}

	const list = append(body, $('.pprc-list.pprc-all', { id: listId }));
	list.hidden = true;
	for (const row of confirm.all) {
		append(list, $(row.changes ? 'div.changes' : 'div', undefined, row.text));
	}
	let isOpen = false;
	const setOpen = (open: boolean) => {
		isOpen = open;
		list.hidden = !open;
		toggle.setAttribute('aria-expanded', String(open));
		toggle.textContent = open ? confirm.closeListLabel : confirm.openListLabel;
	};
	store.add(addDisposableListener(toggle, EventType.CLICK, event => {
		event.preventDefault();
		setOpen(!isOpen);
	}));
	store.add(addDisposableListener(toggle, EventType.KEY_DOWN, event => {
		const key = new StandardKeyboardEvent(event);
		if (key.equals(KeyCode.Enter) || key.equals(KeyCode.Space)) {
			// 本家の Dialog の Enter（フォーカスのあるボタンを押す）に渡さない
			key.preventDefault();
			key.stopPropagation();
			setOpen(!isOpen);
		}
	}));

	// この窓・ほかの窓で起きること
	const split = append(body, $('.pprc-split'));
	const effect = (heading: string, text: string, tone: 'warning' | 'success' | 'info') => {
		const panel = append(split, $('.pprc-effect'));
		const title = append(panel, $(`.pprc-effect-heading.${tone}`));
		append(title, renderIcon(tone === 'success' ? Codicon.check : tone === 'warning' ? Codicon.warning : Codicon.info));
		append(title, $('span', undefined, heading));
		append(panel, $('p', undefined, text));
	};
	effect(confirm.thisWindowHeading, confirm.thisWindow, 'warning');
	effect(confirm.otherWindowsHeading, confirm.otherWindows.text, confirm.otherWindows.tone);

	append(body, $('p.pprc-deny', undefined, confirm.denyNote));
}
