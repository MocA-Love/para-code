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
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, GroupIdentifier, IRevertOptions, ISaveOptions } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PARADIS_FILE_DIFF_EDITOR_ID, PARADIS_FILE_DIFF_INPUT_TYPE_ID } from './paradisFileViewers.js';
import { ParadisResourcePairDiffInput, ParadisResourcePairDiffInputSerializer } from './paradisResourcePairDiffInput.js';

/** MD/HTML 共用のテキスト差分エディタの EditorInput。 */
export class ParadisFileDiffInput extends ParadisResourcePairDiffInput {

	constructor(
		originalResource: URI,
		modifiedResource: URI,
		label: string | undefined,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
	) {
		super(originalResource, modifiedResource, label);
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
}

export class ParadisFileDiffInputSerializer extends ParadisResourcePairDiffInputSerializer<ParadisFileDiffInput> {

	protected owns(editor: EditorInput): editor is ParadisFileDiffInput {
		return editor instanceof ParadisFileDiffInput;
	}

	protected createInput(instantiationService: IInstantiationService, original: URI, modified: URI, label: string | undefined): ParadisFileDiffInput {
		return instantiationService.createInstance(ParadisFileDiffInput, original, modified, label);
	}
}
