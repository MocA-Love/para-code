/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains a PARA-CODE comment)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { type IPromptInputModel, PromptInputState } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';

/**
 * Returns whether DownArrow may open terminal suggestions for the live prompt state.
 * Foreground commands keep ownership of their input even when shell integration retains the
 * executed command text in the prompt model.
 */
export function paradisIsTerminalPromptSuggestEligible(
	model: Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex'>,
	executingCommand: string | undefined,
): boolean {
	if (model.state !== PromptInputState.Input || executingCommand !== undefined) {
		return false;
	}
	const value = model.ghostTextIndex === -1 ? model.value : model.value.substring(0, model.ghostTextIndex);
	return value.trim().length > 0;
}
