/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IResolvedTextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { IParadisReadonlyEditorOptions, paradisFollowModelReadonly } from '../../browser/paradisModelReadonly.js';

suite('paradisFollowModelReadonly', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('makes the editor read-only while the file is, with the reason, and follows changes', () => {
		const changed = store.add(new Emitter<void>());
		const message: IMarkdownString = { value: 'locked by files.readonlyInclude' };
		let readonly: boolean | IMarkdownString = message;
		const model = { isReadonly: () => readonly, onDidChangeReadonly: changed.event } as unknown as IResolvedTextEditorModel;
		const applied: IParadisReadonlyEditorOptions[] = [];
		store.add(paradisFollowModelReadonly(model, options => applied.push(options)));
		readonly = false;
		changed.fire();
		assert.deepStrictEqual(applied, [{ readOnly: true, readOnlyMessage: message }, { readOnly: false, readOnlyMessage: undefined }]);
	});
});
