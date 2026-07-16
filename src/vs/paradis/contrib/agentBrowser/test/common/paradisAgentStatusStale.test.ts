/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentTokenScopeMemory } from '../../common/paradisAgentStatusStale.js';

suite('ParadisAgentTokenScopeMemory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a running agent in its space during pending reattach but not after stable unscoping or token removal', () => {
		const memory = new ParadisAgentTokenScopeMemory();
		assert.strictEqual(memory.resolve('token', 'space-a', false), 'space-a');
		assert.strictEqual(memory.resolve('token', undefined, true), 'space-a');
		assert.strictEqual(memory.resolve('token', undefined, false), undefined);
		memory.prune(new Set());
		assert.strictEqual(memory.resolve('token', undefined, true), undefined);
	});
});
