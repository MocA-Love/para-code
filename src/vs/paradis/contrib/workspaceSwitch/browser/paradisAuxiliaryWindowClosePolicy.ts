/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';

/** 判定に要る部分だけを取り出した別ウィンドウのエディタ。 */
interface IParadisClosableEditor {
	readonly typeId: string;
	isDirty(): boolean;
}

/** 判定に要る部分だけを取り出した別ウィンドウ（エディタ部）。 */
interface IParadisClosablePart {
	readonly groups: readonly { readonly editors: readonly IParadisClosableEditor[] }[];
}

/**
 * 所属スペースが決まっていない（pending の）別ウィンドウを、閉じてよいか。
 *
 * pending の別ウィンドウを閉じさせないのは、中身をどのスペースへ預けるか決められず、ターミナルや
 * 未保存の変更を失うおそれがあるため。中身が内蔵ブラウザのタブだけ（または空）で、未保存の変更も
 * 無ければ、閉じても失うものは無い。エージェントや Web ページの `window.open` で開いた popup が
 * これに当たり、ページの `window.close()` でエディタが閉じたあと別ウィンドウが自分を閉じる経路も
 * ここを通る。
 */
export function paradisCanCloseUnscopedAuxiliaryPart(part: IParadisClosablePart): boolean {
	return part.groups.every(group => group.editors.every(editor => editor.typeId === BrowserEditorInput.ID && !editor.isDirty()));
}
