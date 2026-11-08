/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分エディタの行の下に出すメモの欄（G-01）。書きかけ（入力欄・キャンセル・メモを追加）と、書いたメモ
// （本文・送信済みの印・消す）の 2 つの形を 1 つの ZoneWidget で出す。Orca の DiffCommentDraftCard と DiffCommentCard に当たる。

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ZoneWidget } from '../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { localize } from '../../../../nls.js';
import { IParadisDiffReviewNote, PARADIS_DIFF_REVIEW_NOTE_BODY_MAX } from '../common/paradisDiffReviewNotes.js';

/** 欄の場所。`startLine` は範囲の最初の行、`side` は差分のどちら側か（770-RES）。 */
interface IParadisDiffReviewNoteWidgetPlace {
	readonly line: number;
	readonly startLine?: number;
	readonly side: 'modified' | 'original';
}

export type ParadisDiffReviewNoteWidgetMode =
	| IParadisDiffReviewNoteWidgetPlace & { readonly kind: 'draft' }
	| IParadisDiffReviewNoteWidgetPlace & { readonly kind: 'note'; readonly note: IParadisDiffReviewNote };

/** 欄の見出しの「12 行目」「2〜4 行目」「古い側 6 行目」。 */
function placeLabel(place: IParadisDiffReviewNoteWidgetPlace): string {
	if (place.side === 'original') {
		return place.startLine !== undefined
			? localize('paradis.diffReviewNotes.oldLines', "古い側 {0}〜{1} 行目", place.startLine, place.line)
			: localize('paradis.diffReviewNotes.oldLine', "古い側 {0} 行目", place.line);
	}
	return place.startLine !== undefined
		? localize('paradis.diffReviewNotes.lines', "{0}〜{1} 行目", place.startLine, place.line)
		: localize('paradis.diffReviewNotes.line', "{0} 行目", place.line);
}

export class ParadisDiffReviewNoteWidget extends ZoneWidget {

	private readonly _onDidSubmit = this._disposables.add(new Emitter<string>());
	/** 書きかけで「メモを追加」（Enter）。中身は入力された本文。 */
	readonly onDidSubmit = this._onDidSubmit.event;
	private readonly _onDidCancel = this._disposables.add(new Emitter<void>());
	/** 書きかけで「キャンセル」（Esc）。 */
	readonly onDidCancel = this._onDidCancel.event;
	private readonly _onDidDelete = this._disposables.add(new Emitter<void>());
	/** 書いたメモの「消す」。 */
	readonly onDidDelete = this._onDidDelete.event;

	private textarea: HTMLTextAreaElement | undefined;

	constructor(editor: ICodeEditor, readonly mode: ParadisDiffReviewNoteWidgetMode) {
		super(editor, { showFrame: true, showArrow: false, frameWidth: 1, isAccessible: true, className: 'paradis-diff-review-note-zone', keepEditorSelection: true });
		this.create();
	}

	protected _fillContainer(container: HTMLElement): void {
		const fontInfo = this.editor.getOption(EditorOption.fontInfo);
		container.style.fontSize = `${fontInfo.fontSize}px`;
		const card = append(container, $('.paradis-diff-review-note'));
		const head = append(card, $('.paradis-diff-review-note-head'));
		append(head, $('span.paradis-diff-review-note-line')).textContent = placeLabel(this.mode);

		if (this.mode.kind === 'note') {
			const note = this.mode.note;
			if (note.sentAt !== undefined) {
				append(head, $('span.paradis-diff-review-note-sent')).textContent = localize('paradis.diffReviewNotes.sent', "送信済み");
			}
			const remove = append(head, $('button.paradis-diff-review-note-button.secondary')) as HTMLButtonElement;
			remove.textContent = localize('paradis.diffReviewNotes.delete', "消す");
			this._disposables.add(addDisposableListener(remove, EventType.CLICK, () => this._onDidDelete.fire()));
			append(card, $('.paradis-diff-review-note-body')).textContent = note.body;
			return;
		}

		const textarea = append(card, $('textarea.paradis-diff-review-note-input')) as HTMLTextAreaElement;
		textarea.rows = 3;
		textarea.maxLength = PARADIS_DIFF_REVIEW_NOTE_BODY_MAX;
		textarea.placeholder = localize('paradis.diffReviewNotes.placeholder', "エージェントへのメモ（Enter で追加、Shift+Enter で改行、Esc で閉じる）");
		textarea.setAttribute('aria-label', localize('paradis.diffReviewNotes.inputLabel', "{0}へのメモ", placeLabel(this.mode)));
		this.textarea = textarea;
		const actions = append(card, $('.paradis-diff-review-note-actions'));
		const cancel = append(actions, $('button.paradis-diff-review-note-button.secondary')) as HTMLButtonElement;
		cancel.textContent = localize('paradis.diffReviewNotes.cancel', "キャンセル");
		const add = append(actions, $('button.paradis-diff-review-note-button')) as HTMLButtonElement;
		add.textContent = localize('paradis.diffReviewNotes.add', "メモを追加");
		this._disposables.add(addDisposableListener(cancel, EventType.CLICK, () => this._onDidCancel.fire()));
		this._disposables.add(addDisposableListener(add, EventType.CLICK, () => this.submit()));
		this._disposables.add(addDisposableListener(textarea, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			// 日本語の変換を確定する Enter（変換中・keyCode 229）では追加しない
			if (event.isComposing || event.keyCode === 229) {
				return;
			}
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				event.stopPropagation();
				this.submit();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this._onDidCancel.fire();
			}
		}));
		this._disposables.add(addDisposableListener(textarea, EventType.INPUT, () => this._doLayout(undefined, undefined)));
	}

	/** 書いたメモを並べ直すたびに画面が飛ばないよう、書きかけの欄を開いたときだけ見える所まで動かす。 */
	protected override revealRange(range: Range, isLastLine: boolean): void {
		if (this.mode.kind === 'draft') {
			super.revealRange(range, isLastLine);
		}
	}

	focusInput(): void {
		this.textarea?.focus();
	}

	private submit(): void {
		const body = this.textarea?.value.trim() ?? '';
		if (body.length > 0) {
			this._onDidSubmit.fire(body);
		}
	}

	protected override _doLayout(_heightInPixel: number | undefined, _widthInPixel: number | undefined): void {
		if (!this.container) {
			return;
		}
		// 中身の高さに合わせて行数を決め直す（ExceptionWidget と同じやり方）
		this.container.style.height = 'initial';
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const lines = Math.max(2, Math.ceil((this.container.offsetHeight + 2) / lineHeight));
		this._relayout(lines);
	}
}
