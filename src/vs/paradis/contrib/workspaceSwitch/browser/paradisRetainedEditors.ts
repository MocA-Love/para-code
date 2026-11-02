/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { SideBySideEditor } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../workbench/common/editor/sideBySideEditorInput.js';
import { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';

/**
 * スペースの切り替えでグループから外したエディタの入力を、破棄せずに持っておくための参照カウント。
 * `EditorParts.retainEditor` / `isEditorInputRetained` の中身（`editorParts.ts` から移した）。
 *
 * 横並びの入力は primary / secondary も一緒に握る。握りが 0 になったとき、どのグループにも
 * 残っていない入力だけを破棄する。
 */
export class ParadisRetainedEditors {

	private readonly retainedEditors = new Map<EditorInput, number>();

	/** `groups` は今のエディタグループの一覧を返す（握りを離すときに、まだ開いているかを見る）。 */
	constructor(private readonly groups: () => readonly IEditorGroupView[]) { }

	isRetained(editor: EditorInput): boolean {
		return this.retainedEditors.has(editor);
	}

	retain(editor: EditorInput): IDisposable {
		const retained = this.collectEditorInputs(editor);
		for (const input of retained) {
			this.retainedEditors.set(input, (this.retainedEditors.get(input) ?? 0) + 1);
		}

		return toDisposable(() => {
			for (const input of [...retained].reverse()) {
				const count = this.retainedEditors.get(input);
				if (count === undefined) {
					continue;
				}

				if (count > 1) {
					this.retainedEditors.set(input, count - 1);
					continue;
				}

				this.retainedEditors.delete(input);
				if (!this.groups().some(group => group.contains(input, { strictEquals: true, supportSideBySide: SideBySideEditor.ANY }))) {
					input.dispose();
				}
			}
		});
	}

	private collectEditorInputs(editor: EditorInput, result = new Set<EditorInput>()): ReadonlySet<EditorInput> {
		if (result.has(editor)) {
			return result;
		}

		result.add(editor);
		if (editor instanceof SideBySideEditorInput) {
			this.collectEditorInputs(editor.primary, result);
			this.collectEditorInputs(editor.secondary, result);
		}

		return result;
	}
}
