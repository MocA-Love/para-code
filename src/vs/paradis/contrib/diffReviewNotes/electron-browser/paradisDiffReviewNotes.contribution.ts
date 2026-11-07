/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// G-01: 差分の行にメモを付け、まとめて今のスペースの Claude Code・Codex へ送る（Orca の「Annotate AI Diff」）。
// upstream の sessions/contrib/agentFeedback は Agent Sessions ウィンドウ専用で送り先が Copilot のチャットなので使わない。
// 既定のキーは付けない（Orca の Mod+Shift+A は Linux・Windows でブロックコメントと重なる）。

import { Codicon } from '../../../../base/common/codicons.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { TextCompareEditorActiveContext } from '../../../../workbench/common/contextkeys.js';
import { paradisHandOffToSpaceAgent, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { paradisLocateReviewNoteLine } from '../../mobileRelay/common/paradisMobileDiffReview.js';
import { paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisDiffReviewNote, IParadisDiffReviewNoteToSend, paradisBuildDiffReviewNotesPrompt } from '../common/paradisDiffReviewNotes.js';
import { PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID, ParadisDiffReviewNotesController } from './paradisDiffReviewNotesController.js';
import { IParadisDiffReviewNotesService, ParadisDiffReviewUnsentCountContext } from './paradisDiffReviewNotesService.js';

registerEditorContribution(PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID, ParadisDiffReviewNotesController, EditorContributionInstantiation.AfterFirstRender);

function focusedEditor(codeEditorService: ICodeEditorService): ICodeEditor | null {
	return codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.diffReviewNotes.addAtCursor',
			title: localize2('paradis.diffReviewNotes.addAtCursor', "この行に AI メモを書く"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
			precondition: EditorContextKeys.inDiffEditor,
			menu: { id: MenuId.EditorContext, group: '1_paradis', order: 1, when: EditorContextKeys.inDiffEditor },
		});
	}

	run(accessor: ServicesAccessor): void {
		const editor = focusedEditor(accessor.get(ICodeEditorService));
		const line = editor?.getPosition()?.lineNumber;
		if (editor && line !== undefined) {
			ParadisDiffReviewNotesController.get(editor)?.openDraft(line);
		}
	}
});

type SendChoice = IQuickPickItem & { readonly choice: 'unsent' | 'file' | 'copy' | 'clearSent' | 'clearAll' };

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.diffReviewNotes.send',
			title: localize2('paradis.diffReviewNotes.send', "AI メモを送る..."),
			category: localize2('paradis.category', "Para Code"),
			icon: Codicon.commentDiscussion,
			f1: true,
			menu: [
				{ id: MenuId.EditorTitle, group: 'navigation', order: -10, when: ContextKeyExpr.and(TextCompareEditorActiveContext, ParadisDiffReviewUnsentCountContext.notEqualsTo(0)) },
				{ id: MenuId.SCMTitle, group: 'navigation', order: -10, when: ParadisDiffReviewUnsentCountContext.notEqualsTo(0) },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const services = paradisSpaceAgentHandoffServices(accessor);
		const notesService = accessor.get(IParadisDiffReviewNotesService);
		const textModelService = accessor.get(ITextModelService);
		const clipboardService = accessor.get(IClipboardService);
		const editor = focusedEditor(accessor.get(ICodeEditorService));

		const stateKey = services.switchService.activeStateKey;
		const space = stateKey === undefined ? undefined : paradisListSpaces(services.switchService.repositories, services.worktreeService).find(entry => entry.space === stateKey);
		if (stateKey === undefined || !space) {
			return;
		}
		const notes = notesService.getNotes(stateKey);
		const unsent = notes.filter(note => note.sentAt === undefined);
		const filePath = editor ? ParadisDiffReviewNotesController.get(editor)?.resolveTarget()?.path : undefined;
		const fileUnsent = filePath === undefined ? [] : unsent.filter(note => note.path === filePath);

		const items: SendChoice[] = [];
		if (unsent.length > 0) {
			items.push({ choice: 'unsent', label: localize('paradis.diffReviewNotes.sendUnsent', "未送信のメモすべて（{0}）", unsent.length) });
		}
		if (fileUnsent.length > 0 && fileUnsent.length !== unsent.length) {
			items.push({ choice: 'file', label: localize('paradis.diffReviewNotes.sendFile', "このファイルの未送信のメモ（{0}）", fileUnsent.length), description: filePath });
		}
		if (notes.length > 0) {
			items.push({ choice: 'copy', label: localize('paradis.diffReviewNotes.copy', "すべてコピー（{0}）", notes.length) });
		}
		if (notes.length > unsent.length) {
			items.push({ choice: 'clearSent', label: localize('paradis.diffReviewNotes.clearSent', "送信済みのメモを消す（{0}）", notes.length - unsent.length) });
		}
		if (notes.length > 0) {
			items.push({ choice: 'clearAll', label: localize('paradis.diffReviewNotes.clearAll', "メモをすべて消す（{0}）", notes.length) });
		}
		if (items.length === 0) {
			return;
		}
		const picked = await services.quickInputService.pick(items, { placeHolder: localize('paradis.diffReviewNotes.sendPlaceholder', "{0} の AI メモ", space.name) });
		if (!picked) {
			return;
		}
		if (picked.choice === 'clearSent' || picked.choice === 'clearAll') {
			notesService.remove(stateKey, new Set(notes.filter(note => picked.choice === 'clearAll' || note.sentAt !== undefined).map(note => note.id)));
			return;
		}

		const selected: readonly IParadisDiffReviewNote[] = picked.choice === 'copy' ? notes : picked.choice === 'file' ? fileUnsent : unsent;
		// 送る前に、今のファイルの中身で行を付け直す（書いた後に上の行が増減していても正しい行を指す）
		const readVersions = new Map(selected.map(note => [note.id, note.updatedAt]));
		const toSend: IParadisDiffReviewNoteToSend[] = [];
		const lineCache = new Map<string, ((line: number) => string | undefined) | undefined>();
		for (const note of selected) {
			if (!lineCache.has(note.path)) {
				lineCache.set(note.path, await readLines(textModelService, joinPath(space.uri, note.path)));
			}
			const textAt = lineCache.get(note.path);
			toSend.push({ note, currentLine: textAt ? paradisLocateReviewNoteLine(textAt, note.line, note.lineText) : note.line });
		}
		const prompt = paradisBuildDiffReviewNotesPrompt(toSend);
		if (picked.choice === 'copy') {
			await clipboardService.writeText(prompt);
			return;
		}
		const delivered = await paradisHandOffToSpaceAgent(services, {
			prompt,
			placeholder: localize('paradis.diffReviewNotes.targetPlaceholder', "メモ {0} 件を送るエージェントを選ぶ", selected.length),
			expectedRoot: space.uri,
		});
		if (delivered) {
			notesService.markSent(stateKey, readVersions);
		}
	}
});

/** ファイルの行を読む関数。読めなければ undefined（書いたときの行番号のまま送る）。 */
async function readLines(textModelService: ITextModelService, resource: ReturnType<typeof joinPath>): Promise<((line: number) => string | undefined) | undefined> {
	try {
		const reference = await textModelService.createModelReference(resource);
		try {
			const model = reference.object.textEditorModel;
			const lines = model.getLinesContent();
			return line => line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
		} finally {
			reference.dispose();
		}
	} catch {
		return undefined;
	}
}
