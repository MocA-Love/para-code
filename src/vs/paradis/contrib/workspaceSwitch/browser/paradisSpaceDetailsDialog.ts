/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スペースの詳細（UI キット、Q600。モック mock/ui/kit/space.html）。スペースの行のメニューの「詳細...」から開く M 段の
// ダイアログで、表示名・リンクした作業（PR・Issue）・メモを 1 枚にまとめる。
//
// 中身の読み書きは今ある仕組みをそのまま使う。
//  - 表示名: 行のメニューの「名前を変更...」と同じく IParadisWorktreeService.addKnownWorktree（リポジトリ本体は変えられない）
//  - メモ: サイドバーのメモ欄と同じ IParadisSpaceNotesService。開いてから別の場所（スマホ・エージェント）が書き換えて
//    いたら、直した行が重ならない限り両方を合わせて書く（paradisMergeSpaceNoteEdits）。重なっていたら保存せずに知らせる
//  - リンクした作業: 行の 2 段目と同じ、ブランチから見つけた PR とエージェントの会話から見つけた Issue（読むだけ）
// 保存するまでは何も書かない。⌘Enter（Ctrl+Enter）で保存、Esc・取消で閉じる。
//
// 包んでいる本家のファイル: 無し（箱は paradisModal.ts、フォーカスの閉じ込めと Esc は paradisModalFocus.ts、
// 入力欄は本家の InputBox を包む paradisInputField.ts）。

import './media/paradisSpaceDetails.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { IParadisIssueStatus } from '../../../common/paradisIssueDetection.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisSpaceNotesService, paradisMergeSpaceNoteEdits } from '../common/paradisSpaceNotes.js';
import { IParadisWorktree, IParadisWorktreeService } from '../common/paradisWorkspaceSwitch.js';
import { IParadisPrStatus } from '../common/paradisWorktreeCreate.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.spaceDetails.title', "スペースの詳細");
// allow-any-unicode-next-line
const STR_CLOSE = localize('paradis.spaceDetails.close', "閉じる");
// allow-any-unicode-next-line
const STR_NAME = localize('paradis.spaceDetails.name', "表示名");
// allow-any-unicode-next-line
const STR_NAME_HELP = localize('paradis.spaceDetails.nameHelp', "サイドバーに出る名前です。フォルダ名とブランチ名は変わりません。");
// allow-any-unicode-next-line
const STR_NAME_MAIN = localize('paradis.spaceDetails.nameMain', "リポジトリ本体の表示名は変えられません。");
// allow-any-unicode-next-line
const STR_NAME_EMPTY = localize('paradis.spaceDetails.nameEmpty', "名前を空にすることはできません");
// allow-any-unicode-next-line
const STR_LINKED = localize('paradis.spaceDetails.linked', "リンクした作業");
// allow-any-unicode-next-line
const STR_LINKED_HELP = localize('paradis.spaceDetails.linkedHelp', "PR はこのスペースのブランチから、Issue はエージェントとの会話から自動で見つけます。");
// allow-any-unicode-next-line
const STR_LINKED_EMPTY = localize('paradis.spaceDetails.linkedEmpty', "まだ見つかっていません。");
// allow-any-unicode-next-line
const STR_NOTE = localize('paradis.spaceDetails.note', "メモ");
// allow-any-unicode-next-line
const STR_NOTE_HELP = localize('paradis.spaceDetails.noteHelp', "任意・Markdown。サイドバーのメモ欄と同じ中身です。");
// allow-any-unicode-next-line
const STR_NOTE_CONFLICT = localize('paradis.spaceDetails.noteConflict', "開いている間に、同じ行がスマホやエージェントからも書き換えられたため、保存していません。閉じて開き直してから直してください。");
// allow-any-unicode-next-line
const STR_FOOT_NOTE = isMacintosh ? localize('paradis.spaceDetails.footMac', "保存するまで反映されません · ⌘Enter で保存") : localize('paradis.spaceDetails.foot', "保存するまで反映されません · Ctrl+Enter で保存");
// allow-any-unicode-next-line
const STR_DIRTY = localize('paradis.spaceDetails.dirty', "変更あり");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.spaceDetails.cancel', "取消");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.spaceDetails.save', "保存");

/** 詳細に出すスペースと、行が持っている PR・Issue。 */
export interface IParadisSpaceDetailsInput {
	readonly worktree: IParadisWorktree;
	/** メモの保存先のキー（行と同じ）。 */
	readonly stateKey: string;
	readonly pullRequest: IParadisPrStatus | undefined;
	/** エージェントの会話から見つけた Issue。番号やタイトルがまだ取れていないものは URL だけ。 */
	readonly issues: readonly { readonly url: string; readonly status: IParadisIssueStatus | undefined }[];
}

let activeDialog: ParadisSpaceDetailsDialog | undefined;

/** スペースの詳細。開いている間に別のスペースの詳細を開くと、前のものを閉じる。 */
export class ParadisSpaceDetailsDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly nameField: ParadisInputField;
	private readonly nameHelp: HTMLElement;
	private readonly noteInput: HTMLTextAreaElement;
	private readonly noteError: HTMLElement;
	private readonly dirtyChip: HTMLElement;
	/** 開いたときのメモと版（保存のときに、別の場所の書き換えと合わせるため）。 */
	private readonly noteBase: { readonly text: string; readonly updatedAt: number };

	constructor(
		private readonly input: IParadisSpaceDetailsInput,
		@ILayoutService layoutService: ILayoutService,
		@IParadisSpaceNotesService private readonly notesService: IParadisSpaceNotesService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		activeDialog?.dispose();
		activeDialog = this;

		const entry = this.notesService.readEntry(input.stateKey);
		this.noteBase = { text: entry?.text ?? '', updatedAt: entry?.updatedAt ?? 0 };

		this.backdrop = $(`.paradis-space-details-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		const modal = dom.append(this.backdrop, $('.paradis-space-details'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Medium));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');

		const head = renderParadisModalHead(modal, STR_TITLE);
		head.title.id = 'paradis-space-details-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		// アイコンは中の span に置く（ボタンの要素に codicon を付けると、キットのボタンの font-family が字形を消す）
		const close = dom.append(head.actions, $('button.psdd-close')) as HTMLButtonElement;
		close.classList.add(...paradisButtonClasses('icon'));
		close.type = 'button';
		close.title = STR_CLOSE;
		close.setAttribute('aria-label', STR_CLOSE);
		dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}`));
		const subtitle = dom.append(body, $('p.psdd-subtitle'));
		subtitle.textContent = [input.worktree.branch, input.worktree.uri.fsPath].filter(part => !!part).join(' · ');

		// 表示名
		const nameLabel = dom.append(body, $('label.psdd-label'));
		nameLabel.textContent = STR_NAME;
		const isMain = input.worktree.isMainCheckout === true;
		this.nameField = this._register(new ParadisInputField(body, { ariaLabel: STR_NAME, value: input.worktree.name }));
		this.nameField.enabled = !isMain && !input.worktree.missing;
		this.nameHelp = dom.append(body, $('.psdd-help'));
		this.nameHelp.textContent = isMain ? STR_NAME_MAIN : STR_NAME_HELP;
		this._register(this.nameField.onDidChange(() => {
			this.nameHelp.classList.remove('error');
			this.nameHelp.textContent = STR_NAME_HELP;
			this.updateDirty();
		}));

		// リンクした作業
		const linkedHead = dom.append(body, $('.psdd-section-head'));
		dom.append(linkedHead, $('span.psdd-label')).textContent = STR_LINKED;
		const linkedCount = (input.pullRequest ? 1 : 0) + input.issues.length;
		dom.append(linkedHead, $('span.psdd-count')).textContent = linkedCount > 0 ? String(linkedCount) : '';
		const linked = dom.append(body, $('.psdd-linked'));
		if (input.pullRequest) {
			this.renderLinked(linked, Codicon.gitPullRequest, input.pullRequest.url, `#${input.pullRequest.number}`, input.pullRequest.title, input.pullRequest.state);
		}
		for (const issue of input.issues) {
			this.renderLinked(linked, Codicon.issues, issue.url, issue.status ? `#${issue.status.number}` : undefined, issue.status?.title ?? issue.url, issue.status?.state);
		}
		if (linkedCount === 0) {
			dom.append(linked, $('.psdd-empty')).textContent = STR_LINKED_EMPTY;
		}
		dom.append(body, $('.psdd-help')).textContent = STR_LINKED_HELP;

		// メモ
		const noteLabel = dom.append(body, $('label.psdd-label'));
		noteLabel.textContent = STR_NOTE;
		const noteFrame = dom.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.psdd-note'));
		this.noteInput = dom.append(noteFrame, $('textarea')) as HTMLTextAreaElement;
		this.noteInput.value = this.noteBase.text;
		this.noteInput.spellcheck = false;
		this.noteInput.setAttribute('aria-label', STR_NOTE);
		this._register(dom.addDisposableListener(this.noteInput, dom.EventType.INPUT, () => this.updateDirty()));
		dom.append(body, $('.psdd-help')).textContent = STR_NOTE_HELP;
		this.noteError = dom.append(body, $('.psdd-help.psdd-alert'));
		this.noteError.setAttribute('role', 'alert');
		this.noteError.hidden = true;

		// 下の帯
		const foot = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
		dom.append(foot, $('span.psdd-foot-note')).textContent = STR_FOOT_NOTE;
		this.dirtyChip = createParadisChip(foot, STR_DIRTY, 'warning');
		this.dirtyChip.hidden = true;
		const cancel = this._register(new ParadisButton(foot, { kind: 'secondary', label: STR_CANCEL }));
		this._register(cancel.onDidClick(() => this.dispose()));
		const save = this._register(new ParadisButton(foot, { kind: 'primary', label: STR_SAVE }));
		this._register(save.onDidClick(() => this.save()));

		this._register(dom.addDisposableListener(modal, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			// 日本語の変換を確定する Enter では保存しない
			if (keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.Enter) && !event.isComposing) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				this.save();
			}
		}));
		// 幕の外を押したら閉じる。ただし変えたものがあるときは閉じない（Esc・取消・✕ は明示の操作なので閉じる）
		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, event => {
			if (event.target === this.backdrop && !this.nameChanged() && !this.noteChanged()) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({ backdrop: this.backdrop, modal, onEscape: () => this.dispose(), close: () => this.dispose() }));
		if (this.nameField.enabled) {
			this.nameField.focus();
		} else {
			this.noteInput.focus();
		}
	}

	private renderLinked(parent: HTMLElement, icon: ThemeIcon, url: string, number: string | undefined, title: string, state: string | undefined): void {
		const row = dom.append(parent, $('button.psdd-linked-row.paradis-focus-subtle')) as HTMLButtonElement;
		row.type = 'button';
		row.title = url;
		dom.append(row, $(ThemeIcon.asCSSSelector(icon)));
		if (number) {
			dom.append(row, $('span.psdd-linked-number')).textContent = number;
		}
		dom.append(row, $('span.psdd-linked-title')).textContent = title;
		if (state) {
			createParadisChip(row, state);
		}
		this._register(dom.addDisposableListener(row, dom.EventType.CLICK, () => void this.openerService.open(URI.parse(url))));
	}

	private nameChanged(): boolean {
		return this.nameField.enabled && this.nameField.value.trim() !== this.input.worktree.name;
	}

	private noteChanged(): boolean {
		return this.noteInput.value !== this.noteBase.text;
	}

	private updateDirty(): void {
		this.dirtyChip.hidden = !this.nameChanged() && !this.noteChanged();
	}

	/** 変えたものだけを書いて閉じる。書けないもの（空の名前・重なった書き換え）があれば閉じずに知らせる。 */
	save(): void {
		if (this.nameField.enabled && !this.nameField.value.trim()) {
			this.nameHelp.textContent = STR_NAME_EMPTY;
			this.nameHelp.classList.add('error');
			this.nameField.focus();
			return;
		}
		if (this.noteChanged()) {
			const current = this.notesService.readEntry(this.input.stateKey);
			const currentText = current?.text ?? '';
			const changedElsewhere = (current?.updatedAt ?? 0) !== this.noteBase.updatedAt;
			const merged = changedElsewhere ? paradisMergeSpaceNoteEdits(this.noteBase.text, this.noteInput.value, currentText) : this.noteInput.value;
			if (merged === undefined) {
				this.noteError.textContent = STR_NOTE_CONFLICT;
				this.noteError.hidden = false;
				return;
			}
			this.notesService.write(this.input.stateKey, merged);
		}
		if (this.nameChanged()) {
			this.worktreeService.addKnownWorktree({ ...this.input.worktree, name: this.nameField.value.trim() });
		}
		this.dispose();
	}

	override dispose(): void {
		if (activeDialog === this) {
			activeDialog = undefined;
		}
		this.backdrop.remove();
		super.dispose();
	}
}
