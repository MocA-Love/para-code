/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Rendered（webview）表示中の検索アクション。webview は生成時に enableFindWidget: true で
// 作られており WebviewFindWidget 自体は既に載っている（src/vs/workbench/contrib/webview/browser/webviewFindWidget.ts）が、
// Paradis のビューアは webviewPanel と別のエディタ ID を使うため、上流のキーバインド
// （src/vs/workbench/contrib/webviewPanel/browser/webviewCommands.ts）はマッチしない。
// ここではそれと同じ4アクションを Paradis のビューアペイン向けに用意するだけで、
// find widget の実体・トグル無し/件数無しの制約は上流と同じ（Chromium findInPage 依存）。

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ActiveEditorContext } from '../../../../workbench/common/contextkeys.js';
import { KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_ENABLED, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_FOCUSED, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_VISIBLE } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_HTML_EDITOR_ID, PARADIS_MARKDOWN_EDITOR_ID } from './paradisFileViewers.js';
import { ParadisRenderedFileEditor } from './paradisRenderedFileEditor.js';

// paradisFileViewerActions.ts の viewerEditorActiveContext と同じ条件だが、あちら側に置くと
// registerParadisFileViewerActions() 経由の相互 import で循環が生じる（このファイルのトップレベル
// 定数が相手側の const 初期化より先に評価され得る）ため、ここで ID から独立に組み直す。
const viewerEditorActiveContext = ContextKeyExpr.or(
	ActiveEditorContext.isEqualTo(PARADIS_MARKDOWN_EDITOR_ID),
	ActiveEditorContext.isEqualTo(PARADIS_HTML_EDITOR_ID)
);
const findActiveContext = ContextKeyExpr.and(viewerEditorActiveContext, EditorContextKeys.focus.toNegated())!;

function getActiveViewerPane(accessor: ServicesAccessor): ParadisRenderedFileEditor | undefined {
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof ParadisRenderedFileEditor ? pane : undefined;
}

class ParadisFileViewerShowFindAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.fileViewer.showFind',
			title: localize2('paradis.fileViewer.showFind', "プレビュー内を検索"),
			keybinding: {
				when: ContextKeyExpr.and(findActiveContext, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_ENABLED),
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveViewerPane(accessor)?.showFind();
	}
}

class ParadisFileViewerHideFindAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.fileViewer.hideFind',
			title: localize2('paradis.fileViewer.hideFind', "プレビュー内検索を閉じる"),
			keybinding: {
				when: ContextKeyExpr.and(findActiveContext, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_VISIBLE),
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveViewerPane(accessor)?.hideFind();
	}
}

class ParadisFileViewerFindNextAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.fileViewer.findNext',
			title: localize2('paradis.fileViewer.findNext', "プレビュー内で次を検索"),
			keybinding: {
				when: ContextKeyExpr.and(findActiveContext, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_FOCUSED),
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveViewerPane(accessor)?.runFindAction(false);
	}
}

class ParadisFileViewerFindPreviousAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.fileViewer.findPrevious',
			title: localize2('paradis.fileViewer.findPrevious', "プレビュー内で前を検索"),
			keybinding: {
				when: ContextKeyExpr.and(findActiveContext, KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_FOCUSED),
				primary: KeyMod.Shift | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveViewerPane(accessor)?.runFindAction(true);
	}
}

/** Rendered（webview）表示中に Cmd+F 系の検索操作を有効にする（Markdown/HTML 両ビューアで共有）。 */
export function registerParadisFileViewerFindActions(): void {
	registerAction2(ParadisFileViewerShowFindAction);
	registerAction2(ParadisFileViewerHideFindAction);
	registerAction2(ParadisFileViewerFindNextAction);
	registerAction2(ParadisFileViewerFindPreviousAction);
}
