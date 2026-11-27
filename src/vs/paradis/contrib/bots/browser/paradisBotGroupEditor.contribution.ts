/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot グループの部屋（paradisBotGroupEditor.ts）をエディタに登録する。タブの復元はしない（シリアライザを登録しない）。
// paradisBotGroups.contribution.ts から読み込む。

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions } from '../../../../workbench/common/editor.js';
import { ParadisBotGroupEditor, ParadisBotGroupEditorInput, PARADIS_BOT_GROUP_EDITOR_ID } from './paradisBotGroupEditor.js';
import './media/paradisBotGroup.css';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisBotGroupEditor, PARADIS_BOT_GROUP_EDITOR_ID, localize('paradis.botGroups.editorName', "Bot グループ")),
	[new SyncDescriptor(ParadisBotGroupEditorInput)],
);
