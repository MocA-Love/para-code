/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt, IPromptResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { paradisConfirmThemeColorDraftsBeforeShutdown } from '../../browser/paradisThemeColorShutdownGuard.js';

type Answer = 'save' | 'discard' | 'cancel';

/** 押すボタンを決めておける prompt。何回出たかも数える。 */
function dialogAnswering(answer: Answer): { readonly dialog: Pick<IDialogService, 'prompt'>; readonly prompts: string[] } {
	const prompts: string[] = [];
	const dialog: Pick<IDialogService, 'prompt'> = {
		prompt: async <T>(prompt: IPrompt<T>): Promise<IPromptResult<T>> => {
			prompts.push(prompt.message);
			const labels: Record<Answer, number> = { save: 0, discard: 1, cancel: -1 };
			const index = labels[answer];
			const button = index === -1 ? prompt.cancelButton : prompt.buttons?.[index];
			const run = typeof button === 'object' ? button.run : undefined;
			return { result: await run?.({ checkboxChecked: false }) };
		},
	} as Pick<IDialogService, 'prompt'>;
	return { dialog, prompts };
}

suite('paradisThemeColorShutdownGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('asks before shutting down only while there are unsaved colors, and stops unless the user saves or discards', async () => {
		const outcome = async (dirtyCount: number, answer: Answer, saved: boolean | Error) => {
			const { dialog, prompts } = dialogAnswering(answer);
			let saves = 0;
			const errors: string[] = [];
			const veto = await paradisConfirmThemeColorDraftsBeforeShutdown({
				dirtyCount,
				save: async () => {
					saves++;
					if (saved instanceof Error) {
						throw saved;
					}
					return saved;
				},
			}, dialog, message => errors.push(message));
			return { veto, prompts: prompts.length, saves, errors: errors.length };
		};

		assert.deepStrictEqual({
			clean: await outcome(0, 'cancel', true),
			saved: await outcome(2, 'save', true),
			saveCancelled: await outcome(2, 'save', false),
			saveFailed: await outcome(2, 'save', new Error('disk full')),
			discarded: await outcome(2, 'discard', true),
			cancelled: await outcome(2, 'cancel', true),
		}, {
			clean: { veto: false, prompts: 0, saves: 0, errors: 0 },
			saved: { veto: false, prompts: 1, saves: 1, errors: 0 },
			saveCancelled: { veto: true, prompts: 1, saves: 1, errors: 0 },
			saveFailed: { veto: true, prompts: 1, saves: 1, errors: 1 },
			discarded: { veto: false, prompts: 1, saves: 0, errors: 0 },
			cancelled: { veto: true, prompts: 1, saves: 0, errors: 0 },
		});
	});
});
