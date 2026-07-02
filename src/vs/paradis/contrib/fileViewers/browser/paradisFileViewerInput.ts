/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レンダリングビューア（Markdown / HTML）の EditorInput 基底クラスとその Markdown 実装。
// 単一ペイン内に Rendered（webview）と Raw（埋め込みコードエディタ）の両モードを内蔵する方式のため、
// Input は resource + 現在の表示モード（rendered/raw）を保持し、dirty/save はテキストファイルの
// ワーキングコピーへ委譲する（Raw で編集→保存できる）。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorSerializer, IRevertOptions, ISaveOptions, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PARADIS_MARKDOWN_EDITOR_ID, PARADIS_MARKDOWN_INPUT_TYPE_ID } from './paradisFileViewers.js';

/** ビューアの表示モード。 */
export type ParadisFileViewerMode = 'rendered' | 'raw';

/**
 * レンダリングビューア共通の EditorInput 基底。resource + 表示モードを保持し、
 * 対応する単一の EditorPane（editorId）が Rendered/Raw を内蔵切替する。
 */
export abstract class ParadisFileViewerInput extends EditorInput {

	private _viewMode: ParadisFileViewerMode = 'rendered';

	constructor(
		private readonly _resource: URI,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IWorkingCopyService workingCopyService: IWorkingCopyService,
	) {
		super();
		// Raw で編集された内容の dirty をタブに反映するため、ワーキングコピーの dirty 変化を購読する。
		this._register(workingCopyService.onDidChangeDirty(wc => {
			if (isEqual(wc.resource, this._resource)) {
				this._onDidChangeDirty.fire();
			}
		}));
	}

	override get resource(): URI {
		return this._resource;
	}

	/** 現在の表示モード（rendered/raw）。ペインのトグルが更新し、シリアライザが永続化する。 */
	get viewMode(): ParadisFileViewerMode {
		return this._viewMode;
	}

	setViewMode(mode: ParadisFileViewerMode): void {
		this._viewMode = mode;
	}

	override get capabilities(): EditorInputCapabilities {
		// Raw で編集可能なので Readonly は付けない。
		return EditorInputCapabilities.None;
	}

	override getName(): string {
		return basename(this._resource);
	}

	override getIcon(): ThemeIcon {
		return Codicon.goToFile;
	}

	override isDirty(): boolean {
		return this._textFileService.isDirty(this._resource);
	}

	override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
		const target = await this._textFileService.save(this._resource, options);
		return target ? this : undefined;
	}

	override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		await this._textFileService.revert(this._resource, options);
	}

	override async resolve(): Promise<null> {
		return null;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof ParadisFileViewerInput) {
			return other.typeId === this.typeId && isEqual(other.resource, this._resource);
		}
		return false;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: {
				override: this.editorId
			}
		};
	}
}

/** Markdown レンダリングビューアの EditorInput。 */
export class ParadisMarkdownFileInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_MARKDOWN_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_MARKDOWN_EDITOR_ID;
	}

	override getIcon(): ThemeIcon {
		return Codicon.markdown;
	}
}

/**
 * resource + 表示モードを直列化するシリアライザ。ワークベンチ復元時に
 * 同じ resource を同じモードで Rendered ビューアに開き直す。
 */
export abstract class ParadisFileViewerInputSerializer implements IEditorSerializer {

	protected abstract createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput;

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisFileViewerInput && !!editor.resource;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisFileViewerInput) || !editor.resource) {
			return undefined;
		}
		return JSON.stringify({ resource: editor.resource.toString(), viewMode: editor.viewMode });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as { resource: string; viewMode?: ParadisFileViewerMode };
			const input = this.createInput(instantiationService, URI.parse(data.resource));
			if (data.viewMode === 'raw') {
				input.setViewMode('raw');
			}
			return input;
		} catch {
			return undefined;
		}
	}
}

export class ParadisMarkdownFileInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput {
		return instantiationService.createInstance(ParadisMarkdownFileInput, resource);
	}
}
