/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_SESSION_RESUME_EDITOR_ID = 'paradis.editor.sessionResume';
export const PARADIS_SESSION_RESUME_INPUT_TYPE_ID = 'paradis.input.sessionResume';

export class ParadisSessionResumeInput extends EditorInput {
	static readonly ID = PARADIS_SESSION_RESUME_INPUT_TYPE_ID;
	private static _instance: ParadisSessionResumeInput | undefined;

	static get instance(): ParadisSessionResumeInput {
		if (!this._instance || this._instance.isDisposed()) {
			this._instance = new ParadisSessionResumeInput();
		}
		return this._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-session-resume', path: 'sessions' });
	override get typeId(): string { return ParadisSessionResumeInput.ID; }
	override get editorId(): string { return PARADIS_SESSION_RESUME_EDITOR_ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }
	override getName(): string { return localize('paradis.sessionResume.inputName', "セッション履歴"); }
	override getIcon(): ThemeIcon { return Codicon.history; }

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ParadisSessionResumeInput;
	}
}

export class ParadisSessionResumeInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return '{}'; }
	deserialize(): EditorInput { return ParadisSessionResumeInput.instance; }
}
