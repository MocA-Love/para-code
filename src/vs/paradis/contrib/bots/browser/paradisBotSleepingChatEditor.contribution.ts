/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 眠った Bot の会話を読むだけの吹き出しのエディタ（paradisBotSleepingChatEditor.ts）を登録する。

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { ParadisBotSleepingChatEditor, ParadisBotSleepingChatEditorInput, PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID } from './paradisBotSleepingChatEditor.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisBotSleepingChatEditor, PARADIS_BOT_SLEEPING_CHAT_EDITOR_ID, localize('paradis.botSleeping.editorName', "眠った Bot の会話")),
	[new SyncDescriptor(ParadisBotSleepingChatEditorInput)],
);
