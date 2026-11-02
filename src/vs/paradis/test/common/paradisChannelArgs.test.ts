/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisChannelArgs } from '../../common/paradisChannelArgs.js';

suite('ParadisChannelArgs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads arguments by position and treats a non-array as no arguments', () => {
		const args = ParadisChannelArgs.from(['token', 1, ['a', 2, 'b'], { x: 1 }]);
		const none = ParadisChannelArgs.from({ 0: 'token' });
		assert.deepStrictEqual({
			string: [args.string(0), args.string(1), args.string(9)],
			at: [args.at(1), args.at(3)],
			strings: [args.strings(2), args.strings(0)],
			none: [none.string(0), none.at(0), none.strings(0)],
		}, {
			string: ['token', undefined, undefined],
			at: [1, { x: 1 }],
			strings: [['a', 'b'], []],
			none: [undefined, undefined, []],
		});
	});
});
