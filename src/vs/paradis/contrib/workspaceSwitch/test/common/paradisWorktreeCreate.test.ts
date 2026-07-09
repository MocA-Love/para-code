/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBuildWorktreeNames, paradisShouldCreateDefaultTerminal } from '../../common/paradisWorktreeCreate.js';

suite('paradisWorktreeCreate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses the space name only as the display name', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('音声入力による解析', 'feat/yakucho-ocr'),
			{ displayName: '音声入力による解析', dirName: 'feat-yakucho-ocr' },
		);
	});

	test('falls back to the branch-derived directory name when the space name is empty', () => {
		assert.deepStrictEqual(
			paradisBuildWorktreeNames('  ', 'feat/yakucho-ocr'),
			{ displayName: 'feat-yakucho-ocr', dirName: 'feat-yakucho-ocr' },
		);
	});

	test('creates a default terminal when no agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('none', 'build this'), true);
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', '   '), true);
	});

	test('does not create an extra default terminal when an agent command will run', () => {
		assert.strictEqual(paradisShouldCreateDefaultTerminal('codex', 'build this'), false);
	});
});
