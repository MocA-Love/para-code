/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「接続先のターミナルを終わらせて更新しますか？」の確認。
//
// 接続先ごとに枠を分け、エージェント（作業中・許可待ちを先頭）→何か実行中→待機中の順に並べる。
// macOS の既定（ネイティブのダイアログ）では任意の部品を置けないので、fork の自前モーダル
// （`ParadisModalFocus`）で描く。答えずに閉じた・30 秒過ぎたときは「あとで更新」。
// 箱は UI キットの S のモーダルの 3 段（見出しの帯・本文・ボタンの帯）、ボタンは ParadisButton、札は paradis-chip。

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import {
	IParadisUpdateTerminalSummary,
	ParadisUpdateConfirmAnswer,
	paradisUpdateGroupCount,
	paradisUpdateHostRows,
	paradisUpdateTerminalLabel,
	paradisUpdateTerminalTag,
	paradisWorkingAgentKinds,
} from '../common/paradisUpdateTerminals.js';
import './media/paradisUpdateTerminals.css';
import { PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { createParadisChip, ParadisChipTone } from '../../../browser/paradisBadges.js';

const $ = dom.$;

/** 札の色の種類（作業中は警告色、待っているものは危険色）を UI キットの札の色に当てる。 */
const CHIP_TONE: { readonly [tone in ReturnType<typeof paradisUpdateTerminalTag>['tone']]: ParadisChipTone } = {
	work: 'warning',
	ask: 'danger',
	plain: 'neutral',
};

/** 開くたびに別の id を振る（同じ id の要素が2つ並ばないように）。 */
let dialogSequence = 0;

export interface IParadisUpdateTerminalsDialog {
	readonly answer: Promise<ParadisUpdateConfirmAnswer>;
	/** 外から畳む（30 秒過ぎたとき）。答えは「あとで更新」になる。 */
	close(): void;
}

function titleFor(summary: IParadisUpdateTerminalSummary): { title: string; detail: string } {
	const hasRemote = summary.groups.some(group => group.isRemote);
	const hasLocal = summary.groups.some(group => !group.isRemote);
	if (hasRemote && hasLocal) {
		return {
			title: localize('paradis.updateTerminals.title.both', "接続先と常駐のターミナルを終わらせて更新しますか？"),
			detail: localize('paradis.updateTerminals.detail.both', "更新すると接続先のサーバーとこの PC の常駐が新しい版に替わるため、残しても開き直せません。次のものが終了します。"),
		};
	}
	if (hasLocal) {
		return {
			title: localize('paradis.updateTerminals.title.local', "常駐のターミナルを終わらせて更新しますか？"),
			detail: localize('paradis.updateTerminals.detail.local', "更新するとこの PC の常駐が新しい版に替わるため、残しても開き直せません。次のものが終了します。"),
		};
	}
	return {
		title: localize('paradis.updateTerminals.title', "接続先のターミナルを終わらせて更新しますか？"),
		detail: localize('paradis.updateTerminals.detail', "更新すると接続先のサーバーが新しい版に替わるため、残しても開き直せません。次のものが終了します。"),
	};
}

export function paradisShowUpdateTerminalsDialog(container: HTMLElement, summary: IParadisUpdateTerminalSummary): IParadisUpdateTerminalsDialog {
	let finish: (answer: ParadisUpdateConfirmAnswer) => void = () => { };
	const answer = new Promise<ParadisUpdateConfirmAnswer>(resolve => {
		const store = new DisposableStore();
		let settled = false;
		finish = (value: ParadisUpdateConfirmAnswer) => {
			if (settled) {
				return;
			}
			settled = true;
			backdrop.remove();
			store.dispose();
			resolve(value);
		};

		const backdrop = $('.para-ut-backdrop.paradis-modal-backdrop');
		const modal = dom.append(backdrop, $('.para-ut-modal'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		modal.setAttribute('role', 'alertdialog');
		modal.setAttribute('aria-modal', 'true');
		modal.tabIndex = -1;

		const sequence = ++dialogSequence;
		const text = titleFor(summary);
		const title = renderParadisModalHead(modal, text.title).title;
		title.id = `para-ut-title-${sequence}`;
		modal.setAttribute('aria-labelledby', title.id);
		const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}`));
		const detail = dom.append(body, $('.para-ut-detail'));
		detail.id = `para-ut-detail-${sequence}`;
		detail.textContent = text.detail;
		modal.setAttribute('aria-describedby', detail.id);

		for (const group of summary.groups) {
			const host = dom.append(body, $('.para-ut-host'));
			const header = dom.append(host, $('.para-ut-host-header'));
			dom.append(header, $('span.para-ut-host-name')).textContent = group.hostLabel;
			dom.append(header, $('span.para-ut-host-count')).textContent = localize('paradis.updateTerminals.count', "{0} 個", paradisUpdateGroupCount(group));
			for (const row of paradisUpdateHostRows(group)) {
				const line = dom.append(host, $('.para-ut-pane'));
				const name = dom.append(line, $('span.para-ut-pane-name'));
				if (row.kind === 'terminal') {
					name.textContent = paradisUpdateTerminalLabel(row.terminal);
					const info = paradisUpdateTerminalTag(row.terminal);
					createParadisChip(line, info.text, CHIP_TONE[info.tone]);
				} else {
					name.textContent = row.firstTitle !== undefined
						? localize('paradis.updateTerminals.rest', "{0} ほか {1} 個", row.firstTitle, row.otherCount)
						: localize('paradis.updateTerminals.restUnnamed', "閉じたウィンドウに残したもの {0} 個", row.otherCount);
					createParadisChip(line, row.includesIdle
						? localize('paradis.updateTerminals.tag.includesIdle', "待機中を含む")
						: localize('paradis.updateTerminals.tag.includesBusy', "実行中を含む"));
				}
				name.title = name.textContent ?? '';
			}
		}

		const kinds = paradisWorkingAgentKinds(summary);
		if (kinds.claude || kinds.codex || kinds.unknown) {
			const warn = dom.append(body, $('.para-ut-warn'));
			warn.append(localize('paradis.updateTerminals.warn.stop', "作業中のエージェントは、今のターンの途中で止まります。"));
			// 再開のしかたはエージェントごとに違う。種類の分かっているものだけ書く。
			const hints: { readonly name: string; readonly command: string }[] = [];
			if (kinds.claude) {
				hints.push({ name: 'Claude', command: 'claude --resume' });
			}
			if (kinds.codex) {
				hints.push({ name: 'Codex', command: 'codex resume' });
			}
			if (hints.length === 0) {
				warn.append(localize('paradis.updateTerminals.warn.resumeGeneric', "会話は残るので、更新後に再開できます。"));
			} else {
				warn.append(localize('paradis.updateTerminals.warn.resumeBefore', "会話は残るので、更新後に "));
				hints.forEach((hint, index) => {
					if (index > 0) {
						warn.append(localize('paradis.updateTerminals.warn.resumeSeparator', "、"));
					}
					warn.append(localize('paradis.updateTerminals.warn.resumeAgent', "{0} は ", hint.name));
					dom.append(warn, $('code')).textContent = hint.command;
				});
				warn.append(localize('paradis.updateTerminals.warn.resumeAfter', " で続けられます。"));
			}
		}

		const buttons = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
		const later = store.add(new ParadisButton(buttons, { kind: 'secondary', label: localize('paradis.updateTerminals.later', "あとで更新") }));
		const update = store.add(new ParadisButton(buttons, { kind: 'danger', label: localize('paradis.updateTerminals.update', "終わらせて更新") }));
		store.add(later.onDidClick(() => finish('later')));
		store.add(update.onDidClick(() => finish('update')));

		container.appendChild(backdrop);
		store.add(new ParadisModalFocus({
			backdrop,
			modal,
			onEscape: () => finish('later'),
			close: () => finish('later'),
		}));
		// 取り返しのつかない方に初めからフォーカスを置かない。
		later.focus();
	});
	return { answer, close: () => finish('later') };
}
