/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { assertParadisExactEditorGroup } from '../../browser/paradisExactEditorGroup.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';

suite('Paradis exact terminal editor group', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only the same live group object and matching requested group id', () => {
		const group = { id: 7 } as IEditorGroup;
		const groups = { getGroup: (id: number) => id === 7 ? group : undefined } as IEditorGroupsService;

		assert.doesNotThrow(() => assertParadisExactEditorGroup(groups, group, 7));
	});

	test('rejects another group object even when its id is the same', () => {
		const group = { id: 7 } as IEditorGroup;
		const replacement = { id: 7 } as IEditorGroup;
		const groups = { getGroup: () => replacement } as Partial<IEditorGroupsService> as IEditorGroupsService;

		assert.throws(() => assertParadisExactEditorGroup(groups, group, 7), /destination editor group is no longer available/i);
	});

	test('rejects a requested id that differs from the exact group', () => {
		const group = { id: 7 } as IEditorGroup;
		const groups = { getGroup: () => group } as Partial<IEditorGroupsService> as IEditorGroupsService;

		assert.throws(() => assertParadisExactEditorGroup(groups, group, 8), /does not match/i);
	});
});
