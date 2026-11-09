/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「モバイル」のエディタのタブ（リソースを持たない、1 ウィンドウに 1 つだけの入力）。「タスク」のタブと同じ作り。

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';

export const PARADIS_MOBILE_EDITOR_ID = 'paradis.editor.mobile';
export const PARADIS_MOBILE_INPUT_TYPE_ID = 'paradis.input.mobile';
/** 「モバイル」のタブを開くコマンド（左のサイドバーの「モバイル」の行とステータスバーの項目もこれを呼ぶ）。 */
export const PARADIS_MOBILE_OPEN_COMMAND_ID = 'paradis.mobile.open';
/** 新しく接続する（QR のモーダル。鍵を読めない・再ペアリングが要るときの確認も含む）。 */
export const PARADIS_MOBILE_CONNECT_DEVICE_COMMAND_ID = 'paradis.mobile.connectDevice';
/** 読めなかった鍵と台帳を読み直す（タブのお知らせのボタン。コマンドパレットには出さない）。 */
export const PARADIS_MOBILE_RETRY_STORE_COMMAND_ID = 'paradis.mobile.retryStoreLoad';
/** 端末 1 台を確かめてから解除する（引数は mobileId。コマンドパレットには出さない）。 */
export const PARADIS_MOBILE_REVOKE_DEVICE_COMMAND_ID = 'paradis.mobile.revokeDevice';

export class ParadisMobileEditorInput extends EditorInput {

	static readonly ID = PARADIS_MOBILE_INPUT_TYPE_ID;

	private static _instance: ParadisMobileEditorInput | undefined;
	static get instance(): ParadisMobileEditorInput {
		if (!ParadisMobileEditorInput._instance || ParadisMobileEditorInput._instance.isDisposed()) {
			ParadisMobileEditorInput._instance = new ParadisMobileEditorInput();
		}
		return ParadisMobileEditorInput._instance;
	}

	readonly resource = URI.from({ scheme: 'paradis-mobile', path: 'mobile' });

	override get typeId(): string {
		return ParadisMobileEditorInput.ID;
	}

	override get editorId(): string {
		return PARADIS_MOBILE_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('paradis.mobile.inputName', "モバイル");
	}

	override getIcon(): ThemeIcon {
		return Codicon.deviceMobile;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ParadisMobileEditorInput;
	}
}

/** ウィンドウを開き直してもタブを戻せるようにする。 */
export class ParadisMobileEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(): string {
		return '{}';
	}

	deserialize(): EditorInput {
		return ParadisMobileEditorInput.instance;
	}
}
