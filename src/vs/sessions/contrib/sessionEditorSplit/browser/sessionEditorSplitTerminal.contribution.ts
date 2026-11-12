/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IParadisEditorSplitTerminalService } from '../../../../workbench/services/editor/common/paradisEditorSplitTerminalService.js';

/**
 * The split editor commands (editorCommands.ts) always ask for {@link IParadisEditorSplitTerminalService}.
 * The real service is registered only by the normal window (vs/paradis), so the Agents window registers
 * this implementation that never opens a terminal. The normal window's `paradis.editor.openTerminalOnSplit`
 * setting (default off) is not registered in the Agents window either.
 */
class SessionEditorSplitTerminalService implements IParadisEditorSplitTerminalService {
	declare readonly _serviceBrand: undefined;

	async openTerminalInGroup(): Promise<void> { }
}

registerSingleton(IParadisEditorSplitTerminalService, SessionEditorSplitTerminalService, InstantiationType.Delayed);
