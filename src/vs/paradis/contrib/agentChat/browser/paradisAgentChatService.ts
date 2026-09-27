/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IParadisAgentChatService = createDecorator<IParadisAgentChatService>('paradisAgentChatService');

/** デスクトップのチャット表示（実体は electron-browser の ParadisAgentChatController）。 */
export interface IParadisAgentChatService {
	readonly _serviceBrand: undefined;
	/**
	 * チャット表示とターミナル表示を切り替える。context はタブ列のボタンから渡される
	 * `{ groupId }`（無ければアクティブなグループのタブが対象）。
	 */
	toggleFromCommand(context: unknown): void;
}
