/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorPart } from '../../common/editorGroupsService.js';
import { paradisHandleAuxiliaryWindowRestore, paradisRegisterAuxiliaryWindowCloseHandler, paradisRegisterAuxiliaryWindowRestoreHandler, paradisValidateAuxiliaryWindowClose } from '../../common/paradisAuxiliaryWindowRestore.js';

suite('ParadisAuxiliaryWindowRestore', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const part = {} as IEditorPart;

	test('delegates restore handling while a provider is registered', async () => {
		let handledPart: IEditorPart | undefined;
		const registration = paradisRegisterAuxiliaryWindowRestoreHandler(async candidate => {
			handledPart = candidate;
			return true;
		});
		disposables.add(registration);

		assert.strictEqual(await paradisHandleAuxiliaryWindowRestore(part), true);
		assert.strictEqual(handledPart, part);

		registration.dispose();
		assert.strictEqual(await paradisHandleAuxiliaryWindowRestore(part), false);
	});

	test('exposes and clears close vetoes', () => {
		const registration = paradisRegisterAuxiliaryWindowCloseHandler(candidate => candidate === part ? 'blocked' : undefined);
		disposables.add(registration);

		assert.strictEqual(paradisValidateAuxiliaryWindowClose(part), 'blocked');

		registration.dispose();
		assert.strictEqual(paradisValidateAuxiliaryWindowClose(part), undefined);
	});
});
