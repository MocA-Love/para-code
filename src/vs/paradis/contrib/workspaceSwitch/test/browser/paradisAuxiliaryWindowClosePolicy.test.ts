/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { paradisCanCloseUnscopedAuxiliaryPart } from '../../browser/paradisAuxiliaryWindowClosePolicy.js';

suite('paradisCanCloseUnscopedAuxiliaryPart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function editor(typeId: string, dirty = false) {
		return { typeId, isDirty: () => dirty };
	}

	function part(...groups: ReturnType<typeof editor>[][]) {
		return { groups: groups.map(editors => ({ editors })) };
	}

	test('allows closing only windows that hold nothing but clean browser tabs', () => {
		const browser = BrowserEditorInput.ID;
		assert.deepStrictEqual({
			empty: paradisCanCloseUnscopedAuxiliaryPart(part([])),
			browserOnly: paradisCanCloseUnscopedAuxiliaryPart(part([editor(browser)], [editor(browser)])),
			withTerminal: paradisCanCloseUnscopedAuxiliaryPart(part([editor(browser), editor('workbench.editors.terminal')])),
			withFile: paradisCanCloseUnscopedAuxiliaryPart(part([editor('workbench.editors.files.fileEditorInput')])),
			dirtyBrowser: paradisCanCloseUnscopedAuxiliaryPart(part([editor(browser, true)])),
		}, {
			empty: true,
			browserOnly: true,
			withTerminal: false,
			withFile: false,
			dirtyBrowser: false,
		});
	});
});
