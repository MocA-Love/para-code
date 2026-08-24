/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタタブのターミナル（`TerminalEditor`）向けに、agent-browser-binding indicator（右上の
// 共有ドット + 背面ハイライト）を配線するだけの差し替えクラス。パネルの `SessionTerminalGridCell`
// （sessionTerminalGridGroup.ts参照）は1セル=1インスタンス使い捨てだが、`TerminalEditor` の
// overflow guard 要素はタブ切り替えの間ずっと再利用されるため、`createParadisEditorTerminalIndicator`
// の `setInstance()` で対象ペインを都度差し替える。
//
// `_overflowGuardElement` / `_editorInput` は `TerminalEditor`側で private のため、DOM
// クエリ（createEditor）とメソッド引数（setInput）だけでアクセスし、既存クラスへは一切手を
// 入れない。差し替えは terminal.contribution.ts の EditorPaneDescriptor.create() 呼び出し
// 1箇所のみ。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createParadisEditorTerminalIndicator, IParadisEditorTerminalIndicatorController } from '../../../../paradis/contrib/agentBrowser/browser/paradisPaneIndicator.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { TerminalEditor } from '../../../../workbench/contrib/terminal/browser/terminalEditor.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';

/**
 * `TerminalEditor` に agent-browser-binding indicator を配線するだけの差し替えクラス。
 * ロジックは一切変更せず、`super` 呼び出し前後にインジケータの配置/対象差し替えを足すのみ。
 */
export class SessionTerminalEditor extends TerminalEditor {

	private _paradisIndicator: IParadisEditorTerminalIndicatorController | undefined;

	protected override createEditor(parent: HTMLElement): void {
		super.createEditor(parent);
		// overflow guard 要素は TerminalEditor 側で private のため、公開APIに無い代替手段として
		// DOM クエリで取得する（生成直後でこの1要素しか無いため確実に一致する）。
		// eslint-disable-next-line no-restricted-syntax
		const overflowGuard = parent.querySelector<HTMLElement>('.terminal-overflow-guard.terminal-editor');
		if (overflowGuard) {
			this._paradisIndicator = this._register(createParadisEditorTerminalIndicator(overflowGuard));
		}
	}

	override async setInput(newInput: TerminalEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(newInput, options, context, token);
		this._paradisIndicator?.setInstance(newInput.terminalInstance?.instanceId);
	}

	override clearInput(): void {
		super.clearInput();
		this._paradisIndicator?.setInstance(undefined);
	}
}
