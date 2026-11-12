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
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { TextCompareEditorActiveContext } from '../../../../workbench/common/contextkeys.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { paradisHandOffToSpaceAgent, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { paradisLocateReviewNoteLine } from '../../mobileRelay/common/paradisMobileDiffReview.js';
import { paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisCountBadge } from '../../../browser/paradisBadges.js';
import { IParadisConfirmServices, paradisConfirmYesNo } from '../../confirmDialog/browser/paradisConfirmDialog.js';
import { IParadisDiffReviewNote, IParadisDiffReviewNoteToSend, paradisBuildDiffReviewNotesPrompt } from '../common/paradisDiffReviewNotes.js';
import { PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID, ParadisDiffReviewNotesController, paradisDiffReviewSelectedLines } from './paradisDiffReviewNotesController.js';
import { IParadisDiffReviewNotesService, ParadisDiffReviewUnsentCountContext } from './paradisDiffReviewNotesService.js';

registerEditorContribution(PARADIS_DIFF_REVIEW_NOTES_CONTROLLER_ID, ParadisDiffReviewNotesController, EditorContributionInstantiation.AfterFirstRender);

const SEND_COMMAND_ID = 'paradis.diffReviewNotes.send';
const IN_DIFF_SIDE = ContextKeyExpr.and(EditorContextKeys.inDiffEditor, ContextKeyExpr.or(ContextKeyExpr.has('isInDiffRightEditor'), ContextKeyExpr.has('isInDiffLeftEditor')));

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
			// 新しい側（右・インライン表示ではその 1 枚）と、横並びの表示の古い側（左）で書ける（770-RES）
			precondition: IN_DIFF_SIDE,
			menu: { id: MenuId.EditorContext, group: '1_paradis', order: 1, when: IN_DIFF_SIDE },
		});
	}

	run(accessor: ServicesAccessor): void {
		const editor = focusedEditor(accessor.get(ICodeEditorService));
		const line = editor?.getPosition()?.lineNumber;
		if (editor && line !== undefined) {
			// 行を選んでいれば、選んだ範囲のメモにする
			const range = paradisDiffReviewSelectedLines(editor);
			ParadisDiffReviewNotesController.get(editor)?.openDraft(range && range.start < range.end ? range.end : line, range && range.start < range.end ? range.start : undefined);
		}
	}
});

type SendChoice = IQuickPickItem & { readonly choice: 'unsent' | 'file' | 'copy' | 'clearSent' | 'clearAll' };

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SEND_COMMAND_ID,
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
		const confirmServices: IParadisConfirmServices = { layoutService: accessor.get(ILayoutService), keybindingService: accessor.get(IKeybindingService), hostService: accessor.get(IHostService) };

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
			// 未送信のメモまで消えるときだけ確かめる。送信済みだけを消すのは今のまま 1 手（paradis-19-3 案 C）
			if (picked.choice === 'clearAll' && unsent.length > 0) {
				const ok = await paradisConfirmYesNo(confirmServices, {
					message: localize('paradis.diffReviewNotes.clearAllConfirm', "AI メモを {0} 件すべて削除しますか？", notes.length),
					detail: localize('paradis.diffReviewNotes.clearAllDetail', "まだ送っていない {0} 件も消えます。元に戻せません。", unsent.length),
					primaryButton: localize('paradis.diffReviewNotes.clearAllButton', "すべて削除"),
					danger: true,
				});
				if (!ok) {
					return;
				}
			}
			notesService.remove(stateKey, new Set(notes.filter(note => picked.choice === 'clearAll' || note.sentAt !== undefined).map(note => note.id)));
			return;
		}

		const selected: readonly IParadisDiffReviewNote[] = picked.choice === 'copy' ? notes : picked.choice === 'file' ? fileUnsent : unsent;
		// 送る前に、今のファイルの中身で行を付け直す（書いた後に上の行が増減していても正しい行を指す）
		const readVersions = new Map(selected.map(note => [note.id, note.updatedAt]));
		const toSend: IParadisDiffReviewNoteToSend[] = [];
		const lineCache = new Map<string, ((line: number) => string | undefined) | undefined>();
		for (const note of selected) {
			// 古い側の行は今のファイルに無いので付け直さない（書いたときの番号と中身を送る）
			if (note.side === 'original') {
				toSend.push({ note, currentLine: note.line });
				continue;
			}
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

/**
 * 差分エディタの見出しの「AI メモを送る」に、今のスペースの未送信の数を添える（770-RES、案 A）。ボタンの見た目と押したときの
 * 動きは今のまま（MenuEntryActionViewItem）で、横に数の札を足すだけ。ソース管理の見出しは本家の作りで見た目を差し替えられない
 * ので、アイコンのまま。
 */
class ParadisDiffReviewNotesCountViewItem extends MenuEntryActionViewItem {

	private badge: ParadisCountBadge | undefined;

	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		@IParadisDiffReviewNotesService private readonly notesService: IParadisDiffReviewNotesService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(action, options, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
		this._register(this.notesService.onDidChange(() => this.updateBadge()));
		this._register(this.notesService.onDidChangeActiveSpace(() => this.updateBadge()));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('paradis-diff-review-send-item');
		// キットの塗らない数（paradis-19-16 案 B）。札は読み上げから隠し、件数はボタンの名前に入れる
		this.badge = new ParadisCountBadge(container, 'inline');
		this.updateBadge();
	}

	protected override updateAriaLabel(): void {
		super.updateAriaLabel();
		const count = this.badge ? this.notesService.unsentCountOfActiveSpace() : 0;
		if (this.label && count > 0) {
			this.label.setAttribute('aria-label', localize('paradis.diffReviewNotes.sendAriaLabel', "{0}（未送信 {1} 件）", this.getTooltip() ?? '', count));
		}
	}

	private updateBadge(): void {
		if (!this.badge) {
			return;
		}
		this.badge.update(this.notesService.unsentCountOfActiveSpace(), 'plain');
		this.updateAriaLabel();
	}
}

class ParadisDiffReviewNotesCountContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDiffReviewNotesCount';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.EditorTitle, SEND_COMMAND_ID, (action, options) =>
			action instanceof MenuItemAction ? instantiationService.createInstance(ParadisDiffReviewNotesCountViewItem, action, { hoverDelegate: options.hoverDelegate }) : undefined));
	}
}

// 見た目の登録は、見出しが最初に描かれる前に済ませる（タブのランチャーと同じ）
registerWorkbenchContribution2(ParadisDiffReviewNotesCountContribution.ID, ParadisDiffReviewNotesCountContribution, WorkbenchPhase.BlockStartup);
