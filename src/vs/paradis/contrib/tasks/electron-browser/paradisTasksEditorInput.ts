/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面のエディタのタブ（リソースを持たない、1 ウィンドウに 1 つだけの入力）。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_TASKS_EDITOR_ID = 'paradis.editor.tasks';
export const PARADIS_TASKS_INPUT_TYPE_ID = 'paradis.input.tasks';
/** 「タスク」の画面を開くコマンド（左のサイドバーの「タスク」の行もこれを呼ぶ）。 */
export const PARADIS_TASKS_OPEN_COMMAND_ID = 'paradis.tasks.open';

export class ParadisTasksEditorInput extends EditorInput {

	static readonly ID = PARADIS_TASKS_INPUT_TYPE_ID;

	private static _instance: ParadisTasksEditorInput | undefined;
	static get instance(): ParadisTasksEditorInput {
		if (!ParadisTasksEditorInput._instance || ParadisTasksEditorInput._instance.isDisposed()) {
			ParadisTasksEditorInput._instance = new ParadisTasksEditorInput();
		}
		return ParadisTasksEditorInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-tasks', path: 'tasks' });

	override get typeId(): string {
		return ParadisTasksEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_TASKS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.tasks.inputName', "タスク");
	}

	override getIcon(): ThemeIcon {
		return Codicon.issues;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ParadisTasksEditorInput;
	}
}

/** ウィンドウを開き直してもタブを戻せるようにする。 */
export class ParadisTasksEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisTasksEditorInput.instance;
	}
}
