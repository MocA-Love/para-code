/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSentryRelease } from '../../common/paradisSentryConfiguration.js';

suite('paradisSentryRelease', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports the release stamped at package time and falls back to version and commit without it', () => {
		assert.deepStrictEqual([
			paradisSentryRelease('1.139.1', 'abc123', 'para-code@1.139.1.148+abc123'),
			paradisSentryRelease('1.139.1', 'abc123', ' para-code@1.139.1.148-beta.1+abc123 '),
			paradisSentryRelease('1.139.1', 'abc123', ''),
			paradisSentryRelease('1.139.1', 'abc123', undefined),
			paradisSentryRelease('1.139.1', undefined, undefined),
		], [
			'para-code@1.139.1.148+abc123',
			'para-code@1.139.1.148-beta.1+abc123',
			'para-code@1.139.1+abc123',
			'para-code@1.139.1+abc123',
			'para-code@1.139.1',
		]);
	});
});
