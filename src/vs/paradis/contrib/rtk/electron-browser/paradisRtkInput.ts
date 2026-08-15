/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// RTK 節約ダッシュボードのシングルトン EditorInput とシリアライザ。
// ファイルリソースを持たないダッシュボード型エディタ(upstream の RuntimeExtensionsInput と同じパターン)。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_RTK_EDITOR_ID = 'paradis.editor.rtkDashboard';
export const PARADIS_RTK_INPUT_TYPE_ID = 'paradis.input.rtkDashboard';

export class ParadisRtkInput extends EditorInput {

	static readonly ID = PARADIS_RTK_INPUT_TYPE_ID;

	private static _instance: ParadisRtkInput | undefined;
	static get instance(): ParadisRtkInput {
		if (!ParadisRtkInput._instance || ParadisRtkInput._instance.isDisposed()) {
			ParadisRtkInput._instance = new ParadisRtkInput();
		}
		return ParadisRtkInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-rtk', path: 'dashboard' });

	override get typeId(): string {
		return ParadisRtkInput.ID;
	}

	override get editorId(): string {
		return PARADIS_RTK_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.rtk.inputName', "RTK 節約ダッシュボード");
	}

	override getIcon(): ThemeIcon {
		return Codicon.zap;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ParadisRtkInput;
	}
}

/** ウィンドウ再起動後もタブを復元できるようにするシリアライザ。 */
export class ParadisRtkInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisRtkInput.instance;
	}
}
