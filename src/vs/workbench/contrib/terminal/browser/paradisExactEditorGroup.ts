/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

export function assertParadisExactEditorGroup(
	editorGroupsService: IEditorGroupsService,
	exactGroup: IEditorGroup,
	requestedGroupId: number,
): void {
	if (requestedGroupId !== exactGroup.id) {
		throw new Error('The requested terminal editor group does not match the exact destination group.');
	}
	if (editorGroupsService.getGroup(exactGroup.id) !== exactGroup) {
		throw new Error('The destination editor group is no longer available.');
	}
}
