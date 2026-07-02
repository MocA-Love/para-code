/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// レンダリングビューア（Markdown / HTML）の EditorInput 基底クラスとその Markdown 実装。
// Input はリソース URI を保持するだけの薄いラッパで、実際の描画は対応する EditorPane が行う。
// Raw（通常のテキストエディタ）への切り替えは、同じ resource を override='default' で開き直すことで実現する。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, IUntypedEditorInput, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { PARADIS_MARKDOWN_EDITOR_ID, PARADIS_MARKDOWN_INPUT_TYPE_ID } from './paradisFileViewers.js';

/**
 * レンダリングビューア共通の EditorInput 基底。resource を保持し、
 * それに対応する Rendered EditorPane（editorId）へルーティングされる。
 */
export abstract class ParadisFileViewerInput extends EditorInput {

	constructor(
		private readonly _resource: URI,
	) {
		super();
	}

	override get resource(): URI {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		// レンダリング表示は読み取り専用（編集は Raw のテキストエディタで行う）。
		return EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return basename(this._resource);
	}

	override getIcon(): ThemeIcon {
		return Codicon.goToFile;
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
 * リソース URI のみを直列化するシリアライザ。ワークベンチ復元時に
 * 同じ resource を再び Rendered ビューアで開き直すために使う。
 */
export abstract class ParadisFileViewerInputSerializer implements IEditorSerializer {

	protected abstract createInput(instantiationService: IInstantiationService, resource: URI): EditorInput;

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof ParadisFileViewerInput && !!editor.resource;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!(editor instanceof ParadisFileViewerInput) || !editor.resource) {
			return undefined;
		}
		return JSON.stringify({ resource: editor.resource.toString() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditor) as { resource: string };
			return this.createInput(instantiationService, URI.parse(data.resource));
		} catch {
			return undefined;
		}
	}
}

export class ParadisMarkdownFileInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): EditorInput {
		return instantiationService.createInstance(ParadisMarkdownFileInput, resource);
	}
}
