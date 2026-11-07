/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IParadisLayoutPresetService } from '../../common/paradisLayoutPresets.js';
import { ParadisLayoutPresetEditorInput } from '../../electron-browser/paradisLayoutPresetEditorInput.js';

suite('ParadisLayoutPresetEditorInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps edits made while saving as unsaved', async () => {
		const written = new DeferredPromise<string>();
		const input = store.add(new ParadisLayoutPresetEditorInput(undefined, upcastPartial<IParadisLayoutPresetService>({
			presets: [],
			savePreset: () => written.p,
		}), upcastPartial<IDialogService>({})));
		input.updateDraft({ ...input.draft, name: 'saved' });
		const saving = input.save();
		// 設定へ書いている間に、名前を続けて直す
		input.updateDraft({ ...input.draft, name: 'edited while saving' });
		written.complete('id');
		await saving;
		assert.strictEqual(input.isDirty(), true);
	});
});
