/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像ビューアの EditorInput とシリアライザ。画像は読み取り専用（SVG をテキストで編集するときは
// 「ソース テキストとして開き直す」で標準のテキストエディタへ移る）。

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities } from '../../../../../workbench/common/editor.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../paradisFileViewerInput.js';
import { PARADIS_IMAGE_EDITOR_ID, PARADIS_IMAGE_INPUT_TYPE_ID, ParadisImageScale } from './paradisImagePreview.js';

/** タブを切り替えて戻ったときに戻す倍率とスクロール位置。 */
export interface ParadisImageViewState {
	readonly scale: ParadisImageScale;
	readonly scrollLeft: number;
	readonly scrollTop: number;
}

/** 画像ビューアの EditorInput。 */
export class ParadisImageInput extends ParadisFileViewerInput {

	/** このタブで最後に見ていた倍率と位置（ウィンドウを開き直すと「画像全体」に戻る）。 */
	viewState: ParadisImageViewState | undefined;

	override get typeId(): string {
		return PARADIS_IMAGE_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_IMAGE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	override getIcon(): ThemeIcon {
		return Codicon.fileMedia;
	}

	/** 同じ SVG をテキストで編集中でも、画像のタブは保存の対象にしない（upstream の読み取り専用プレビューと同じ）。 */
	override isDirty(): boolean {
		return false;
	}
}

export class ParadisImageInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput {
		return instantiationService.createInstance(ParadisImageInput, resource);
	}
}
