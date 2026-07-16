/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { GroupIdentifier } from '../../../common/editor.js';

type ParadisEditorOpenFenceHandler = (groupId: GroupIdentifier) => boolean;

let currentHandler: ParadisEditorOpenFenceHandler | undefined;

/** Registers the Para Code scope-retirement fence used by editor groups. */
export function paradisRegisterEditorOpenFenceHandler(handler: ParadisEditorOpenFenceHandler): IDisposable {
	currentHandler = handler;
	return toDisposable(() => {
		if (currentHandler === handler) {
			currentHandler = undefined;
		}
	});
}

/** Returns whether a Para Code retirement transaction currently blocks this group. */
export function paradisIsEditorOpenFenced(groupId: GroupIdentifier): boolean {
	return currentHandler?.(groupId) ?? false;
}
