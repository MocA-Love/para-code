/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';

/**
 * チャット表示のボタン（許可・回答・送信）。本家の Button をそのまま使い、主か副かだけを選ぶ。
 * 要素には `paradis-agent-chat-primary` / `paradis-agent-chat-secondary` を付ける（並べ方の CSS とテストが探す印）。
 */
export function paradisAgentChatButton(container: HTMLElement, kind: 'primary' | 'secondary', store: DisposableStore): Button {
	const button = store.add(new Button(container, { ...defaultButtonStyles, secondary: kind === 'secondary' }));
	button.element.classList.add(kind === 'primary' ? 'paradis-agent-chat-primary' : 'paradis-agent-chat-secondary');
	return button;
}
