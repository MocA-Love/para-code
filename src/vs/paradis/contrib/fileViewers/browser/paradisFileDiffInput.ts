/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MD/HTML ビューアが差分オープン(SCM の Open Changes 等)を横取りしたときの EditorInput。
// 旧版(original、通常 git: スキーム)と新版(modified)の2リソースを保持し、
// dirty/save は新版のテキストファイルワーキングコピーへ委譲する(標準 diff と同じく右側は編集可能)。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorSerializer, IRevertOptions, ISaveOptions, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PARADIS_FILE_DIFF_EDITOR_ID, PARADIS_FILE_DIFF_INPUT_TYPE_ID } from './paradisFileViewers.js';

/** MD/HTML 共用のテキスト差分エディタの EditorInput。 */
export class ParadisFileDiffInput extends EditorInput {

	constructor(
		readonly originalResource: URI,
		readonly modifiedResource: URI,
		private readonly _label: string | undefined,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
	) {
		super();
		// 右側(modified)で編集された内容の dirty をタブへ反映する。
		this._register(workingCopyService.onDidChangeDirty(wc => {
			if (isEqual(wc.resource, this.modifiedResource)) {
				this._onDidChangeDirty.fire();
			}
		}));
	}

	override get typeId(): string {
		return PARADIS_FILE_DIFF_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_FILE_DIFF_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// 右側(modified)は編集・保存可能なので Readonly は付けない。
		return EditorInputCapabilities.None;
	}

	override get resource(): URI {
		return this.modifiedResource;
	}

	override getName(): string {
		// allow-any-unicode-next-line
		return this._label || localize('paradis.fileDiff.name', "{0} (差分)", basename(this.modifiedResource));
	}

	override getIcon(): ThemeIcon {
		return Codicon.diff;
	}

	override isDirty(): boolean {
		return this._textFileService.isDirty(this.modifiedResource);
	}

	override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
		const target = await this._textFileService.save(this.modifiedResource, options);
		return target ? this : undefined;
	}

	override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		await this._textFileService.revert(this.modifiedResource, options);
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof ParadisFileDiffInput) {
			return isEqual(other.originalResource, this.originalResource) && isEqual(other.modifiedResource, this.modifiedResource);
		}
		return false;
	}
}

export class ParadisFileDiffInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisFileDiffInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisFileDiffInput)) {
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
			return instantiationService.createInstance(ParadisFileDiffInput, URI.parse(data.original), URI.parse(data.modified), data.label);
		} catch {
			return undefined;
		}
	}
}
