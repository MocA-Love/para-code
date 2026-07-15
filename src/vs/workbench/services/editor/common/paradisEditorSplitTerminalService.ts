/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroup } from './editorGroupsService.js';

export const IParadisEditorSplitTerminalService = createDecorator<IParadisEditorSplitTerminalService>('paradisEditorSplitTerminalService');

export interface IParadisEditorSplitTerminalService {
	readonly _serviceBrand: undefined;

	openTerminalInGroup(group: IEditorGroup): Promise<void>;
}
