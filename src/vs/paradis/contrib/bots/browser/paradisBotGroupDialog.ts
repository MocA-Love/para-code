/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループを作る・変える S のモーダル（名前・メンバー・返事をする Bot の決め方）。Bot の帯の ＋ のメニューと、
// グループの行のメニュー、部屋の「メンバーを変える...」から開く。

import './media/paradisBotGroup.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ParadisButton, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisCheck } from '../../../browser/paradisCheck.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisBotGroup, PARADIS_BOT_GROUP_LIMITS, ParadisBotGroupReplyMode } from '../common/paradisBotGroups.js';
import { IParadisBotGroupsService } from '../common/paradisBotGroupsApi.js';
import { IParadisBotsService } from '../common/paradisBotsApi.js';
import { paradisBotFace } from '../common/paradisBotsBandModel.js';
import { paradisBotCanReceiveBotMessages, paradisBotCannotReceiveLabel, paradisBotGroupDialogProblem } from '../common/paradisBotGroupRoomModel.js';
import { renderParadisBotFace } from './paradisBotFace.js';

let activeDialog: ParadisBotGroupDialog | undefined;

/** グループのモーダル。`group` を渡すと変える、渡さないと作る。開いている間にもう一度開くと、前のものを閉じる。 */
export class ParadisBotGroupDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly nameField: ParadisInputField;
	private readonly checks: { readonly botId: string; readonly check: ParadisCheck }[] = [];
	private readonly replyMode: ParadisSegmented<ParadisBotGroupReplyMode>;
	private readonly note: HTMLElement;
	private readonly submit: ParadisButton;
	private touched = false;
	private saving = false;

	constructor(
		restoreFocusTo: HTMLElement | undefined,
		private readonly group: IParadisBotGroup | undefined,
		private readonly onDidSave: (groupId: string) => void,
		@ILayoutService layoutService: ILayoutService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IParadisBotGroupsService private readonly groupsService: IParadisBotGroupsService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		activeDialog?.dispose();
		activeDialog = this;

		this.backdrop = dom.$(`.paradis-bot-group-dialog-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		const modal = dom.append(this.backdrop, dom.$('.paradis-bot-group-dialog'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');

		const head = renderParadisModalHead(modal, group === undefined ? localize('paradis.botGroups.dialog.newTitle', "新しいグループ") : localize('paradis.botGroups.dialog.editTitle', "グループを変える"));
		head.title.id = 'paradis-bot-group-dialog-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		const closeLabel = localize('paradis.botGroups.dialog.close', "閉じる");
		const close = dom.append(head.actions, dom.$('button.pbgd-close')) as HTMLButtonElement;
		close.classList.add(...paradisButtonClasses('icon'));
		close.type = 'button';
		close.setAttribute('aria-label', closeLabel);
		this._register(hoverService.setupDelayedHover(close, { content: closeLabel }));
		dom.append(close, dom.$(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const body = dom.append(modal, dom.$(`.${PARADIS_MODAL_BODY_CLASS}`));
		const nameLabel = localize('paradis.botGroups.dialog.name', "名前");
		dom.append(body, dom.$('label.pbgd-label')).textContent = nameLabel;
		this.nameField = this._register(new ParadisInputField(body, { ariaLabel: nameLabel, placeholder: localize('paradis.botGroups.dialog.namePlaceholder', "例: リリース班"), value: group?.name ?? '' }));
		this._register(this.nameField.onDidChange(() => {
			this.touched = true;
			this.update();
		}));

		const membersLabel = localize('paradis.botGroups.dialog.members', "メンバー（{0} 人まで）", PARADIS_BOT_GROUP_LIMITS.members);
		dom.append(body, dom.$('label.pbgd-label')).textContent = membersLabel;
		const list = dom.append(body, dom.$('.pbgd-members'));
		list.setAttribute('role', 'group');
		list.setAttribute('aria-label', membersLabel);
		for (const bot of this.botsService.snapshot.bots) {
			const row = dom.append(list, dom.$('.pbgd-member'));
			renderParadisBotFace(row, paradisBotFace(bot));
			const check = this._register(new ParadisCheck(row, { label: bot.name, checked: group?.members.includes(bot.id) ?? false }));
			if (!paradisBotCanReceiveBotMessages(bot.agent)) {
				dom.append(row, dom.$('span.pbgd-member-note')).textContent = paradisBotCannotReceiveLabel();
			}
			this._register(check.onDidChange(() => {
				this.touched = true;
				this.update();
			}));
			this.checks.push({ botId: bot.id, check });
		}
		if (this.checks.length === 0) {
			dom.append(list, dom.$('.pbgd-empty')).textContent = localize('paradis.botGroups.dialog.noBots', "Bot がまだいません。先に Bot を作ってください");
		}

		const replyLabel = localize('paradis.botGroups.replyMode', "返事をする Bot:");
		dom.append(body, dom.$('label.pbgd-label')).textContent = replyLabel;
		this.replyMode = this._register(new ParadisSegmented<ParadisBotGroupReplyMode>(body, {
			items: [
				{ value: 'mentioned', label: localize('paradis.botGroups.replyMentioned', "名指しのときだけ") },
				{ value: 'all', label: localize('paradis.botGroups.replyAll', "全員") },
			],
			value: group?.replyMode ?? 'mentioned',
			ariaLabel: replyLabel,
		}));
		dom.append(body, dom.$('.pbgd-help')).textContent = localize('paradis.botGroups.dialog.help', "グループを開くと、メンバーの Bot のターミナルが横に並び、上の 1 行から「@名前」か「@全員」で名指しして送れます。");

		const foot = dom.append(modal, dom.$(`.${PARADIS_MODAL_FOOT_CLASS}`));
		this.note = dom.append(foot, dom.$('span.pbgd-note'));
		this.note.setAttribute('role', 'status');
		const cancel = this._register(new ParadisButton(foot, { kind: 'secondary', label: localize('paradis.botGroups.dialog.cancel', "やめる") }));
		this._register(cancel.onDidClick(() => this.dispose()));
		this.submit = this._register(new ParadisButton(foot, { kind: 'primary', label: group === undefined ? localize('paradis.botGroups.dialog.create', "作る") : localize('paradis.botGroups.dialog.save', "保存") }));
		this._register(this.submit.onDidClick(() => void this.save()));

		this._register(dom.addDisposableListener(modal, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if ((keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.Enter) || (keyboardEvent.equals(KeyCode.Enter) && dom.isAncestor(event.target as Node, this.nameField.element))) && !event.isComposing) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				void this.save();
			}
		}));
		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, event => {
			if (event.target === this.backdrop && !this.touched) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal,
			onEscape: () => this.dispose(),
			close: () => this.dispose(),
			restoreFallback: () => restoreFocusTo?.isConnected ? restoreFocusTo : undefined,
		}));
		this.update();
		this.nameField.focus();
	}

	private selected(): string[] {
		return this.checks.filter(entry => entry.check.checked).map(entry => entry.botId);
	}

	private update(): void {
		const problem = paradisBotGroupDialogProblem(this.nameField.value, this.selected().length, this.groupsService.snapshot.groups, this.group?.id);
		this.submit.enabled = problem === undefined && !this.saving;
		const show = problem !== undefined && this.touched;
		this.note.textContent = show ? problem : localize('paradis.botGroups.dialog.noteHelp', "2〜{0} 人の Bot を選んでください", PARADIS_BOT_GROUP_LIMITS.members);
		this.note.classList.toggle('error', show);
	}

	private async save(): Promise<void> {
		if (this.saving || paradisBotGroupDialogProblem(this.nameField.value, this.selected().length, this.groupsService.snapshot.groups, this.group?.id) !== undefined) {
			this.touched = true;
			this.update();
			return;
		}
		this.saving = true;
		this.update();
		const input = { name: this.nameField.value.trim(), members: this.selected(), replyMode: this.replyMode.value ?? 'mentioned' };
		const result = this.group === undefined ? await this.groupsService.createGroup(input) : await this.groupsService.updateGroup(this.group.id, input);
		if (this._store.isDisposed) {
			return;
		}
		this.saving = false;
		if (!result.ok) {
			this.update();
			this.note.textContent = localize('paradis.botGroups.dialog.failed', "保存できませんでした: {0}", result.message);
			this.note.classList.add('error');
			return;
		}
		this.dispose();
		this.onDidSave(result.value.id);
	}

	override dispose(): void {
		if (activeDialog === this) {
			activeDialog = undefined;
		}
		this.backdrop.remove();
		super.dispose();
	}
}
