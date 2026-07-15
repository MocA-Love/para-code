/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisApplySameUriScopeCorrection } from '../../browser/paradisWorkspaceSwitchService.js';

suite('ParadisWorkspaceSwitchService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks the window managed before a same-URI state-key correction returns', () => {
		const calls: string[] = [];
		paradisApplySameUriScopeCorrection(
			'space-old',
			'space-corrected',
			() => calls.push('set'),
			stateKey => calls.push(`switch:${stateKey}`),
			() => calls.push('managed'),
		);
		assert.deepStrictEqual(calls, ['managed', 'set', 'switch:space-corrected']);
	});

	test('does not emit a duplicate switch when the state key is unchanged', () => {
		const calls: string[] = [];
		paradisApplySameUriScopeCorrection(
			'space-a',
			'space-a',
			() => calls.push('set'),
			stateKey => calls.push(`switch:${stateKey}`),
			() => calls.push('managed'),
		);
		assert.deepStrictEqual(calls, ['managed', 'set']);
	});
});
