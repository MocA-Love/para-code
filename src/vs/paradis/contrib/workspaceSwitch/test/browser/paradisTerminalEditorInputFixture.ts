/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDeserializedTerminalEditorInput } from '../../../../../workbench/contrib/terminal/browser/terminal.js';

/**
 * 直列化されたターミナルエディタ入力の最小形。
 *
 * `id` は「working set を保存した世代」の persistentProcessId で、`shellIntegrationNonce` が
 * 世代を跨いで不変な同一性。この2つの食い違いこそが park/revive のテスト対象なので、
 * 両方を明示的に指定できる形にしてある。
 */
export function paradisCreateDeserializedTerminalEditorInput(
	persistentProcessId: number,
	shellIntegrationNonce: string,
): IDeserializedTerminalEditorInput {
	return {
		id: persistentProcessId,
		pid: 0,
		shellIntegrationNonce,
	} satisfies Partial<IDeserializedTerminalEditorInput> as unknown as IDeserializedTerminalEditorInput;
}
