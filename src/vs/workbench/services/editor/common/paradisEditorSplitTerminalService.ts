/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroup } from './editorGroupsService.js';

export const IParadisEditorSplitTerminalService = createDecorator<IParadisEditorSplitTerminalService>('paradisEditorSplitTerminalService');

export interface IParadisEditorSplitTerminalService {
	readonly _serviceBrand: undefined;

	/**
	 * Opens a terminal in the group. Without options it only does so when `paradis.editor.openTerminalOnSplit`
	 * is on (the editor split). The terminal context menus pass `force` to split a terminal regardless.
	 */
	openTerminalInGroup(group: IEditorGroup, options?: IParadisOpenTerminalInGroupOptions): Promise<void>;
}

export interface IParadisOpenTerminalInGroupOptions {
	/** Open the terminal even when `paradis.editor.openTerminalOnSplit` is off. */
	readonly force?: boolean;
	/** The working directory of the new terminal (the split source's, for a terminal split). */
	readonly cwd?: string | URI;
}
