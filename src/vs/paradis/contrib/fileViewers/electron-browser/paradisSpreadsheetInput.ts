/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分の EditorInput とシリアライザ。exceljs(shared process)依存のため electron-browser 層に置く。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../browser/paradisFileViewerInput.js';
import { PARADIS_SPREADSHEET_DIFF_EDITOR_ID, PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID, PARADIS_SPREADSHEET_EDITOR_ID, PARADIS_SPREADSHEET_INPUT_TYPE_ID } from '../browser/paradisFileViewers.js';

/** Excel ビューア(単一ファイル)の EditorInput。 */
export class ParadisSpreadsheetInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_SPREADSHEET_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_SPREADSHEET_EDITOR_ID;
	}

	override getIcon(): ThemeIcon {
		return Codicon.table;
	}
}

export class ParadisSpreadsheetInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): EditorInput {
		return instantiationService.createInstance(ParadisSpreadsheetInput, resource);
	}
}

/** Excel 差分ビューアの EditorInput(旧版=original / 新版=modified の2リソースを保持)。 */
export class ParadisSpreadsheetDiffInput extends EditorInput {

	constructor(
		readonly originalResource: URI,
		readonly modifiedResource: URI,
		private readonly _label: string | undefined,
	) {
		super();
	}

	override get typeId(): string {
		return PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_SPREADSHEET_DIFF_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override get resource(): URI {
		return this.modifiedResource;
	}

	override getName(): string {
		// allow-any-unicode-next-line
		return this._label || localize('paradis.spreadsheetDiff.name', "{0} (差分)", basename(this.modifiedResource));
	}

	override getIcon(): ThemeIcon {
		return Codicon.table;
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof ParadisSpreadsheetDiffInput) {
			return isEqual(other.originalResource, this.originalResource) && isEqual(other.modifiedResource, this.modifiedResource);
		}
		return false;
	}
}

export class ParadisSpreadsheetDiffInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisSpreadsheetDiffInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisSpreadsheetDiffInput)) {
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
			return instantiationService.createInstance(ParadisSpreadsheetDiffInput, URI.parse(data.original), URI.parse(data.modified), data.label);
		} catch {
			return undefined;
		}
	}
}
