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
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../browser/paradisFileViewerInput.js';
import { PARADIS_DOCX_DIFF_EDITOR_ID, PARADIS_DOCX_DIFF_INPUT_TYPE_ID, PARADIS_DOCX_EDITOR_ID, PARADIS_DOCX_INPUT_TYPE_ID } from '../browser/paradisFileViewers.js';
import type { ParadisOfficeSerializerRegistration } from '../browser/paradisOfficeConfiguration.js';

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

/** Word(.docx)差分ビューアの EditorInput(旧版=original / 新版=modified の2リソースを保持)。 */
export class ParadisDocxDiffInput extends EditorInput {

	constructor(
		readonly originalResource: URI,
		readonly modifiedResource: URI,
		private readonly _label: string | undefined,
	) {
		super();
	}

	override get typeId(): string {
		return PARADIS_DOCX_DIFF_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_DOCX_DIFF_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override get resource(): URI {
		return this.modifiedResource;
	}

	override getName(): string {
		// allow-any-unicode-next-line
		return this._label || localize('paradis.docxDiff.name', "{0} (差分)", basename(this.modifiedResource));
	}

	override getIcon(): ThemeIcon {
		return Codicon.fileText;
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof ParadisDocxDiffInput) {
			return isEqual(other.originalResource, this.originalResource) && isEqual(other.modifiedResource, this.modifiedResource);
		}
		return false;
	}
}

export class ParadisDocxDiffInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisDocxDiffInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisDocxDiffInput)) {
			return undefined;
		}
		return JSON.stringify({
			original: editor.originalResource.toString(),
			modified: editor.modifiedResource.toString(),
			label: editor.getName(),
		});
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as { original: string; modified: string; label?: string };
			return instantiationService.createInstance(ParadisDocxDiffInput, URI.parse(data.original), URI.parse(data.modified), data.label);
		} catch {
			return undefined;
		}
	}
}

export const PARADIS_DOCX_SERIALIZER_REGISTRATIONS = Object.freeze([
	[PARADIS_DOCX_INPUT_TYPE_ID, ParadisDocxInputSerializer],
	[PARADIS_DOCX_DIFF_INPUT_TYPE_ID, ParadisDocxDiffInputSerializer],
] satisfies readonly ParadisOfficeSerializerRegistration[]);
