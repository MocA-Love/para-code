/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { paradisCanUseWindowTransparency } from '../../common/paradisWindowTransparency.js';

suite('paradisCanUseWindowTransparency', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is unavailable only on Windows with the native title bar', () => {
		const native = new TestConfigurationService({ window: { titleBarStyle: 'native' } });
		const custom = new TestConfigurationService({ window: { titleBarStyle: 'custom' } });
		assert.deepStrictEqual({
			windowsNative: paradisCanUseWindowTransparency(native, true),
			windowsCustom: paradisCanUseWindowTransparency(custom, true),
			otherNative: paradisCanUseWindowTransparency(native, false),
		}, { windowsNative: false, windowsCustom: true, otherNative: true });
	});
});
