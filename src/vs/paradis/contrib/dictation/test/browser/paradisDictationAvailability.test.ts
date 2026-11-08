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

	test('turns dictation off by default only off the Mac when the build has no runtime download source', () => {
		const runtime = { dictationRuntime: { version: '1.2.3', urlTemplate: 'https://example.com/{target}.tgz' } };
		assert.deepStrictEqual({
			withoutRuntime: paradisDictationDefaultOverrides({}, false),
			withRuntime: paradisDictationDefaultOverrides(runtime, false),
			macWithoutRuntime: paradisDictationDefaultOverrides({}, true),
			macWithRuntime: paradisDictationDefaultOverrides(runtime, true),
		}, {
			withoutRuntime: { 'dictation.enabled': false },
			withRuntime: undefined,
			macWithoutRuntime: undefined,
			macWithRuntime: undefined,
		});
	});
});
