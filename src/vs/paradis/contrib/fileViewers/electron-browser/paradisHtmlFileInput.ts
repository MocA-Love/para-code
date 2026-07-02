/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// HTML レンダリングビューアの EditorInput とシリアライザ。webview を使うため electron-browser 層に置く。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../browser/paradisFileViewerInput.js';
import { PARADIS_HTML_EDITOR_ID, PARADIS_HTML_INPUT_TYPE_ID } from '../browser/paradisFileViewers.js';

/** HTML レンダリングビューアの EditorInput。 */
export class ParadisHtmlFileInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_HTML_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_HTML_EDITOR_ID;
	}

	override getIcon(): ThemeIcon {
		return Codicon.code;
	}
}

export class ParadisHtmlFileInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): EditorInput {
		return instantiationService.createInstance(ParadisHtmlFileInput, resource);
	}
}
