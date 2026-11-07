/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分エディタの新しい側（modified）の行番号にマウスを載せると「+」を出し、押すとその行の下にメモの欄を開く（G-01）。
// 書いたメモは同じ行の下に並べる。対象は今のスペースの中のファイルを開いた差分エディタだけ
// （ふつうのエディタ・別のスペースのファイルには出さない）。「+」の出し方は upstream の agentFeedback と同じく
// 行番号の位置のデコレーション（glyph margin を使わない）。

import './media/paradisDiffReviewNotes.css';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ICodeEditor, IEditorMouseEvent } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { paradisLocateReviewNoteLine } from '../../mobileRelay/common/paradisMobileDiffReview.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_DIFF_REVIEW_MAX_NOTES, paradisDiffReviewRelativePath } from '../common/paradisDiffReviewNotes.js';
import { IParadisDiffReviewNotesService } from './paradisDiffReviewNotesService.js';
import { ParadisDiffReviewNoteWidget } from './paradisDiffReviewNoteWidget.js';

export const PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID = 'paradis.diffReviewNotes.controller';

const HOVER_GLYPH_CLASS = 'paradis-diff-review-glyph';

/** 差分エディタのファイルが今のスペースのどこにあるか。 */
export interface IParadisDiffReviewTarget {
	readonly stateKey: string;
	/** スペースのルートからのパス（`/` 区切り）。 */
	readonly path: string;
}

export class ParadisDiffReviewNotesController extends Disposable implements IEditorContribution {

	static get(editor: ICodeEditor): ParadisDiffReviewNotesController | null {
		return editor.getContribution<ParadisDiffReviewNotesController>(PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID);
	}

	private readonly hoverDecorations = this.editor.createDecorationsCollection();
	private hoverLine: number | undefined;
	private readonly draft = this._register(new MutableDisposable<ParadisDiffReviewNoteWidget>());
	private readonly noteWidgets = this._register(new DisposableStore());
	/** 書いたメモの欄を出しているか（ふつうのエディタではリスナを張るだけで何も描かない）。 */
	private rendered = false;

	constructor(
		private readonly editor: ICodeEditor,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IParadisDiffReviewNotesService private readonly notesService: IParadisDiffReviewNotesService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._register(this.editor.onMouseMove(e => this.onMouseMove(e)));
		this._register(this.editor.onMouseLeave(() => this.clearHover()));
		this._register(this.editor.onMouseDown(e => this.onMouseDown(e)));
		this._register(this.editor.onDidChangeModel(() => {
			this.draft.clear();
			this.clearHover();
			this.renderNotes();
		}));
		this._register(this.notesService.onDidChange(() => this.renderNotes()));
		this._register(this.switchService.onDidSwitchScope(() => {
			this.draft.clear();
			this.renderNotes();
		}));
		// 差分エディタは中のエディタを作った後でモデルを付けるので、付いたときにも描く（上の onDidChangeModel）
		this.renderNotes();
	}

	/** この差分エディタのファイルがメモの対象なら、そのスペースとパス。 */
	resolveTarget(): IParadisDiffReviewTarget | undefined {
		const model = this.editor.getModel();
		if (!model || !this.codeEditorService.listDiffEditors().some(diffEditor => diffEditor.getModifiedEditor() === this.editor)) {
			return undefined;
		}
		const stateKey = this.switchService.activeStateKey;
		const space = stateKey === undefined ? undefined : paradisListSpaces(this.switchService.repositories, this.worktreeService).find(entry => entry.space === stateKey);
		if (stateKey === undefined || !space) {
			return undefined;
		}
		const path = paradisDiffReviewRelativePath(space.uri.path, model.uri.path, space.uri.scheme === 'file' && !isLinux);
		return path === undefined ? undefined : { stateKey, path };
	}

	/** `line` の下にメモの欄を開く（右クリックの「この行に AI メモを書く」と「+」から）。 */
	openDraft(line: number): void {
		const target = this.resolveTarget();
		const model = this.editor.getModel();
		if (!target || !model) {
			this.notificationService.notify({ severity: Severity.Info, message: localize('paradis.diffReviewNotes.notTarget', "AI メモは、今のスペースのファイルの差分エディタ（新しい側）で書けます。") });
			return;
		}
		if (this.notesService.getNotes(target.stateKey).length >= PARADIS_DIFF_REVIEW_MAX_NOTES) {
			this.notificationService.notify({ severity: Severity.Warning, message: localize('paradis.diffReviewNotes.full', "メモが {0} 件に達しました。送るか消してから書いてください。", PARADIS_DIFF_REVIEW_MAX_NOTES) });
			return;
		}
		this.clearHover();
		const widget = new ParadisDiffReviewNoteWidget(this.editor, { kind: 'draft', line });
		this.draft.value = widget;
		widget.onDidCancel(() => {
			this.draft.clear();
			this.editor.focus();
		});
		widget.onDidSubmit(body => {
			this.notesService.add(target.stateKey, { path: target.path, line, lineText: model.getLineContent(line), body });
			this.draft.clear();
			this.editor.focus();
		});
		widget.show({ lineNumber: line, column: 1 }, 4);
		widget.focusInput();
	}

	private onMouseMove(e: IEditorMouseEvent): void {
		if (this.draft.value) {
			this.clearHover();
			return;
		}
		const line = e.target.position?.lineNumber;
		const model = this.editor.getModel();
		if (line === undefined || !model || line > model.getLineCount() || model.getLineFirstNonWhitespaceColumn(line) === 0) {
			this.clearHover();
			return;
		}
		if (this.hoverLine === line) {
			return;
		}
		if (!this.resolveTarget()) {
			this.clearHover();
			return;
		}
		this.hoverLine = line;
		this.hoverDecorations.set([{
			range: new Range(line, 1, line, 1),
			options: {
				description: 'paradis-diff-review-hover',
				lineNumberClassName: `${HOVER_GLYPH_CLASS} line-hover`,
				lineNumberHoverMessage: new MarkdownString(localize('paradis.diffReviewNotes.addHover', "AI へのメモを追加")),
			},
		}]);
	}

	private onMouseDown(e: IEditorMouseEvent): void {
		if (!isHTMLElement(e.target.element) || !e.target.element.classList.contains(HOVER_GLYPH_CLASS)) {
			return;
		}
		const line = e.target.position?.lineNumber;
		if (line === undefined) {
			return;
		}
		e.event.preventDefault();
		e.event.stopPropagation();
		this.openDraft(line);
	}

	private clearHover(): void {
		if (this.hoverLine !== undefined) {
			this.hoverLine = undefined;
			this.hoverDecorations.clear();
		}
	}

	/** 書いたメモを、今の行（中身で追いかけた行）の下に並べ直す。 */
	private renderNotes(): void {
		const target = this.resolveTarget();
		const model = this.editor.getModel();
		const notes = target && model ? this.notesService.getNotes(target.stateKey).filter(note => note.path === target.path) : [];
		if (notes.length === 0 && !this.rendered) {
			return;
		}
		this.noteWidgets.clear();
		this.rendered = notes.length > 0;
		if (!target || !model) {
			return;
		}
		for (const note of notes) {
			const line = locateLine(model, note.line, note.lineText) ?? Math.min(note.line, model.getLineCount());
			const widget = this.noteWidgets.add(new ParadisDiffReviewNoteWidget(this.editor, { kind: 'note', line, note }));
			this.noteWidgets.add(widget.onDidDelete(() => this.notesService.remove(target.stateKey, new Set([note.id]))));
			widget.show({ lineNumber: line, column: 1 }, 2);
		}
	}
}

function locateLine(model: ITextModel, line: number, lineText: string): number | undefined {
	const count = model.getLineCount();
	return paradisLocateReviewNoteLine(candidate => candidate >= 1 && candidate <= count ? model.getLineContent(candidate) : undefined, line, lineText);
}
