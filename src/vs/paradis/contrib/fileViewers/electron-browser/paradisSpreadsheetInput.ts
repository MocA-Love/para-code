/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excelビューア/差分の EditorInput とシリアライザ。exceljs(shared process)依存のため electron-browser 層に置く。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../browser/paradisFileViewerInput.js';
import { ParadisResourcePairDiffInput, ParadisResourcePairDiffInputSerializer } from '../browser/paradisResourcePairDiffInput.js';
import { PARADIS_SPREADSHEET_DIFF_EDITOR_ID, PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID, PARADIS_SPREADSHEET_EDITOR_ID, PARADIS_SPREADSHEET_INPUT_TYPE_ID } from '../browser/paradisFileViewers.js';
import type { ParadisOfficeSerializerRegistration } from '../browser/paradisOfficeConfiguration.js';

/** Excel ビューア(単一ファイル)の EditorInput。Excel には Raw テキストモードが無いので読み取り専用。 */
export class ParadisSpreadsheetInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_SPREADSHEET_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_SPREADSHEET_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getIcon(): ThemeIcon {
		return Codicon.table;
	}
}

export class ParadisSpreadsheetInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput {
		return instantiationService.createInstance(ParadisSpreadsheetInput, resource);
	}
}

/** Excel 差分ビューアの EditorInput(旧版=original / 新版=modified の2リソースを保持)。 */
export class ParadisSpreadsheetDiffInput extends ParadisResourcePairDiffInput {

	override get typeId(): string {
		return PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_SPREADSHEET_DIFF_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getIcon(): ThemeIcon {
		return Codicon.table;
	}
}

export class ParadisSpreadsheetDiffInputSerializer extends ParadisResourcePairDiffInputSerializer<ParadisSpreadsheetDiffInput> {

	protected owns(editor: EditorInput): editor is ParadisSpreadsheetDiffInput {
		return editor instanceof ParadisSpreadsheetDiffInput;
	}

	protected createInput(_instantiationService: IInstantiationService, original: URI, modified: URI, label: string | undefined): ParadisSpreadsheetDiffInput {
		return new ParadisSpreadsheetDiffInput(original, modified, label);
	}
}

export const PARADIS_SPREADSHEET_SERIALIZER_REGISTRATIONS = Object.freeze([
	[PARADIS_SPREADSHEET_INPUT_TYPE_ID, ParadisSpreadsheetInputSerializer],
	[PARADIS_SPREADSHEET_DIFF_INPUT_TYPE_ID, ParadisSpreadsheetDiffInputSerializer],
] satisfies readonly ParadisOfficeSerializerRegistration[]);
