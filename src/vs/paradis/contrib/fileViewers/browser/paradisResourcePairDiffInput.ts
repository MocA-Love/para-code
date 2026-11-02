/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 旧版(original)と新版(modified)の 2 つのリソースを持つ、ビューアの差分の EditorInput とそのシリアライザの共通部分。
// MD/HTML・Word・Excel の差分の Input はこれを継ぐ。

import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

/** 名前を渡されなかったときのタブの名前。 */
function defaultResourcePairDiffName(modifiedResource: URI): string {
	// allow-any-unicode-next-line
	return localize('paradis.fileDiff.name', "{0} (差分)", basename(modifiedResource));
}

/** 2 つのリソースを持つ差分の EditorInput。タブの名前は渡された名前、無ければ新版のファイル名から作る。 */
export abstract class ParadisResourcePairDiffInput extends EditorInput {

	constructor(
		readonly originalResource: URI,
		readonly modifiedResource: URI,
		/** 開いた側が渡した名前。無ければ {@link getName} が新版のファイル名から作る。 */
		readonly label: string | undefined,
	) {
		super();
	}

	override get resource(): URI {
		return this.modifiedResource;
	}

	override getName(): string {
		return this.label || defaultResourcePairDiffName(this.modifiedResource);
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisResourcePairDiffInput && other.typeId === this.typeId
			&& isEqual(other.originalResource, this.originalResource) && isEqual(other.modifiedResource, this.modifiedResource);
	}
}

interface ISerializedResourcePairDiff {
	readonly original: string;
	readonly modified: string;
	readonly label?: string;
}

/**
 * {@link ParadisResourcePairDiffInput} のシリアライザ。保存するのは渡された名前だけにする（`getName()` を保存すると、
 * 名前を渡されなかった差分の既定の名前が、復元した後も固定される）。
 */
export abstract class ParadisResourcePairDiffInputSerializer<T extends ParadisResourcePairDiffInput> implements IEditorSerializer {

	/** この Input の種類か。 */
	protected abstract owns(editor: EditorInput): editor is T;

	protected abstract createInput(instantiationService: IInstantiationService, original: URI, modified: URI, label: string | undefined): T;

	canSerialize(editor: EditorInput): boolean {
		return this.owns(editor);
	}

	serialize(editor: EditorInput): string | undefined {
		if (!this.owns(editor)) {
			return undefined;
		}
		const data: ISerializedResourcePairDiff = {
			original: editor.originalResource.toString(),
			modified: editor.modifiedResource.toString(),
			...(editor.label ? { label: editor.label } : {}),
		};
		return JSON.stringify(data);
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as ISerializedResourcePairDiff;
			const original = URI.parse(data.original);
			const modified = URI.parse(data.modified);
			// 前の版は `getName()` を保存していた。既定の名前と同じなら、渡された名前ではなかったものとして扱う。
			const label = typeof data.label === 'string' && data.label !== defaultResourcePairDiffName(modified) ? data.label : undefined;
			return this.createInput(instantiationService, original, modified, label);
		} catch {
			return undefined;
		}
	}
}
