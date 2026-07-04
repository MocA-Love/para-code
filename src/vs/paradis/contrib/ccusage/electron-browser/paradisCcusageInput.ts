/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ccusage ダッシュボードのシングルトン EditorInput とシリアライザ。
// ファイルリソースを持たないダッシュボード型エディタ(upstream の RuntimeExtensionsInput と同じパターン)。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_CCUSAGE_EDITOR_ID = 'paradis.editor.ccusageDashboard';
export const PARADIS_CCUSAGE_INPUT_TYPE_ID = 'paradis.input.ccusageDashboard';

export class ParadisCcusageInput extends EditorInput {

	static readonly ID = PARADIS_CCUSAGE_INPUT_TYPE_ID;

	private static _instance: ParadisCcusageInput | undefined;
	static get instance(): ParadisCcusageInput {
		if (!ParadisCcusageInput._instance || ParadisCcusageInput._instance.isDisposed()) {
			ParadisCcusageInput._instance = new ParadisCcusageInput();
		}
		return ParadisCcusageInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-ccusage', path: 'dashboard' });

	override get typeId(): string {
		return ParadisCcusageInput.ID;
	}

	override get editorId(): string {
		return PARADIS_CCUSAGE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.ccusage.inputName', "ccusage Dashboard");
	}

	override getIcon(): ThemeIcon {
		return Codicon.graph;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisCcusageInput;
	}
}

/** ウィンドウ再起動後もタブを復元できるようにするシリアライザ。 */
export class ParadisCcusageInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisCcusageInput.instance;
	}
}
