/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)ビューアの EditorInput とシリアライザ。vendored docx-preview(electron-browser 層の media)を
// 使うため PDF ビューアと同じく electron-browser 層に置く。docx に Raw テキストモードは無いので読み取り専用。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../browser/paradisFileViewerInput.js';
import { PARADIS_DOCX_EDITOR_ID, PARADIS_DOCX_INPUT_TYPE_ID } from '../browser/paradisFileViewers.js';

/** Word(.docx)ビューアの EditorInput。 */
export class ParadisDocxInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_DOCX_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_DOCX_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getIcon(): ThemeIcon {
		return Codicon.fileText;
	}
}

export class ParadisDocxInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput {
		return instantiationService.createInstance(ParadisDocxInput, resource);
	}
}
