/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDictationDefaultOverrides } from '../../browser/paradisDictationAvailability.contribution.js';

suite('Paradis dictation availability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns dictation off by default only when the build has no runtime download source', () => {
		assert.deepStrictEqual({
			withoutRuntime: paradisDictationDefaultOverrides({}),
			withRuntime: paradisDictationDefaultOverrides({ dictationRuntime: { version: '1.2.3', urlTemplate: 'https://example.com/{target}.tgz' } }),
		}, {
			withoutRuntime: { 'dictation.enabled': false },
			withRuntime: undefined,
		});
	});
});
