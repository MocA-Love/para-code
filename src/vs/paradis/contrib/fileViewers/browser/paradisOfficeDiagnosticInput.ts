/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import {
	PARADIS_OFFICE_BROWSER_EDITOR_ID,
	PARADIS_OFFICE_BROWSER_INPUT_TYPE_ID,
	getParadisOfficeFormat,
	type ParadisOfficeFileFormat,
} from './paradisFileViewers.js';

export type ParadisOfficeBrowserInputMode = 'semantic' | 'diagnostic';

/** Read-only input shared by the browser semantic summary and unsupported-format diagnostic. */
export class ParadisOfficeDiagnosticInput extends EditorInput {

	constructor(
		private readonly _resource: URI,
		readonly format: ParadisOfficeFileFormat,
		readonly mode: ParadisOfficeBrowserInputMode,
		readonly originalResource?: URI,
		private readonly _label?: string,
	) {
		super();
	}

	override get typeId(): string { return PARADIS_OFFICE_BROWSER_INPUT_TYPE_ID; }
	override get editorId(): string { return PARADIS_OFFICE_BROWSER_EDITOR_ID; }
	override get resource(): URI { return this._resource; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly; }
	override getName(): string { return this._label ?? basename(this._resource); }
	override async resolve(): Promise<null> { return null; }

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisOfficeDiagnosticInput
			&& other.format === this.format
			&& other.mode === this.mode
			&& isEqual(other.resource, this.resource)
			&& (other.originalResource === undefined && this.originalResource === undefined
				|| other.originalResource !== undefined && this.originalResource !== undefined && isEqual(other.originalResource, this.originalResource));
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: this.editorId } };
	}
}

interface SerializedParadisOfficeInput {
	readonly resource: string;
	readonly format: ParadisOfficeFileFormat;
	readonly mode: ParadisOfficeBrowserInputMode;
	readonly originalResource?: string;
	readonly label?: string;
}

export class ParadisOfficeDiagnosticInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisOfficeDiagnosticInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisOfficeDiagnosticInput)) {
			return undefined;
		}
		const data: SerializedParadisOfficeInput = {
			resource: editor.resource.toString(),
			format: editor.format,
			mode: editor.mode,
			...(editor.originalResource ? { originalResource: editor.originalResource.toString() } : {}),
		};
		return JSON.stringify(data);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as SerializedParadisOfficeInput;
			const resource = URI.parse(data.resource);
			if (getParadisOfficeFormat(resource) !== data.format || data.mode !== 'semantic' && data.mode !== 'diagnostic') {
				return undefined;
			}
			return instantiationService.createInstance(
				ParadisOfficeDiagnosticInput,
				resource,
				data.format,
				data.mode,
				data.originalResource ? URI.parse(data.originalResource) : undefined,
				data.label,
			);
		} catch {
			return undefined;
		}
	}
}
