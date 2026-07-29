/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { toParadisKeepAwakeMode } from '../../common/paradisKeepAwake.js';

suite('ParadisKeepAwake', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only supported blocker modes and safely disables every other setting value', () => {
		assert.deepStrictEqual([
			toParadisKeepAwakeMode('system'),
			toParadisKeepAwakeMode('display'),
			toParadisKeepAwakeMode('off'),
			toParadisKeepAwakeMode('SYSTEM'),
			toParadisKeepAwakeMode(undefined),
			toParadisKeepAwakeMode(null),
			toParadisKeepAwakeMode(1),
		], [
			'system',
			'display',
			'off',
			'off',
			'off',
			'off',
			'off',
		]);
	});
});
