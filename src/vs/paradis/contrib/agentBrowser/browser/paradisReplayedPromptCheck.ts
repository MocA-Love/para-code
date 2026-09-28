/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 控えから流し直した許可要求・質問（W2-20）が、画面に今も出ているかの判定。判定の文言は、チャット表示が
// 文を送る前に使っている既存の画面読み取り（paradisAgentTuiInput.ts）をそのまま使う。

import { paradisScreenShowsPermissionPrompt, paradisScreenShowsQuestionPrompt } from '../../agentChat/browser/paradisAgentTuiInput.js';

/** その種類の確認が画面の下端に出ているか。画面が読めない（空）ときは出ていないとみなす。 */
export function paradisReplayedPromptShownOnScreen(status: 'permission' | 'question', screen: string): boolean {
	if (screen.trim().length === 0) {
		return false;
	}
	return status === 'permission' ? paradisScreenShowsPermissionPrompt(screen) : paradisScreenShowsQuestionPrompt(screen);
}
